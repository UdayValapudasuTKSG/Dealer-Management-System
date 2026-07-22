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

  const [order] = await db
    .insert(serviceOrdersTable)
    .values({
      ...parsed.data,
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
  const [card] = await db
    .insert(jobCardsTable)
    .values({ ...parsed.data, dealerId: order.dealerId })
    .returning();

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

  const patch: Record<string, unknown> = { ...parsed.data };
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
  const [part] = await db
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
  if (kind === "issue" && part.stock < parsed.data.quantity) {
    res.status(422).json({
      error: `Insufficient stock: ${part.stock} of ${part.name} available`,
    });
    return;
  }

  const [line] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(jobCardPartsTable)
      .values({
        dealerId: card.dealerId,
        jobCardId: card.id,
        partId: part.id,
        partName: part.name,
        kind,
        quantity: parsed.data.quantity,
        unitPrice: part.unitPrice,
      })
      .returning();
    const delta =
      kind === "issue" ? -parsed.data.quantity : parsed.data.quantity;
    await tx
      .update(partsTable)
      .set({ stock: sql`${partsTable.stock} + ${delta}` })
      .where(
        and(eq(partsTable.id, part.id), eq(partsTable.dealerId, card.dealerId)),
      );
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
