import { eq, inArray, and } from "drizzle-orm";
import {
  db,
  dealsTable,
  gatesTable,
  timelineEventsTable,
  usersTable,
  rolePermissionsTable,
  financeApplicationsTable,
  type FinanceApplication,
  type FinanceStatusEvent,
} from "@workspace/db";
import { onFinanceStatusChanged, onDealStageChanged } from "./email-triggers";
import { notifyUsers } from "./email";
import { ensureDeliveryForDeal } from "./delivery";
import { logger } from "./logger";

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  submitted: "Submitted",
  under_review: "Under Review",
  approved: "Approved",
  declined: "Rejected",
  disbursed: "Disbursed",
};

export function statusEvent(status: string, note: string): FinanceStatusEvent {
  return { status, note, at: new Date().toISOString() };
}

async function financeUserIds(): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .innerJoin(
      rolePermissionsTable,
      eq(rolePermissionsTable.roleId, usersTable.roleId),
    )
    .where(
      and(
        eq(rolePermissionsTable.module, "finance"),
        inArray(rolePermissionsTable.category, ["view", "admin"]),
        eq(usersTable.status, "active"),
      ),
    );
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * Applies every connected side effect of a finance-application status change:
 * timeline receipt, lifecycle emails, staff notifications, a credit-decline
 * decision gate on rejection, the delivery-workflow trigger on approval, and
 * the automatic deal advance on disbursement. Fire-and-forget safe pieces are
 * wrapped so a failure never breaks the API request.
 */
export async function applyFinanceStatusEffects(
  app: FinanceApplication,
  previousStatus: string,
  note: string,
): Promise<void> {
  if (app.status === previousStatus) return;
  const label = STATUS_LABEL[app.status] ?? app.status;

  try {
    await db.insert(timelineEventsTable).values({
      customerId: app.customerId ?? null,
      domain: "finance",
      kind: `finance_${app.status}`,
      title: `Finance application ${label.toLowerCase()}`,
      detail: note,
      actor: app.losConnector ? `${app.losConnector} LOS` : "Finance desk",
      isAgent: true,
      cause: `Application #${app.id} — ${money(app.amount)} over ${app.termMonths} months`,
      refType: "finance",
      refId: app.id,
    });
  } catch (err) {
    logger.error({ err, appId: app.id }, "finance timeline receipt failed");
  }

  onFinanceStatusChanged(app, app.status);

  try {
    const ids = await financeUserIds();
    await notifyUsers(ids, {
      type: "system",
      title: `Finance application #${app.id} ${label.toLowerCase()}`,
      body: `${app.customerName} — ${money(app.amount)} / ${app.termMonths} mo. ${note}`,
      link: "/finance",
    });
  } catch (err) {
    logger.error({ err, appId: app.id }, "finance notification failed");
  }

  if (app.status === "declined") {
    try {
      await db.insert(gatesTable).values({
        type: "credit_decline",
        status: "pending",
        priority: "high",
        customerId: app.customerId ?? null,
        customerName: app.customerName,
        refType: "finance",
        refId: app.id,
        title: `Credit declined — ${app.customerName}`,
        summary: note,
        recommendation:
          "Review the decline: confirm the adverse decision, or adjust to re-route the file for restructured terms.",
        amount: app.amount,
        evidence: [
          { label: "Amount financed", value: money(app.amount) },
          { label: "Down payment", value: money(app.downPayment) },
          { label: "Term", value: `${app.termMonths} months` },
          { label: "APR", value: `${app.apr}%` },
          ...(app.monthlyIncome != null
            ? [{ label: "Monthly income", value: money(app.monthlyIncome) }]
            : []),
          { label: "Lender", value: app.lender ?? "Demerara Bank" },
        ],
      });
    } catch (err) {
      logger.error({ err, appId: app.id }, "credit decline gate failed");
    }
  }

  if (app.status === "approved") {
    try {
      await db.insert(timelineEventsTable).values({
        customerId: app.customerId ?? null,
        domain: "finance",
        kind: "delivery_workflow_unlocked",
        title: "Delivery workflow unlocked",
        detail:
          "Financing approved — the vehicle booking and delivery workflow can now proceed for this customer.",
        actor: "AURA orchestration",
        isAgent: true,
        cause: `Finance application #${app.id} approved`,
        refType: "finance",
        refId: app.id,
      });
    } catch (err) {
      logger.error({ err, appId: app.id }, "delivery trigger receipt failed");
    }
    if (app.dealId) {
      try {
        await ensureDeliveryForDeal(app.dealId, {
          cause: `Finance application #${app.id} approved`,
        });
      } catch (err) {
        logger.error({ err, appId: app.id }, "delivery workflow start failed");
      }
    }
  }

  if (app.status === "disbursed" && app.dealId) {
    try {
      const [deal] = await db
        .select()
        .from(dealsTable)
        .where(eq(dealsTable.id, app.dealId));
      if (deal && !["committed", "delivered", "lost"].includes(deal.stage)) {
        const [updated] = await db
          .update(dealsTable)
          .set({ stage: "committed" })
          .where(eq(dealsTable.id, deal.id))
          .returning();
        if (updated) {
          onDealStageChanged(deal, updated);
          await db.insert(timelineEventsTable).values({
            customerId: app.customerId ?? null,
            domain: "deals",
            kind: "deal_auto_advanced",
            title: "Deal advanced to Committed",
            detail: `Loan disbursement of ${money(app.amount)} landed — the deal moved to Committed automatically.`,
            actor: "AURA orchestration",
            isAgent: true,
            cause: `Finance application #${app.id} disbursed`,
            refType: "deal",
            refId: deal.id,
          });
        }
      }
    } catch (err) {
      logger.error({ err, appId: app.id }, "deal auto-advance failed");
    }
  }
}

/** Persist a status change + history entry, then run all side effects. */
export async function transitionFinanceStatus(
  appId: number,
  next: FinanceApplication["status"],
  note: string,
  extra: Partial<typeof financeApplicationsTable.$inferInsert> = {},
): Promise<FinanceApplication | null> {
  const [current] = await db
    .select()
    .from(financeApplicationsTable)
    .where(eq(financeApplicationsTable.id, appId));
  if (!current) return null;
  const [updated] = await db
    .update(financeApplicationsTable)
    .set({
      status: next,
      statusHistory: [...current.statusHistory, statusEvent(next, note)],
      ...(next === "approved" || next === "declined"
        ? { decisionAt: new Date() }
        : {}),
      ...(next === "disbursed" ? { disbursedAt: new Date() } : {}),
      ...extra,
    })
    .where(eq(financeApplicationsTable.id, appId))
    .returning();
  if (!updated) return null;
  await applyFinanceStatusEffects(updated, current.status, note);
  return updated;
}
