import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  externalJobCardPartsTable,
  jobCardPartsTable,
  jobCardsTable,
  partRequisitionFulfillmentsTable,
  partRequisitionLinesTable,
  partRequisitionPoAllocationsTable,
  partRequisitionsTable,
  partsTable,
  purchaseOrderLinesTable,
  purchaseOrdersTable,
  serviceInvoicesTable,
  serviceOrdersTable,
  collisionClaimsTable,
  suppliersTable,
} from "@workspace/db";
import {
  CreateJobCardPartRequisitionBody,
  CreateJobCardPartRequisitionParams,
  CreateJobCardPartRequisitionResponse,
  CreateInventoryPartRequisitionBody,
  CreateInventoryPartRequisitionResponse,
  DecidePartRequisitionBody,
  DecidePartRequisitionParams,
  DecidePartRequisitionResponse,
  FulfillPartRequisitionBody,
  FulfillPartRequisitionParams,
  FulfillPartRequisitionResponse,
  GetPartRequisitionParams,
  GetPartRequisitionResponse,
  ListJobCardPartRequisitionsParams,
  ListJobCardPartRequisitionsResponse,
  ListPartRequisitionsQueryParams,
  ListPartRequisitionsResponse,
  MarkPartRequisitionOrderedBody,
  MarkPartRequisitionOrderedParams,
  MarkPartRequisitionOrderedResponse,
  ConvertPartRequisitionToPurchaseOrdersBody,
  ConvertPartRequisitionToPurchaseOrdersParams,
  ConvertPartRequisitionToPurchaseOrdersResponse,
  CancelPartRequisitionBody,
  CancelPartRequisitionParams,
  CancelPartRequisitionResponse,
} from "@workspace/api-zod";
import { activeDealerId, hasPermission, type AuthedUser } from "../middlewares/rbac";
import {
  enqueuePurchaseOrderSync,
  enqueueStockEntrySync,
} from "../lib/erpnext/parts-sync";
import { notifyPartsRequisitionSubmitted } from "../lib/notify-triggers";
import { buildServiceEstimateBreakdown } from "../lib/service-estimate-breakdown";
import { clearEstimateStaffAcknowledgement } from "../lib/service-estimate-gate";
import { invalidateServiceEstimate } from "../lib/service-estimate-invalidation";
import { checkLowStockCrossing } from "./parts";

const router: IRouter = Router();

function actorName(user: AuthedUser | undefined): string {
  return user?.name ?? user?.email ?? "Staff";
}

function isApprover(user: AuthedUser | undefined): boolean {
  if (!user) return false;
  return (
    user.isSuperAdmin ||
    /service manager|general manager|leadership|management|owner.?admin|admin/i.test(
      user.roleName ?? "",
    )
  );
}

function canPartsView(user: AuthedUser | undefined): boolean {
  return !!user && (isApprover(user) || hasPermission(user, "parts", "view"));
}

function canProcess(user: AuthedUser | undefined): boolean {
  return (
    !!user &&
    (isApprover(user) ||
      hasPermission(user, "parts", "edit") ||
      hasPermission(user, "parts", "admin"))
  );
}

function isAssigned(
  user: AuthedUser | undefined,
  card: { technicianUserId: number | null },
  order: { technicianUserId: number | null },
): boolean {
  return !!user && /technician/i.test(user.roleName ?? "") &&
    (card.technicianUserId === user.id || order.technicianUserId === user.id);
}

async function loadCardAndOrder(dealerId: number, jobCardId: number) {
  const [row] = await db
    .select({ card: jobCardsTable, order: serviceOrdersTable })
    .from(jobCardsTable)
    .innerJoin(
      serviceOrdersTable,
      and(
        eq(serviceOrdersTable.id, jobCardsTable.serviceOrderId),
        eq(serviceOrdersTable.dealerId, jobCardsTable.dealerId),
      ),
    )
    .where(and(eq(jobCardsTable.id, jobCardId), eq(jobCardsTable.dealerId, dealerId)));
  return row ?? null;
}

async function loadDetail(dealerId: number, id: number) {
  const [header] = await db
    .select()
    .from(partRequisitionsTable)
    .where(and(eq(partRequisitionsTable.id, id), eq(partRequisitionsTable.dealerId, dealerId)));
  if (!header) return null;
  const lines = await db
    .select()
    .from(partRequisitionLinesTable)
    .where(
      and(
        eq(partRequisitionLinesTable.requisitionId, id),
        eq(partRequisitionLinesTable.dealerId, dealerId),
      ),
    )
    .orderBy(partRequisitionLinesTable.id);
  const allocations = await db
    .select()
    .from(partRequisitionPoAllocationsTable)
    .where(
      and(
        eq(partRequisitionPoAllocationsTable.dealerId, dealerId),
        eq(partRequisitionPoAllocationsTable.requisitionId, id),
      ),
    );
  const byLine = new Map<number, typeof allocations>();
  for (const allocation of allocations) {
    const list = byLine.get(allocation.requisitionLineId) ?? [];
    list.push(allocation);
    byLine.set(allocation.requisitionLineId, list);
  }
  return {
    ...header,
    lines: lines.map((line) => {
      const links = byLine.get(line.id) ?? [];
      const orderedQuantity = links.reduce((sum, link) => sum + link.quantityOrdered, 0);
      const receivedQuantity = links.reduce((sum, link) => sum + link.quantityReceived, 0);
      return {
        ...line,
        orderedQuantity,
        receivedQuantity,
        outstandingQuantity: Math.max(0, line.quantity - orderedQuantity),
        purchaseOrderLinks: links.map((link) => ({
          purchaseOrderId: link.purchaseOrderId,
          purchaseOrderLineId: link.purchaseOrderLineId,
          supplierId: link.supplierId,
          quantityOrdered: link.quantityOrdered,
          quantityReceived: link.quantityReceived,
        })),
      };
    }),
  };
}

async function canViewRequisition(user: AuthedUser | undefined, dealerId: number, jobCardId: number | null) {
  if (canPartsView(user)) return true;
  if (jobCardId == null) return false;
  const linked = await loadCardAndOrder(dealerId, jobCardId);
  return !!linked && isAssigned(user, linked.card, linked.order);
}

async function createJobCardRequisition(
  req: Request,
  res: Response,
  collisionClaimId?: number,
): Promise<void> {
  const params = CreateJobCardPartRequisitionParams.safeParse(req.params);
  const parsed = CreateJobCardPartRequisitionBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: (params.success ? parsed : params).error?.message ?? "Invalid" });
    return;
  }
  const dealerId = activeDealerId(res);
  const linked = await loadCardAndOrder(dealerId, params.data.id);
  if (!linked || linked.order.id !== parsed.data.serviceOrderId) {
    res.status(404).json({ error: "Job card and service order were not found together" });
    return;
  }
  const user = res.locals.user;
  if (!isAssigned(user, linked.card, linked.order) && !canProcess(user)) {
    res.status(403).json({ error: "Only the assigned technician, a service approver, or Parts staff may submit this requisition" });
    return;
  }

  const internalIds = [
    ...new Set(parsed.data.lines.filter((line) => line.source === "INTERNAL").map((line) => line.partId)),
  ];
  if (internalIds.some((id) => id == null)) {
    res.status(422).json({ error: "INTERNAL lines require partId" });
    return;
  }
  for (const line of parsed.data.lines) {
    if (line.source === "EXTERNAL" && (!line.description?.trim() || line.partId != null)) {
      res.status(422).json({ error: "EXTERNAL lines require description and cannot specify partId" });
      return;
    }
    if (line.source === "EXTERNAL" && line.unitPrice == null) {
      res.status(422).json({ error: "EXTERNAL lines require the GYD unitPrice charged to the customer" });
      return;
    }
  }
  const internalParts = internalIds.length
    ? await db
        .select()
        .from(partsTable)
        .where(
          and(
            eq(partsTable.dealerId, dealerId),
            sql`${partsTable.id} in (${sql.join(internalIds.map((id) => sql`${id}`), sql`,`)})`,
          ),
        )
    : [];
  const partById = new Map(internalParts.map((part) => [part.id, part]));
  if (internalIds.some((id) => !partById.has(id!))) {
    res.status(404).json({ error: "One or more internal parts were not found in this dealership" });
    return;
  }

  const requisition = await db.transaction(async (tx) => {
    const [header] = await tx
      .insert(partRequisitionsTable)
      .values({
        dealerId,
        collisionClaimId: collisionClaimId ?? null,
        serviceOrderId: linked.order.id,
        jobCardId: linked.card.id,
        requesterUserId: user?.id ?? null,
        requesterName: actorName(user),
        status: "submitted",
        urgency: parsed.data.urgency,
        needBy: parsed.data.needBy
          ? parsed.data.needBy instanceof Date
            ? parsed.data.needBy.toISOString().slice(0, 10)
            : String(parsed.data.needBy).slice(0, 10)
          : null,
        notes: parsed.data.notes ?? null,
      })
      .returning();
    await tx.insert(partRequisitionLinesTable).values(
      parsed.data.lines.map((line) => {
        const part = line.partId == null ? undefined : partById.get(line.partId);
        return {
          dealerId,
          requisitionId: header.id,
          source: line.source,
          partId: part?.id ?? null,
          skuSnapshot: part?.sku ?? null,
          descriptionSnapshot: part?.name ?? line.description!.trim(),
          supplierSnapshot: line.supplier?.trim() || null,
          quantity: line.quantity,
          unitCost: part?.unitCost ?? line.unitCost ?? 0,
          unitPrice: part?.unitPrice ?? line.unitPrice ?? 0,
          taxCost: line.taxCost ?? 0,
          freightCost: line.freightCost ?? 0,
        };
      }),
    );
    return header;
  });
  notifyPartsRequisitionSubmitted({
    id: requisition.id,
    dealerId,
    jobCardId: linked.card.id,
    requesterName: requisition.requesterName,
    urgency: requisition.urgency,
    lineCount: parsed.data.lines.length,
  });
  res.status(201).json(CreateJobCardPartRequisitionResponse.parse(await loadDetail(dealerId, requisition.id)));
}
router.post("/job-cards/:id/part-requisitions", (req, res) =>
  createJobCardRequisition(req, res),
);

router.post("/part-requisitions", async (req, res): Promise<void> => {
  const parsed = CreateInventoryPartRequisitionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!canPartsView(res.locals.user)) {
    res.status(403).json({ error: "Parts access required" });
    return;
  }
  const dealerId = activeDealerId(res);
  const partIds = [...new Set(parsed.data.lines.map((line) => line.partId))];
  const parts = await db
    .select()
    .from(partsTable)
    .where(
      and(
        eq(partsTable.dealerId, dealerId),
        inArray(partsTable.id, partIds),
        eq(partsTable.status, "active"),
      ),
    );
  const partById = new Map(parts.map((part) => [part.id, part]));
  if (partIds.some((id) => !partById.has(id))) {
    res.status(422).json({ error: "One or more active inventory parts were not found in this dealership" });
    return;
  }
  const user = res.locals.user;
  const requisition = await db.transaction(async (tx) => {
    const [header] = await tx
      .insert(partRequisitionsTable)
      .values({
        dealerId,
        serviceOrderId: null,
        jobCardId: null,
        requesterUserId: user?.id ?? null,
        requesterName: actorName(user),
        status: "submitted",
        urgency: parsed.data.urgency,
        needBy: parsed.data.needBy
          ? parsed.data.needBy instanceof Date
            ? parsed.data.needBy.toISOString().slice(0, 10)
            : String(parsed.data.needBy).slice(0, 10)
          : null,
        notes: parsed.data.notes?.trim() || null,
      })
      .returning();
    await tx.insert(partRequisitionLinesTable).values(
      parsed.data.lines.map((line) => {
        const part = partById.get(line.partId)!;
        return {
          dealerId,
          requisitionId: header.id,
          source: "INTERNAL",
          partId: part.id,
          skuSnapshot: part.sku,
          descriptionSnapshot: part.name,
          quantity: line.quantity,
          unitCost: part.unitCost,
          unitPrice: part.unitPrice,
        };
      }),
    );
    return header;
  });
  notifyPartsRequisitionSubmitted({
    id: requisition.id,
    dealerId,
    jobCardId: null,
    requesterName: requisition.requesterName,
    urgency: requisition.urgency,
    lineCount: parsed.data.lines.length,
  });
  res.status(201).json(
    CreateInventoryPartRequisitionResponse.parse(await loadDetail(dealerId, requisition.id)),
  );
});

/** Collision requests deliberately delegate to the job-card implementation so
 * inventory validation, snapshots and lifecycle semantics cannot diverge. */
router.post("/collision-claims/:id/part-requisitions", async (req, res): Promise<void> => {
  const claimId = Number(req.params.id);
  if (!Number.isInteger(claimId) || claimId <= 0) { res.status(404).json({ error: "Claim not found" }); return; }
  const dealerId = activeDealerId(res);
  const [claim] = await db.select().from(collisionClaimsTable).where(and(
    eq(collisionClaimsTable.id, claimId), eq(collisionClaimsTable.dealerId, dealerId),
  ));
  if (!claim) { res.status(404).json({ error: "Claim not found" }); return; }
  if (["closed", "denied", "total_loss"].includes(claim.status)) { res.status(422).json({ error: "Cannot requisition parts for a terminal collision claim" }); return; }
  const [card] = await db.select({ id: jobCardsTable.id, status: jobCardsTable.status }).from(jobCardsTable).where(and(
    eq(jobCardsTable.dealerId, dealerId), eq(jobCardsTable.serviceOrderId, claim.serviceOrderId),
    sql`${jobCardsTable.status} not in ('completed', 'cancelled')`,
  )).orderBy(desc(jobCardsTable.id));
  if (!card) { res.status(422).json({ error: "An active job card is required for this collision claim" }); return; }
  if (Number(req.body?.serviceOrderId) !== claim.serviceOrderId) { res.status(422).json({ error: "Requisition service order must match the collision claim" }); return; }
  (req.params as Record<string, string>).id = String(card.id);
  await createJobCardRequisition(req, res, claim.id);
});

router.get("/collision-claims/:id/part-requisitions", async (req, res): Promise<void> => {
  const claimId = Number(req.params.id);
  const dealerId = activeDealerId(res);
  const [claim] = await db.select().from(collisionClaimsTable).where(and(eq(collisionClaimsTable.id, claimId), eq(collisionClaimsTable.dealerId, dealerId)));
  if (!claim) { res.status(404).json({ error: "Claim not found" }); return; }
  if (!canPartsView(res.locals.user)) { res.status(403).json({ error: "Parts access required" }); return; }
  const rows = await db.select().from(partRequisitionsTable).where(and(eq(partRequisitionsTable.dealerId, dealerId), eq(partRequisitionsTable.collisionClaimId, claim.id))).orderBy(desc(partRequisitionsTable.createdAt));
  res.json(rows);
});

router.get("/job-cards/:id/part-requisitions", async (req, res): Promise<void> => {
  const params = ListJobCardPartRequisitionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const linked = await loadCardAndOrder(dealerId, params.data.id);
  if (!linked) {
    const [orphanCard] = await db
      .select({ id: jobCardsTable.id })
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.id, params.data.id),
          eq(jobCardsTable.dealerId, dealerId),
        ),
      );
    if (!orphanCard || !canPartsView(res.locals.user)) {
      res.status(404).json({ error: "Job card not found" });
      return;
    }
  } else if (
    !canPartsView(res.locals.user) &&
    !isAssigned(res.locals.user, linked.card, linked.order)
  ) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  const rows = await db
    .select()
    .from(partRequisitionsTable)
    .where(
      and(
        eq(partRequisitionsTable.dealerId, dealerId),
        eq(partRequisitionsTable.jobCardId, params.data.id),
      ),
    )
    .orderBy(desc(partRequisitionsTable.createdAt));
  res.json(ListJobCardPartRequisitionsResponse.parse(rows));
});

router.get("/part-requisitions", async (req, res): Promise<void> => {
  const query = ListPartRequisitionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (!canPartsView(res.locals.user)) {
    res.status(403).json({ error: "Dealer-wide requisitions require Service approver or Parts access" });
    return;
  }
  const filters = [eq(partRequisitionsTable.dealerId, activeDealerId(res))];
  if (query.data.status) filters.push(eq(partRequisitionsTable.status, query.data.status));
  if (query.data.urgency) filters.push(eq(partRequisitionsTable.urgency, query.data.urgency));
  if (query.data.serviceOrderId) filters.push(eq(partRequisitionsTable.serviceOrderId, query.data.serviceOrderId));
  if (query.data.jobCardId) filters.push(eq(partRequisitionsTable.jobCardId, query.data.jobCardId));
  const rows = await db.select().from(partRequisitionsTable).where(and(...filters)).orderBy(desc(partRequisitionsTable.createdAt));
  res.json(ListPartRequisitionsResponse.parse(rows));
});

router.get("/part-requisitions/:id", async (req, res): Promise<void> => {
  const params = GetPartRequisitionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const detail = await loadDetail(dealerId, params.data.id);
  if (!detail || !(await canViewRequisition(res.locals.user, dealerId, detail.jobCardId))) {
    res.status(404).json({ error: "Requisition not found" });
    return;
  }
  res.json(GetPartRequisitionResponse.parse(detail));
});

function rejectProcessor(res: Response): boolean {
  if (canProcess(res.locals.user)) return false;
  res.status(403).json({ error: "Only a service approver or Parts processor may perform this action" });
  return true;
}

router.post("/part-requisitions/:id/decision", async (req, res): Promise<void> => {
  const params = DecidePartRequisitionParams.safeParse(req.params);
  const parsed = DecidePartRequisitionBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: (params.success ? parsed : params).error?.message ?? "Invalid" });
    return;
  }
  if (rejectProcessor(res)) return;
  if (parsed.data.action === "reject" && !parsed.data.reason?.trim()) {
    res.status(422).json({ error: "A rejection reason is required" });
    return;
  }
  const dealerId = activeDealerId(res);
  const [updated] = await db
    .update(partRequisitionsTable)
    .set({
      status: parsed.data.action === "approve" ? "approved" : "rejected",
      decisionReason: parsed.data.reason?.trim() || null,
      decidedByUserId: res.locals.user?.id ?? null,
      decidedByName: actorName(res.locals.user),
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(partRequisitionsTable.id, params.data.id),
        eq(partRequisitionsTable.dealerId, dealerId),
        eq(partRequisitionsTable.status, "submitted"),
      ),
    )
    .returning();
  if (!updated) {
    const existing = await loadDetail(dealerId, params.data.id);
    res.status(existing ? 422 : 404).json({ error: existing ? `Cannot decide a ${existing.status} requisition` : "Requisition not found" });
    return;
  }
  res.json(DecidePartRequisitionResponse.parse(await loadDetail(dealerId, updated.id)));
});

router.post("/part-requisitions/:id/ordered", async (req, res): Promise<void> => {
  const params = MarkPartRequisitionOrderedParams.safeParse(req.params);
  const parsed = MarkPartRequisitionOrderedBody.safeParse(req.body ?? {});
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: (params.success ? parsed : params).error?.message ?? "Invalid" });
    return;
  }
  if (rejectProcessor(res)) return;
  const dealerId = activeDealerId(res);
  const [updated] = await db
    .update(partRequisitionsTable)
    .set({
      status: "ordered",
      orderReference: parsed.data.reference?.trim() || null,
      orderedByUserId: res.locals.user?.id ?? null,
      orderedByName: actorName(res.locals.user),
      orderedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(partRequisitionsTable.id, params.data.id),
        eq(partRequisitionsTable.dealerId, dealerId),
        eq(partRequisitionsTable.status, "approved"),
      ),
    )
    .returning();
  if (!updated) {
    const existing = await loadDetail(dealerId, params.data.id);
    res.status(existing ? 422 : 404).json({ error: existing ? `Cannot order a ${existing.status} requisition` : "Requisition not found" });
    return;
  }
  res.json(MarkPartRequisitionOrderedResponse.parse(await loadDetail(dealerId, updated.id)));
});

router.post(
  "/part-requisitions/:id/convert-to-purchase-orders",
  async (req, res): Promise<void> => {
    const params = ConvertPartRequisitionToPurchaseOrdersParams.safeParse(req.params);
    const parsed = ConvertPartRequisitionToPurchaseOrdersBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: (params.success ? parsed : params).error?.message ?? "Invalid" });
      return;
    }
    if (rejectProcessor(res)) return;
    if (new Set(parsed.data.lines.map((line) => line.lineId)).size !== parsed.data.lines.length) {
      res.status(422).json({ error: "Each requisition line may appear only once per conversion" });
      return;
    }
    const dealerId = activeDealerId(res);
    const createdPoIds: number[] = [];
    let replay = false;
    try {
      await db.transaction(async (tx) => {
        const [header] = await tx
          .select()
          .from(partRequisitionsTable)
          .where(
            and(
              eq(partRequisitionsTable.id, params.data.id),
              eq(partRequisitionsTable.dealerId, dealerId),
            ),
          )
          .for("update");
        if (!header) throw Object.assign(new Error("Requisition not found"), { status: 404 });

        const prior = await tx
          .select()
          .from(partRequisitionPoAllocationsTable)
          .where(
            and(
              eq(partRequisitionPoAllocationsTable.dealerId, dealerId),
              eq(partRequisitionPoAllocationsTable.requisitionId, header.id),
              eq(partRequisitionPoAllocationsTable.idempotencyKey, parsed.data.idempotencyKey),
            ),
          );
        if (prior.length > 0) {
          const requested = [...parsed.data.lines]
            .map((line) => `${line.lineId}:${line.supplierId}:${line.quantity}`)
            .sort()
            .join("|");
          const existing = prior
            .map((line) => `${line.requisitionLineId}:${line.supplierId}:${line.quantityOrdered}`)
            .sort()
            .join("|");
          if (requested !== existing) {
            throw Object.assign(new Error("Idempotency key was already used with a different conversion"), { status: 409 });
          }
          createdPoIds.push(...new Set(prior.map((line) => line.purchaseOrderId)));
          replay = true;
          return;
        }
        if (!["approved", "partially_ordered", "partially_fulfilled"].includes(header.status)) {
          throw Object.assign(new Error(`Cannot convert a ${header.status} requisition`), { status: 422 });
        }

        const supplierIds = [...new Set(parsed.data.lines.map((line) => line.supplierId))];
        const suppliers = await tx
          .select({ id: suppliersTable.id, status: suppliersTable.status })
          .from(suppliersTable)
          .where(and(eq(suppliersTable.dealerId, dealerId), inArray(suppliersTable.id, supplierIds)))
          .for("update");
        if (
          suppliers.length !== supplierIds.length ||
          suppliers.some((supplier) => supplier.status !== "active")
        ) {
          throw Object.assign(new Error("Every selected supplier must be active in this dealership"), { status: 422 });
        }

        const requestLines = new Map(parsed.data.lines.map((line) => [line.lineId, line]));
        const lines = await tx
          .select()
          .from(partRequisitionLinesTable)
          .where(
            and(
              eq(partRequisitionLinesTable.dealerId, dealerId),
              eq(partRequisitionLinesTable.requisitionId, header.id),
              inArray(partRequisitionLinesTable.id, [...requestLines.keys()]),
            ),
          )
          .orderBy(partRequisitionLinesTable.id)
          .for("update");
        if (lines.length !== requestLines.size) {
          throw Object.assign(new Error("One or more requisition lines were not found"), { status: 404 });
        }
        const existingAllocations = await tx
          .select({
            requisitionLineId: partRequisitionPoAllocationsTable.requisitionLineId,
            quantityOrdered: partRequisitionPoAllocationsTable.quantityOrdered,
          })
          .from(partRequisitionPoAllocationsTable)
          .where(
            and(
              eq(partRequisitionPoAllocationsTable.dealerId, dealerId),
              eq(partRequisitionPoAllocationsTable.requisitionId, header.id),
            ),
          );
        const allocated = new Map<number, number>();
        for (const row of existingAllocations) {
          allocated.set(row.requisitionLineId, (allocated.get(row.requisitionLineId) ?? 0) + row.quantityOrdered);
        }
        for (const line of lines) {
          const requested = requestLines.get(line.id)!;
          const outstanding = line.quantity - (allocated.get(line.id) ?? 0);
          if (requested.quantity > outstanding) {
            throw Object.assign(
              new Error(`Line #${line.id} has only ${outstanding} unit(s) available to allocate`),
              { status: 422 },
            );
          }
        }

        const bySupplier = new Map<number, typeof lines>();
        for (const line of lines) {
          const supplierId = requestLines.get(line.id)!.supplierId;
          const group = bySupplier.get(supplierId) ?? [];
          group.push(line);
          bySupplier.set(supplierId, group);
        }
        for (const [supplierId, group] of bySupplier) {
          const [po] = await tx
            .insert(purchaseOrdersTable)
            .values({
              dealerId,
              supplierId,
              status: "ordered",
              expectedDate:
                parsed.data.expectedDate instanceof Date
                  ? parsed.data.expectedDate.toISOString().slice(0, 10)
                  : parsed.data.expectedDate,
              reference: `REQ-${header.id}-${parsed.data.idempotencyKey}`,
              notes: parsed.data.notes ?? `Created from requisition #${header.id}`,
            })
            .returning();
          createdPoIds.push(po.id);
          for (const line of group) {
            const requested = requestLines.get(line.id)!;
            const [poLine] = await tx
              .insert(purchaseOrderLinesTable)
              .values({
                dealerId,
                purchaseOrderId: po.id,
                partId: line.partId,
                source: line.source,
                partName: line.descriptionSnapshot,
                quantity: requested.quantity,
                unitCost: requested.unitCost ?? line.unitCost,
                jobCardId: header.jobCardId,
              })
              .returning();
            await tx.insert(partRequisitionPoAllocationsTable).values({
              dealerId,
              requisitionId: header.id,
              requisitionLineId: line.id,
              supplierId,
              purchaseOrderId: po.id,
              purchaseOrderLineId: poLine.id,
              idempotencyKey: parsed.data.idempotencyKey,
              quantityOrdered: requested.quantity,
            });
            allocated.set(line.id, (allocated.get(line.id) ?? 0) + requested.quantity);
          }
        }
        const allLines = await tx
          .select({ id: partRequisitionLinesTable.id, quantity: partRequisitionLinesTable.quantity })
          .from(partRequisitionLinesTable)
          .where(
            and(
              eq(partRequisitionLinesTable.dealerId, dealerId),
              eq(partRequisitionLinesTable.requisitionId, header.id),
            ),
          );
        const complete = allLines.every((line) => (allocated.get(line.id) ?? 0) >= line.quantity);
        const nextStatus =
          header.status === "partially_fulfilled"
            ? "partially_fulfilled"
            : complete
              ? "ordered"
              : "partially_ordered";
        await tx
          .update(partRequisitionsTable)
          .set({
            status: nextStatus,
            orderedByUserId: res.locals.user?.id ?? null,
            orderedByName: actorName(res.locals.user),
            ...(complete ? { orderedAt: new Date() } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(partRequisitionsTable.id, header.id), eq(partRequisitionsTable.dealerId, dealerId)));
      });
    } catch (error) {
      const failure = error as Error & { status?: number };
      if (failure.status) {
        res.status(failure.status).json({ error: failure.message });
        return;
      }
      throw error;
    }
    if (!replay) {
      for (const poId of createdPoIds) enqueuePurchaseOrderSync(dealerId, poId, "insert");
    }
    const purchaseOrders = [];
    for (const poId of createdPoIds) {
      const [po] = await db
        .select()
        .from(purchaseOrdersTable)
        .where(and(eq(purchaseOrdersTable.id, poId), eq(purchaseOrdersTable.dealerId, dealerId)));
      const lines = await db
        .select()
        .from(purchaseOrderLinesTable)
        .where(and(eq(purchaseOrderLinesTable.purchaseOrderId, poId), eq(purchaseOrderLinesTable.dealerId, dealerId)));
      purchaseOrders.push({ ...po, lines });
    }
    const result = {
      requisition: await loadDetail(dealerId, params.data.id),
      purchaseOrders,
    };
    res.status(replay ? 200 : 201).json(ConvertPartRequisitionToPurchaseOrdersResponse.parse(result));
  },
);

router.post("/part-requisitions/:id/cancel", async (req, res): Promise<void> => {
  const params = CancelPartRequisitionParams.safeParse(req.params);
  const parsed = CancelPartRequisitionBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: (params.success ? parsed : params).error?.message ?? "Invalid" });
    return;
  }
  const dealerId = activeDealerId(res);
  try {
    await db.transaction(async (tx) => {
      const [header] = await tx
        .select()
        .from(partRequisitionsTable)
        .where(and(eq(partRequisitionsTable.id, params.data.id), eq(partRequisitionsTable.dealerId, dealerId)))
        .for("update");
      if (!header) throw Object.assign(new Error("Requisition not found"), { status: 404 });
      const requesterBeforeApproval =
        header.status === "submitted" && header.requesterUserId === res.locals.user?.id;
      if (!requesterBeforeApproval && !canProcess(res.locals.user)) {
        throw Object.assign(
          new Error("Only the requester before approval, or a service approver/Parts processor after approval, may cancel"),
          { status: 403 },
        );
      }
      const links = await tx
        .select({
          purchaseOrderId: partRequisitionPoAllocationsTable.purchaseOrderId,
          quantityReceived: partRequisitionPoAllocationsTable.quantityReceived,
          poStatus: purchaseOrdersTable.status,
        })
        .from(partRequisitionPoAllocationsTable)
        .innerJoin(
          purchaseOrdersTable,
          and(
            eq(purchaseOrdersTable.id, partRequisitionPoAllocationsTable.purchaseOrderId),
            eq(purchaseOrdersTable.dealerId, partRequisitionPoAllocationsTable.dealerId),
          ),
        )
        .where(
          and(
            eq(partRequisitionPoAllocationsTable.dealerId, dealerId),
            eq(partRequisitionPoAllocationsTable.requisitionId, header.id),
          ),
        );
      if (links.some((link) => link.quantityReceived > 0)) {
        throw Object.assign(new Error("Cannot cancel: linked purchase-order goods have been received"), { status: 409 });
      }
      if (["rejected", "fulfilled", "cancelled"].includes(header.status)) {
        throw Object.assign(new Error(`Cannot cancel a ${header.status} requisition`), { status: 422 });
      }
      if (links.some((link) => link.poStatus !== "cancelled")) {
        throw Object.assign(
          new Error(`Cancel linked purchase order(s) ${[...new Set(links.map((l) => l.purchaseOrderId))].join(", ")} first`),
          { status: 409 },
        );
      }
      await tx
        .update(partRequisitionsTable)
        .set({
          status: "cancelled",
          cancellationReason: parsed.data.reason.trim(),
          cancelledByUserId: res.locals.user?.id ?? null,
          cancelledByName: actorName(res.locals.user),
          cancelledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(partRequisitionsTable.id, header.id), eq(partRequisitionsTable.dealerId, dealerId)));
    });
  } catch (error) {
    const failure = error as Error & { status?: number };
    if (failure.status) {
      res.status(failure.status).json({ error: failure.message });
      return;
    }
    throw error;
  }
  res.json(CancelPartRequisitionResponse.parse(await loadDetail(dealerId, params.data.id)));
});

router.post("/part-requisitions/:id/fulfill", async (req, res): Promise<void> => {
  const params = FulfillPartRequisitionParams.safeParse(req.params);
  const parsed = FulfillPartRequisitionBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: (params.success ? parsed : params).error?.message ?? "Invalid" });
    return;
  }
  if (rejectProcessor(res)) return;
  if (new Set(parsed.data.lines.map((line) => line.lineId)).size !== parsed.data.lines.length) {
    res.status(422).json({ error: "Each requisition line may appear only once per fulfillment" });
    return;
  }
  const dealerId = activeDealerId(res);
  const user = res.locals.user;
  const issuedInternal: Array<{
    partId: number;
    quantity: number;
    jobCardId: number;
    jobCardPartId: number;
    part: typeof partsTable.$inferSelect;
    previousStock: number;
  }> = [];
  try {
    await db.transaction(async (tx) => {
      const [header] = await tx
        .select()
        .from(partRequisitionsTable)
        .where(and(eq(partRequisitionsTable.id, params.data.id), eq(partRequisitionsTable.dealerId, dealerId)))
        .for("update");
      if (!header) throw Object.assign(new Error("Requisition not found"), { status: 404 });
      if (header.jobCardId == null) {
        throw Object.assign(
          new Error("Inventory restock requisitions are fulfilled by receiving their purchase order"),
          { status: 422 },
        );
      }
      const jobCardId = header.jobCardId;
      const [jobCard] = await tx.select().from(jobCardsTable).where(and(
        eq(jobCardsTable.id, jobCardId),
        eq(jobCardsTable.dealerId, dealerId),
      )).for("update");
      if (!jobCard) throw Object.assign(new Error("Linked job card was not found"), { status: 409 });
      if (header.status === "fulfilled") {
        const prior = await tx
          .select({ lineId: partRequisitionFulfillmentsTable.lineId })
          .from(partRequisitionFulfillmentsTable)
          .where(
            and(
              eq(partRequisitionFulfillmentsTable.dealerId, dealerId),
              eq(partRequisitionFulfillmentsTable.requisitionId, header.id),
              eq(partRequisitionFulfillmentsTable.idempotencyKey, parsed.data.idempotencyKey),
            ),
          );
        const priorIds = new Set(prior.map((row) => row.lineId));
        if (parsed.data.lines.every((line) => priorIds.has(line.lineId))) return;
      }
       if (!["approved", "partially_ordered", "ordered", "partially_fulfilled"].includes(header.status)) {
        throw Object.assign(new Error(`Cannot fulfill a ${header.status} requisition`), { status: 422 });
      }
      const [invoice] = await tx
        .select({ id: serviceInvoicesTable.id })
        .from(serviceInvoicesTable)
        .where(and(eq(serviceInvoicesTable.dealerId, dealerId), eq(serviceInvoicesTable.jobCardId, jobCardId)));
      if (invoice) throw Object.assign(new Error(`Invoice #${invoice.id} is already issued`), { status: 422 });

      // A version captures the immutable itemized quote, not just its total.
      // Even a zero-price fulfillment changes the customer-visible lines and
      // must therefore revoke any prior decision/acknowledgement.
      let quoteChanged = false;
      for (const requestLine of parsed.data.lines) {
        const [prior] = await tx
          .select({ id: partRequisitionFulfillmentsTable.id })
          .from(partRequisitionFulfillmentsTable)
          .where(
            and(
              eq(partRequisitionFulfillmentsTable.dealerId, dealerId),
              eq(partRequisitionFulfillmentsTable.requisitionId, header.id),
              eq(partRequisitionFulfillmentsTable.lineId, requestLine.lineId),
              eq(partRequisitionFulfillmentsTable.idempotencyKey, parsed.data.idempotencyKey),
            ),
          );
        if (prior) continue;
        const [line] = await tx
          .select()
          .from(partRequisitionLinesTable)
          .where(
            and(
              eq(partRequisitionLinesTable.id, requestLine.lineId),
              eq(partRequisitionLinesTable.requisitionId, header.id),
              eq(partRequisitionLinesTable.dealerId, dealerId),
            ),
          )
          .for("update");
        if (!line) throw Object.assign(new Error(`Line #${requestLine.lineId} not found`), { status: 404 });
        if (line.source === "EXTERNAL") {
          throw Object.assign(new Error(`External line #${line.id} is attached automatically when its PO is received`), { status: 422 });
        }
        if (requestLine.quantity > line.quantity - line.fulfilledQuantity) {
          throw Object.assign(new Error(`Line #${line.id} has only ${line.quantity - line.fulfilledQuantity} unit(s) outstanding`), { status: 422 });
        }
        const [fulfillment] = await tx
          .insert(partRequisitionFulfillmentsTable)
          .values({
            dealerId,
            requisitionId: header.id,
            lineId: line.id,
            idempotencyKey: parsed.data.idempotencyKey,
            quantity: requestLine.quantity,
            fulfilledByUserId: user?.id ?? null,
            fulfilledByName: actorName(user),
          })
          .returning();
        if (line.source === "INTERNAL") {
          const [beforePart] = await tx
            .select()
            .from(partsTable)
            .where(and(eq(partsTable.id, line.partId!), eq(partsTable.dealerId, dealerId)))
            .for("update");
          if (!beforePart) {
            throw Object.assign(new Error(`Part not found for ${line.descriptionSnapshot}`), { status: 404 });
          }
          const [part] = await tx
            .update(partsTable)
            .set({ stock: sql`${partsTable.stock} - ${requestLine.quantity}` })
            .where(
              and(
                eq(partsTable.id, line.partId!),
                eq(partsTable.dealerId, dealerId),
                sql`${partsTable.stock} >= ${requestLine.quantity}`,
              ),
            )
            .returning();
          if (!part) {
            throw Object.assign(new Error(`Insufficient current stock for ${line.descriptionSnapshot}`), { status: 409 });
          }
          const [jobLine] = await tx
            .insert(jobCardPartsTable)
            .values({
              dealerId,
              jobCardId,
              partId: part.id,
              partName: line.descriptionSnapshot,
              kind: "issue",
              quantity: requestLine.quantity,
              unitPrice: line.unitPrice,
              unitCost: line.unitCost,
              backordered: false,
            })
            .returning({ id: jobCardPartsTable.id });
          await tx
            .update(partRequisitionFulfillmentsTable)
            .set({ jobCardPartId: jobLine.id })
            .where(eq(partRequisitionFulfillmentsTable.id, fulfillment.id));
          issuedInternal.push({
            partId: part.id,
            quantity: requestLine.quantity,
            jobCardId,
            jobCardPartId: jobLine.id,
            part,
            previousStock: beforePart.stock,
          });
        } else {
          const [externalLine] = await tx
            .insert(externalJobCardPartsTable)
            .values({
              dealerId,
              jobCardId,
              requisitionLineId: line.id,
              fulfillmentId: fulfillment.id,
              description: `External part — ${line.descriptionSnapshot}`,
              supplierSnapshot: line.supplierSnapshot,
              quantity: requestLine.quantity,
              unitCost: line.unitCost,
              unitPrice: line.unitPrice,
              taxCost: line.taxCost,
              freightCost: line.freightCost,
            })
            .returning({ id: externalJobCardPartsTable.id });
          await tx
            .update(partRequisitionFulfillmentsTable)
            .set({ externalJobCardPartId: externalLine.id })
            .where(eq(partRequisitionFulfillmentsTable.id, fulfillment.id));
        }
        // Both internal and external fulfillments materialize a billable
        // customer quote line. Do not key the reprice on numeric delta: an
        // external-only fulfillment (and a zero-price line) still changes the
        // canonical immutable snapshot.
        quoteChanged = true;
        await tx
          .update(partRequisitionLinesTable)
          .set({ fulfilledQuantity: line.fulfilledQuantity + requestLine.quantity })
          .where(eq(partRequisitionLinesTable.id, line.id));
      }
      if (quoteChanged) {
        const breakdown = await buildServiceEstimateBreakdown(tx, jobCard);
        await tx.update(jobCardsTable).set({
          quoteTotal: breakdown.total,
          estimateVersion: sql`${jobCardsTable.estimateVersion} + 1`,
          estimateApprovedVersion: null,
          estimateApprovalAt: null,
          estimateApprovalEvidence: null,
          quoteApprovedAt: null,
          ...clearEstimateStaffAcknowledgement,
        }).where(and(
          eq(jobCardsTable.id, jobCard.id),
          eq(jobCardsTable.dealerId, dealerId),
          eq(jobCardsTable.estimateVersion, jobCard.estimateVersion),
        ));
        await invalidateServiceEstimate(tx, dealerId, jobCard.id);
      }
      const freshLines = await tx
        .select({ quantity: partRequisitionLinesTable.quantity, fulfilledQuantity: partRequisitionLinesTable.fulfilledQuantity })
        .from(partRequisitionLinesTable)
        .where(and(eq(partRequisitionLinesTable.dealerId, dealerId), eq(partRequisitionLinesTable.requisitionId, header.id)));
      const complete = freshLines.every((line) => line.fulfilledQuantity >= line.quantity);
      await tx
        .update(partRequisitionsTable)
        .set({
          status: complete ? "fulfilled" : "partially_fulfilled",
          fulfilledByUserId: user?.id ?? null,
          fulfilledByName: actorName(user),
          fulfilledAt: complete ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(and(eq(partRequisitionsTable.id, header.id), eq(partRequisitionsTable.dealerId, dealerId)));
    });
  } catch (error) {
    const failure = error as Error & { status?: number };
    if (failure.status) {
      res.status(failure.status).json({ error: failure.message });
      return;
    }
    throw error;
  }
  for (const issue of issuedInternal) {
    checkLowStockCrossing(issue.part, issue.previousStock, issue.part.stock);
    enqueueStockEntrySync({
      dealerId,
      partId: issue.partId,
      qty: issue.quantity,
      direction: "out",
      entityType: "job_card_part",
      entityId: issue.jobCardPartId,
      remark: `AURA job card #${issue.jobCardId} — requisition issue`,
      dedupeKey: `erp:se:jcp:${dealerId}:${issue.jobCardPartId}`,
    });
  }
  res.json(FulfillPartRequisitionResponse.parse(await loadDetail(dealerId, params.data.id)));
});

export default router;