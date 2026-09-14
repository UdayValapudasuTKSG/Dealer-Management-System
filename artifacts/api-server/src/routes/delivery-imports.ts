import { Router, type IRouter } from "express";
import multer from "multer";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
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
  vehiclesTable,
  defaultDeliverySteps,
  DEFAULT_PDI_ITEMS,
} from "@workspace/db";
import {
  ApplyDeliveryHistoryImportResponse,
  PreviewDeliveryHistoryImportResponse,
} from "@workspace/api-zod";
import { activeDealerId, hasPermission } from "../middlewares/rbac";

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
    .array(z.object({ row: z.number().int().min(2), leadId: z.number().int().positive() }))
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
    ? await db.select({ id: vehiclesTable.id, vin: vehiclesTable.vin }).from(vehiclesTable).where(and(
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
  const vehicleByVin = new Map(vehicles.map((vehicle) => [normalizedVin(vehicle.vin ?? ""), vehicle.id]));
  const existingDeliveries = vins.length
    ? await db
        .select({
          vin: vehiclesTable.vin,
          customerName: deliveriesTable.customerName,
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
  const rows = parsed.rows.map((row) => {
    if (!advisorIds.has(row.advisorUserId)) errors.push(`CSV row ${row.row}: advisor ${row.advisorUserId} is not a member of this dealership.`);
    const candidates = candidatesByName.get(row.customerName.toLowerCase()) ?? [];
    if (candidates.length > 1)
      errors.push(`CSV row ${row.row}: multiple exact-name leads exist; choose a confirmed lead outside this importer before retrying.`);
    const matchingCustomers = customerMatchResults[row.row - 2] ?? [];
    const confirmedLeadCustomerId = candidates.length === 1 ? candidates[0]!.customerId : null;
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
    if (
      matchingCustomers.length &&
      !verifiedReplay &&
      (matchingCustomers.length !== 1 || matchingCustomers[0]!.id !== confirmedLeadCustomerId)
    )
      errors.push(`CSV row ${row.row}: an existing customer name or email match requires an explicit confirmed customer identity; this importer will not merge by name/email.`);
    const candidateLeadId = candidates.length === 1 ? candidates[0]!.id : null;
    if (row.candidateLeadId != null && candidateLeadId !== row.candidateLeadId)
      errors.push(`CSV row ${row.row}: declared lead candidate ${row.candidateLeadId} no longer exactly matches live dealership data.`);
    return {
      row: row.row,
      vin: row.vin,
      customerName: row.customerName,
      action: vehicleByVin.has(row.vin) ? "reuse_vehicle" : "create_vehicle",
      existingVehicleId: vehicleByVin.get(row.vin) ?? null,
      candidateLeadId,
      requiresLeadConfirmation: candidateLeadId != null,
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
    ["deals", "create"],
    ["finance", "create"],
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
    res.status(403).json({ error: "This reviewed import requires the active dealership General Manager and create permission for deliveries, inventory, customers, deals, and finance." });
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
    res.status(400).json({ error: "Each lead-confirmation row may appear only once." });
    return;
  }
  if (
    input.data.confirmations.some(
      (confirmation) =>
        check.rows.find((row) => row.row === confirmation.row)?.candidateLeadId !==
        confirmation.leadId,
    )
  ) {
    res.status(409).json({ error: "Every lead confirmation must match the live exact-name candidate in this review." });
    return;
  }
  for (const row of parsed.rows) {
    const candidate = check.rows.find((item) => item.row === row.row)?.candidateLeadId ?? null;
    if (candidate != null && confirmationByRow.get(row.row)?.leadId !== candidate) {
      res.status(409).json({ error: `CSV row ${row.row}: exact-name lead candidate ${candidate} must be explicitly confirmed before applying.` });
      return;
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
    const outcomes: { row: number; deliveryId: number; status: "created" | "unchanged" }[] = [];
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
      const [existing] = await tx.select({ id: deliveriesTable.id, customerName: deliveriesTable.customerName }).from(deliveriesTable)
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
        return { status: "unchanged" as const, deliveryId: existing.id };
      }
      const meta = importMetadata(row, input.data, batchFingerprint);
      const [vehicle] = await tx.select().from(vehiclesTable).where(and(
        eq(vehiclesTable.dealerId, dealerId),
        isNull(vehiclesTable.deletedAt),
        eq(sql<string>`upper(btrim(${vehiclesTable.vin}))`, row.vin),
      )).for("update");
      if (vehicle) {
        if (
          vehicle.status !== "available" ||
          vehicle.recallFlag ||
          vehicle.damageFlag ||
          (vehicle.holdUntil != null && vehicle.holdUntil > new Date())
        )
          throw new Error(`CSV row ${row.row}: existing VIN ${row.vin} is unavailable, held, sold, recalled, or damaged.`);
        const [booking] = await tx
          .select({ id: bookingsTable.id })
          .from(bookingsTable)
          .where(and(eq(bookingsTable.dealerId, dealerId), eq(bookingsTable.vehicleId, vehicle.id), eq(bookingsTable.status, "active")))
          .limit(1);
        const [activeDeal] = await tx
          .select({ id: dealsTable.id })
          .from(dealsTable)
          .where(and(eq(dealsTable.dealerId, dealerId), eq(dealsTable.vehicleId, vehicle.id), inArray(dealsTable.stage, ["desking", "finance", "committed"])))
          .limit(1);
        const [activeItem] = await tx
          .select({ id: dealItemsTable.id })
          .from(dealItemsTable)
          .innerJoin(dealsTable, eq(dealsTable.id, dealItemsTable.dealId))
          .where(and(eq(dealItemsTable.dealerId, dealerId), eq(dealItemsTable.vehicleId, vehicle.id), inArray(dealsTable.stage, ["desking", "finance", "committed"])))
          .limit(1);
        if (booking || activeDeal || activeItem)
          throw new Error(`CSV row ${row.row}: existing VIN ${row.vin} has an active reservation or deal allocation.`);
      }
      const selectedVehicle = vehicle
        ? (await tx.update(vehiclesTable).set({ status: "booked", importMetadata: meta }).where(eq(vehiclesTable.id, vehicle.id)).returning())[0]!
        : (await tx.insert(vehiclesTable).values({
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
      const confirmedLeadId = confirmed?.leadId ?? null;
      let customer: typeof customersTable.$inferSelect;
      if (confirmedLeadId != null) {
        const [lead] = await tx.select({ id: leadsTable.id, customerId: leadsTable.customerId }).from(leadsTable).where(and(
          eq(leadsTable.id, confirmedLeadId),
          eq(leadsTable.dealerId, dealerId),
          eq(sql<string>`lower(btrim(${leadsTable.name}))`, row.customerName.toLowerCase()),
        )).for("update");
        if (!lead) throw new Error(`Confirmed lead ${confirmedLeadId} no longer exactly matches this dealership/customer.`);
        if (lead.customerId != null) {
          const [linked] = await tx.select().from(customersTable).where(and(eq(customersTable.id, lead.customerId), eq(customersTable.dealerId, dealerId))).for("update");
          if (!linked || linked.name.trim().toLowerCase() !== row.customerName.toLowerCase())
            throw new Error(`CSV row ${row.row}: confirmed lead ${confirmedLeadId} has a different linked customer.`);
          customer = linked;
        } else {
          [customer] = await tx.insert(customersTable).values({
            dealerId, name: row.customerName, email: row.raw["Email"]?.trim() || null,
            phone: null, address: row.raw["Address"]?.trim() || null,
          }).returning();
          await tx.update(leadsTable).set({ customerId: customer!.id }).where(and(eq(leadsTable.id, lead.id), eq(leadsTable.dealerId, dealerId)));
        }
      } else {
        [customer] = await tx.insert(customersTable).values({
          dealerId, name: row.customerName, email: row.raw["Email"]?.trim() || null,
          phone: null, address: row.raw["Address"]?.trim() || null,
        }).returning();
      }
      const [deal] = await tx.insert(dealsTable).values({
        dealerId,
        customerId: customer!.id,
        leadId: confirmedLeadId,
        vehicleId: selectedVehicle.id,
        customerName: row.customerName,
        stage: "committed",
        vehiclePrice: row.sellingPrice,
        otdPrice: row.sellingPrice,
        depositPaid: false,
        salesAdvisor: row.raw["Advisor"],
        salesAdvisorUserId: row.advisorUserId,
      }).returning();
      const [item] = await tx.insert(dealItemsTable).values({
        dealerId,
        dealId: deal!.id,
        vehicleId: selectedVehicle.id,
        make: selectedVehicle.make,
        model: selectedVehicle.model,
        modelYear: selectedVehicle.year,
        variant: selectedVehicle.trim,
        color: selectedVehicle.exteriorColor,
        quantity: 1,
        position: 0,
        vehiclePrice: row.sellingPrice,
        total: row.sellingPrice,
        status: "allocated",
      }).returning();
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
      const [invoice] = await tx.update(invoicesTable).set({
        invoiceNumber: `INV-${new Date().getUTCFullYear()}-${String(invoiceBase!.id).padStart(4, "0")}`,
      }).where(eq(invoicesTable.id, invoiceBase!.id)).returning();
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
      return { status: "created" as const, deliveryId: delivery!.id };
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