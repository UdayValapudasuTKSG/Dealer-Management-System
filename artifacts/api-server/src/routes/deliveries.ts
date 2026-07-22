import { Router, type IRouter } from "express";
import PDFDocument from "pdfkit";
import { and, desc, eq } from "drizzle-orm";
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
  reviewsTable,
  DELIVERY_STEPS,
  DELIVERY_STEP_LABELS,
  type Delivery,
  type DeliveryStep,
  type DeliveryStepState,
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
import { buildHandoverPdf } from "../lib/document-pdfs";
import { enqueueEmail, notifyUser } from "../lib/email";
import { onDealStageChanged } from "../lib/email-triggers";
import { logger } from "../lib/logger";
import { activeDealerId } from "../middlewares/rbac";

const router: IRouter = Router();

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

type Enriched = Delivery & {
  advisorName: string | null;
  vehicleLabel: string | null;
};

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
  return rows.map((r) => {
    const a = advisors.find((x) => x.id === r.advisorUserId);
    const v = vehicles.find((x) => x.id === r.vehicleId);
    return {
      ...r,
      advisorName: a ? (a.name ?? a.email ?? `User #${a.id}`) : null,
      vehicleLabel: v
        ? `${v.year} ${v.make} ${v.model}${v.vin ? ` · ${v.vin}` : ""}`
        : null,
    };
  });
}

async function loadDelivery(
  id: number,
  dealerId: number,
): Promise<Delivery | undefined> {
  const [row] = await db
    .select()
    .from(deliveriesTable)
    .where(and(eq(deliveriesTable.id, id), eq(deliveriesTable.dealerId, dealerId)));
  return row;
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

  const rows = await db
    .select()
    .from(deliveriesTable)
    .where(and(...filters))
    .orderBy(desc(deliveriesTable.createdAt));

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
  const [row] = await db
    .update(deliveriesTable)
    .set({ advisorUserId: parsed.data.advisorUserId ?? null })
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
    res.status(422).json({ error: "Delivery is already completed" });
    return;
  }
  const step = parsed.data.step as DeliveryStep;
  if (step !== delivery.currentStep) {
    res.status(422).json({
      error: `Steps must be completed in order — next step is "${DELIVERY_STEP_LABELS[delivery.currentStep as DeliveryStep]}"`,
    });
    return;
  }

  const extra: Partial<Delivery> = {};

  // Per-step requirements + side data
  switch (step) {
    case "pdi_checklist": {
      const unchecked = delivery.pdiItems.filter((i) => !i.checked);
      if (unchecked.length > 0) {
        res.status(422).json({
          error: `PDI checklist incomplete — ${unchecked.length} item(s) remaining`,
        });
        return;
      }
      break;
    }
    case "registration":
      if (parsed.data.registrationNumber)
        extra.registrationNumber = parsed.data.registrationNumber;
      break;
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
        res
          .status(422)
          .json({ error: "An appointment date/time is required" });
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
      if (!parsed.data.signatureName) {
        res.status(422).json({ error: "Customer signature name is required" });
        return;
      }
      extra.signatureName = parsed.data.signatureName;
      if (parsed.data.signatureData)
        extra.signatureData = parsed.data.signatureData;
      break;
    case "feedback":
      if (!parsed.data.feedbackRating) {
        res.status(422).json({ error: "A feedback rating (1–5) is required" });
        return;
      }
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
        const [existingAsset] = await db
          .select({ id: assetsTable.id })
          .from(assetsTable)
          .where(
            and(
              eq(assetsTable.vehicleId, delivery.vehicleId),
              eq(assetsTable.accountId, delivery.customerId),
              eq(assetsTable.dealerId, delivery.dealerId),
              eq(assetsTable.status, "active"),
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

          const [serviceAdvisor] = await db
            .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
            .from(usersTable)
            .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
            .innerJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
            .where(
              and(
                eq(dealerUsersTable.dealerId, delivery.dealerId),
                eq(rolesTable.name, "Service Advisor"),
                eq(usersTable.status, "active"),
              ),
            )
            .limit(1);

          const [asset] = await db
            .insert(assetsTable)
            .values({
              dealerId: delivery.dealerId,
              accountId: delivery.customerId,
              vehicleId: delivery.vehicleId,
              dealId: delivery.dealId,
              deliveryId: delivery.id,
              deliveredAt: new Date(),
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
  const [row] = await db
    .update(deliveriesTable)
    .set({ pdiItems: parsed.data.items })
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
  res.json(UpdateDeliveryPdiResponse.parse((await enrich([row], activeDealerId(res)))[0]));
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
