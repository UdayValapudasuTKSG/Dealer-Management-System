import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  db,
  customersTable,
  dealersTable,
  jobCardsTable,
  jobCardPartsTable,
  serviceEstimateDecisionsTable,
  serviceOrdersTable,
  timelineEventsTable,
  type ServiceEstimateLine,
  type ServiceEstimateDecision,
} from "@workspace/db";
import {
  DecidePublicServiceEstimateBody,
  DecidePublicServiceEstimateParams,
  DecidePublicServiceEstimateResponse,
  GetPublicServiceEstimateParams,
  GetPublicServiceEstimateResponse,
} from "@workspace/api-zod";
import { enqueueEmail } from "../lib/email";

const router: IRouter = Router();
const INVALID = { error: "This estimate link is not valid" };
const EXPIRED = { error: "This estimate link has expired" };

const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

async function estimateStillMatches(
  tx: any,
  row: ServiceEstimateDecision,
): Promise<boolean> {
  const [card] = await tx
    .select({
      quoteTotal: jobCardsTable.quoteTotal,
      laborHours: jobCardsTable.laborHours,
      laborRate: jobCardsTable.laborRate,
    })
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, row.jobCardId),
        eq(jobCardsTable.serviceOrderId, row.serviceOrderId),
        eq(jobCardsTable.dealerId, row.dealerId),
      ),
    );
  if (!card || card.quoteTotal !== row.estimateTotal) return false;
  const parts = (await tx
    .select()
    .from(jobCardPartsTable)
    .where(
      and(
        eq(jobCardPartsTable.dealerId, row.dealerId),
        eq(jobCardPartsTable.jobCardId, row.jobCardId),
      ),
    )
    .orderBy(jobCardPartsTable.id)) as Array<{
      kind: string;
      partName: string;
      quantity: number;
      unitPrice: number;
    }>;
  const current: ServiceEstimateLine[] = parts
    .filter((part) => part.kind === "issue")
    .map((part) => ({
      kind: "part" as const,
      description: part.partName,
      quantity: part.quantity,
      amount: part.quantity * part.unitPrice,
    }));
  if (card.laborHours > 0) {
    current.push({
      kind: "labour",
      description: "Labour",
      quantity: card.laborHours,
      amount: card.laborHours * card.laborRate,
    });
  }
  const canonicalize = (lines: ServiceEstimateLine[]) =>
    lines
      .map((line) => ({
        kind: line.kind,
        description: line.description.trim(),
        quantity: line.quantity == null ? null : Number(line.quantity),
        amount: Number(line.amount),
      }))
      .sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) ||
          a.description.localeCompare(b.description) ||
          (a.quantity ?? 0) - (b.quantity ?? 0) ||
          a.amount - b.amount,
      );
  return (
    JSON.stringify(canonicalize(current)) ===
    JSON.stringify(canonicalize(row.linesSnapshot))
  );
}

async function findDecision(token: string): Promise<ServiceEstimateDecision | null> {
  const [row] = await db
    .select()
    .from(serviceEstimateDecisionsTable)
    .where(eq(serviceEstimateDecisionsTable.tokenHash, digest(token)))
    .limit(1);
  return row ?? null;
}

async function serialize(row: ServiceEstimateDecision) {
  // All related records must match the token-bound dealer and entity ids.
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, row.serviceOrderId),
        eq(serviceOrdersTable.dealerId, row.dealerId),
      ),
    );
  const [card] = await db
    .select({ id: jobCardsTable.id })
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, row.jobCardId),
        eq(jobCardsTable.serviceOrderId, row.serviceOrderId),
        eq(jobCardsTable.dealerId, row.dealerId),
      ),
    );
  const [dealer] = await db
    .select({ name: dealersTable.name, brandName: dealersTable.brandName })
    .from(dealersTable)
    .where(eq(dealersTable.id, row.dealerId));
  if (!order || !card || !dealer) return null;
  return {
    state: row.decision ?? "open",
    brandName: dealer.brandName || dealer.name,
    vehicle: order.vehicleInfo,
    service: order.type,
    total: row.estimateTotal,
    lines: row.linesSnapshot,
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

router.get("/service-estimates/:token", async (req, res): Promise<void> => {
  const params = GetPublicServiceEstimateParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json(INVALID);
    return;
  }
  const row = await findDecision(params.data.token);
  if (!row || !(await serialize(row))) {
    res.status(404).json(INVALID);
    return;
  }
  if (!row.decision && row.expiresAt.getTime() <= Date.now()) {
    res.status(410).json(EXPIRED);
    return;
  }
  res.json(GetPublicServiceEstimateResponse.parse(await serialize(row)));
});

router.post("/service-estimates/:token", async (req, res): Promise<void> => {
  const params = DecidePublicServiceEstimateParams.safeParse(req.params);
  const body = DecidePublicServiceEstimateBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(params.success ? 422 : 404).json(
      params.success ? { error: "Invalid decision" } : INVALID,
    );
    return;
  }
  const row = await findDecision(params.data.token);
  if (!row || !(await serialize(row))) {
    res.status(404).json(INVALID);
    return;
  }
  if (row.decision || row.invalidatedAt) {
    res.status(409).json({ error: "This estimate was already decided" });
    return;
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    res.status(410).json(EXPIRED);
    return;
  }
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    if (!(await estimateStillMatches(tx, row))) return null;
    // Lock/mutate the current job card first. Its total must still equal the
    // immutable token snapshot; an advisor revision therefore wins safely and
    // causes a stale link to fail closed.
    if (body.data.decision === "approved") {
      const [card] = await tx
        .update(jobCardsTable)
        .set({ quoteApprovedAt: now })
        .where(
          and(
            eq(jobCardsTable.id, row.jobCardId),
            eq(jobCardsTable.serviceOrderId, row.serviceOrderId),
            eq(jobCardsTable.dealerId, row.dealerId),
            eq(jobCardsTable.quoteTotal, row.estimateTotal),
            isNull(jobCardsTable.quoteApprovedAt),
          ),
        )
        .returning({ id: jobCardsTable.id });
      if (!card) return null;
    }
    const [decision] = await tx
      .update(serviceEstimateDecisionsTable)
      .set({ decision: body.data.decision, decidedAt: now })
      .where(
        and(
          eq(serviceEstimateDecisionsTable.id, row.id),
          eq(serviceEstimateDecisionsTable.dealerId, row.dealerId),
          eq(serviceEstimateDecisionsTable.serviceOrderId, row.serviceOrderId),
          eq(serviceEstimateDecisionsTable.jobCardId, row.jobCardId),
          eq(serviceEstimateDecisionsTable.estimateTotal, row.estimateTotal),
          isNull(serviceEstimateDecisionsTable.decision),
          isNull(serviceEstimateDecisionsTable.invalidatedAt),
          gt(serviceEstimateDecisionsTable.expiresAt, now),
        ),
      )
      .returning();
    // A declined estimate has no job-card mutation but still commits the CAS
    // in this transaction; an approval whose CAS loses rolls back its card set.
    if (!decision) throw new Error("estimate_decision_conflict");
    return decision;
  }).catch((error) => {
    if (error instanceof Error && error.message === "estimate_decision_conflict") return null;
    throw error;
  });
  if (!updated) {
    res.status(409).json({ error: "This estimate was already decided" });
    return;
  }
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, row.serviceOrderId),
        eq(serviceOrdersTable.dealerId, row.dealerId),
      ),
    );
  if (order?.customerId != null) {
    await db.insert(timelineEventsTable).values({
      dealerId: row.dealerId,
      customerId: order.customerId,
      domain: "service",
      kind: "service_estimate_decided",
      title: `Service estimate ${body.data.decision}`,
      detail: `Customer ${body.data.decision} the whole estimate.`,
      actor: "Customer",
      isAgent: false,
      refType: "service_order",
      refId: row.serviceOrderId,
    });
    const [customer] = await db
      .select({ email: customersTable.email })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, order.customerId),
          eq(customersTable.dealerId, row.dealerId),
        ),
      );
    if (customer?.email) {
      await enqueueEmail({
        dealerId: row.dealerId,
        template: "service.estimate.decision",
        to: customer.email,
        customerId: order.customerId,
        dedupeKey: `svc:${row.serviceOrderId}:estimate-decision:${row.id}`,
        data: {
          decision: body.data.decision === "approved" ? "approve" : "decline",
          vehicle: order.vehicleInfo,
          total: `GY$${row.estimateTotal.toLocaleString("en-US")}`,
        },
      });
    }
  }
  res.json(DecidePublicServiceEstimateResponse.parse(await serialize(updated)));
});

export default router;