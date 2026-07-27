import { Router, type IRouter } from "express";
import {
  buildCoverageCertificatePdf,
  buildServiceInvoicePdf,
} from "../lib/document-pdfs";
import { dealerExchangeRate } from "../lib/invoicing";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  serviceOrdersTable,
  jobCardsTable,
  jobCardPartsTable,
  partsTable,
  coveragePlansTable,
  serviceInvoicesTable,
  customersTable,
  usersTable,
  rolesTable,
  dealerUsersTable,
  gatesTable,
  timelineEventsTable,
  partPurchasesTable,
} from "@workspace/db";
import {
  CreateServiceOrderBody,
  UpdateServiceOrderBody,
  UpdateServiceOrderParams,
  ListServiceOrdersQueryParams,
  ListServiceOrdersResponse,
  CreateServiceOrderResponse,
  UpdateServiceOrderResponse,
  SendServiceReminderParams,
  SendServiceReminderResponse,
  ListServiceTechniciansResponse,
  ListJobCardsQueryParams,
  ListJobCardsResponse,
  CreateJobCardBody,
  CreateJobCardResponse,
  UpdateJobCardParams,
  UpdateJobCardBody,
  UpdateJobCardResponse,
  ListJobCardPartsParams,
  ListJobCardPartsResponse,
  AddJobCardPartParams,
  AddJobCardPartBody,
  AddJobCardPartResponse,
  CreateJobCardInvoiceParams,
  CreateJobCardInvoiceResponse,
  ListServiceInvoicesQueryParams,
  ListServiceInvoicesResponse,
  UpdateServiceInvoiceParams,
  UpdateServiceInvoiceBody,
  UpdateServiceInvoiceResponse,
  ListCoveragePlansQueryParams,
  ListCoveragePlansResponse,
  CreateCoveragePlanBody,
  CreateCoveragePlanResponse,
  UpdateCoveragePlanParams,
  UpdateCoveragePlanBody,
  UpdateCoveragePlanResponse,
  SendCoverageReminderParams,
  SendCoverageReminderResponse,
  AdvanceServiceOrderParams,
  AdvanceServiceOrderBody,
  AdvanceServiceOrderResponse,
} from "@workspace/api-zod";
import { onServiceOrderCompleted } from "../lib/email-triggers";
import { enqueueEmail, notifyUser } from "../lib/email";
import { activeDealerId } from "../middlewares/rbac";
import { resolveDealerUserIdByName } from "../lib/user-lookup";
import { computeServiceTax, ensureDealerTaxes } from "../lib/taxes";

const router: IRouter = Router();

function toDateString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return undefined;
}

async function customerEmail(
  customerId: number | null | undefined,
  dealerId: number,
): Promise<{ email: string | null; name: string | null }> {
  if (customerId == null) return { email: null, name: null };
  const [row] = await db
    .select({ email: customersTable.email, name: customersTable.name })
    .from(customersTable)
    .where(
      and(eq(customersTable.id, customerId), eq(customersTable.dealerId, dealerId)),
    );
  return { email: row?.email ?? null, name: row?.name ?? null };
}

// ---------------------------------------------------------------------------
// Service orders (bookings)
// ---------------------------------------------------------------------------

router.get("/service-orders", async (req, res): Promise<void> => {
  const query = ListServiceOrdersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.dealerId, activeDealerId(res)),
        query.data.status
          ? eq(serviceOrdersTable.status, query.data.status)
          : undefined,
      ),
    )
    .orderBy(desc(serviceOrdersTable.scheduledDate));

  res.json(ListServiceOrdersResponse.parse(rows));
});

router.post("/service-orders", async (req, res): Promise<void> => {
  const parsed = CreateServiceOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const createDealerId = activeDealerId(res);
  // Stamp the technician's user ID so briefing scoping matches by ID, not name.
  const technicianUserId =
    parsed.data.technicianUserId ??
    (await resolveDealerUserIdByName(createDealerId, parsed.data.technician));

  // Pay-type resolution: explicit wins; warranty/recall work defaults to
  // warranty pay; otherwise an active coverage plan (by date window) for the
  // customer flips the default from customer-pay to warranty-pay.
  let payType = parsed.data.payType;
  if (!payType) {
    if (parsed.data.type === "warranty" || parsed.data.type === "recall") {
      payType = "warranty";
    } else if (parsed.data.customerId != null) {
      const today = new Date().toISOString().slice(0, 10);
      const [plan] = await db
        .select({ id: coveragePlansTable.id })
        .from(coveragePlansTable)
        .where(
          and(
            eq(coveragePlansTable.dealerId, createDealerId),
            eq(coveragePlansTable.customerId, parsed.data.customerId),
            sql`${coveragePlansTable.startDate} <= ${today}`,
            sql`${coveragePlansTable.endDate} >= ${today}`,
          ),
        )
        .limit(1);
      payType = plan ? "warranty" : "customer";
    } else {
      payType = "customer";
    }
  }

  const [order] = await db
    .insert(serviceOrdersTable)
    .values({
      ...parsed.data,
      payType,
      technicianUserId,
      dealerId: createDealerId,
      scheduledDate: toDateString(parsed.data.scheduledDate)!,
    })
    .returning();

  // Best-effort booking confirmation / reminder email
  if (order && order.customerId != null) {
    const { email } = await customerEmail(order.customerId, order.dealerId);
    if (email) {
      void enqueueEmail({
        template: "service_reminder",
        to: email,
        dealerId: order.dealerId,
        customerId: order.customerId,
        data: {
          vehicle: order.vehicleInfo,
          service: order.type,
          date: order.scheduledDate,
        },
      });
    }
  }

  res.status(201).json(CreateServiceOrderResponse.parse(order));
});

router.patch("/service-orders/:id", async (req, res): Promise<void> => {
  const params = UpdateServiceOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateServiceOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { scheduledDate, ...rest } = parsed.data;
  const dateStr = toDateString(scheduledDate);

  const dealerId = activeDealerId(res);
  const [before] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, params.data.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    );

  // Keep the technician user ID in sync when only the display name is sent.
  // Clear the ID explicitly when the new name doesn't resolve, so a stale ID
  // from the previous technician never survives a rename.
  const updateValues: Partial<typeof serviceOrdersTable.$inferInsert> = {
    ...rest,
  };
  if (rest.technician !== undefined && rest.technicianUserId === undefined) {
    updateValues.technicianUserId = await resolveDealerUserIdByName(
      dealerId,
      rest.technician,
    );
  }
  if (dateStr) updateValues.scheduledDate = dateStr;

  const [order] = await db
    .update(serviceOrdersTable)
    .set(updateValues)
    .where(
      and(
        eq(serviceOrdersTable.id, params.data.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    )
    .returning();

  if (!order) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }

  if (before) onServiceOrderCompleted(before, order);

  res.json(UpdateServiceOrderResponse.parse(order));
});

router.post("/service-orders/:id/remind", async (req, res): Promise<void> => {
  const params = SendServiceReminderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, params.data.id),
        eq(serviceOrdersTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!order) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }
  const { email } = await customerEmail(order.customerId, order.dealerId);
  if (!email) {
    res.status(422).json({ error: "Customer has no email on file" });
    return;
  }
  await enqueueEmail({
    template: "service_reminder",
    to: email,
    dealerId: order.dealerId,
    customerId: order.customerId,
    data: {
      vehicle: order.vehicleInfo,
      service: order.type,
      date: order.scheduledDate,
    },
  });
  res.json(
    SendServiceReminderResponse.parse({ status: "queued", recipient: email }),
  );
});

// ---------------------------------------------------------------------------
// Service case advance (adjacent-only NC-3 machine + manager review gate)
// ---------------------------------------------------------------------------

/** Adjacent-only transitions for the 7-status service case machine. */
const SERVICE_ADVANCE_MAP: Record<string, string[]> = {
  open: ["acknowledged", "cancelled"],
  acknowledged: ["in_progress", "cancelled"],
  in_progress: ["on_hold", "resolved", "cancelled"],
  on_hold: ["in_progress", "cancelled"],
  resolved: ["closed"],
  closed: [],
  cancelled: [],
};

/** Pay types whose closure needs an approved manager gate (money the dealer eats). */
const GATED_PAY_TYPES = new Set(["warranty", "goodwill", "rectify"]);

router.post("/service-orders/:id/advance", async (req, res): Promise<void> => {
  const params = AdvanceServiceOrderParams.safeParse(req.params);
  const parsed = AdvanceServiceOrderBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, params.data.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    );
  if (!order) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }
  const target = parsed.data.targetStatus;
  if (!(SERVICE_ADVANCE_MAP[order.status] ?? []).includes(target)) {
    res.status(422).json({
      unmet: [
        `Cannot move a ${order.status} case to ${target} — transitions are one step at a time`,
      ],
    });
    return;
  }

  const unmet: string[] = [];

  if (target === "resolved") {
    // All active work must be finished before the case can resolve.
    const cards = await db
      .select({ id: jobCardsTable.id, status: jobCardsTable.status })
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.serviceOrderId, order.id),
          eq(jobCardsTable.dealerId, dealerId),
        ),
      );
    const unfinished = cards.filter(
      (c) => !["completed", "closed", "cancelled"].includes(c.status),
    );
    if (unfinished.length > 0) {
      unmet.push(
        `${unfinished.length} job card(s) still open — complete or cancel them first`,
      );
    }
  }

  if (target === "closed") {
    // Customer-pay work needs an issued invoice before pickup.
    if (order.payType === "customer") {
      const [invoice] = await db
        .select({ id: serviceInvoicesTable.id })
        .from(serviceInvoicesTable)
        .where(
          and(
            eq(serviceInvoicesTable.serviceOrderId, order.id),
            eq(serviceInvoicesTable.dealerId, dealerId),
          ),
        )
        .limit(1);
      if (!invoice) unmet.push("No service invoice issued for this case yet");
    }
    // Recall work and dealer-funded pay types need explicit manager approval
    // before the case closes (mirrors the pipeline stage_advance gate).
    if (GATED_PAY_TYPES.has(order.payType) || order.type === "recall") {
      const [gate] = await db
        .select()
        .from(gatesTable)
        .where(
          and(
            eq(gatesTable.dealerId, dealerId),
            eq(gatesTable.type, "stage_advance"),
            eq(gatesTable.refType, "service_order"),
            eq(gatesTable.refId, order.id),
          ),
        )
        .orderBy(desc(gatesTable.createdAt))
        .limit(1);
      if (!gate || gate.status === "dismissed") {
        await db.insert(gatesTable).values({
          dealerId,
          type: "stage_advance",
          status: "pending",
          priority: "normal",
          customerId: order.customerId ?? null,
          customerName: order.customerName ?? null,
          refType: "service_order",
          refId: order.id,
          title: `Close ${order.payType}-pay service case #${order.id}`,
          summary: `${order.vehicleInfo} — ${order.type} case funded as ${order.payType}. Manager sign-off required before closing.`,
          evidence: [
            { label: "Pay type", value: order.payType },
            { label: "Case type", value: order.type },
          ],
        });
        unmet.push("Manager approval requested — pending review");
      } else if (gate.status === "pending") {
        unmet.push("Manager approval pending review");
      }
    }
  }

  if (unmet.length > 0) {
    res.status(422).json({ unmet });
    return;
  }

  const [before] = [order];
  const [updated] = await db
    .update(serviceOrdersTable)
    .set({ status: target })
    .where(
      and(
        eq(serviceOrdersTable.id, order.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    )
    .returning();

  if (updated && before) onServiceOrderCompleted(before, updated);

  // Closing the case writes the pickup into the customer's service history.
  if (updated && target === "closed" && updated.customerId != null) {
    await db.insert(timelineEventsTable).values({
      dealerId,
      customerId: updated.customerId,
      domain: "service",
      kind: "service_case_closed",
      title: `Service case #${updated.id} closed — vehicle picked up`,
      detail: `${updated.vehicleInfo} — ${updated.type} (${updated.payType}-pay) completed.`,
      actor: res.locals.user?.name ?? "Service",
      isAgent: false,
      cause: `Service order #${updated.id}`,
      refType: "service_order",
      refId: updated.id,
    });
  }

  res.json(AdvanceServiceOrderResponse.parse(updated));
});

// ---------------------------------------------------------------------------
// Technicians
// ---------------------------------------------------------------------------

router.get("/service-technicians", async (_req, res): Promise<void> => {
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
        eq(rolesTable.name, "Technician"),
      ),
    );
  res.json(
    ListServiceTechniciansResponse.parse(
      rows.map((r) => ({ id: r.id, name: r.name ?? r.email ?? `User #${r.id}` })),
    ),
  );
});

// ---------------------------------------------------------------------------
// Job cards
// ---------------------------------------------------------------------------

router.get("/job-cards", async (req, res): Promise<void> => {
  const query = ListJobCardsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const me = res.locals.user;
  const filters = [
    eq(jobCardsTable.dealerId, activeDealerId(res)),
    query.data.serviceOrderId !== undefined
      ? eq(jobCardsTable.serviceOrderId, query.data.serviceOrderId)
      : undefined,
    query.data.status !== undefined
      ? eq(jobCardsTable.status, query.data.status)
      : undefined,
    query.data.mine === "1" && me
      ? eq(jobCardsTable.technicianUserId, me.id)
      : undefined,
  ].filter((f): f is NonNullable<typeof f> => Boolean(f));

  const rows = await db
    .select()
    .from(jobCardsTable)
    .where(and(...filters))
    .orderBy(desc(jobCardsTable.createdAt));
  res.json(ListJobCardsResponse.parse(rows));
});

router.post("/job-cards", async (req, res): Promise<void> => {
  const parsed = CreateJobCardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, parsed.data.serviceOrderId),
        eq(serviceOrdersTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!order) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }
  let card: typeof jobCardsTable.$inferSelect | undefined;
  try {
    // Asset + pay type flow down from the case unless explicitly overridden.
    [card] = await db
      .insert(jobCardsTable)
      .values({
        ...parsed.data,
        assetId: order.assetId ?? null,
        payType: parsed.data.payType ?? order.payType,
        scheduledAt: parsed.data.scheduledAt
          ? new Date(parsed.data.scheduledAt)
          : null,
        dealerId: order.dealerId,
      })
      .returning();
  } catch (err) {
    // Partial unique index: one active job card per asset at a time.
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      res.status(409).json({
        error:
          "active_job_card_exists: this vehicle already has an active job card — complete or close it first",
      });
      return;
    }
    throw err;
  }

  if (card?.technicianUserId != null) {
    void notifyUser({
      userId: card.technicianUserId,
      dealerId: card.dealerId,
      type: "assignment",
      title: `Job card #${card.id} assigned to you`,
      body: `${card.title} — ${order.vehicleInfo}`,
      link: "/workshop",
    });
  }

  res.status(201).json(CreateJobCardResponse.parse(card));
});

router.patch("/job-cards/:id", async (req, res): Promise<void> => {
  const params = UpdateJobCardParams.safeParse(req.params);
  const parsed = UpdateJobCardBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const [existing] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }

  const { approveQuote, scheduledAt, ...updateFields } = parsed.data;
  const patch: Record<string, unknown> = { ...updateFields };
  if (scheduledAt !== undefined) patch.scheduledAt = new Date(scheduledAt);
  // Quote approval is a one-way timestamp: customer signed off on the estimate.
  if (approveQuote && !existing.quoteApprovedAt) {
    patch.quoteApprovedAt = new Date();
  }
  if (
    parsed.data.status === "in_progress" &&
    existing.status === "open" &&
    !existing.startedAt
  ) {
    patch.startedAt = new Date();
  }
  if (parsed.data.status === "completed" && existing.status !== "completed") {
    patch.completedAt = new Date();
  }

  const [card] = await db
    .update(jobCardsTable)
    .set(patch)
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, existing.dealerId),
      ),
    )
    .returning();

  if (
    card &&
    parsed.data.technicianUserId != null &&
    parsed.data.technicianUserId !== existing.technicianUserId
  ) {
    void notifyUser({
      userId: parsed.data.technicianUserId,
      dealerId: card.dealerId,
      type: "assignment",
      title: `Job card #${card.id} assigned to you`,
      body: card.title,
      link: "/workshop",
    });
  }

  res.json(UpdateJobCardResponse.parse(card));
});

// ---------------------------------------------------------------------------
// Job card part lines (issue decrements stock, return restocks)
// ---------------------------------------------------------------------------

router.get("/job-cards/:id/parts", async (req, res): Promise<void> => {
  const params = ListJobCardPartsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(jobCardPartsTable)
    .where(
      and(
        eq(jobCardPartsTable.jobCardId, params.data.id),
        eq(jobCardPartsTable.dealerId, activeDealerId(res)),
      ),
    )
    .orderBy(desc(jobCardPartsTable.createdAt));
  res.json(ListJobCardPartsResponse.parse(rows));
});

router.post("/job-cards/:id/parts", async (req, res): Promise<void> => {
  const params = AddJobCardPartParams.safeParse(req.params);
  const parsed = AddJobCardPartBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const kind = parsed.data.kind ?? "issue";

  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  let [part] = await db
    .select()
    .from(partsTable)
    .where(
      and(
        eq(partsTable.id, parsed.data.partId),
        eq(partsTable.dealerId, card.dealerId),
      ),
    );
  if (!part) {
    res.status(404).json({ error: "Part not found" });
    return;
  }
  // Supersession redirect: an old part number transparently resolves to its
  // replacement; obsolete parts with no successor are dead ends.
  if (part.status === "superseded" && part.supersededByPartId != null) {
    const [successor] = await db
      .select()
      .from(partsTable)
      .where(
        and(
          eq(partsTable.id, part.supersededByPartId),
          eq(partsTable.dealerId, card.dealerId),
        ),
      );
    if (successor) part = successor;
  }
  if (part.status === "obsolete") {
    res.status(422).json({
      error: `${part.name} (${part.sku}) is obsolete and cannot be issued`,
    });
    return;
  }

  // Backorder path: an issue that exceeds stock does NOT fail — the line is
  // flagged backordered, the job card goes on hold, and a draft PO is raised.
  const backordered = kind === "issue" && part.stock < parsed.data.quantity;
  const currentPart = part;

  const [line] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(jobCardPartsTable)
      .values({
        dealerId: card.dealerId,
        jobCardId: card.id,
        partId: currentPart.id,
        partName: currentPart.name,
        kind,
        quantity: parsed.data.quantity,
        unitPrice: currentPart.unitPrice,
        unitCost: currentPart.unitCost,
        backordered,
      })
      .returning();
    if (backordered) {
      const shortfall = parsed.data.quantity - currentPart.stock;
      await tx
        .update(jobCardsTable)
        .set({ status: "on_hold" })
        .where(
          and(
            eq(jobCardsTable.id, card.id),
            eq(jobCardsTable.dealerId, card.dealerId),
          ),
        );
      await tx.insert(partPurchasesTable).values({
        dealerId: card.dealerId,
        partId: currentPart.id,
        supplierId: currentPart.supplierId,
        quantity: Math.max(shortfall, currentPart.reorderLevel),
        qtyReceived: 0,
        status: "ordered",
        unitCost: currentPart.unitCost,
        reference: `Backorder — job card #${card.id}`,
      });
    } else {
      const delta =
        kind === "issue" ? -parsed.data.quantity : parsed.data.quantity;
      await tx
        .update(partsTable)
        .set({ stock: sql`${partsTable.stock} + ${delta}` })
        .where(
          and(
            eq(partsTable.id, currentPart.id),
            eq(partsTable.dealerId, card.dealerId),
          ),
        );
    }
    return inserted;
  });

  res.status(201).json(AddJobCardPartResponse.parse(line));
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

router.post("/job-cards/:id/invoice", async (req, res): Promise<void> => {
  const params = CreateJobCardInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  const [existing] = await db
    .select()
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.jobCardId, card.id),
        eq(serviceInvoicesTable.dealerId, card.dealerId),
      ),
    );
  if (existing) {
    res
      .status(409)
      .json({ error: `Invoice #${existing.id} already exists for this job card` });
    return;
  }
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, card.serviceOrderId),
        eq(serviceOrdersTable.dealerId, card.dealerId),
      ),
    );
  if (!order) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }

  const lines = await db
    .select()
    .from(jobCardPartsTable)
    .where(
      and(
        eq(jobCardPartsTable.jobCardId, card.id),
        eq(jobCardPartsTable.dealerId, card.dealerId),
      ),
    );
  const partsTotal = lines.reduce(
    (sum, l) =>
      sum + l.unitPrice * l.quantity * (l.kind === "return" ? -1 : 1),
    0,
  );
  const laborTotal = card.laborHours * card.laborRate;
  // Deterministic tax engine: same per-dealer configured rules as sales
  // quotes (dealer_taxes VAT rule) — no hardcoded rate.
  const taxRules = await ensureDealerTaxes(card.dealerId);
  const { tax, total } = computeServiceTax(
    Math.round((partsTotal + laborTotal) * 100) / 100,
    taxRules,
  );

  const [invoice] = await db
    .insert(serviceInvoicesTable)
    .values({
      dealerId: order.dealerId,
      serviceOrderId: order.id,
      jobCardId: card.id,
      customerId: order.customerId,
      customerName: order.customerName,
      vehicleInfo: order.vehicleInfo,
      partsTotal: Math.round(partsTotal * 100) / 100,
      laborTotal: Math.round(laborTotal * 100) / 100,
      tax,
      total,
      status: "issued",
    })
    .returning();

  res.status(201).json(CreateJobCardInvoiceResponse.parse(invoice));
});

router.get("/service-invoices", async (req, res): Promise<void> => {
  const query = ListServiceInvoicesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.dealerId, activeDealerId(res)),
        query.data.status
          ? eq(serviceInvoicesTable.status, query.data.status)
          : undefined,
      ),
    )
    .orderBy(desc(serviceInvoicesTable.createdAt));
  res.json(ListServiceInvoicesResponse.parse(rows));
});

router.patch("/service-invoices/:id", async (req, res): Promise<void> => {
  const params = UpdateServiceInvoiceParams.safeParse(req.params);
  const parsed = UpdateServiceInvoiceBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const [invoice] = await db
    .update(serviceInvoicesTable)
    .set(parsed.data)
    .where(
      and(
        eq(serviceInvoicesTable.id, params.data.id),
        eq(serviceInvoicesTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  res.json(UpdateServiceInvoiceResponse.parse(invoice));
});

router.get("/service-invoices/:id/pdf", async (req, res): Promise<void> => {
  const params = UpdateServiceInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [invoice] = await db
    .select()
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.id, params.data.id),
        eq(serviceInvoicesTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!invoice) {
    res.status(404).json({ error: "Service invoice not found" });
    return;
  }
  const rate = await dealerExchangeRate(invoice.dealerId);
  const pdf = await buildServiceInvoicePdf(invoice, rate);
  res
    .setHeader("Content-Type", "application/pdf")
    .setHeader(
      "Content-Disposition",
      `inline; filename="SV-${String(invoice.id).padStart(5, "0")}.pdf"`,
    )
    .send(pdf);
});

// ---------------------------------------------------------------------------
// Warranty / AMC coverage
// ---------------------------------------------------------------------------

router.get("/coverage", async (req, res): Promise<void> => {
  const query = ListCoveragePlansQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(coveragePlansTable)
    .where(
      and(
        eq(coveragePlansTable.dealerId, activeDealerId(res)),
        query.data.type
          ? eq(coveragePlansTable.type, query.data.type)
          : undefined,
      ),
    )
    .orderBy(coveragePlansTable.endDate);
  res.json(ListCoveragePlansResponse.parse(rows));
});

router.post("/coverage", async (req, res): Promise<void> => {
  const parsed = CreateCoveragePlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [plan] = await db
    .insert(coveragePlansTable)
    .values({
      ...parsed.data,
      dealerId: activeDealerId(res),
      startDate: toDateString(parsed.data.startDate)!,
      endDate: toDateString(parsed.data.endDate)!,
    })
    .returning();
  res.status(201).json(CreateCoveragePlanResponse.parse(plan));
});

router.get("/coverage/:id/pdf", async (req, res): Promise<void> => {
  const params = UpdateCoveragePlanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [plan] = await db
    .select()
    .from(coveragePlansTable)
    .where(
      and(
        eq(coveragePlansTable.id, params.data.id),
        eq(coveragePlansTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!plan) {
    res.status(404).json({ error: "Coverage plan not found" });
    return;
  }
  const pdf = await buildCoverageCertificatePdf(plan);
  res
    .setHeader("Content-Type", "application/pdf")
    .setHeader(
      "Content-Disposition",
      `inline; filename="CP-${String(plan.id).padStart(5, "0")}-certificate.pdf"`,
    )
    .send(pdf);
});

router.patch("/coverage/:id", async (req, res): Promise<void> => {
  const params = UpdateCoveragePlanParams.safeParse(req.params);
  const parsed = UpdateCoveragePlanBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const { startDate, endDate, ...rest } = parsed.data;
  const patch: Record<string, unknown> = { ...rest };
  const start = toDateString(startDate);
  const end = toDateString(endDate);
  if (start) patch.startDate = start;
  if (end) patch.endDate = end;

  const [plan] = await db
    .update(coveragePlansTable)
    .set(patch)
    .where(
      and(
        eq(coveragePlansTable.id, params.data.id),
        eq(coveragePlansTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();
  if (!plan) {
    res.status(404).json({ error: "Coverage plan not found" });
    return;
  }
  res.json(UpdateCoveragePlanResponse.parse(plan));
});

router.post("/coverage/:id/remind", async (req, res): Promise<void> => {
  const params = SendCoverageReminderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [plan] = await db
    .select()
    .from(coveragePlansTable)
    .where(
      and(
        eq(coveragePlansTable.id, params.data.id),
        eq(coveragePlansTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!plan) {
    res.status(404).json({ error: "Coverage plan not found" });
    return;
  }
  const { email } = await customerEmail(plan.customerId, plan.dealerId);
  if (!email) {
    res.status(422).json({ error: "Customer has no email on file" });
    return;
  }
  await enqueueEmail({
    template: "warranty_reminder",
    to: email,
    dealerId: plan.dealerId,
    customerId: plan.customerId,
    data: { vehicle: plan.vehicleInfo, expiry: plan.endDate },
  });
  res.json(
    SendCoverageReminderResponse.parse({ status: "queued", recipient: email }),
  );
});

export default router;
