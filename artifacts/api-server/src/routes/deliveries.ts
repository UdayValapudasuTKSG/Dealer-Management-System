import { getDealerPdfBranding } from "../lib/dealer-branding";
import { Router, type IRouter } from "express";
import PDFDocument from "pdfkit";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  deliveriesTable,
  dealsTable,
  leadsTable,
  dealersTable,
  vehiclesTable,
  customersTable,
  bookingsTable,
  invoicesTable,
  paymentsTable,
  usersTable,
  rolesTable,
  dealerUsersTable,
  timelineEventsTable,
  assetsTable,
  tasksTable,
  reviewsTable,
  documentsTable,
  serviceOrdersTable,
  DELIVERY_STEPS,
  DELIVERY_STEP_LABELS,
  type Delivery,
  type DeliveryStep,
  type DeliveryStepState,
  type PdiItem,
  normalizePdiItems,
  normalizeDeliverySteps,
} from "@workspace/db";
import {
  ListDeliveriesQueryParams,
  ListDeliveriesResponse,
  CreateDeliveryBody,
  CreateDeliveryResponse,
  GetDeliveryParams,
  GetDeliveryResponse,
  UpdateDeliveryParams,
  UpdateDeliveryBody,
  UpdateDeliveryResponse,
  AdvanceDeliveryParams,
  AdvanceDeliveryBody,
  AdvanceDeliveryResponse,
  UpdateDeliveryPdiParams,
  UpdateDeliveryPdiBody,
  UpdateDeliveryPdiResponse,
  GetDeliveryInvoicePdfParams,
  GetDeliveryHandoverPdfParams,
  ListDeliveryAdvisorsResponse,
} from "@workspace/api-zod";
import { ensureDeliveryForDeal } from "../lib/delivery";
import {
  buildHandoverVerification,
  handoverExpectedFor,
  type HandoverVerification,
} from "../lib/handover-verify";
import { buildHandoverPdf } from "../lib/document-pdfs";
import { buildWarrantyPdf } from "../lib/warranty-pdf";
import { enqueueEmail, notifyUser } from "../lib/email";
import {
  onDealStageChanged,
  onDeliveryAdvisorAssigned,
  onDeliveryCompleted,
} from "../lib/email-triggers";
import { ensureAccountForLead } from "../lib/accounts";
import { ensureFinalInvoiceForDeal } from "../lib/invoicing";
import { logger } from "../lib/logger";
import { activeDealerId } from "../middlewares/rbac";
import {
  notifyDeliveryReady,
  notifyDeliveredServiceHandoff,
  notifyFeedbackSurvey,
} from "../lib/notify-triggers";
import { usersWithPermission } from "../lib/notify-matrix";

const router: IRouter = Router();

/**
 * Adds N business days (Mon–Fri) to a date, evaluated in the dealership's
 * GMT-4 calendar so weekend boundaries land on the right local day.
 */
function addBusinessDays(from: Date, days: number): Date {
  const result = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    result.setTime(result.getTime() + 24 * 60 * 60 * 1000);
    // Local dealership day-of-week at GMT-4.
    const local = new Date(result.getTime() - 4 * 60 * 60 * 1000);
    const dow = local.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return result;
}

const money = (n: number) =>
  `GY$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

type Enriched = Delivery & {
  advisorName: string | null;
  vehicleLabel: string | null;
  unmet: string[];
  registrationStuck: boolean;
  handoverVerification: HandoverVerification | null;
};

const REGISTRATION_STUCK_MS = 72 * 60 * 60 * 1000;

function isRegistrationStuck(d: Delivery): boolean {
  return (
    d.registrationStatus === "submitted" &&
    !!d.registrationSubmittedAt &&
    Date.now() - d.registrationSubmittedAt.getTime() > REGISTRATION_STUCK_MS
  );
}

const pdiOk = (i: PdiItem) => i.status === "pass" || i.status === "waived";

/**
 * L7/L8 readiness: what is still blocking the CURRENT step from advancing,
 * computed purely from stored state (body-supplied values like the signature
 * name are validated at advance time). Powers both the 422 payload and the
 * readiness panel.
 */
async function computeUnmet(d: Delivery): Promise<string[]> {
  if (d.status === "completed") return [];
  const unmet: string[] = [];
  switch (d.currentStep as DeliveryStep) {
    case "pdi_checklist": {
      const failed = d.pdiItems.filter((i) => i.status === "fail");
      const open = d.pdiItems.filter((i) => !pdiOk(i) && i.status !== "fail");
      if (failed.length > 0)
        unmet.push(
          `PDI failed: ${failed.map((i) => i.label).join(", ")} — resolve the rectification work order${d.pdiWorkOrderId ? ` (#${d.pdiWorkOrderId})` : ""}, then mark the item(s) pass or waived`,
        );
      if (open.length > 0)
        unmet.push(
          `${open.length} PDI item(s) still pending — each must be marked pass or waived (with a reason)`,
        );
      break;
    }
    case "registration":
      if (!d.registrationNumber)
        unmet.push("Registration plate number not recorded");
      if (d.registrationStatus !== "issued")
        unmet.push(
          `Registration certificate not issued yet (currently "${d.registrationStatus}")`,
        );
      break;
    case "insurance":
      if (!d.insuranceDocId)
        unmet.push("Insurance cover note document not attached");
      break;
    case "warranty":
      if (!d.warrantySignatureData)
        unmet.push(
          "Customer signature on the warranty certificate is required — capture it on the signature pad",
        );
      break;
    case "delivery": {
      if (!d.deliveredAt)
        unmet.push("Actual handover date/time must be recorded");
      // Settlement guard: the vehicle never leaves with money outstanding.
      // The final invoice already nets reservation credit, trade-in and
      // financed amounts, so "paid" here means the customer balance is zero.
      // Void invoices are excluded (finance can void and reissue), and the
      // outstanding figure is the true remainder after applied payments.
      const [outstanding] = await db
        .select({
          due: sql<number>`coalesce(sum(${invoicesTable.amount} - coalesce(p.paid, 0)), 0)`,
        })
        .from(invoicesTable)
        .leftJoin(
          sql`lateral (select sum(amount) as paid from payments where payments.invoice_id = ${invoicesTable.id} and payments.dealer_id = ${invoicesTable.dealerId}) p`,
          sql`true`,
        )
        .where(
          and(
            eq(invoicesTable.dealId, d.dealId),
            eq(invoicesTable.dealerId, d.dealerId),
            eq(invoicesTable.kind, "final"),
            sql`${invoicesTable.status} not in ('paid', 'void')`,
          ),
        );
      if ((outstanding?.due ?? 0) > 0.005)
        unmet.push(
          `Settlement invoice not fully paid — GY$${(outstanding!.due).toLocaleString("en-US", { maximumFractionDigits: 0 })} outstanding must be received before handover`,
        );
      break;
    }
    case "signature": {
      if (d.handoverSheetDocId) {
        const [doc] = await db
          .select({ extractionStatus: documentsTable.extractionStatus })
          .from(documentsTable)
          .where(
            and(
              eq(documentsTable.id, d.handoverSheetDocId),
              eq(documentsTable.dealerId, d.dealerId),
            ),
          );
        // The uploaded sheet only satisfies the gate once an advisor has
        // ACCEPTED the OCR verification — every other status blocks.
        if (!doc) {
          unmet.push("Signed handover sheet document is missing — re-upload it");
        } else if (doc.extractionStatus !== "accepted") {
          unmet.push(
            doc.extractionStatus === "dismissed"
              ? "Handover sheet verification was dismissed — upload a corrected signed sheet"
              : doc.extractionStatus === "failed"
                ? "Handover sheet verification failed — upload a clearer scan or capture the signature pad instead"
                : "Signed handover sheet verification awaiting advisor review",
          );
        }
      } else if (!d.signatureName || !d.signatureData) {
        unmet.push(
          "Capture the customer signature (pad) or upload the signed handover sheet",
        );
      }
      break;
    }
    case "feedback":
      break;
  }
  return unmet;
}

async function handoverVerificationFor(
  d: Delivery,
): Promise<HandoverVerification | null> {
  if (!d.handoverSheetDocId) return null;
  const [doc] = await db
    .select({
      extractionStatus: documentsTable.extractionStatus,
      extraction: documentsTable.extraction,
    })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.id, d.handoverSheetDocId),
        eq(documentsTable.dealerId, d.dealerId),
      ),
    );
  if (!doc) return null;
  return buildHandoverVerification(doc, await handoverExpectedFor(d));
}

async function enrich(rows: Delivery[], dealerId: number): Promise<Enriched[]> {
  const advisorIds = [
    ...new Set(rows.map((r) => r.advisorUserId).filter((x): x is number => !!x)),
  ];
  const vehicleIds = [...new Set(rows.map((r) => r.vehicleId))];
  const advisors = advisorIds.length
    ? await db
        .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
        .from(usersTable)
        .innerJoin(
          dealerUsersTable,
          and(
            eq(dealerUsersTable.userId, usersTable.id),
            eq(dealerUsersTable.dealerId, dealerId),
          ),
        )
    : [];
  const vehicles = vehicleIds.length
    ? await db
        .select({
          id: vehiclesTable.id,
          year: vehiclesTable.year,
          make: vehiclesTable.make,
          model: vehiclesTable.model,
          vin: vehiclesTable.vin,
        })
        .from(vehiclesTable)
        .where(eq(vehiclesTable.dealerId, dealerId))
    : [];
  const dealIds = [...new Set(rows.map((r) => r.dealId))];
  const deals = dealIds.length
    ? await db
        .select({
          id: dealsTable.id,
          salesAdvisor: dealsTable.salesAdvisor,
          salesAdvisorUserId: dealsTable.salesAdvisorUserId,
        })
        .from(dealsTable)
        .where(
          and(eq(dealsTable.dealerId, dealerId), inArray(dealsTable.id, dealIds)),
        )
    : [];
  return Promise.all(
    rows.map(async (r) => {
      const a = advisors.find((x) => x.id === r.advisorUserId);
      const v = vehicles.find((x) => x.id === r.vehicleId);
      const deal = deals.find((x) => x.id === r.dealId);
      return {
        ...r,
        advisorName: a ? (a.name ?? a.email ?? `User #${a.id}`) : null,
        salesAdvisorUserId: deal?.salesAdvisorUserId ?? null,
        salesAdvisorName: deal?.salesAdvisor ?? null,
        vehicleLabel: v
          ? `${v.year} ${v.make} ${v.model}${v.vin ? ` · ${v.vin}` : ""}`
          : null,
        unmet: await computeUnmet(r),
        registrationStuck: isRegistrationStuck(r),
        handoverVerification: await handoverVerificationFor(r),
      };
    }),
  );
}

async function loadDelivery(
  id: number,
  dealerId: number,
): Promise<Delivery | undefined> {
  const [row] = await db
    .select()
    .from(deliveriesTable)
    .where(and(eq(deliveriesTable.id, id), eq(deliveriesTable.dealerId, dealerId)));
  return row
    ? {
        ...row,
        pdiItems: normalizePdiItems(row.pdiItems),
        steps: normalizeRowSteps(row),
      }
    : row;
}

/**
 * Splice steps added after a delivery row was created (e.g. warranty) into
 * its persisted steps array. Steps the workflow has already moved past are
 * marked skipped so old deliveries don't show a forever-pending step.
 */
function normalizeRowSteps(row: Delivery): DeliveryStepState[] {
  const currentIdx = DELIVERY_STEPS.indexOf(row.currentStep as DeliveryStep);
  const had = new Set(row.steps.map((s) => s.key));
  return normalizeDeliverySteps(row.steps).map((s) =>
    !had.has(s.key) &&
    s.status === "pending" &&
    (row.status === "completed" || DELIVERY_STEPS.indexOf(s.key) < currentIdx)
      ? {
          ...s,
          status: "skipped" as const,
          note: "Step introduced after this delivery had passed this stage",
        }
      : s,
  );
}

router.get("/deliveries", async (req, res): Promise<void> => {
  const query = ListDeliveriesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const filters = [eq(deliveriesTable.dealerId, activeDealerId(res))];
  if (query.data.status)
    filters.push(eq(deliveriesTable.status, query.data.status));
  if (query.data.mine === 1 && res.locals.user?.id)
    filters.push(eq(deliveriesTable.advisorUserId, res.locals.user.id));

  const rows = (
    await db
      .select()
      .from(deliveriesTable)
      .where(and(...filters))
      .orderBy(desc(deliveriesTable.createdAt))
  ).map((r) => ({
    ...r,
    pdiItems: normalizePdiItems(r.pdiItems),
    steps: normalizeRowSteps(r),
  }));

  res.json(ListDeliveriesResponse.parse(await enrich(rows, activeDealerId(res))));
});

router.post("/deliveries", async (req, res): Promise<void> => {
  const parsed = CreateDeliveryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [deal] = await db
    .select({ id: dealsTable.id })
    .from(dealsTable)
    .where(and(eq(dealsTable.id, parsed.data.dealId), eq(dealsTable.dealerId, dealerId)));
  if (!deal) {
    res.status(404).json({ error: "Deal not found or has no vehicle" });
    return;
  }
  const [existing] = await db
    .select({ id: deliveriesTable.id })
    .from(deliveriesTable)
    .where(
      and(
        eq(deliveriesTable.dealId, parsed.data.dealId),
        eq(deliveriesTable.dealerId, dealerId),
      ),
    );
  if (existing) {
    res.status(409).json({ error: "A delivery already exists for this deal" });
    return;
  }
  const delivery = await ensureDeliveryForDeal(parsed.data.dealId, {
    advisorUserId: parsed.data.advisorUserId ?? null,
    cause: "Delivery started manually",
  });
  if (!delivery) {
    res.status(404).json({ error: "Deal not found or has no vehicle" });
    return;
  }
  res.status(201).json(CreateDeliveryResponse.parse((await enrich([delivery], activeDealerId(res)))[0]));
});

router.get("/deliveries/:id", async (req, res): Promise<void> => {
  const params = GetDeliveryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await loadDelivery(params.data.id, activeDealerId(res));
  if (!row) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  // L7 flag: registration sitting at "submitted" for >72h leaves an agent
  // timeline receipt once so the delay is visible on the customer journey.
  if (isRegistrationStuck(row)) {
    try {
      const [existing] = await db
        .select({ id: timelineEventsTable.id })
        .from(timelineEventsTable)
        .where(
          and(
            eq(timelineEventsTable.dealerId, row.dealerId),
            eq(timelineEventsTable.kind, "delivery_registration_stuck"),
            eq(timelineEventsTable.refType, "delivery"),
            eq(timelineEventsTable.refId, row.id),
          ),
        );
      if (!existing) {
        await db.insert(timelineEventsTable).values({
          dealerId: row.dealerId,
          customerId: row.customerId ?? null,
          domain: "delivery",
          kind: "delivery_registration_stuck",
          title: "Registration submission stuck for more than 72 hours",
          detail: `Registration for delivery #${row.id} was submitted ${row.registrationSubmittedAt?.toISOString() ?? ""} and has not been issued — follow up with the licensing office.`,
          actor: "AURA orchestration",
          isAgent: true,
          cause: `Delivery #${row.id} registration monitoring`,
          refType: "delivery",
          refId: row.id,
        });
      }
    } catch (err) {
      logger.error({ err, deliveryId: row.id }, "stuck receipt failed");
    }
  }
  res.json(GetDeliveryResponse.parse((await enrich([row], activeDealerId(res)))[0]));
});

router.patch("/deliveries/:id", async (req, res): Promise<void> => {
  const params = UpdateDeliveryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateDeliveryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const current = await loadDelivery(params.data.id, activeDealerId(res));
  if (!current) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  const patch: Partial<Delivery> = {};
  if ("advisorUserId" in (req.body ?? {}))
    patch.advisorUserId = parsed.data.advisorUserId ?? null;
  if (parsed.data.registrationNumber !== undefined)
    patch.registrationNumber = parsed.data.registrationNumber;
  if (parsed.data.insurancePolicy !== undefined)
    patch.insurancePolicy = parsed.data.insurancePolicy;
  if (parsed.data.insuranceProvider !== undefined)
    patch.insuranceProvider = parsed.data.insuranceProvider;
  if (
    parsed.data.registrationStatus !== undefined &&
    parsed.data.registrationStatus !== current.registrationStatus
  ) {
    patch.registrationStatus = parsed.data.registrationStatus;
    // Stamp submission time on the pending → submitted hop (basis of the
    // >72h stuck flag); reset it when pulled back to pending.
    if (parsed.data.registrationStatus === "submitted")
      patch.registrationSubmittedAt = new Date();
    if (parsed.data.registrationStatus === "pending")
      patch.registrationSubmittedAt = null;
  }
  if (Object.keys(patch).length === 0) {
    res.json(
      UpdateDeliveryResponse.parse(
        (await enrich([current], activeDealerId(res)))[0],
      ),
    );
    return;
  }
  const [row] = await db
    .update(deliveriesTable)
    .set(patch)
    .where(
      and(
        eq(deliveriesTable.id, params.data.id),
        eq(deliveriesTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  if (parsed.data.advisorUserId) {
    void notifyUser({
      userId: parsed.data.advisorUserId,
      dealerId: row.dealerId,
      type: "system",
      title: `Delivery #${row.id} assigned to you`,
      body: `${row.customerName ?? "A customer"} is waiting on the delivery workflow.`,
      link: "/deliveries",
    }).catch((err) =>
      logger.error({ err, deliveryId: row.id }, "advisor notification failed"),
    );
    // Introduce the advisor to the customer (deduped per delivery+advisor,
    // so re-saving the same advisor never re-sends).
    if (parsed.data.advisorUserId !== current.advisorUserId) {
      // Fall back to the deal's customer when the delivery row hasn't been
      // linked yet (that linkage is otherwise only reconciled at completion).
      let recipientCustomerId = row.customerId;
      if (!recipientCustomerId) {
        const [deal] = await db
          .select({ customerId: dealsTable.customerId })
          .from(dealsTable)
          .where(
            and(
              eq(dealsTable.id, row.dealId),
              eq(dealsTable.dealerId, row.dealerId),
            ),
          );
        recipientCustomerId = deal?.customerId ?? null;
      }
      onDeliveryAdvisorAssigned({
        dealerId: row.dealerId,
        deliveryId: row.id,
        customerId: recipientCustomerId,
        customerName: row.customerName,
        advisorUserId: parsed.data.advisorUserId,
        vehicleLabel: await vehicleLabelFor(row.vehicleId, row.dealerId),
      });
    }
  }
  res.json(UpdateDeliveryResponse.parse((await enrich([row], activeDealerId(res)))[0]));
});

async function customerEmailFor(
  delivery: Delivery,
): Promise<{ email: string | null; name: string }> {
  if (!delivery.customerId)
    return { email: null, name: delivery.customerName ?? "there" };
  const [c] = await db
    .select({ email: customersTable.email, name: customersTable.name })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, delivery.customerId),
        eq(customersTable.dealerId, delivery.dealerId),
      ),
    );
  return {
    email: c?.email ?? null,
    name: c?.name ?? delivery.customerName ?? "there",
  };
}

async function vehicleLabelFor(
  vehicleId: number,
  dealerId: number,
): Promise<string> {
  const [v] = await db
    .select({
      year: vehiclesTable.year,
      make: vehiclesTable.make,
      model: vehiclesTable.model,
    })
    .from(vehiclesTable)
    .where(and(eq(vehiclesTable.id, vehicleId), eq(vehiclesTable.dealerId, dealerId)));
  return v ? `${v.year} ${v.make} ${v.model}` : `Vehicle #${vehicleId}`;
}

router.post("/deliveries/:id/advance", async (req, res): Promise<void> => {
  const params = AdvanceDeliveryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = AdvanceDeliveryBody.safeParse(req.body);
  if (!parsed.success) {
    const registrationIssue = parsed.error.issues.some((i) =>
      i.path.includes("registrationNumber"),
    );
    res.status(400).json({
      error: registrationIssue
        ? "Registration number must be 3 uppercase letters followed by 1–4 digits (e.g. PAB1234)"
        : parsed.error.message,
    });
    return;
  }
  const delivery = await loadDelivery(params.data.id, activeDealerId(res));
  if (!delivery) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  if (delivery.status === "completed") {
    res
      .status(422)
      .json({ error: "Delivery is already completed", unmet: [] });
    return;
  }
  const step = parsed.data.step as DeliveryStep;
  if (step !== delivery.currentStep) {
    res.status(422).json({
      error: `Steps must be completed in order — next step is "${DELIVERY_STEP_LABELS[delivery.currentStep as DeliveryStep]}"`,
      unmet: [],
    });
    return;
  }

  const extra: Partial<Delivery> = {};

  // Body-supplied values land on the row BEFORE gating so the unmet list is
  // evaluated against what the advisor just provided.
  const gated: Delivery = { ...delivery };
  if (parsed.data.registrationNumber) {
    extra.registrationNumber = parsed.data.registrationNumber;
    gated.registrationNumber = parsed.data.registrationNumber;
  }
  if (parsed.data.deliveredAt) {
    extra.deliveredAt = new Date(parsed.data.deliveredAt);
    gated.deliveredAt = extra.deliveredAt;
  }
  if (parsed.data.signatureName) gated.signatureName = parsed.data.signatureName;
  if (parsed.data.signatureData) gated.signatureData = parsed.data.signatureData;
  // The warranty step reuses the shared signature body fields but persists
  // to its own columns — the later Customer Signature step stays separate.
  if (step === "warranty") {
    if (parsed.data.signatureName)
      gated.warrantySignatureName = parsed.data.signatureName;
    if (parsed.data.signatureData)
      gated.warrantySignatureData = parsed.data.signatureData;
  }

  // Steps are OPTIONAL: `skip: true` bypasses the readiness gates and marks
  // the step skipped so the workflow can move on without it.
  const skipping = parsed.data.skip === true;

  // L7/L8 readiness gates — a single 422 shape { error, unmet[] }.
  if (!skipping) {
    const unmet = await computeUnmet(gated);
    if (step === "signature" && !parsed.data.signatureName) {
      unmet.push("Customer signature name is required");
    }
    if (step === "feedback" && !parsed.data.feedbackRating) {
      unmet.push("A feedback rating (1–5) is required");
    }
    if (unmet.length > 0) {
      res.status(422).json({
        error: `${DELIVERY_STEP_LABELS[step]} cannot be completed yet`,
        unmet,
      });
      return;
    }
  }

  // Per-step side data (side effects only run for genuinely completed steps —
  // a skipped step must not create invoices or send scheduling emails).
  switch (skipping ? ("__skipped__" as DeliveryStep) : step) {
    case "insurance":
      if (parsed.data.insurancePolicy)
        extra.insurancePolicy = parsed.data.insurancePolicy;
      if (parsed.data.insuranceProvider)
        extra.insuranceProvider = parsed.data.insuranceProvider;
      break;
    case "invoice": {
      if (!delivery.invoiceId) {
        const [deal] = await db
          .select()
          .from(dealsTable)
          .where(
            and(
              eq(dealsTable.id, delivery.dealId),
              eq(dealsTable.dealerId, delivery.dealerId),
            ),
          );
        // Reuse the settlement invoice generated at commit (or create it via
        // the shared path) instead of minting a duplicate here — this also
        // sends the customer their "invoice generated" email with the PDF.
        const invoice = deal ? await ensureFinalInvoiceForDeal(deal) : null;
        if (invoice) extra.invoiceId = invoice.id;
      }
      break;
    }
    case "appointment": {
      const at = parsed.data.appointmentAt
        ? new Date(parsed.data.appointmentAt)
        : delivery.appointmentAt;
      if (!at) {
        res.status(422).json({
          error: "An appointment date/time is required",
          unmet: ["An appointment date/time is required"],
        });
        return;
      }
      extra.appointmentAt = at;
      void (async () => {
        const { email, name } = await customerEmailFor(delivery);
        if (!email) return;
        await enqueueEmail({
          template: "delivery_schedule",
          to: email,
          dealerId: delivery.dealerId,
          customerId: delivery.customerId,
          data: {
            name,
            vehicle: await vehicleLabelFor(delivery.vehicleId, delivery.dealerId),
            date: at.toLocaleString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }),
          },
        });
      })().catch((err) =>
        logger.error({ err }, "delivery schedule email failed"),
      );
      // R6.2 #12 Delivery Ready → delivery + sales advisors (In-App + Email):
      // invoice + appointment are both cleared once this step completes.
      void (async () => {
        const advisorUserIds = await usersWithPermission(
          delivery.dealerId,
          "deliveries",
          ["edit", "admin"],
        );
        notifyDeliveryReady({
          dealerId: delivery.dealerId,
          deliveryId: delivery.id,
          customerName: delivery.customerName ?? "Customer",
          vehicle: await vehicleLabelFor(delivery.vehicleId, delivery.dealerId),
          advisorUserIds,
        });
      })().catch((err) => logger.error({ err }, "delivery-ready notify failed"));
      break;
    }
    case "warranty":
      if (parsed.data.signatureName)
        extra.warrantySignatureName = parsed.data.signatureName;
      if (parsed.data.signatureData)
        extra.warrantySignatureData = parsed.data.signatureData;
      break;
    case "signature":
      if (parsed.data.signatureName)
        extra.signatureName = parsed.data.signatureName;
      if (parsed.data.signatureData)
        extra.signatureData = parsed.data.signatureData;
      break;
    case "feedback":
      if (parsed.data.feedbackRating)
        extra.feedbackRating = parsed.data.feedbackRating;
      if (parsed.data.feedbackComment)
        extra.feedbackComment = parsed.data.feedbackComment;
      break;
  }

  const actor =
    res.locals.user?.name ?? res.locals.user?.email ?? "Delivery desk";
  const now = new Date().toISOString();
  const steps: DeliveryStepState[] = delivery.steps.map((s) =>
    s.key === step
      ? {
          ...s,
          status: skipping ? "skipped" : "completed",
          note: parsed.data.note ?? s.note ?? null,
          completedAt: now,
          completedBy: actor,
        }
      : s,
  );
  const idx = DELIVERY_STEPS.indexOf(step);
  const isLast = idx === DELIVERY_STEPS.length - 1;
  const nextStep = isLast ? step : DELIVERY_STEPS[idx + 1]!;

  const [updated] = await db
    .update(deliveriesTable)
    .set({
      ...extra,
      steps,
      currentStep: nextStep,
      ...(isLast ? { status: "completed", completedAt: new Date() } : {}),
    })
    .where(
      and(
        eq(deliveriesTable.id, delivery.id),
        eq(deliveriesTable.dealerId, delivery.dealerId),
      ),
    )
    .returning();

  // Timeline receipt for every completed step.
  try {
    await db.insert(timelineEventsTable).values({
      dealerId: delivery.dealerId,
      customerId: delivery.customerId ?? null,
      domain: "delivery",
      kind: `delivery_${step}`,
      title: `${DELIVERY_STEP_LABELS[step]} completed`,
      detail: parsed.data.note ?? null,
      actor,
      isAgent: false,
      cause: `Delivery #${delivery.id} — deal #${delivery.dealId}`,
      refType: "delivery",
      refId: delivery.id,
    });
  } catch (err) {
    logger.error({ err, deliveryId: delivery.id }, "step receipt failed");
  }

  // The CSAT rating becomes a first-class review record.
  if (step === "feedback" && parsed.data.feedbackRating) {
    try {
      const [customer] = delivery.customerId
        ? await db
            .select()
            .from(customersTable)
            .where(
              and(
                eq(customersTable.id, delivery.customerId),
                eq(customersTable.dealerId, delivery.dealerId),
              ),
            )
        : [];
      const [vehicle] = await db
        .select()
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, delivery.vehicleId),
            eq(vehiclesTable.dealerId, delivery.dealerId),
          ),
        );
      await db.insert(reviewsTable).values({
        dealerId: delivery.dealerId,
        customerId: delivery.customerId ?? null,
        customerName: customer?.name ?? null,
        source: "delivery_csat",
        rating: parsed.data.feedbackRating,
        comment: parsed.data.feedbackComment ?? null,
        refType: "delivery",
        refId: delivery.id,
        vehicleLabel: vehicle
          ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
          : null,
        capturedBy: actor,
      });
    } catch (err) {
      logger.error({ err, deliveryId: delivery.id }, "csat review insert failed");
    }
  }

  // Handover side effects on the final step.
  if (isLast) {
    await db
      .update(vehiclesTable)
      .set({ status: "delivered" })
      .where(
        and(
          eq(vehiclesTable.id, delivery.vehicleId),
          eq(vehiclesTable.dealerId, delivery.dealerId),
        ),
      );
    if (delivery.bookingId) {
      await db
        .update(bookingsTable)
        .set({ status: "converted" })
        .where(
          and(
            eq(bookingsTable.id, delivery.bookingId),
            eq(bookingsTable.dealerId, delivery.dealerId),
          ),
        );
    }
    const [before] = await db
      .select()
      .from(dealsTable)
      .where(
        and(
          eq(dealsTable.id, delivery.dealId),
          eq(dealsTable.dealerId, delivery.dealerId),
        ),
      );
    // The garage asset and the completion email both need a customer account.
    // Some deliveries reach completion without one (deal was created before
    // the lead was promoted) — resolve it now: deal's customer, else promote
    // the lead into an account, and backfill delivery + deal so downstream
    // reads (assets, emails, portal) all agree.
    if (!delivery.customerId) {
      try {
        let resolvedCustomerId: number | null = before?.customerId ?? null;
        if (!resolvedCustomerId && before?.leadId) {
          const [lead] = await db
            .select()
            .from(leadsTable)
            .where(
              and(
                eq(leadsTable.id, before.leadId),
                eq(leadsTable.dealerId, delivery.dealerId),
              ),
            );
          if (lead) resolvedCustomerId = await ensureAccountForLead(lead, "reservation");
        }
        if (resolvedCustomerId) {
          delivery.customerId = resolvedCustomerId;
          await db
            .update(deliveriesTable)
            .set({ customerId: resolvedCustomerId })
            .where(
              and(
                eq(deliveriesTable.id, delivery.id),
                eq(deliveriesTable.dealerId, delivery.dealerId),
              ),
            );
          if (before && !before.customerId) {
            await db
              .update(dealsTable)
              .set({ customerId: resolvedCustomerId })
              .where(
                and(
                  eq(dealsTable.id, delivery.dealId),
                  eq(dealsTable.dealerId, delivery.dealerId),
                ),
              );
          }
        }
      } catch (err) {
        logger.error(
          { err, deliveryId: delivery.id },
          "customer resolution at delivery completion failed",
        );
      }
    }
    if (before && before.stage !== "delivered") {
      const [after] = await db
        .update(dealsTable)
        .set({ stage: "delivered" })
        .where(
          and(
            eq(dealsTable.id, delivery.dealId),
            eq(dealsTable.dealerId, delivery.dealerId),
          ),
        )
        .returning();
      if (after) onDealStageChanged(before, after);
    }
    // Handover celebration email (deduped per delivery).
    onDeliveryCompleted({
      dealerId: delivery.dealerId,
      deliveryId: delivery.id,
      customerId: delivery.customerId,
      customerName: delivery.customerName,
      vehicleLabel: await vehicleLabelFor(delivery.vehicleId, delivery.dealerId),
    });
    // Lifetime Asset: the delivered vehicle joins the account's garage and is
    // handed off to a Service Advisor for the ownership phase.
    if (delivery.customerId) {
      try {
        // Idempotent on the delivery itself: a retried completion can never
        // mint a second asset row for the same delivery.
        const [existingAsset] = await db
          .select({ id: assetsTable.id })
          .from(assetsTable)
          .where(
            and(
              eq(assetsTable.deliveryId, delivery.id),
              eq(assetsTable.dealerId, delivery.dealerId),
            ),
          );
        if (!existingAsset) {
          // Any previous owner's active asset row for this vehicle is closed out.
          await db
            .update(assetsTable)
            .set({ status: "transferred" })
            .where(
              and(
                eq(assetsTable.vehicleId, delivery.vehicleId),
                eq(assetsTable.dealerId, delivery.dealerId),
                eq(assetsTable.status, "active"),
              ),
            );

          // Division-scoped round robin: prefer Service Advisors in the
          // deal's division (oldest lastLeadAssignedAt first, never-assigned
          // leading), falling back to any active Service Advisor.
          const [deal] = await db
            .select({ divisionId: dealsTable.divisionId })
            .from(dealsTable)
            .where(
              and(
                eq(dealsTable.id, delivery.dealId),
                eq(dealsTable.dealerId, delivery.dealerId),
              ),
            );
          const advisorPool = (divisionId: number | null) =>
            db
              .select({
                id: usersTable.id,
                name: usersTable.name,
                email: usersTable.email,
                memberId: dealerUsersTable.id,
              })
              .from(usersTable)
              .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
              .innerJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
              .where(
                and(
                  eq(dealerUsersTable.dealerId, delivery.dealerId),
                  eq(rolesTable.name, "Service Advisor"),
                  eq(usersTable.status, "active"),
                  ...(divisionId != null
                    ? [eq(dealerUsersTable.divisionId, divisionId)]
                    : []),
                ),
              )
              .orderBy(
                sql`${dealerUsersTable.lastLeadAssignedAt} asc nulls first`,
                asc(dealerUsersTable.id),
              )
              .limit(1);
          let [serviceAdvisor] = deal?.divisionId
            ? await advisorPool(deal.divisionId)
            : [];
          if (!serviceAdvisor) [serviceAdvisor] = await advisorPool(null);
          if (serviceAdvisor) {
            await db
              .update(dealerUsersTable)
              .set({ lastLeadAssignedAt: new Date() })
              .where(eq(dealerUsersTable.id, serviceAdvisor.memberId));
          }

          const [asset] = await db
            .insert(assetsTable)
            .values({
              dealerId: delivery.dealerId,
              accountId: delivery.customerId,
              vehicleId: delivery.vehicleId,
              dealId: delivery.dealId,
              deliveryId: delivery.id,
              deliveredAt: delivery.deliveredAt ?? new Date(),
              serviceAdvisorUserId: serviceAdvisor?.id ?? null,
              status: "active",
            })
            .returning();

          // Lifetime value: the delivered vehicle's price joins the owner's
          // running total (same basis as the batch recompute: sum of asset
          // vehicle prices). Guarded by the existingAsset check above, so a
          // retried completion never double-counts.
          const [pricedVehicle] = await db
            .select({ price: vehiclesTable.price })
            .from(vehiclesTable)
            .where(
              and(
                eq(vehiclesTable.id, delivery.vehicleId),
                eq(vehiclesTable.dealerId, delivery.dealerId),
              ),
            );
          if (pricedVehicle?.price) {
            await db
              .update(customersTable)
              .set({
                lifetimeValue: sql`${customersTable.lifetimeValue} + ${pricedVehicle.price}`,
              })
              .where(
                and(
                  eq(customersTable.id, delivery.customerId),
                  eq(customersTable.dealerId, delivery.dealerId),
                ),
              );
          }

          const label = await vehicleLabelFor(delivery.vehicleId, delivery.dealerId);
          await db.insert(timelineEventsTable).values({
            dealerId: delivery.dealerId,
            customerId: delivery.customerId,
            domain: "delivery",
            kind: "asset_created",
            title: `${label ?? "Vehicle"} added to the garage`,
            detail: serviceAdvisor
              ? `Ownership handed off to Service Advisor ${serviceAdvisor.name ?? serviceAdvisor.email ?? `#${serviceAdvisor.id}`} for the lifetime relationship.`
              : "Vehicle recorded as a lifetime asset. No Service Advisor is configured yet — assign one for the ownership phase.",
            actor: "AURA orchestration",
            isAgent: true,
            cause: `Delivery #${delivery.id} completed`,
            refType: "asset",
            refId: asset?.id ?? null,
          });

          // R6.2 #13 Delivered → service handoff (In-App + Email), keyed on
          // the asset so a retried completion never double-notifies.
          if (asset) {
            notifyDeliveredServiceHandoff({
              dealerId: delivery.dealerId,
              assetId: asset.id,
              customerName: delivery.customerName ?? "the customer",
              vehicle: label ?? `Vehicle #${delivery.vehicleId}`,
              serviceAdvisorUserId: serviceAdvisor?.id ?? null,
            });
          }

          if (serviceAdvisor) {
            // Ownership-phase kickoff: the advisor calls the customer within
            // 5 business days of delivery (GMT-4 business calendar).
            const introDue = addBusinessDays(
              delivery.deliveredAt ?? new Date(),
              5,
            );
            await db.insert(tasksTable).values({
              dealerId: delivery.dealerId,
              title: `Intro call — ${delivery.customerName ?? `customer #${delivery.customerId}`}`,
              description: `Welcome ${delivery.customerName ?? "the customer"} to the ownership phase for ${label ?? `vehicle #${delivery.vehicleId}`}: introduce yourself as their Service Advisor, confirm first-service expectations, and log any concerns.`,
              assigneeUserId: serviceAdvisor.id,
              dueDate: introDue.toISOString().slice(0, 10),
              dueAt: introDue,
              kind: "manual",
              priority: "normal",
              status: "open",
            });
          }
        }
      } catch (err) {
        logger.error({ err, deliveryId: delivery.id }, "asset creation failed");
      }
    }

    // R6.2 #16 Feedback survey → customer (WhatsApp + Email), keyed on the
    // delivery (replaces the old single-channel feedback_request email).
    void (async () => {
      const [customer] = delivery.customerId
        ? await db
            .select({
              name: customersTable.name,
              email: customersTable.email,
              phone: customersTable.phone,
            })
            .from(customersTable)
            .where(
              and(
                eq(customersTable.id, delivery.customerId),
                eq(customersTable.dealerId, delivery.dealerId),
              ),
            )
        : [];
      notifyFeedbackSurvey({
        dealerId: delivery.dealerId,
        entityType: "delivery",
        entityId: delivery.id,
        customerId: delivery.customerId,
        customerName: customer?.name ?? delivery.customerName ?? "Customer",
        customerEmail: customer?.email ?? null,
        customerPhone: customer?.phone ?? null,
        vehicle: await vehicleLabelFor(delivery.vehicleId, delivery.dealerId),
      });
    })().catch((err) => logger.error({ err }, "feedback survey notify failed"));
  }

  res.json(AdvanceDeliveryResponse.parse((await enrich([updated!], activeDealerId(res)))[0]));
});

router.patch("/deliveries/:id/pdi", async (req, res): Promise<void> => {
  const params = UpdateDeliveryPdiParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateDeliveryPdiBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // L7 tri-state guard: a waiver is only valid with a recorded reason.
  const badWaiver = parsed.data.items.find(
    (i) => i.status === "waived" && !i.waiveReason?.trim(),
  );
  if (badWaiver) {
    res.status(400).json({
      error: `"${badWaiver.label}" is waived without a reason — a waive reason is required`,
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const delivery = await loadDelivery(params.data.id, dealerId);
  if (!delivery) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  // The signed PDI is part of the handover record — once the customer has
  // signed, reopening the checklist would falsify it.
  const signatureDone = delivery.steps.some(
    (s) => s.key === "signature" && s.status === "completed",
  );
  if (signatureDone) {
    res.status(422).json({
      error: "The customer has already signed — the PDI checklist is locked",
    });
    return;
  }

  const patch: Partial<Delivery> = { pdiItems: parsed.data.items };
  const failed = parsed.data.items.filter((i) => i.status === "fail");

  // L7: a failed PDI item spins up ONE rectification work order in Service.
  if (failed.length > 0 && !delivery.pdiWorkOrderId) {
    const vehicleLabel = await vehicleLabelFor(delivery.vehicleId, dealerId);
    const [workOrder] = await db
      .insert(serviceOrdersTable)
      .values({
        dealerId,
        customerId: delivery.customerId ?? null,
        customerName: delivery.customerName ?? null,
        vehicleInfo: vehicleLabel,
        type: "repair",
        status: "open",
        scheduledDate: new Date().toISOString().slice(0, 10),
        complaint: `PDI rectification for delivery #${delivery.id} — failed: ${failed.map((i) => i.label).join(", ")}`,
        jobs: failed.map((i) => `Rectify: ${i.label}${i.note ? ` (${i.note})` : ""}`),
      })
      .returning();
    patch.pdiWorkOrderId = workOrder?.id ?? null;
    if (workOrder) {
      try {
        await db.insert(timelineEventsTable).values({
          dealerId,
          customerId: delivery.customerId ?? null,
          domain: "delivery",
          kind: "pdi_rectification_opened",
          title: `PDI failure — rectification work order #${workOrder.id} opened`,
          detail: `Failed item(s): ${failed.map((i) => i.label).join(", ")}. Delivery is blocked until each is marked pass or waived.`,
          actor: "AURA orchestration",
          isAgent: true,
          cause: `PDI checklist on delivery #${delivery.id}`,
          refType: "service_order",
          refId: workOrder.id,
        });
      } catch (err) {
        logger.error({ err, deliveryId: delivery.id }, "pdi receipt failed");
      }
    }
  }

  const [row] = await db
    .update(deliveriesTable)
    .set(patch)
    .where(
      and(
        eq(deliveriesTable.id, params.data.id),
        eq(deliveriesTable.dealerId, dealerId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  res.json(UpdateDeliveryPdiResponse.parse((await enrich([row], dealerId))[0]));
});

router.get("/deliveries/:id/invoice.pdf", async (req, res): Promise<void> => {
  const params = GetDeliveryInvoicePdfParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const delivery = await loadDelivery(params.data.id, activeDealerId(res));
  if (!delivery) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  if (!delivery.invoiceId) {
    res.status(404).json({ error: "Invoice has not been generated yet" });
    return;
  }
  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.id, delivery.invoiceId),
        eq(invoicesTable.dealerId, delivery.dealerId),
      ),
    );
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, delivery.vehicleId),
        eq(vehiclesTable.dealerId, delivery.dealerId),
      ),
    );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${invoice.invoiceNumber}.pdf"`,
  );

  const doc = new PDFDocument({ size: "A4", margin: 54 });
  doc.pipe(res);

  // White-label header: GM-configured logo + brand name, AURA fallback.
  const branding = await getDealerPdfBranding(delivery.dealerId);
  if (branding.displayName) {
    if (branding.logo) {
      try {
        doc.image(branding.logo, 54, doc.y, { fit: [140, 48] });
        doc.moveDown(0.4);
        doc.y = Math.max(doc.y, 54 + 52);
      } catch {
        /* unreadable logo bytes — name-only header */
      }
    }
    doc
      .fillColor("#111111")
      .fontSize(22)
      .font("Helvetica-Bold")
      .text(branding.displayName);
  } else {
    doc
      .fillColor("#b30f16")
      .fontSize(26)
      .font("Helvetica-Bold")
      .text("AURA", { continued: true })
      .fillColor("#111111")
      .text(" Dealership OS");
  }
  doc
    .fontSize(10)
    .fillColor("#555555")
    .font("Helvetica")
    .text("Vehicle Delivery Invoice");
  doc.moveDown(1.5);

  doc
    .fillColor("#111111")
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(`Invoice ${invoice.invoiceNumber}`);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#555555")
    .text(`Issued ${invoice.createdAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`)
    .text(`Status: ${invoice.status.toUpperCase()}`);
  doc.moveDown(1);

  doc.font("Helvetica-Bold").fillColor("#111111").text("Billed to");
  doc
    .font("Helvetica")
    .fillColor("#333333")
    .text(invoice.customerName ?? delivery.customerName ?? "Customer");
  doc.moveDown(1);

  doc.font("Helvetica-Bold").fillColor("#111111").text("Vehicle");
  if (vehicle) {
    doc
      .font("Helvetica")
      .fillColor("#333333")
      .text(`${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""}`);
    if (vehicle.vin) doc.text(`VIN: ${vehicle.vin}`);
    if (vehicle.exteriorColor) doc.text(`Color: ${vehicle.exteriorColor}`);
  } else {
    doc.font("Helvetica").text(`Vehicle #${delivery.vehicleId}`);
  }
  if (delivery.registrationNumber)
    doc.text(`Registration: ${delivery.registrationNumber}`);
  if (delivery.insurancePolicy)
    doc.text(
      `Insurance: ${delivery.insurancePolicy}${delivery.insuranceProvider ? ` (${delivery.insuranceProvider})` : ""}`,
    );
  doc.moveDown(1.5);

  const y = doc.y;
  doc
    .moveTo(54, y)
    .lineTo(541, y)
    .strokeColor("#dddddd")
    .stroke();
  doc.moveDown(0.75);
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor("#111111")
    .text("Total due", { continued: true })
    .text(money(invoice.amount), { align: "right" });
  doc.moveDown(2);

  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#888888")
    .text(
      "Thank you for choosing AURA. This invoice was generated by the delivery workflow engine.",
    );

  doc.end();
});

router.get("/deliveries/:id/handover.pdf", async (req, res): Promise<void> => {
  const params = GetDeliveryHandoverPdfParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const delivery = await loadDelivery(params.data.id, activeDealerId(res));
  if (!delivery) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, delivery.vehicleId),
        eq(vehiclesTable.dealerId, delivery.dealerId),
      ),
    );
  let advisorName: string | null = null;
  if (delivery.advisorUserId) {
    const [advisor] = await db
      .select({ name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, delivery.advisorUserId));
    advisorName = advisor?.name ?? advisor?.email ?? null;
  }
  const [deal] = await db
    .select({
      salesAdvisor: dealsTable.salesAdvisor,
      leadId: dealsTable.leadId,
    })
    .from(dealsTable)
    .where(
      and(
        eq(dealsTable.id, delivery.dealId),
        eq(dealsTable.dealerId, delivery.dealerId),
      ),
    );
  const [customer] = delivery.customerId
    ? await db
        .select({
          email: customersTable.email,
          phone: customersTable.phone,
          location: customersTable.location,
          city: customersTable.city,
          country: customersTable.country,
        })
        .from(customersTable)
        .where(
          and(
            eq(customersTable.id, delivery.customerId),
            eq(customersTable.dealerId, delivery.dealerId),
          ),
        )
    : [];
  const [dealer] = await db
    .select({
      name: dealersTable.name,
      city: dealersTable.city,
      country: dealersTable.country,
    })
    .from(dealersTable)
    .where(eq(dealersTable.id, delivery.dealerId));
  let invoiceNumber: string | null = null;
  if (delivery.invoiceId) {
    const [inv] = await db
      .select({ invoiceNumber: invoicesTable.invoiceNumber })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.id, delivery.invoiceId),
          eq(invoicesTable.dealerId, delivery.dealerId),
        ),
      );
    invoiceNumber = inv?.invoiceNumber ?? null;
  }
  const handoverBranding = await getDealerPdfBranding(delivery.dealerId);
  const pdf = await buildHandoverPdf(delivery, vehicle, advisorName, {
    salesAdvisorName: deal?.salesAdvisor ?? null,
    dealerName: handoverBranding.displayName ?? dealer?.name ?? null,
    logo: handoverBranding.logo,
    dealerAddress: [dealer?.city, dealer?.country].filter(Boolean).join(", "),
    customerAddress:
      customer?.location ??
      [customer?.city, customer?.country].filter(Boolean).join(", ") ??
      null,
    customerEmail: customer?.email ?? null,
    customerPhone: customer?.phone ?? null,
    invoiceNumber,
  });
  res
    .setHeader("Content-Type", "application/pdf")
    .setHeader(
      "Content-Disposition",
      `inline; filename="handover-delivery-${delivery.id}.pdf"`,
    )
    .send(pdf);
});

// Autofilled BYD warranty documents (warranty step downloads). `doc` selects
// the standalone certificate or the full booklet (certificate = its page 5).
router.get("/deliveries/:id/warranty.pdf", async (req, res): Promise<void> => {
  const params = GetDeliveryHandoverPdfParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const variant = req.query.doc === "booklet" ? "booklet" : "certificate";
  const delivery = await loadDelivery(params.data.id, activeDealerId(res));
  if (!delivery) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, delivery.vehicleId),
        eq(vehiclesTable.dealerId, delivery.dealerId),
      ),
    );
  // Owner details: prefer the delivery's linked customer, then the deal's
  // customer, then the deal's lead — many deals only carry a lead record.
  let warrantyCustomerId = delivery.customerId;
  let warrantyLeadId: number | null = null;
  {
    const [deal] = await db
      .select({
        customerId: dealsTable.customerId,
        leadId: dealsTable.leadId,
      })
      .from(dealsTable)
      .where(
        and(
          eq(dealsTable.id, delivery.dealId),
          eq(dealsTable.dealerId, delivery.dealerId),
        ),
      );
    warrantyCustomerId = warrantyCustomerId ?? deal?.customerId ?? null;
    warrantyLeadId = deal?.leadId ?? null;
  }
  const [customer] = warrantyCustomerId
    ? await db
        .select({
          name: customersTable.name,
          email: customersTable.email,
          phone: customersTable.phone,
          location: customersTable.location,
          city: customersTable.city,
          country: customersTable.country,
        })
        .from(customersTable)
        .where(
          and(
            eq(customersTable.id, warrantyCustomerId),
            eq(customersTable.dealerId, delivery.dealerId),
          ),
        )
    : [];
  const [dealer] = await db
    .select({
      name: dealersTable.name,
      city: dealersTable.city,
      country: dealersTable.country,
      address: dealersTable.address,
      servicePhone: dealersTable.servicePhone,
      emergencyPhone: dealersTable.emergencyPhone,
    })
    .from(dealersTable)
    .where(eq(dealersTable.id, delivery.dealerId));
  // Lead fallback for owner contact details — many deals carry only a lead.
  const [lead] =
    !customer && warrantyLeadId
      ? await db
          .select({
            name: leadsTable.name,
            email: leadsTable.email,
            phone: leadsTable.phone,
            address: leadsTable.address,
          })
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.id, warrantyLeadId),
              eq(leadsTable.dealerId, delivery.dealerId),
            ),
          )
      : [];
  let invoiceNumber: string | null = null;
  // Date of sale = the day the final payment settled the invoice.
  let dateOfSale: Date | null = null;
  if (delivery.invoiceId) {
    const [inv] = await db
      .select({
        invoiceNumber: invoicesTable.invoiceNumber,
        status: invoicesTable.status,
      })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.id, delivery.invoiceId),
          eq(invoicesTable.dealerId, delivery.dealerId),
        ),
      );
    invoiceNumber = inv?.invoiceNumber ?? null;
    if (inv?.status === "paid") {
      const [lastPayment] = await db
        .select({ createdAt: paymentsTable.createdAt })
        .from(paymentsTable)
        .where(
          and(
            eq(paymentsTable.invoiceId, delivery.invoiceId),
            eq(paymentsTable.dealerId, delivery.dealerId),
          ),
        )
        .orderBy(desc(paymentsTable.createdAt))
        .limit(1);
      dateOfSale = lastPayment?.createdAt ?? null;
    }
  }
  const branding = await getDealerPdfBranding(delivery.dealerId);
  const fmt = (d: Date | null | undefined) =>
    d
      ? d.toLocaleDateString("en-US", {
          timeZone: "America/Guyana",
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;
  const address =
    customer?.location ??
    ([customer?.city, customer?.country].filter(Boolean).join(", ") || null) ??
    lead?.address ??
    null;
  const ownerPhone = customer?.phone ?? lead?.phone ?? null;
  const pdf = await buildWarrantyPdf(variant, {
    ownerName: customer?.name ?? delivery.customerName ?? lead?.name,
    ownerEmail: customer?.email ?? lead?.email,
    ownerAddressContact:
      [address, ownerPhone].filter(Boolean).join(" · ") || null,
    vehicleModel: vehicle ? `${vehicle.make} ${vehicle.model}` : null,
    color: vehicle?.exteriorColor,
    // Odometer reading at delivery is recorded by hand during handover.
    odometer: null,
    manufactureYear: vehicle?.year ? String(vehicle.year) : null,
    vin: vehicle?.vin,
    motorNumber: vehicle?.engineNumber,
    dealerName: branding.displayName ?? dealer?.name ?? null,
    servicePhone: dealer?.servicePhone,
    emergencyContact: dealer?.emergencyPhone,
    dealerAddress:
      dealer?.address ??
      ([dealer?.city, dealer?.country].filter(Boolean).join(", ") || null),
    dateOfSale: fmt(dateOfSale),
    invoiceNumber,
    dateOfDelivery: fmt(delivery.deliveredAt ?? delivery.appointmentAt),
    signatureDataUrl: delivery.warrantySignatureData,
  });
  res
    .setHeader("Content-Type", "application/pdf")
    .setHeader(
      "Content-Disposition",
      `inline; filename="warranty-${variant}-delivery-${delivery.id}.pdf"`,
    )
    .send(pdf);
});

router.get("/delivery-advisors", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
    })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .where(
      and(
        eq(dealerUsersTable.dealerId, activeDealerId(res)),
        eq(rolesTable.name, "Delivery Advisor"),
      ),
    );
  res.json(
    ListDeliveryAdvisorsResponse.parse(
      rows.map((r) => ({
        id: r.id,
        name: r.name ?? r.email ?? `User #${r.id}`,
        email: r.email,
      })),
    ),
  );
});

export default router;
