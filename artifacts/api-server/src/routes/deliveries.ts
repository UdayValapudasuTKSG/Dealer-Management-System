import { Router, type IRouter } from "express";
import PDFDocument from "pdfkit";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  deliveriesTable,
  dealsTable,
  vehiclesTable,
  customersTable,
  bookingsTable,
  invoicesTable,
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
import { enqueueEmail, notifyUser } from "../lib/email";
import { onDealStageChanged } from "../lib/email-triggers";
import { logger } from "../lib/logger";
import { activeDealerId } from "../middlewares/rbac";

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
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

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
    case "delivery":
      if (!d.deliveredAt)
        unmet.push("Actual handover date/time must be recorded");
      break;
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
  return Promise.all(
    rows.map(async (r) => {
      const a = advisors.find((x) => x.id === r.advisorUserId);
      const v = vehicles.find((x) => x.id === r.vehicleId);
      return {
        ...r,
        advisorName: a ? (a.name ?? a.email ?? `User #${a.id}`) : null,
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
  return row ? { ...row, pdiItems: normalizePdiItems(row.pdiItems) } : row;
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
  ).map((r) => ({ ...r, pdiItems: normalizePdiItems(r.pdiItems) }));

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

  // L7/L8 readiness gates — a single 422 shape { error, unmet[] }.
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

  // Per-step side data
  switch (step) {
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
        const amount = deal ? deal.otdPrice || deal.vehiclePrice : 0;
        const invoice = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(invoicesTable)
            .values({
              dealerId: delivery.dealerId,
              invoiceNumber: "PENDING",
              customerId: delivery.customerId ?? null,
              customerName: delivery.customerName ?? "Customer",
              dealId: delivery.dealId,
              description: `Vehicle delivery invoice — deal #${delivery.dealId}`,
              amount,
              status: "issued",
            })
            .returning();
          const [numbered] = await tx
            .update(invoicesTable)
            .set({
              invoiceNumber: `INV-${new Date().getFullYear()}-${String(row!.id).padStart(4, "0")}`,
            })
            .where(eq(invoicesTable.id, row!.id))
            .returning();
          return numbered!;
        });
        extra.invoiceId = invoice.id;
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
      break;
    }
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
          status: "completed",
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

          if (serviceAdvisor) {
            await notifyUser({
              userId: serviceAdvisor.id,
              dealerId: delivery.dealerId,
              type: "system",
              title: `New vehicle in your care: ${label ?? `Vehicle #${delivery.vehicleId}`}`,
              body: `${delivery.customerName ?? "A customer"} took delivery. The vehicle is now a lifetime asset on their account — you own the service relationship.`,
              link: `/customers/${delivery.customerId}`,
            });

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

    void (async () => {
      const { email, name } = await customerEmailFor(delivery);
      if (!email) return;
      await enqueueEmail({
        template: "feedback_request",
        to: email,
        dealerId: delivery.dealerId,
        customerId: delivery.customerId,
        dedupeKey: `delivery:${delivery.id}:csat`,
        data: { name, vehicle: await vehicleLabelFor(delivery.vehicleId, delivery.dealerId) },
      });
    })().catch((err) => logger.error({ err }, "feedback email failed"));
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

  doc
    .fillColor("#b30f16")
    .fontSize(26)
    .font("Helvetica-Bold")
    .text("AURA", { continued: true })
    .fillColor("#111111")
    .text(" Dealership OS");
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
  const pdf = await buildHandoverPdf(delivery, vehicle, advisorName);
  res
    .setHeader("Content-Type", "application/pdf")
    .setHeader(
      "Content-Disposition",
      `inline; filename="handover-delivery-${delivery.id}.pdf"`,
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
