import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  asc,
  sql,
} from "drizzle-orm";
import {
  db,
  assetsTable,
  customersTable,
  deliveriesTable,
  vehiclesTable,
  emailLogsTable,
  dealersTable,
  leadsTable,
  serviceOrdersTable,
  testDrivesTable,
  usersTable,
} from "@workspace/db";
import { getServiceSettings } from "./service-settings";
import { generalManagers, usersWithPermission } from "./notify-matrix";
import {
  enqueueEmail,
  enqueueWhatsapp,
  notifyUser,
  type TemplateData,
} from "./email";
import { divisionSalesManagers } from "./notify-matrix";
import { autoAssignLead } from "./lead-assignment";
import { logger } from "./logger";

/**
 * R6.2 scheduled-sweep triggers (#3, #4a/4b, #5, #17). Each sweep is
 * idempotent by construction: In-App rows dedupe on their natural key
 * (userId + type + entity), and outbox rows carry the trigger's canonical
 * dedupeKey, so overlapping sweep runs can never double-send.
 */

const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// #3 / #4a / #4b — 48h first-contact SLA on assigned leads.
// A lead still in phase "new" has, by the NC-3 machine, no logged first
// contact (the contact log is exactly what advances it to "contacted").
// ---------------------------------------------------------------------------
async function sweepLeadSla(): Promise<void> {
  const now = Date.now();
  const rows = await db
    .select({
      id: leadsTable.id,
      dealerId: leadsTable.dealerId,
      name: leadsTable.name,
      ownerUserId: leadsTable.ownerUserId,
      divisionId: leadsTable.divisionId,
      stageEnteredAt: leadsTable.stageEnteredAt,
      createdAt: leadsTable.createdAt,
    })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.phase, "new"),
        isNotNull(leadsTable.ownerUserId),
      ),
    );

  for (const lead of rows) {
    const advisorId = lead.ownerUserId;
    if (!advisorId) continue;
    const start = (lead.stageEnteredAt ?? lead.createdAt).getTime();
    const age = now - start;
    try {
      if (age >= 48 * HOUR) {
        // #4a breach → advisor (In-App + Email).
        await notifyUser({
          userId: advisorId,
          dealerId: lead.dealerId,
          type: "lead.sla.breach.advisor",
          title: `SLA breached — ${lead.name}`,
          body: "48 hours have passed with no logged first contact on this lead. Reach out now and log the contact.",
          link: `/pipeline/${lead.id}`,
          entityType: "lead",
          entityId: lead.id,
        });
        await enqueueInternalEmail({
          dealerId: lead.dealerId,
          userId: advisorId,
          template: "lead.sla.breach.advisor",
          dedupeKey: `lead:sla24:breach:${lead.id}:advisor`,
          data: { name: lead.name },
        });
        // #4b breach escalation → reporting manager(s), distinct key.
        // Spec #4b fallback order: explicit reportingManagerUserId first,
        // then the division Sales Manager(s) (which itself falls back to the
        // GMs only when no division SM matches).
        const explicit = await explicitReportingManager(
          lead.dealerId,
          advisorId,
        );
        let managers =
          explicit != null
            ? [explicit]
            : await divisionSalesManagers(
                lead.dealerId,
                lead.divisionId ?? null,
              );
        managers = managers.filter((id) => id !== advisorId);
        for (const managerId of managers) {
          await notifyUser({
            userId: managerId,
            dealerId: lead.dealerId,
            type: "lead.sla.breach.manager",
            title: `SLA breach escalation — ${lead.name}`,
            body: "An assigned lead passed the 48h first-contact SLA with no outreach logged. Review with the advisor.",
            link: `/pipeline/${lead.id}`,
            entityType: "lead",
            entityId: lead.id,
          });
          await enqueueInternalEmail({
            dealerId: lead.dealerId,
            userId: managerId,
            template: "lead.sla.breach.manager",
            dedupeKey: `lead:sla24:breach:${lead.id}:manager:u${managerId}`,
            data: { name: lead.name },
          });
        }
      } else if (age >= 44 * HOUR) {
        // #3 approaching (~T-4h) → advisor In-App reminder (one per window).
        // Spec adds WhatsApp "if advisor opted in" — advisors have no stored
        // phone/opt-in today, so In-App (the guaranteed floor) is the only
        // deliverable channel for this internal reminder.
        await notifyUser({
          userId: advisorId,
          dealerId: lead.dealerId,
          type: "lead.sla.reminder",
          title: `First-contact SLA closing — ${lead.name}`,
          body: "Less than 4 hours remain on the 48h first-contact SLA. Make contact and log it to stop the clock.",
          link: `/pipeline/${lead.id}`,
          entityType: "lead",
          entityId: lead.id,
        });
      }
    } catch (err) {
      logger.error({ err, leadId: lead.id }, "lead SLA sweep item failed");
    }
  }
}

/** Explicit reporting manager from the employee master, or null. */
async function explicitReportingManager(
  dealerId: number,
  userId: number,
): Promise<number | null> {
  const { dealerUsersTable } = await import("@workspace/db");
  const [row] = await db
    .select({ managerId: dealerUsersTable.reportingManagerUserId })
    .from(dealerUsersTable)
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(dealerUsersTable.userId, userId),
      ),
    );
  return row?.managerId ?? null;
}

/** Email an internal user by id via the outbox (skips users without email). */
async function enqueueInternalEmail(opts: {
  dealerId: number;
  userId: number;
  template: Parameters<typeof enqueueEmail>[0]["template"];
  dedupeKey: string;
  data: TemplateData;
}): Promise<void> {
  const { usersTable } = await import("@workspace/db");
  const [user] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, opts.userId));
  if (!user?.email) return;
  await enqueueEmail({
    template: opts.template,
    to: user.email,
    dealerId: opts.dealerId,
    data: opts.data,
    dedupeKey: opts.dedupeKey,
  });
}

// ---------------------------------------------------------------------------
// #5 — Test-drive reminder at T-24h: customer (WhatsApp + Email) + advisor
// (In-App), key testdrive:remind24:{leadId}:{driveId}.
// ---------------------------------------------------------------------------
async function sweepTestDriveReminders(): Promise<void> {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * HOUR);
  const drives = await db
    .select({
      id: testDrivesTable.id,
      dealerId: testDrivesTable.dealerId,
      leadId: testDrivesTable.leadId,
      customerId: testDrivesTable.customerId,
      scheduledAt: testDrivesTable.scheduledAt,
      branch: testDrivesTable.branch,
    })
    .from(testDrivesTable)
    .where(
      and(
        eq(testDrivesTable.status, "scheduled"),
        gte(testDrivesTable.scheduledAt, now),
        lte(testDrivesTable.scheduledAt, in24h),
      ),
    );

  for (const drive of drives) {
    try {
      const [lead] = await db
        .select({
          id: leadsTable.id,
          name: leadsTable.name,
          email: leadsTable.email,
          phone: leadsTable.phone,
          ownerUserId: leadsTable.ownerUserId,
        })
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.id, drive.leadId),
            eq(leadsTable.dealerId, drive.dealerId),
          ),
        );
      if (!lead) continue;
      const key = `testdrive:remind24:${drive.leadId}:${drive.id}`;
      const when = drive.scheduledAt.toLocaleString("en-US", {
        timeZone: "America/Guyana",
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      const data: TemplateData = {
        name: lead.name,
        date: when,
        ...(drive.branch ? { branch: drive.branch } : {}),
      };
      if (lead.email) {
        await enqueueEmail({
          template: "testdrive.reminder.24h",
          to: lead.email,
          dealerId: drive.dealerId,
          customerId: drive.customerId,
          leadId: lead.id,
          data,
          dedupeKey: `${key}:email`,
          notifyUserId: lead.ownerUserId ?? undefined,
        });
      }
      if (lead.phone) {
        await enqueueWhatsapp({
          kind: "testdrive.reminder.24h",
          to: lead.phone,
          dealerId: drive.dealerId,
          customerId: drive.customerId,
          leadId: lead.id,
          summary: `Test-drive reminder — ${when}`,
          body: `Hello ${lead.name}, a reminder that your test drive is booked for ${when}${drive.branch ? ` at our ${drive.branch} showroom` : ""}. Reply YES to confirm or NO to release the slot.`,
          dedupeKey: `${key}:whatsapp`,
          fallbackEmail: lead.email
            ? { to: lead.email, template: "testdrive.reminder.24h", data }
            : undefined,
          notifyUserId: lead.ownerUserId ?? undefined,
        });
      }
      if (lead.ownerUserId) {
        await notifyUser({
          userId: lead.ownerUserId,
          dealerId: drive.dealerId,
          type: "testdrive.reminder.advisor",
          title: `Test drive tomorrow — ${lead.name}`,
          body: `${lead.name} is booked for a test drive on ${when}${drive.branch ? ` (${drive.branch})` : ""}. The customer has been sent a confirm/decline reminder.`,
          link: `/pipeline/${lead.id}`,
          entityType: "test_drive",
          entityId: drive.id,
        });
      }
    } catch (err) {
      logger.error({ err, driveId: drive.id }, "test-drive reminder failed");
    }
  }
}

// ---------------------------------------------------------------------------
// #17 — Service cadence approaching: active assets nearing a 6-month service
// interval since delivery. dueWindow = the upcoming interval index, bounding
// the nudge to one per cycle: cadence:{assetId}:{dueWindow}.
// ---------------------------------------------------------------------------
const CADENCE_MONTHS = 6;
const APPROACH_DAYS = 30;

async function sweepServiceCadence(): Promise<void> {
  const assets = await db
    .select()
    .from(assetsTable)
    .where(eq(assetsTable.status, "active"));

  const now = Date.now();
  for (const asset of assets) {
    try {
      const delivered = asset.deliveredAt.getTime();
      const monthsSince = (now - delivered) / (30.44 * 24 * HOUR);
      const nextWindow = Math.floor(monthsSince / CADENCE_MONTHS) + 1;
      const dueAt =
        delivered + nextWindow * CADENCE_MONTHS * 30.44 * 24 * HOUR;
      // Only nudge inside the approach window before the due date.
      if (dueAt - now > APPROACH_DAYS * 24 * HOUR) continue;

      const [customer] = await db
        .select({
          name: customersTable.name,
          email: customersTable.email,
          phone: customersTable.phone,
        })
        .from(customersTable)
        .where(
          and(
            eq(customersTable.id, asset.accountId),
            eq(customersTable.dealerId, asset.dealerId),
          ),
        );
      if (!customer) continue;
      const key = `cadence:${asset.id}:${nextWindow}`;
      const dueLabel = new Date(dueAt).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "America/Guyana",
      });
      const data: TemplateData = { name: customer.name, due: dueLabel };
      if (customer.email) {
        await enqueueEmail({
          template: "service.cadence.due",
          to: customer.email,
          dealerId: asset.dealerId,
          customerId: asset.accountId,
          data,
          dedupeKey: `${key}:email`,
          notifyUserId: asset.serviceAdvisorUserId ?? undefined,
        });
      }
      if (customer.phone) {
        await enqueueWhatsapp({
          kind: "service.cadence.due",
          to: customer.phone,
          dealerId: asset.dealerId,
          customerId: asset.accountId,
          summary: `Service due ${dueLabel}`,
          body: `Hello ${customer.name}, your vehicle's scheduled service window is coming up (${dueLabel}). Reply to this message or contact your Service Advisor to book a convenient slot.`,
          dedupeKey: `${key}:whatsapp`,
          fallbackEmail: customer.email
            ? { to: customer.email, template: "service.cadence.due", data }
            : undefined,
          notifyUserId: asset.serviceAdvisorUserId ?? undefined,
        });
      }
      if (asset.serviceAdvisorUserId) {
        await notifyUser({
          userId: asset.serviceAdvisorUserId,
          dealerId: asset.dealerId,
          type: "service.cadence.due",
          title: `Service window approaching — ${customer.name}`,
          body: `The vehicle delivered ${new Date(asset.deliveredAt).toLocaleDateString("en-US", { month: "long", year: "numeric" })} is due for its interval service around ${dueLabel}. The customer has been nudged to book.`,
          link: `/customers/${asset.accountId}`,
          entityType: "asset",
          entityId: asset.id,
        });
      }
    } catch (err) {
      logger.error({ err, assetId: asset.id }, "service cadence sweep failed");
    }
  }
}

// ---------------------------------------------------------------------------
// FR-COM-03 — management scheduled-services summary. Per-dealer cadence
// (daily default / weekly / off) from the service settings. Recipients are
// the dealer's service management (service admin/approve grants, falling
// back to the GMs). Idempotent via a period-scoped dedupe key, so the
// 10-minute sweep loop sends at most one digest per period per recipient.
// ---------------------------------------------------------------------------
const SUMMARY_LOOKAHEAD_DAYS: Record<"daily" | "weekly", number> = {
  daily: 3,
  weekly: 7,
};

/** Guyana-local YYYY-MM-DD for a Date. */
function guyanaDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Guyana" });
}

async function sweepServiceSummaries(): Promise<void> {
  const dealers = await db.select({ id: dealersTable.id }).from(dealersTable);
  const now = new Date();
  const today = guyanaDate(now);
  const weekday = now.toLocaleDateString("en-US", {
    timeZone: "America/Guyana",
    weekday: "short",
  });

  for (const dealer of dealers) {
    try {
      const { summaryCadence } = await getServiceSettings(dealer.id);
      if (summaryCadence === "off") continue;
      // Weekly digests go out on Mondays only.
      if (summaryCadence === "weekly" && weekday !== "Mon") continue;

      const days = SUMMARY_LOOKAHEAD_DAYS[summaryCadence];
      const until = guyanaDate(new Date(now.getTime() + days * 24 * HOUR));
      const periodKey =
        summaryCadence === "weekly" ? `week:${today}` : `day:${today}`;

      let managers = await usersWithPermission(dealer.id, "service", [
        "admin",
        "approve",
      ]);
      if (managers.length === 0) managers = await generalManagers(dealer.id);
      if (managers.length === 0) continue;

      const upcoming = await db
        .select({
          scheduledDate: serviceOrdersTable.scheduledDate,
          vehicleInfo: serviceOrdersTable.vehicleInfo,
          type: serviceOrdersTable.type,
          customerName: serviceOrdersTable.customerName,
          technician: serviceOrdersTable.technician,
        })
        .from(serviceOrdersTable)
        .where(
          and(
            eq(serviceOrdersTable.dealerId, dealer.id),
            inArray(serviceOrdersTable.status, [
              "open",
              "acknowledged",
              "in_progress",
              "on_hold",
            ]),
            gte(serviceOrdersTable.scheduledDate, today),
            lte(serviceOrdersTable.scheduledDate, until),
          ),
        )
        .orderBy(asc(serviceOrdersTable.scheduledDate))
        .limit(50);

      const rows = upcoming
        .map((o) => {
          const day = new Date(`${o.scheduledDate}T12:00:00`).toLocaleDateString(
            "en-US",
            { month: "short", day: "numeric" },
          );
          const who = o.customerName ? ` (${o.customerName})` : "";
          const tech = o.technician ? ` — ${o.technician}` : "";
          return `<strong>${day}</strong> — ${o.vehicleInfo}, ${o.type}${who}${tech}`;
        })
        .join("<br/>");

      const data: TemplateData = {
        count: String(upcoming.length),
        window:
          summaryCadence === "weekly"
            ? "over the next 7 days"
            : `over the next ${days} days`,
        rows,
      };

      const recipients = await db
        .select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .where(inArray(usersTable.id, managers));
      for (const r of recipients) {
        if (!r.email) continue;
        await enqueueEmail({
          template: "service.summary.management",
          to: r.email,
          dealerId: dealer.id,
          data,
          dedupeKey: `svc:summary:${dealer.id}:${periodKey}:u${r.id}`,
        });
      }
    } catch (err) {
      logger.error({ err, dealerId: dealer.id }, "service summary sweep failed");
    }
  }
}

// ---------------------------------------------------------------------------
// Assignment catch-up: a lead normally gets an owner synchronously at
// creation (creator or round robin), but a crash/restart mid-intake can
// strand it unowned. Re-route any unowned lead older than 5 minutes so no
// lead ever sits without an advisor. autoAssignLead is a no-op when the
// lead gained an owner in the meantime (guarded update) and never throws.
// ---------------------------------------------------------------------------
async function sweepUnassignedLeads(): Promise<void> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  const strays = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        isNull(leadsTable.ownerUserId),
        isNull(leadsTable.deletedAt),
        lte(leadsTable.createdAt, cutoff),
        inArray(leadsTable.phase, ["new", "contacted"]),
      ),
    )
    .limit(50);
  for (const lead of strays) {
    const assigned = await autoAssignLead(lead);
    if (assigned)
      logger.info(
        { leadId: lead.id, ownerUserId: assigned.ownerUserId },
        "assignment catch-up: routed stranded lead",
      );
  }
}

// ---------------------------------------------------------------------------
// Post-delivery feedback: one email to the customer 7 days after handover.
// The lower bound (21 days) keeps a backlog of historical/imported
// deliveries from all firing at once when this sweep first ships; the
// dedupeKey makes each delivery one-shot regardless.
// ---------------------------------------------------------------------------
async function sweepDeliveryFeedback(): Promise<void> {
  const now = Date.now();
  const upper = new Date(now - 7 * 24 * HOUR);
  const lower = new Date(now - 21 * 24 * HOUR);
  const rows = await db
    .select({
      id: deliveriesTable.id,
      dealerId: deliveriesTable.dealerId,
      customerId: deliveriesTable.customerId,
      customerName: deliveriesTable.customerName,
      vehicleId: deliveriesTable.vehicleId,
      email: customersTable.email,
      name: customersTable.name,
    })
    .from(deliveriesTable)
    .leftJoin(
      customersTable,
      and(
        eq(customersTable.id, deliveriesTable.customerId),
        eq(customersTable.dealerId, deliveriesTable.dealerId),
      ),
    )
    // Anti-join on the outbox dedupe key so already-handled deliveries never
    // occupy the batch — a backlog larger than one batch drains across runs
    // instead of re-selecting the same deduped rows forever.
    .leftJoin(
      emailLogsTable,
      eq(
        emailLogsTable.dedupeKey,
        sql`'delivery:feedback7d:' || ${deliveriesTable.id}`,
      ),
    )
    .where(
      and(
        eq(deliveriesTable.status, "completed"),
        isNotNull(deliveriesTable.deliveredAt),
        lte(deliveriesTable.deliveredAt, upper),
        gte(deliveriesTable.deliveredAt, lower),
        isNull(emailLogsTable.id),
      ),
    )
    // Oldest first so nothing ages past the window while newer rows hog the batch.
    .orderBy(asc(deliveriesTable.deliveredAt))
    .limit(200);
  for (const row of rows) {
    if (!row.email) continue;
    try {
      const [v] = await db
        .select({
          year: vehiclesTable.year,
          make: vehiclesTable.make,
          model: vehiclesTable.model,
        })
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, row.vehicleId),
            eq(vehiclesTable.dealerId, row.dealerId),
          ),
        );
      const vehicle = v ? `${v.year} ${v.make} ${v.model}` : "your new vehicle";
      await enqueueEmail({
        template: "feedback_request",
        to: row.email,
        dealerId: row.dealerId,
        customerId: row.customerId,
        data: {
          name: row.name ?? row.customerName ?? "there",
          context: `the delivery of your ${vehicle}`,
        },
        dedupeKey: `delivery:feedback7d:${row.id}`,
      });
    } catch (err) {
      logger.error(
        { err, deliveryId: row.id },
        "delivery feedback sweep failed",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export async function runNotificationSweeps(): Promise<void> {
  await sweepUnassignedLeads();
  await sweepLeadSla();
  await sweepTestDriveReminders();
  await sweepServiceCadence();
  await sweepServiceSummaries();
  await sweepDeliveryFeedback();
}

export function startNotificationSweeps(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    runNotificationSweeps().catch((err) =>
      logger.error({ err }, "notification sweep run failed"),
    );
  }, SWEEP_INTERVAL_MS);
  setTimeout(() => {
    runNotificationSweeps().catch((err) =>
      logger.error({ err }, "notification sweep run failed"),
    );
  }, 8_000);
  logger.info("notification sweep worker started");
}
