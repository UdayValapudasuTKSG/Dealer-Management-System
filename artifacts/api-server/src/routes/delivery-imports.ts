import { Router, type IRouter } from "express";
import multer from "multer";
import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  db,
  customersTable,
  bookingsTable,
  dealerUsersTable,
  deliveriesTable,
  dealsTable,
  dealItemsTable,
  invoicesTable,
  leadsTable,
  leadVehicleInterestsTable,
  paymentsTable,
  emailLogsTable,
  tasksTable,
  vehiclesTable,
  defaultDeliverySteps,
  DEFAULT_PDI_ITEMS,
} from "@workspace/db";
import {
  ApplyDeliveryHistoryImportResponse,
  PreviewDeliveryHistoryImportResponse,
} from "@workspace/api-zod";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import {
  canCreateCommittedDealForVehicle,
  hasUnsafeReusableFinance,
  identityImportPlan,
  isReusableCommittedDeal,
  matchesReviewedVehicle,
  PRE_IMPORT_SALES_DELIVERY_TEMPLATES,
  reviewedOutboxCommunicationLockKeys,
  requiresApplyIdentityConfirmation,
} from "../lib/reviewed-delivery-import-policy";

const router: IRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});
const BATCH_KEY = "gt-automotive-august-2026-reviewed";
const EXPECTED_VIN_SET_DIGEST =
  "ce4a4dce84bbb62b52ea9f9aebe43171b3f11f2fef355a3aaa526c487b4a2e62";
// SHA-256 of the approved worksheet bytes. It contains no source data, and
// prevents a different ten-row sheet from masquerading as this named batch.
const EXPECTED_SOURCE_DIGEST =
  "b89d087d5f91ac6fc97b10f230a32286ece974d552684d564ea9200bdc203a0f";
const reviewInput = z.object({
  dealershipId: z.number().int().positive(),
  modelYear: z.number().int().min(1886).max(2100),
  vehicleMake: z.string().trim().min(1).max(80),
  powertrain: z.string().trim().min(1).max(80),
  bodyType: z.string().trim().min(1).max(80),
});
const applyInput = reviewInput.extend({
  confirmations: z
    .array(z.object({
      row: z.number().int().min(2),
      leadId: z.number().int().positive().optional(),
      customerId: z.number().int().positive().optional(),
      dealId: z.number().int().positive().optional(),
    }))
    .default([]),
});

type ParsedRow = {
  row: number;
  raw: Record<string, string>;
  vin: string;
  customerName: string;
  advisorUserId: number;
  sellingPrice: number;
  candidateLeadId: number | null;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted value.");
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function normalizedVin(value: string): string {
  return value.trim().toUpperCase();
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function csvRows(buffer: Buffer): { rows: ParsedRow[]; errors: string[] } {
  let matrix: string[][];
  try {
    matrix = parseCsv(buffer.toString("utf8"));
  } catch (error) {
    return { rows: [], errors: [error instanceof Error ? error.message : "Invalid CSV."] };
  }
  const headers = matrix.shift()?.map((header) => header.trim()) ?? [];
  const required = [
    "Dealer ID",
    "VIN",
    "Customer",
    "Advisor User ID",
    "Source LOU AMT GYD",
    "Source Pipeline Stage",
    "Customer Emails",
    "Model",
    "Engine No",
    "Arrival Date",
  ];
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length) return { rows: [], errors: [`Missing required CSV columns: ${missing.join(", ")}.`] };
  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  if (sha256(buffer) !== EXPECTED_SOURCE_DIGEST)
    errors.push("Uploaded CSV bytes do not match the approved reviewed GT Automotive source digest.");
  const seen = new Set<string>();
  matrix.forEach((cells, index) => {
    const row = index + 2;
    if (cells.every((cell) => !cell.trim())) return;
    const raw = Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? ""]));
    const vin = normalizedVin(raw["VIN"] ?? "");
    const customerName = (raw["Customer"] ?? "").trim();
    const advisorUserId = Number(raw["Advisor User ID"]);
    const sellingPrice = Number((raw["Source LOU AMT GYD"] ?? "").replace(/[,\s$]/g, ""));
    if (Number(raw["Dealer ID"]) !== 1 || (raw["Dealership"] ?? "").trim() !== "GT Automotive")
      errors.push(`CSV row ${row}: this reviewed importer is restricted to GT Automotive (dealer ID 1).`);
    if (!vin || vin.length < 17 || vin.length > 18) errors.push(`CSV row ${row}: VIN must be 17 or 18 characters.`);
    if (!customerName) errors.push(`CSV row ${row}: customer name is required.`);
    if (!(raw["Model"] ?? "").trim()) errors.push(`CSV row ${row}: model is required.`);
    if (!(raw["Engine No"] ?? "").trim()) errors.push(`CSV row ${row}: engine number is required.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test((raw["Arrival Date"] ?? "").trim()))
      errors.push(`CSV row ${row}: arrival/receipt date must be YYYY-MM-DD.`);
    if (!Number.isInteger(advisorUserId) || advisorUserId <= 0) errors.push(`CSV row ${row}: a valid advisor user ID is required.`);
    if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) errors.push(`CSV row ${row}: confirmed selling price must be positive.`);
    if ((raw["Customer Emails"] ?? "").trim().toUpperCase() !== "SUPPRESS")
      errors.push(`CSV row ${row}: Customer Emails must be SUPPRESS.`);
    if ((raw["Source Pipeline Stage"] ?? "").trim().toLowerCase() !== "delivered")
      errors.push(`CSV row ${row}: this reviewed importer only accepts Delivered source rows.`);
    if (seen.has(vin)) errors.push(`CSV row ${row}: duplicate VIN in uploaded file.`);
    seen.add(vin);
    rows.push({
      row,
      raw,
      vin,
      customerName,
      advisorUserId,
      sellingPrice,
      candidateLeadId: Number.isInteger(Number(raw["Candidate Lead ID"])) ? Number(raw["Candidate Lead ID"]) : null,
    });
  });
  if (rows.length !== 10) errors.push("This reviewed import accepts exactly the ten approved GT Automotive rows.");
  const vinSetDigest = sha256([...rows.map((row) => row.vin)].sort().join("\n") + "\n");
  if (vinSetDigest !== EXPECTED_VIN_SET_DIGEST)
    errors.push("Uploaded VIN set does not match the approved reviewed GT Automotive batch.");
  return { rows, errors };
}

async function receiveFile(req: Parameters<ReturnType<typeof upload.single>>[0], res: Parameters<ReturnType<typeof upload.single>>[1]): Promise<boolean> {
  return new Promise((resolve) => upload.single("file")(req, res, (error: unknown) => {
    if (error) {
      res.status(error instanceof multer.MulterError ? 413 : 400).json({ error: "Could not process CSV upload." });
      resolve(false);
      return;
    }
    resolve(true);
  }));
}

function importMetadata(row: ParsedRow, input: { modelYear: number; vehicleMake: string; powertrain: string; bodyType: string }, batchFingerprint: string) {
  return {
    batchKey: BATCH_KEY,
    kind: "reviewed_delivery_history",
    sourceStatus: row.raw["Source Pipeline Stage"],
    targetWorkflowStatus: "in_progress",
    sourceRow: row.row,
    sourceVin: row.vin,
    sourceFingerprint: sha256(JSON.stringify(row.raw)),
    batchFingerprint,
    source: row.raw,
    arrivalDate: row.raw["Arrival Date"] || null,
    receiptDate: row.raw["Arrival Date"] || null,
    confirmedSellingPriceGyd: row.sellingPrice,
    priceTaxInclusive: true,
    mileageKnown: false,
    paymentState: "UNRECORDED",
    sourceDepositGyd: row.raw["Source Deposit GYD"] || null,
    suppressCustomerCommunications: true,
    reviewedVehicleFields: {
      make: input.vehicleMake,
      modelYear: input.modelYear,
      powertrain: input.powertrain,
      bodyType: input.bodyType,
    },
  };
}

function matchesReviewedFields(
  metadata: Record<string, unknown> | null | undefined,
  input: { modelYear: number; vehicleMake: string; powertrain: string; bodyType: string },
): boolean {
  const fields = metadata?.reviewedVehicleFields;
  return (
    !!fields &&
    typeof fields === "object" &&
    (fields as Record<string, unknown>).modelYear === input.modelYear &&
    (fields as Record<string, unknown>).make === input.vehicleMake &&
    (fields as Record<string, unknown>).powertrain === input.powertrain &&
    (fields as Record<string, unknown>).bodyType === input.bodyType
  );
}

function sameText(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? "").trim().toLocaleLowerCase() === (right ?? "").trim().toLocaleLowerCase();
}

function leadImportMetadata(
  row: ParsedRow,
  input: z.infer<typeof reviewInput>,
  batchFingerprint: string,
  importedAt: Date,
) {
  return {
    ...importMetadata(row, input, batchFingerprint),
    importedAt: importedAt.toISOString(),
    suppressSalesAutomation: true,
    suppressionReason: "reviewed historical committed sale; no customer outreach or new-lead automation",
  };
}

async function lockReviewedOutboxCommunication(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  identity: Parameters<typeof reviewedOutboxCommunicationLockKeys>[0],
): Promise<void> {
  for (const key of reviewedOutboxCommunicationLockKeys(identity)) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  }
}

async function preview(
  dealerId: number,
  input: { dealershipId: number; modelYear: number; vehicleMake: string; powertrain: string; bodyType: string },
  buffer: Buffer,
) {
  const parsed = csvRows(buffer);
  const errors = [...parsed.errors];
  if (dealerId !== 1)
    errors.push("This reviewed GT Automotive batch can only be applied in dealer ID 1.");
  if (input.dealershipId !== dealerId) errors.push("The explicitly selected dealership does not match the active dealership.");
  const vins = parsed.rows.map((row) => row.vin);
  const batchFingerprint = sha256(buffer);
  const vehicles = vins.length
    ? await db.select().from(vehiclesTable).where(and(
      eq(vehiclesTable.dealerId, dealerId),
      isNull(vehiclesTable.deletedAt),
      inArray(sql<string>`upper(btrim(${vehiclesTable.vin}))`, vins),
    ))
    : [];
  const advisors = await db.select({ userId: dealerUsersTable.userId }).from(dealerUsersTable).where(and(
    eq(dealerUsersTable.dealerId, dealerId),
    inArray(dealerUsersTable.userId, [...new Set(parsed.rows.map((row) => row.advisorUserId))]),
  ));
  const advisorIds = new Set(advisors.map((advisor) => advisor.userId));
  const leadNames = [...new Set(parsed.rows.map((row) => row.customerName.toLocaleLowerCase()))];
  const leads = leadNames.length
    ? await db.select({ id: leadsTable.id, name: leadsTable.name, customerId: leadsTable.customerId }).from(leadsTable).where(and(
      eq(leadsTable.dealerId, dealerId),
      isNull(leadsTable.deletedAt),
      inArray(sql<string>`lower(btrim(${leadsTable.name}))`, leadNames),
    ))
    : [];
  const vehicleByVin = new Map(vehicles.map((vehicle) => [normalizedVin(vehicle.vin ?? ""), vehicle]));
  const existingDeliveries = vins.length
    ? await db
        .select({
          id: deliveriesTable.id,
          vin: vehiclesTable.vin,
          customerName: deliveriesTable.customerName,
          customerId: deliveriesTable.customerId,
          dealId: deliveriesTable.dealId,
          invoiceId: deliveriesTable.invoiceId,
          importMetadata: deliveriesTable.importMetadata,
        })
        .from(deliveriesTable)
        .innerJoin(vehiclesTable, eq(vehiclesTable.id, deliveriesTable.vehicleId))
        .where(
          and(
            eq(deliveriesTable.dealerId, dealerId),
            eq(vehiclesTable.dealerId, dealerId),
            inArray(sql<string>`upper(btrim(${vehiclesTable.vin}))`, vins),
          ),
        )
    : [];
  const deliveryByVin = new Map(
    existingDeliveries.map((delivery) => [
      normalizedVin(delivery.vin ?? ""),
      delivery,
    ]),
  );
  const candidatesByName = new Map<string, { id: number; customerId: number | null }[]>();
  for (const lead of leads) {
    const key = lead.name.trim().toLowerCase();
    candidatesByName.set(key, [...(candidatesByName.get(key) ?? []), { id: lead.id, customerId: lead.customerId }]);
  }
  const customerMatchResults = await Promise.all(
    parsed.rows.map(async (row) => {
      const email = row.raw["Email"]?.trim();
      return db
        .select({ id: customersTable.id, name: customersTable.name, email: customersTable.email })
        .from(customersTable)
        .where(
          and(
            eq(customersTable.dealerId, dealerId),
            isNull(customersTable.deletedAt),
            or(
              eq(sql<string>`lower(btrim(${customersTable.name}))`, row.customerName.toLowerCase()),
              ...(email ? [eq(sql<string>`lower(btrim(${customersTable.email}))`, email.toLowerCase())] : []),
            ),
          ),
        );
    }),
  );
  const existingDeals = vins.length
    ? await db
        .select({
          id: dealsTable.id,
          vin: vehiclesTable.vin,
          vehicleId: dealsTable.vehicleId,
          customerId: dealsTable.customerId,
          leadId: dealsTable.leadId,
          stage: dealsTable.stage,
          vehiclePrice: dealsTable.vehiclePrice,
          otdPrice: dealsTable.otdPrice,
        })
        .from(dealsTable)
        .innerJoin(vehiclesTable, eq(vehiclesTable.id, dealsTable.vehicleId))
        .where(and(
          eq(dealsTable.dealerId, dealerId),
          eq(vehiclesTable.dealerId, dealerId),
          inArray(sql<string>`upper(btrim(${vehiclesTable.vin}))`, vins),
        ))
    : [];
  const dealsByVin = new Map<string, typeof existingDeals>();
  for (const deal of existingDeals) {
    const key = normalizedVin(deal.vin ?? "");
    dealsByVin.set(key, [...(dealsByVin.get(key) ?? []), deal]);
  }
  const dealIds = existingDeals.map((deal) => deal.id);
  const invoices = dealIds.length
    ? await db
        .select({
          id: invoicesTable.id,
          dealId: invoicesTable.dealId,
          customerId: invoicesTable.customerId,
          customerName: invoicesTable.customerName,
          amount: invoicesTable.amount,
          kind: invoicesTable.kind,
          status: invoicesTable.status,
          taxLines: invoicesTable.taxLines,
          paymentCount: sql<number>`count(${paymentsTable.id})`,
        })
        .from(invoicesTable)
        .leftJoin(paymentsTable, and(
          eq(paymentsTable.invoiceId, invoicesTable.id),
          eq(paymentsTable.dealerId, dealerId),
        ))
        .where(and(eq(invoicesTable.dealerId, dealerId), inArray(invoicesTable.dealId, dealIds)))
        .groupBy(invoicesTable.id)
    : [];
  const invoicesByDeal = new Map<number, typeof invoices>();
  for (const invoice of invoices) {
    if (invoice.dealId == null) continue;
    invoicesByDeal.set(invoice.dealId, [...(invoicesByDeal.get(invoice.dealId) ?? []), invoice]);
  }
  const rows = parsed.rows.map((row) => {
    if (!advisorIds.has(row.advisorUserId)) errors.push(`CSV row ${row.row}: advisor ${row.advisorUserId} is not a member of this dealership.`);
    const candidates = candidatesByName.get(row.customerName.toLowerCase()) ?? [];
    const matchingCustomers = customerMatchResults[row.row - 2] ?? [];
    const existingDelivery = deliveryByVin.get(row.vin);
    const prior = existingDelivery?.importMetadata as Record<string, unknown> | null | undefined;
    const verifiedReplay =
      prior?.batchKey === BATCH_KEY &&
      prior?.batchFingerprint === batchFingerprint &&
      prior?.sourceFingerprint === sha256(JSON.stringify(row.raw)) &&
      prior?.confirmedSellingPriceGyd === row.sellingPrice &&
      existingDelivery?.customerName?.trim().toLowerCase() ===
        row.customerName.toLowerCase() &&
      matchesReviewedFields(prior, input);
    if (existingDelivery && !verifiedReplay)
      errors.push(
        `CSV row ${row.row}: existing VIN delivery has different import content, customer, price, or reviewed vehicle fields.`,
      );
    const candidateLeadIds = candidates.map((candidate) => candidate.id);
    const candidateCustomerIds = matchingCustomers.map((candidate) => candidate.id);
    if (row.candidateLeadId != null && !candidateLeadIds.includes(row.candidateLeadId))
      errors.push(`CSV row ${row.row}: declared lead candidate ${row.candidateLeadId} no longer exactly matches live dealership data.`);
    const vehicle = vehicleByVin.get(row.vin);
    if (vehicle && !matchesReviewedVehicle(vehicle, row, input))
      errors.push(`CSV row ${row.row}: existing VIN ${row.vin} does not exactly match the reviewed model, version, engine, price, or vehicle specification.`);
    const vinDeals = dealsByVin.get(row.vin) ?? [];
    const compatibleDeals = vehicle
      ? vinDeals.filter((deal) =>
          deal.stage === "committed" &&
          deal.vehicleId === vehicle.id &&
          deal.vehiclePrice === row.sellingPrice &&
          deal.otdPrice === row.sellingPrice &&
          deal.leadId != null &&
          deal.customerId != null &&
          candidateLeadIds.includes(deal.leadId) &&
          candidateCustomerIds.includes(deal.customerId),
        )
      : [];
    const candidateDealIds = compatibleDeals.map((deal) => deal.id);
    if (!verifiedReplay && vinDeals.some((deal) => !candidateDealIds.includes(deal.id)))
      errors.push(`CSV row ${row.row}: VIN ${row.vin} has a foreign, cancelled, delivered, desking, or price-conflicting deal that cannot be reused.`);
    for (const deal of compatibleDeals) {
      const finals = (invoicesByDeal.get(deal.id) ?? []).filter((invoice) => invoice.kind === "final");
      if (
        (invoicesByDeal.get(deal.id) ?? []).some((invoice) => invoice.paymentCount !== 0) ||
        hasUnsafeReusableFinance(finals, row.sellingPrice)
      )
        errors.push(`CSV row ${row.row}: reusable deal #${deal.id} has a conflicting finance state (final invoice, tax snapshot, or payment ledger).`);
    }
    const identityPlan = identityImportPlan(
      candidateLeadIds,
      candidateCustomerIds,
      candidateDealIds,
      verifiedReplay,
    );
    return {
      row: row.row,
      vin: row.vin,
      customerName: row.customerName,
      action: vehicleByVin.has(row.vin) ? "reuse_vehicle" : "create_vehicle",
      existingVehicleId: vehicleByVin.get(row.vin)?.id ?? null,
      leadAction: identityPlan.leadAction,
      leadId: identityPlan.leadId,
      candidateLeadIds,
      customerAction: identityPlan.customerAction,
      customerId: identityPlan.customerId,
      candidateCustomerIds,
      dealAction: identityPlan.dealAction,
      dealId: identityPlan.dealId,
      candidateDealIds,
      invoiceAction: compatibleDeals.length && (invoicesByDeal.get(compatibleDeals[0]!.id) ?? []).some((invoice) => invoice.kind === "final") ? "reuse_invoice" : "create_invoice",
      invoiceId: compatibleDeals.length === 1
        ? ((invoicesByDeal.get(compatibleDeals[0]!.id) ?? []).find((invoice) => invoice.kind === "final")?.id ?? null)
        : null,
      requiresIdentityConfirmation: identityPlan.requiresIdentityConfirmation,
      sellingPriceGyd: row.sellingPrice,
      paymentState: "UNRECORDED",
      sourceStatus: row.raw["Source Pipeline Stage"] ?? null,
      targetStatus: "in_progress",
    };
  });
  return { batchKey: BATCH_KEY, total: parsed.rows.length, rows, errors, canApply: errors.length === 0 };
}

function canApply(
  user: NonNullable<Express.Locals["user"]>,
  dealerId: number,
): boolean {
  const membership = user.dealers.find(
    (member) => member.dealerId === dealerId,
  );
  return (
    user.dealerId === dealerId &&
    (membership?.isGeneralManager === true ||
      membership?.roleName === "General Manager") &&
    [
    ["deliveries", "create"],
    ["inventory", "create"],
    ["customers", "create"],
    ["leads", "create"],
    ["deals", "create"],
    ["finance", "create"],
    ["inventory", "edit"],
    ["customers", "edit"],
    ["leads", "edit"],
    ["deals", "edit"],
    ].every(([module, category]) => hasPermission(user, module, category))
  );
}

router.post("/delivery-imports/preview", async (req, res): Promise<void> => {
  if (!(await receiveFile(req, res)) || !req.file) {
    if (!req.file && !res.headersSent) res.status(400).json({ error: "CSV file is required (field name: file)." });
    return;
  }
  const input = reviewInput.safeParse({
    ...req.body,
    dealershipId: Number(req.body.dealershipId),
    modelYear: Number(req.body.modelYear),
  });
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  const result = await preview(activeDealerId(res), input.data, req.file.buffer);
  res.json(PreviewDeliveryHistoryImportResponse.parse(result));
});

router.post("/delivery-imports/apply", async (req, res): Promise<void> => {
  if (!(await receiveFile(req, res)) || !req.file) {
    if (!req.file && !res.headersSent) res.status(400).json({ error: "CSV file is required (field name: file)." });
    return;
  }
  let confirmations: unknown = [];
  try {
    confirmations = req.body.confirmations
      ? JSON.parse(req.body.confirmations)
      : [];
  } catch {
    res.status(400).json({ error: "confirmations must be valid JSON." });
    return;
  }
  const input = applyInput.safeParse({
    ...req.body,
    dealershipId: Number(req.body.dealershipId),
    modelYear: Number(req.body.modelYear),
    confirmations,
  });
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  if (!canApply(res.locals.user!, dealerId)) {
    res.status(403).json({ error: "This reviewed import requires the active dealership General Manager plus explicit create permissions for deliveries, inventory, customers, leads, deals and finance, and edit permissions for inventory, customers, leads and deals when confirmed records are reused." });
    return;
  }
  const check = await preview(dealerId, input.data, req.file.buffer);
  if (!check.canApply) {
    res.status(409).json({ error: "Import review is no longer valid. Correct the reported rows and preview again.", review: check });
    return;
  }
  const parsed = csvRows(req.file.buffer);
  const confirmationByRow = new Map(input.data.confirmations.map((confirmation) => [confirmation.row, confirmation]));
  if (confirmationByRow.size !== input.data.confirmations.length) {
    res.status(400).json({ error: "Each identity-confirmation row may appear only once." });
    return;
  }
  for (const row of parsed.rows) {
    const reviewRow = check.rows.find((item) => item.row === row.row);
    const confirmation = confirmationByRow.get(row.row);
    if (!reviewRow) {
      res.status(409).json({ error: `CSV row ${row.row}: review row is missing.` });
      return;
    }
    // A replay has already proved its immutable source fingerprint, customer,
    // price, and reviewed fields. It must not be made impossible merely
    // because its own created records now appear as exact candidates.
    if (!requiresApplyIdentityConfirmation(reviewRow)) continue;
    const selected = [
      ["lead", reviewRow.candidateLeadIds, confirmation?.leadId],
      ["customer", reviewRow.candidateCustomerIds, confirmation?.customerId],
      ["deal", reviewRow.candidateDealIds, confirmation?.dealId],
    ] as const;
    for (const [kind, candidates, id] of selected) {
      if (candidates.length > 0 && (id == null || !candidates.includes(id))) {
        res.status(409).json({ error: `CSV row ${row.row}: explicitly confirm one of the exact ${kind} candidates (${candidates.join(", ")}) before applying.` });
        return;
      }
      if (candidates.length === 0 && id != null) {
        res.status(409).json({ error: `CSV row ${row.row}: no ${kind} candidate may be supplied for this review.` });
        return;
      }
    }
  }
  const batchFingerprint = sha256(req.file.buffer);
  const outcomes = await db.transaction(async (tx) => {
    // Canonical dealer-wide VIN lock used by the regular inventory paths.
    // It is acquired before *any* VIN lookup so this import cannot race a
    // normal reservation/allocation between preview and apply.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`vehicle-vin:${dealerId}`}))`,
    );
    const outcomes: {
      row: number; deliveryId: number; leadId: number; dealId: number; invoiceId: number;
      leadAction: "create_lead" | "reuse_lead";
      dealAction: "create_deal" | "reuse_deal";
      invoiceAction: "create_invoice" | "reuse_invoice";
      status: "created" | "unchanged";
    }[] = [];
    for (const row of parsed.rows) {
      const confirmed = confirmationByRow.get(row.row);
      const result = await tx.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`reviewed-delivery-import:${dealerId}:${row.vin}`}))`);
      const [advisorMembership] = await tx
        .select({ userId: dealerUsersTable.userId })
        .from(dealerUsersTable)
        .where(
          and(
            eq(dealerUsersTable.dealerId, dealerId),
            eq(dealerUsersTable.userId, row.advisorUserId),
          ),
        )
        .for("update");
      if (!advisorMembership)
        throw new Error(
          `CSV row ${row.row}: advisor ${row.advisorUserId} is no longer a member of this dealership.`,
        );
      const [existing] = await tx.select({
        id: deliveriesTable.id,
        customerName: deliveriesTable.customerName,
        dealId: deliveriesTable.dealId,
        invoiceId: deliveriesTable.invoiceId,
      }).from(deliveriesTable)
        .innerJoin(vehiclesTable, eq(vehiclesTable.id, deliveriesTable.vehicleId))
        .where(and(
          eq(deliveriesTable.dealerId, dealerId),
          eq(vehiclesTable.dealerId, dealerId),
          eq(sql<string>`upper(btrim(${vehiclesTable.vin}))`, row.vin),
        ))
        .limit(1);
      if (existing) {
        const [matched] = await tx.select({ importMetadata: deliveriesTable.importMetadata })
          .from(deliveriesTable)
          .where(and(eq(deliveriesTable.id, existing.id), eq(deliveriesTable.dealerId, dealerId)));
        const prior = matched?.importMetadata as Record<string, unknown> | null;
        if (
          prior?.batchKey !== BATCH_KEY ||
          prior?.batchFingerprint !== batchFingerprint ||
          prior?.sourceFingerprint !== sha256(JSON.stringify(row.raw)) ||
          prior?.confirmedSellingPriceGyd !== row.sellingPrice ||
          existing.customerName?.trim().toLowerCase() !== row.customerName.toLowerCase() ||
          !matchesReviewedFields(prior, input.data)
        )
          throw new Error(`CSV row ${row.row}: VIN ${row.vin} is already occupied by a different delivery.`);
        if (existing.invoiceId == null)
          throw new Error(`CSV row ${row.row}: replay delivery ${existing.id} has no invoice link.`);
        const [replayDeal] = await tx.select({ leadId: dealsTable.leadId }).from(dealsTable).where(and(
          eq(dealsTable.id, existing.dealId),
          eq(dealsTable.dealerId, dealerId),
        ));
        if (replayDeal?.leadId == null)
          throw new Error(`CSV row ${row.row}: replay delivery ${existing.id} has no lead link.`);
        return {
          status: "unchanged" as const,
          deliveryId: existing.id,
          leadId: replayDeal.leadId,
          dealId: existing.dealId,
          invoiceId: existing.invoiceId,
          leadAction: "reuse_lead" as const,
          dealAction: "reuse_deal" as const,
          invoiceAction: "reuse_invoice" as const,
        };
      }
      const meta = importMetadata(row, input.data, batchFingerprint);
      const [vehicle] = await tx.select().from(vehiclesTable).where(and(
        eq(vehiclesTable.dealerId, dealerId),
        isNull(vehiclesTable.deletedAt),
        eq(sql<string>`upper(btrim(${vehiclesTable.vin}))`, row.vin),
      )).for("update");
      if (vehicle && !matchesReviewedVehicle(vehicle, row, input.data))
        throw new Error(`CSV row ${row.row}: existing VIN ${row.vin} does not exactly match the reviewed specification and price.`);
      if (vehicle && (vehicle.recallFlag || vehicle.damageFlag || (vehicle.holdUntil != null && vehicle.holdUntil > new Date())))
        throw new Error(`CSV row ${row.row}: existing VIN ${row.vin} is held, recalled, or damaged.`);

      let customer: typeof customersTable.$inferSelect;
      if (confirmed?.customerId != null) {
        const [selected] = await tx.select().from(customersTable).where(and(
          eq(customersTable.id, confirmed.customerId),
          eq(customersTable.dealerId, dealerId),
          isNull(customersTable.deletedAt),
          or(
            eq(sql<string>`lower(btrim(${customersTable.name}))`, row.customerName.toLowerCase()),
            ...(row.raw["Email"]?.trim()
              ? [eq(sql<string>`lower(btrim(${customersTable.email}))`, row.raw["Email"]!.trim().toLowerCase())]
              : []),
          ),
        )).for("update");
        if (!selected) throw new Error(`CSV row ${row.row}: confirmed customer ${confirmed.customerId} is no longer an exact name/email candidate.`);
        customer = selected;
      } else {
        [customer] = await tx.insert(customersTable).values({
          dealerId, name: row.customerName, email: row.raw["Email"]?.trim() || null,
          phone: null, address: row.raw["Address"]?.trim() || null,
        }).returning();
      }

      let lead: typeof leadsTable.$inferSelect;
      let leadAction: "create_lead" | "reuse_lead";
      const importedAt = new Date();
      if (confirmed?.leadId != null) {
        // This is the same lead-link lock used by normal deal creation and
        // archive flows. Acquire it before the row lock/update.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lead-link:${dealerId}:${confirmed.leadId}`}))`);
        const [selected] = await tx.select().from(leadsTable).where(and(
          eq(leadsTable.id, confirmed.leadId),
          eq(leadsTable.dealerId, dealerId),
          isNull(leadsTable.deletedAt),
          eq(sql<string>`lower(btrim(${leadsTable.name}))`, row.customerName.toLowerCase()),
        )).for("update");
        if (!selected) throw new Error(`CSV row ${row.row}: confirmed lead ${confirmed.leadId} is no longer an exact active lead candidate.`);
        if (selected.customerId != null && selected.customerId !== customer!.id)
          throw new Error(`CSV row ${row.row}: confirmed lead ${selected.id} is linked to a different customer.`);
        // Acquire the exact fence that a worker holds through its final
        // provenance check and provider hand-off. Include only legacy lookup
        // identities, never a broad customer-email suppression rule.
        await lockReviewedOutboxCommunication(tx, {
          dealerId,
          leadId: selected.id,
          customerId: customer!.id,
          email: row.raw["Email"],
          emails: [selected.email, customer!.email],
          whatsappPhones: [selected.phone, customer!.phone],
        });
        [lead] = await tx.update(leadsTable).set({
          customerId: selected.customerId ?? customer!.id,
          // A reused historical-sale lead must leave the actionable pipeline
          // too. Keep its existing valid owner/assignment; only the scoped
          // import state is changed under the canonical lead-link lock.
          phase: "won",
          status: "converted",
          contactedDate: selected.contactedDate,
          stageEnteredAt: new Date(),
          importMetadata: leadImportMetadata(row, input.data, batchFingerprint, importedAt),
        }).where(and(
          eq(leadsTable.id, selected.id), eq(leadsTable.dealerId, dealerId),
        )).returning();
        await tx.update(emailLogsTable).set({
          status: "cancelled",
          deliveryStatus: "cancelled",
          nextAttemptAt: null,
          lastError: "cancelled: reviewed historical sale has customer communication suppression",
        }).where(and(
          eq(emailLogsTable.dealerId, dealerId),
          eq(emailLogsTable.leadId, lead!.id),
          inArray(emailLogsTable.status, ["queued", "processing", "failed"]),
        ));
        await tx.update(tasksTable).set({
          status: "done",
          completedAt: new Date(),
          description: sql`coalesce(${tasksTable.description}, '') || E'\nClosed without outreach: lead was linked to a reviewed historical committed sale.'`,
          updatedAt: new Date(),
        }).where(and(
          eq(tasksTable.dealerId, dealerId),
          eq(tasksTable.leadId, lead!.id),
          inArray(tasksTable.kind, ["cadence", "callback"]),
          ne(tasksTable.status, "done"),
        ));
        leadAction = "reuse_lead";
      } else {
        // Deliberately bypass POST /leads: that endpoint starts welcome,
        // quoting, intake and manager-notification automation even for a won
        // phase. This is an already committed historical sale, not an enquiry.
        // A newly inserted lead cannot have a pre-existing explicit outbox
        // row, but an identity-less legacy row can match its customer/email.
        // Fence those identities before the suppression provenance is made
        // visible to other transactions.
        await lockReviewedOutboxCommunication(tx, {
          dealerId,
          customerId: customer!.id,
          email: row.raw["Email"],
          whatsappPhones: [customer!.phone],
        });
        [lead] = await tx.insert(leadsTable).values({
          dealerId,
          name: row.customerName,
          email: row.raw["Email"]?.trim() || null,
          address: row.raw["Address"]?.trim() || null,
          channel: "reviewed_delivery_import",
          source: "walk_in",
          phase: "won",
          status: "converted",
          customerId: customer!.id,
          interestedVehicleId: null,
          selectedModel: row.raw["Model"],
          interestedModelText: row.raw["Model"],
          variant: row.raw["Version"] || null,
          color: row.raw["Exterior"] || null,
          assignedTo: row.raw["Advisor"] || null,
          ownerUserId: row.advisorUserId,
          emailOptOut: false,
          contactedDate: null,
          stageEnteredAt: new Date(),
          notes: `Imported reviewed committed sale (${BATCH_KEY}); customer outreach and sales automation are suppressed by import provenance.`,
          importMetadata: leadImportMetadata(row, input.data, batchFingerprint, importedAt),
        }).returning();
        await tx.insert(leadVehicleInterestsTable).values({
          dealerId,
          leadId: lead!.id,
          vehicleId: null,
          make: input.data.vehicleMake,
          model: row.raw["Model"],
          modelYear: input.data.modelYear,
          variant: row.raw["Version"] || null,
          color: row.raw["Exterior"] || null,
          unitPrice: row.sellingPrice,
          quantity: 1,
          position: 0,
        });
        leadAction = "create_lead";
      }

      // Before leadId was persisted on every customer outbox event, some
      // legacy rows carried only customerId (or just the destination). Once a
      // reviewed imported lead is converted, cancel those identity-less rows
      // while they are still claimable. Explicitly lead-scoped rows for an
      // unrelated same-address lead are intentionally untouched; ambiguous
      // legacy rows fail closed here because their origin cannot be proven.
      const importedEmail = lead!.email?.trim().toLowerCase() || null;
      await tx.update(emailLogsTable).set({
        status: "cancelled",
        deliveryStatus: "cancelled",
        nextAttemptAt: null,
        lastError: "cancelled: legacy outbox identity is ambiguous for a suppressed imported lead",
      }).where(and(
        eq(emailLogsTable.dealerId, dealerId),
        isNull(emailLogsTable.leadId),
        inArray(emailLogsTable.template, PRE_IMPORT_SALES_DELIVERY_TEMPLATES),
        lt(emailLogsTable.createdAt, importedAt),
        inArray(emailLogsTable.status, ["queued", "processing", "failed"]),
        or(
          eq(emailLogsTable.customerId, customer!.id),
          ...(importedEmail
            ? [sql`lower(btrim(${emailLogsTable.recipient})) = ${importedEmail}`]
            : []),
        ),
      ));

      const selectedVehicle = vehicle ?? (await tx.insert(vehiclesTable).values({
        dealerId,
        make: input.data.vehicleMake,
        model: row.raw["Model"],
        trim: row.raw["Version"] || null,
        year: input.data.modelYear,
        vin: row.vin,
        engineNumber: row.raw["Engine No"] || null,
        price: row.sellingPrice,
        powertrain: input.data.powertrain,
        // Schema currently requires a number. Provenance deliberately marks
        // this sentinel as unknown so documents never render it as 0 km.
        mileageKm: 0,
        exteriorColor: row.raw["Exterior"] || "Unknown",
        bodyType: input.data.bodyType,
        status: "booked",
        importMetadata: meta,
      }).returning())[0]!;
      const allVehicleDeals = await tx.select().from(dealsTable).where(and(
        eq(dealsTable.dealerId, dealerId), eq(dealsTable.vehicleId, selectedVehicle.id),
      )).for("update");
      let deal: typeof dealsTable.$inferSelect;
      let dealAction: "create_deal" | "reuse_deal";
      if (confirmed?.dealId != null) {
        const selected = allVehicleDeals.find((candidate) => candidate.id === confirmed.dealId);
        if (!selected || !isReusableCommittedDeal(selected, selectedVehicle.id, customer!.id, lead!.id, row.sellingPrice))
          throw new Error(`CSV row ${row.row}: confirmed deal ${confirmed.dealId} no longer matches the confirmed lead/customer, VIN, specification, and price.`);
        deal = selected;
        dealAction = "reuse_deal";
      } else {
        if (allVehicleDeals.length)
          throw new Error(`CSV row ${row.row}: existing deal allocation for VIN ${row.vin} was not explicitly confirmed as a safe reuse.`);
        if (!canCreateCommittedDealForVehicle(vehicle))
          throw new Error(`CSV row ${row.row}: existing VIN ${row.vin} is unavailable for a new committed allocation.`);
        [deal] = await tx.insert(dealsTable).values({
          dealerId,
          customerId: customer!.id,
          leadId: lead!.id,
          vehicleId: selectedVehicle.id,
          customerName: row.customerName,
          stage: "committed",
          vehiclePrice: row.sellingPrice,
          otdPrice: row.sellingPrice,
          depositPaid: false,
          salesAdvisor: row.raw["Advisor"],
          salesAdvisorUserId: row.advisorUserId,
        }).returning();
        dealAction = "create_deal";
      }
      if (vehicle && confirmed?.dealId == null)
        await tx.update(vehiclesTable).set({ status: "booked", importMetadata: meta }).where(eq(vehiclesTable.id, vehicle.id));
      const dealItems = await tx.select().from(dealItemsTable).where(and(
        eq(dealItemsTable.dealerId, dealerId),
        eq(dealItemsTable.dealId, deal!.id),
      )).for("update");
      const matchingItems = dealItems.filter((candidate) =>
        candidate.vehicleId === selectedVehicle.id,
      );
      let item = matchingItems.find((candidate) =>
        candidate.quantity === 1 && candidate.status === "allocated" &&
        candidate.vehiclePrice === row.sellingPrice && candidate.total === row.sellingPrice &&
        sameText(candidate.make, selectedVehicle.make) && sameText(candidate.model, selectedVehicle.model) &&
        candidate.modelYear === selectedVehicle.year && sameText(candidate.variant, selectedVehicle.trim) &&
        sameText(candidate.color, selectedVehicle.exteriorColor),
      );
      if (matchingItems.length && !item)
        throw new Error(`CSV row ${row.row}: reused deal #${deal!.id} has a VIN item with a conflicting specification or price.`);
      if (!item) [item] = await tx.insert(dealItemsTable).values({
        dealerId,
        dealId: deal!.id,
        vehicleId: selectedVehicle.id,
        make: selectedVehicle.make,
        model: selectedVehicle.model,
        modelYear: selectedVehicle.year,
        variant: selectedVehicle.trim,
        color: selectedVehicle.exteriorColor,
        quantity: 1,
        position: Math.max(-1, ...dealItems.map((candidate) => candidate.position)) + 1,
        vehiclePrice: row.sellingPrice,
        total: row.sellingPrice,
        status: "allocated",
       }).returning();
      const dealInvoices = await tx.select({
        id: invoicesTable.id, kind: invoicesTable.kind, amount: invoicesTable.amount,
        status: invoicesTable.status, customerId: invoicesTable.customerId, customerName: invoicesTable.customerName,
        taxLines: invoicesTable.taxLines,
      }).from(invoicesTable).where(and(
        eq(invoicesTable.dealerId, dealerId), eq(invoicesTable.dealId, deal!.id),
      )).for("update");
      const paymentRows = dealInvoices.length
        ? await tx.select({ id: paymentsTable.id }).from(paymentsTable).where(and(
            eq(paymentsTable.dealerId, dealerId),
            inArray(paymentsTable.invoiceId, dealInvoices.map((invoice) => invoice.id)),
          )).for("update")
        : [];
      if (paymentRows.length)
        throw new Error(`CSV row ${row.row}: reused deal #${deal!.id} has payment ledger evidence; imported payment state is unrecorded and cannot overwrite finance.`);
      const finals = dealInvoices.filter((invoice) => invoice.kind === "final");
      if (finals.length > 1)
        throw new Error(`CSV row ${row.row}: reused deal #${deal!.id} has multiple final invoices and cannot be safely imported.`);
      let invoice = finals[0];
      let invoiceAction: "create_invoice" | "reuse_invoice" = invoice ? "reuse_invoice" : "create_invoice";
      if (invoice && (
        invoice.amount !== row.sellingPrice || invoice.status !== "issued" ||
        invoice.customerId !== customer!.id || !sameText(invoice.customerName, row.customerName) ||
        !Array.isArray(invoice.taxLines) || invoice.taxLines.length !== 0
      ))
        throw new Error(`CSV row ${row.row}: reused final invoice #${invoice.id} conflicts with the reviewed full-price, no-tax, unrecorded settlement.`);
      if (!invoice) {
       const [invoiceBase] = await tx.insert(invoicesTable).values({
        dealerId,
        invoiceNumber: "PENDING",
        customerId: customer!.id,
        customerName: row.customerName,
        dealId: deal!.id,
        description: `Imported reviewed sale — ${selectedVehicle.make} ${selectedVehicle.model} (VIN ${row.vin}); payment unrecorded.`,
        amount: row.sellingPrice,
        kind: "final",
        status: "issued",
        importMetadata: meta,
       }).returning();
       [invoice] = await tx.update(invoicesTable).set({
        invoiceNumber: `INV-${new Date().getUTCFullYear()}-${String(invoiceBase!.id).padStart(4, "0")}`,
       }).where(eq(invoicesTable.id, invoiceBase!.id)).returning();
      }
      const [delivery] = await tx.insert(deliveriesTable).values({
        dealerId,
         dealId: deal!.id,
         dealItemId: item!.id,
        dealItemUnit: 0,
        vehicleId: selectedVehicle.id,
        customerId: customer!.id,
        customerName: row.customerName,
        advisorUserId: row.advisorUserId,
        status: "in_progress",
        currentStep: "sales_order",
        steps: defaultDeliverySteps(),
        pdiItems: DEFAULT_PDI_ITEMS,
         invoiceId: invoice!.id,
        importMetadata: meta,
      }).returning();
       return {
         status: "created" as const, deliveryId: delivery!.id, leadId: lead!.id,
         dealId: deal!.id, invoiceId: invoice!.id, leadAction, dealAction, invoiceAction,
       };
    });
    outcomes.push({ row: row.row, ...result });
  }
    return outcomes;
  });
  res.status(201).json(ApplyDeliveryHistoryImportResponse.parse({
    batchKey: BATCH_KEY,
    created: outcomes.filter((outcome) => outcome.status === "created").length,
    unchanged: outcomes.filter((outcome) => outcome.status === "unchanged").length,
    outcomes,
  }));
});

export default router;