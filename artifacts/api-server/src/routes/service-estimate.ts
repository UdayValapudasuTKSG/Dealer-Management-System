import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import {
  db,
  customersTable,
  dealersTable,
  jobCardsTable,
  serviceEstimateDecisionsTable,
  serviceOrdersTable,
  timelineEventsTable,
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
import {
  buildServiceEstimateBreakdown,
  serviceEstimateLinesMatch,
} from "../lib/service-estimate-breakdown";
import { clearEstimateStaffAcknowledgement } from "../lib/service-estimate-gate";

const router: IRouter = Router();
const INVALID = { error: "This estimate link is not valid" };
const EXPIRED = { error: "This estimate link has expired" };

const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** The locked card and immutable token must describe the exact same price. */
async function estimateStillMatches(
  tx: any,
  card: {
    id: number;
    dealerId: number;
    serviceOrderId: number;
    quoteTotal: number;
    estimateVersion: number;
    laborHours: number;
    laborRate: number;
    surchargeStatus: string;
    surchargeAmount: number;
  },
  row: ServiceEstimateDecision,
): Promise<boolean> {
  if (
    card.id !== row.jobCardId ||
    card.dealerId !== row.dealerId ||
    card.serviceOrderId !== row.serviceOrderId ||
    Math.round(card.quoteTotal * 100) !== Math.round(row.estimateTotal * 100) ||
    card.estimateVersion !== row.estimateVersion
  ) return false;
  const current = await buildServiceEstimateBreakdown(tx, card);
  return (
    Math.round(current.total * 100) === Math.round(row.estimateTotal * 100) &&
    serviceEstimateLinesMatch(current.lines, row.linesSnapshot)
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
    state: row.invalidatedAt
      ? "stale"
      : row.decision ?? (row.expiresAt.getTime() <= Date.now() ? "expired" : "open"),
    brandName: dealer.brandName || dealer.name,
    vehicle: order.vehicleInfo,
    service: order.type,
    total: row.estimateTotal,
    estimateVersion: row.estimateVersion,
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
  if (row.invalidatedAt) {
    res.status(409).json({ error: "This estimate is stale — use the latest link sent by the dealership." });
    return;
  }
  if (row.decision) {
    res.status(409).json({ error: "This estimate was already decided" });
    return;
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    res.status(410).json(EXPIRED);
    return;
  }
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    // Find from the bearer digest, then lock the job card before making any
    // decision. Every send/reprice path uses the same lock, so a stale token
    // can never win a concurrent charge revision.
    const [bound] = await tx
      .select()
      .from(serviceEstimateDecisionsTable)
      .where(
        and(
          eq(serviceEstimateDecisionsTable.id, row.id),
          eq(serviceEstimateDecisionsTable.tokenHash, digest(params.data.token)),
        ),
      )
      .limit(1);
    if (!bound) return null;
    const [card] = await tx
      .select()
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.id, bound.jobCardId),
          eq(jobCardsTable.dealerId, bound.dealerId),
          eq(jobCardsTable.serviceOrderId, bound.serviceOrderId),
        ),
      )
      .for("update");
    if (!card) return null;
    const [locked] = await tx
      .select()
      .from(serviceEstimateDecisionsTable)
      .where(eq(serviceEstimateDecisionsTable.id, bound.id))
      .for("update");
    if (
      !locked ||
      locked.invalidatedAt ||
      locked.decision ||
      locked.expiresAt.getTime() <= now.getTime() ||
      !(await estimateStillMatches(tx, card, locked))
    ) return null;
    // A historic concurrent sender might have left a duplicate token. Only
    // one active decision may ever settle a version; fail closed rather than
    // letting a later decline contradict an already approved quote.
    const [otherActive] = await tx
      .select({ id: serviceEstimateDecisionsTable.id })
      .from(serviceEstimateDecisionsTable)
      .where(
        and(
          eq(serviceEstimateDecisionsTable.dealerId, locked.dealerId),
          eq(serviceEstimateDecisionsTable.jobCardId, locked.jobCardId),
          eq(serviceEstimateDecisionsTable.estimateVersion, locked.estimateVersion),
          isNull(serviceEstimateDecisionsTable.invalidatedAt),
          ne(serviceEstimateDecisionsTable.id, locked.id),
        ),
      )
      .limit(1);
    if (otherActive) return null;
    const [decision] = await tx
      .update(serviceEstimateDecisionsTable)
      .set({
        decision: body.data.decision,
        decidedAt: now,
        decisionEvidence: {
          method: "secure_customer_estimate_link",
          version: locked.estimateVersion,
          decidedAt: now.toISOString(),
        },
      })
      .where(
        and(
          eq(serviceEstimateDecisionsTable.id, locked.id),
          isNull(serviceEstimateDecisionsTable.decision),
          isNull(serviceEstimateDecisionsTable.invalidatedAt),
          gt(serviceEstimateDecisionsTable.expiresAt, now),
        ),
      )
      .returning();
    if (!decision) throw new Error("estimate_decision_conflict");
    if (body.data.decision === "approved") {
      const [approved] = await tx
        .update(jobCardsTable)
        .set({
          quoteApprovedAt: now,
          estimateApprovedVersion: locked.estimateVersion,
          estimateApprovalAt: now,
          estimateApprovalEvidence: {
            method: "secure_customer_estimate_link",
            decisionId: locked.id,
            version: locked.estimateVersion,
            decidedAt: now.toISOString(),
          },
          ...clearEstimateStaffAcknowledgement,
        })
        .where(
          and(
            eq(jobCardsTable.id, card.id),
            eq(jobCardsTable.estimateVersion, locked.estimateVersion),
            eq(jobCardsTable.quoteTotal, locked.estimateTotal),
            isNull(jobCardsTable.estimateApprovedVersion),
          ),
        )
        .returning({ id: jobCardsTable.id });
      if (!approved) throw new Error("estimate_decision_conflict");
    } else {
      // A resend or old duplicate must never leave an earlier approval
      // effective after the customer has declined this exact version.
      await tx
        .update(jobCardsTable)
        .set({
          quoteApprovedAt: null,
          estimateApprovedVersion: null,
          estimateApprovalAt: null,
          estimateApprovalEvidence: null,
          ...clearEstimateStaffAcknowledgement,
        })
        .where(
          and(
            eq(jobCardsTable.id, card.id),
            eq(jobCardsTable.estimateVersion, locked.estimateVersion),
            eq(jobCardsTable.estimateApprovedVersion, locked.estimateVersion),
          ),
        );
    }
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