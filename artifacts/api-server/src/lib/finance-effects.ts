import { eq, inArray, and } from "drizzle-orm";
import {
  db,
  dealsTable,
  gatesTable,
  timelineEventsTable,
  usersTable,
  dealerUsersTable,
  rolePermissionsTable,
  financeApplicationsTable,
  type FinanceApplication,
  type FinanceStatusEvent,
} from "@workspace/db";
import { onFinanceStatusChanged, onDealStageChanged } from "./email-triggers";
import { notifyUsers } from "./email";
import { ensureDeliveryForDeal } from "./delivery";
import { ensureFinalInvoiceForDeal } from "./invoicing";
import { logger } from "./logger";

const money = (n: number) =>
  `GY$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

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

async function financeUserIds(dealerId: number): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(
      rolePermissionsTable,
      eq(rolePermissionsTable.roleId, dealerUsersTable.roleId),
    )
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(rolePermissionsTable.module, "finance"),
        // view is the explicit visibility switch — admin does not imply it
        eq(rolePermissionsTable.category, "view"),
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
      dealerId: app.dealerId,
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
    const ids = await financeUserIds(app.dealerId);
    await notifyUsers(ids, {
      dealerId: app.dealerId,
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
        dealerId: app.dealerId,
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
        dealerId: app.dealerId,
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
          // Dual-invoice #2 (L6): auto-commit must also generate the final
          // settlement invoice, same as the manual PATCH commit path.
          try {
            await ensureFinalInvoiceForDeal(updated);
          } catch (err) {
            logger.error(
              { err, dealId: updated.id },
              "final invoice generation failed on auto-commit",
            );
          }
          onDealStageChanged(deal, updated);
          await db.insert(timelineEventsTable).values({
            dealerId: app.dealerId,
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
    // Safety net: approval normally opens the delivery workflow, but if that
    // trigger failed (restart, transient error) the deal would sit Committed
    // with no delivery to complete. ensureDeliveryForDeal is idempotent.
    try {
      await ensureDeliveryForDeal(app.dealId, {
        cause: `Finance application #${app.id} disbursed`,
      });
    } catch (err) {
      logger.error({ err, appId: app.id }, "delivery workflow start failed");
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
