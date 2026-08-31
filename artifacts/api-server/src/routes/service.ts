import { getDealerPdfBranding } from "../lib/dealer-branding";
import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  buildCoverageCertificatePdf,
  buildServiceInvoicePdf,
  buildServiceReceiptPdf,
} from "../lib/document-pdfs";
import {
  dealerTimezone,
  zonedDayKey,
  zonedParts,
  zonedTimeToUtc,
} from "../lib/timezone";
import { getServiceSettings } from "../lib/service-settings";
import { queueCustomerSync } from "../lib/erpnext/entities";
import { dealerExchangeRate } from "../lib/invoicing";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
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
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  partCreditNotesTable,
  jobCardTechnicianNotesTable,
  collisionClaimsTable,
  collisionSettlementsTable,
  collisionSupplementsTable,
  type JobCard,
  type ServiceInvoice,
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
  ListJobCardHistoryQueryParams,
  ListJobCardHistoryResponse,
  ToggleJobCardTimerParams,
  ToggleJobCardTimerBody,
  ToggleJobCardTimerResponse,
  ReopenJobCardParams,
  ReopenJobCardBody,
  ReopenJobCardResponse,
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
  RolloverJobCardParams,
  RolloverJobCardBody,
  RolloverJobCardResponse,
  ApproveJobCardRolloverParams,
  ApproveJobCardRolloverBody,
  ApproveJobCardRolloverResponse,
  DecideJobCardSurchargeParams,
  DecideJobCardSurchargeBody,
  DecideJobCardSurchargeResponse,
  RequestServiceInvoiceDiscountParams,
  RequestServiceInvoiceDiscountBody,
  RequestServiceInvoiceDiscountResponse,
  DecideServiceInvoiceDiscountParams,
  DecideServiceInvoiceDiscountBody,
  DecideServiceInvoiceDiscountResponse,
  AdjustServiceInvoiceParams,
  AdjustServiceInvoiceBody,
  AdjustServiceInvoiceResponse,
  ListJobCardCreditNotesParams,
  ListJobCardCreditNotesResponse,
  CreateJobCardCreditNoteParams,
  CreateJobCardCreditNoteBody,
  CreateJobCardCreditNoteResponse,
} from "@workspace/api-zod";
import { checkLowStockCrossing } from "./parts";
import {
  enqueueStockEntrySync,
  enqueuePurchaseOrderSync,
} from "../lib/erpnext/parts-sync";
import {
  onServiceOrderBooked,
  onServiceOrderStatusChanged,
  onJobCardRolloverApproved,
  onServiceInvoiceIssued,
} from "../lib/email-triggers";
import { enqueueEmail, notifyUser } from "../lib/email";
import { activeDealerId } from "../middlewares/rbac";
import { resolveDealerUserIdByName } from "../lib/user-lookup";
import { computeServiceTax, ensureDealerTaxes } from "../lib/taxes";
import { logger } from "../lib/logger";
import { coordinateCollisionClaim } from "../lib/collision-coordinator";

const router: IRouter = Router();

/**
 * Service Manager / Management sign-off check for rollover approvals and
 * discount decisions. Permission-based checks stay in the authorize
 * middleware; this narrows WHO within the service module may sign off.
 */
function isServiceApprover(user: {
  roleName?: string | null;
  isSuperAdmin?: boolean;
} | null | undefined): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  const role = user.roleName ?? "";
  return /service manager|general manager|leadership|management|owner.?admin|admin/i.test(
    role,
  );
}

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

/** Technicians only ever see their own assigned bookings (RBAC "My Day"). */
export function isTechnicianRole(user: {
  roleName?: string | null;
  isSuperAdmin?: boolean;
} | null | undefined): boolean {
  if (!user || user.isSuperAdmin) return false;
  return /technician/i.test(user.roleName ?? "");
}

/**
 * Round-robin technician auto-assignment with capacity awareness.
 * Eligibility: booked hours on the scheduled date + this job's hours must fit
 * inside the GM-configured workday. Among eligible technicians, pick the
 * least-loaded; tie-break round-robin by least-recently-assigned.
 * Returns null when every technician's day is already full.
 */
async function pickTechnicianRoundRobin(
  dealerId: number,
  scheduledDate: string,
  jobHours: number,
  workHoursPerDay: number,
  tx: Pick<typeof db, "select"> = db,
): Promise<{ id: number; name: string; overCapacity: boolean } | null> {
  const techs = await tx
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(rolesTable.name, "Technician"),
      ),
    );
  if (techs.length === 0) return null;

  // One pass: per-technician booked hours on the date + last assignment time.
  const load = await tx
    .select({
      technicianUserId: serviceOrdersTable.technicianUserId,
      bookedHours: sql<number>`coalesce(sum(case when ${serviceOrdersTable.scheduledDate} = ${scheduledDate} and ${serviceOrdersTable.status} not in ('cancelled','closed') then ${serviceOrdersTable.estimatedHours} else 0 end), 0)`,
      lastAssignedAt: sql<string | null>`max(${serviceOrdersTable.createdAt})`,
    })
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.dealerId, dealerId),
        sql`${serviceOrdersTable.technicianUserId} is not null`,
      ),
    )
    .groupBy(serviceOrdersTable.technicianUserId);
  const byTech = new Map(load.map((l) => [l.technicianUserId, l]));

  const candidates = techs.map((t) => {
    const l = byTech.get(t.id);
    return {
      id: t.id,
      name: t.name ?? t.email ?? `User #${t.id}`,
      booked: Number(l?.bookedHours ?? 0),
      lastAssignedAt: l?.lastAssignedAt ?? null,
    };
  });

  // FIFO ordering: never-assigned first, then oldest last assignment.
  const fifo = (a: (typeof candidates)[number], b: (typeof candidates)[number]) => {
    if (a.lastAssignedAt === b.lastAssignedAt) return a.id - b.id;
    if (a.lastAssignedAt == null) return -1;
    if (b.lastAssignedAt == null) return 1;
    return a.lastAssignedAt < b.lastAssignedAt ? -1 : 1;
  };

  const eligible = candidates.filter(
    (t) => t.booked + jobHours <= workHoursPerDay,
  );
  if (eligible.length > 0) {
    eligible.sort((a, b) =>
      a.booked !== b.booked ? a.booked - b.booked : fifo(a, b),
    );
    const top = eligible[0]!;
    return { id: top.id, name: top.name, overCapacity: false };
  }

  // Everyone is full: still assign — strict FIFO across all technicians so
  // the overflow lands on whoever has waited longest since their last job.
  candidates.sort(fifo);
  const next = candidates[0]!;
  return { id: next.id, name: next.name, overCapacity: true };
}

router.get("/service-orders", async (req, res): Promise<void> => {
  const query = ListServiceOrdersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  // RBAC: technicians only see bookings assigned to them (server-enforced).
  const viewer = res.locals.user;
  const rows = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.dealerId, activeDealerId(res)),
        query.data.status
          ? eq(serviceOrdersTable.status, query.data.status)
          : undefined,
        isTechnicianRole(viewer)
          ? eq(serviceOrdersTable.technicianUserId, viewer!.id)
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

  // Customer email capture: link the booking to a customer record by email so
  // confirmations and the completion invoice have a real recipient. Matches an
  // existing dealer customer first; otherwise creates one from name + email.
  const { customerEmail: bookingEmail, ...orderInput } = parsed.data;
  const submittedPhone = orderInput.customerPhoneSnapshot?.trim() ?? null;
  if (submittedPhone && !validPhone(submittedPhone)) {
    res.status(422).json({ error: "customerPhoneSnapshot must be a valid phone number" });
    return;
  }
  let bookingCustomerId = orderInput.customerId;
  if (bookingEmail && bookingCustomerId == null) {
    const [existingCustomer] = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.dealerId, createDealerId),
          sql`lower(${customersTable.email}) = ${bookingEmail.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (existingCustomer) {
      bookingCustomerId = existingCustomer.id;
    } else {
      const [created] = await db
        .insert(customersTable)
        .values({
          dealerId: createDealerId,
          name: orderInput.customerName?.trim() || bookingEmail,
          email: bookingEmail,
        })
        .returning({ id: customersTable.id });
      bookingCustomerId = created?.id;
      // ERPNext two-way sync: mirror the service-created account.
      if (created) queueCustomerSync(createDealerId, created.id);
    }
  } else if (bookingEmail && bookingCustomerId != null) {
    // Booking supplied both: backfill the customer's email if they have none.
    const [backfilled] = await db
      .update(customersTable)
      // updatedAt drives the ERPNext last-write-wins check.
      .set({ email: bookingEmail, updatedAt: new Date() })
      .where(
        and(
          eq(customersTable.id, bookingCustomerId),
          eq(customersTable.dealerId, createDealerId),
          isNull(customersTable.email),
        ),
      )
      .returning({ id: customersTable.id });
    // ERPNext two-way sync: push the contact-field change.
    if (backfilled) queueCustomerSync(createDealerId, backfilled.id);
  }
  // This contact value is an immutable operational snapshot. An explicit,
  // valid intake number wins; customer master data is only a creation-time
  // fallback and is never consulted by PATCH.
  const customerPhoneSnapshot =
    submittedPhone ?? await resolveCustomerPhoneSnapshot(bookingCustomerId, createDealerId);
  if (!customerPhoneSnapshot) {
    res.status(422).json({
      error: "A valid customer phone number is required to create a service order",
    });
    return;
  }

  const settings = await getServiceSettings(createDealerId);
  const estimatedHours = parsed.data.estimatedHours ?? settings.defaultJobHours;
  const scheduledDateStr = toDateString(parsed.data.scheduledDate)!;

  // Stamp the technician's user ID so briefing scoping matches by ID, not name.
  let technicianUserId =
    parsed.data.technicianUserId ??
    (await resolveDealerUserIdByName(createDealerId, parsed.data.technician));
  let technicianName = parsed.data.technician;
  let assignmentNote: string | null = null;

  // Manual assignment by ID only: backfill the display name from the user
  // record so the booking card never shows "Unassigned" for an assigned tech.
  if (technicianUserId != null && !technicianName) {
    const [u] = await db
      .select({ name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, technicianUserId));
    technicianName = u?.name ?? u?.email ?? `User #${technicianUserId}`;
  }

  // Bookings are created unassigned by default — the workshop assigns a
  // technician later. Round-robin only runs when explicitly requested.
  const autoAssign =
    parsed.data.autoAssign === true &&
    technicianUserId == null &&
    !parsed.data.technician;

  // Pay-type resolution: explicit wins; warranty/recall work defaults to
  // warranty pay; otherwise an active coverage plan (by date window) for the
  // customer flips the default from customer-pay to warranty-pay.
  let payType = parsed.data.payType;
  if (!payType) {
    if (parsed.data.type === "warranty" || parsed.data.type === "recall") {
      payType = "warranty";
    } else if (bookingCustomerId != null) {
      const today = zonedDayKey(
        new Date(),
        await dealerTimezone(createDealerId),
      );
      const [plan] = await db
        .select({ id: coveragePlansTable.id })
        .from(coveragePlansTable)
        .where(
          and(
            eq(coveragePlansTable.dealerId, createDealerId),
            eq(coveragePlansTable.customerId, bookingCustomerId),
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

  // Assignment + insert run in one transaction under a per-dealer/date
  // advisory lock so concurrent bookings can't both grab a technician's last
  // free hours and overbook the day.
  const order = await db.transaction(async (tx) => {
    if (autoAssign) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`svc-assign-${createDealerId}-${scheduledDateStr}`}))`,
      );
      const pick = await pickTechnicianRoundRobin(
        createDealerId,
        scheduledDateStr,
        estimatedHours,
        settings.techWorkHoursPerDay,
        tx,
      );
      if (pick) {
        technicianUserId = pick.id;
        technicianName = pick.name;
        if (pick.overCapacity) {
          assignmentNote = `All technicians are fully booked on ${scheduledDateStr} — assigned to ${pick.name} over capacity (FIFO).`;
        }
      } else {
        assignmentNote = `No technicians are set up for this dealership — booking left unassigned.`;
      }
    }
    const [row] = await tx
      .insert(serviceOrdersTable)
      .values({
        ...orderInput,
        customerPhoneSnapshot,
        customerId: bookingCustomerId,
        payType,
        technician: technicianName,
        technicianUserId,
        estimatedHours,
        dealerId: createDealerId,
        scheduledDate: scheduledDateStr,
      })
      .returning();
    return row;
  });

  // Tell the auto-assigned technician a job landed on their day.
  if (order && technicianUserId != null && parsed.data.technicianUserId == null) {
    notifyUser({
      dealerId: createDealerId,
      userId: technicianUserId,
      type: "assignment",
      entityType: "service_order",
      entityId: order.id,
      title: `New service booking #${order.id} assigned to you`,
      body: `${order.vehicleInfo} — ${order.type}, ${estimatedHours}h on ${scheduledDateStr}.`,
    }).catch(() => {});
  }

  // The initial job card is opened automatically with the booking so the
  // workshop queue always mirrors intake.
  if (order) await autoCreateJobCard(order);

  // FR-COM-01: branded booking confirmation (deduped per order).
  if (order && order.customerId != null) onServiceOrderBooked(order);

  // Note: when assignmentNote is set the order goes out unassigned; the
  // client detects technician == null and surfaces the capacity warning.
  res.status(201).json(CreateServiceOrderResponse.parse(order));
});

router.patch("/service-orders/:id", async (req, res): Promise<void> => {
  const params = UpdateServiceOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if ("customerPhoneSnapshot" in (req.body ?? {})) {
    res.status(422).json({ error: "customerPhoneSnapshot is immutable after service-order creation" });
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

  if (before && !technicianOwnsOrder(res, before)) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }

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

  if (before) onServiceOrderStatusChanged(before, order);

  res.json(UpdateServiceOrderResponse.parse(order));
});

/** Technicians may only touch orders assigned to them (404, not 403, to avoid leaking existence). */
function technicianOwnsOrder(
  res: { locals: { user?: { id: number; roleName?: string | null; isSuperAdmin?: boolean } | null } },
  order: { technicianUserId: number | null },
): boolean {
  const viewer = res.locals.user;
  if (!isTechnicianRole(viewer)) return true;
  return order.technicianUserId === viewer!.id;
}

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
  if (!order || !technicianOwnsOrder(res, order)) {
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
    // Collision repairs cannot close around the claim: the claim must have
    // completed insurer sign-off + invoicing (or exited as denied/total-loss)
    // before the repair order itself closes (Task 279).
    const [claim] = await db
      .select({
        id: collisionClaimsTable.id,
        status: collisionClaimsTable.status,
      })
      .from(collisionClaimsTable)
      .where(
        and(
          eq(collisionClaimsTable.serviceOrderId, order.id),
          eq(collisionClaimsTable.dealerId, dealerId),
        ),
      );
    if (
      claim &&
      !["invoiced", "closed", "denied", "total_loss"].includes(claim.status)
    ) {
      unmet.push(
        `Collision claim #${claim.id} is still ${claim.status.replace(/_/g, " ")} — it needs insurer sign-off and invoicing (or a denied/total-loss outcome) first`,
      );
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

  // Every stage transition carries a mandatory justification (audit trail).
  const stageEvent = {
    from: order.status,
    to: target,
    justification: parsed.data.justification.trim(),
    byUserId: res.locals.user?.id ?? null,
    byName: res.locals.user?.name ?? res.locals.user?.email ?? "Unknown",
    at: new Date().toISOString(),
  };

  const [before] = [order];
  const [updated] = await db
    .update(serviceOrdersTable)
    .set({
      status: target,
      stageHistory: sql`coalesce(${serviceOrdersTable.stageHistory}, '[]'::jsonb) || ${JSON.stringify([stageEvent])}::jsonb`,
    })
    .where(
      and(
        eq(serviceOrdersTable.id, order.id),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    )
    .returning();

  if (updated && before) onServiceOrderStatusChanged(before, updated);

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

router.delete("/service-orders/:id", async (req, res): Promise<void> => {
  const params = UpdateServiceOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
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
  if (!order || !technicianOwnsOrder(res, order)) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }

  // Invoiced work is a financial record — it can't be deleted from here.
  const [invoice] = await db
    .select({ id: serviceInvoicesTable.id })
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.dealerId, dealerId),
        eq(serviceInvoicesTable.serviceOrderId, order.id),
      ),
    )
    .limit(1);
  if (invoice) {
    res.status(409).json({
      error:
        "order_invoiced: this booking has an issued invoice — void the invoice first",
    });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.dealerId, dealerId),
          eq(jobCardsTable.serviceOrderId, order.id),
        ),
      );
    await tx
      .delete(serviceOrdersTable)
      .where(eq(serviceOrdersTable.id, order.id));
  });
  res.status(204).end();
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

/**
 * Late-service surcharge detection (FR-SR-07): the case's intake odometer is
 * compared against the vehicle's last serviced odometer plus the
 * dealer-configured interval. Over-interval arrivals get a surcharge
 * suggestion staff must apply or waive.
 */
async function computeLateSurcharge(order: {
  id: number;
  dealerId: number;
  odometer: number | null;
  vehicleId: number | null;
  customerId: number | null;
  vehicleInfo: string;
}): Promise<{
  surchargeStatus?: string;
  surchargeAmount?: number;
  surchargeOverKm?: number;
}> {
  if (order.odometer == null) return {};
  const settings = await getServiceSettings(order.dealerId);
  const priorFilter = order.vehicleId != null
    ? eq(serviceOrdersTable.vehicleId, order.vehicleId)
    : order.customerId != null
      ? and(
          eq(serviceOrdersTable.customerId, order.customerId),
          eq(serviceOrdersTable.vehicleInfo, order.vehicleInfo),
        )
      : undefined;
  if (!priorFilter) return {};
  const [prior] = await db
    .select({
      lastOdo: sql<number | null>`max(${serviceOrdersTable.odometer})`,
    })
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.dealerId, order.dealerId),
        priorFilter,
        sql`${serviceOrdersTable.id} <> ${order.id}`,
        sql`${serviceOrdersTable.status} in ('resolved', 'closed')`,
        sql`${serviceOrdersTable.odometer} is not null`,
      ),
    );
  const lastOdo = prior?.lastOdo;
  if (lastOdo == null) return {};
  const overKm = order.odometer - Number(lastOdo) - settings.serviceIntervalKm;
  if (overKm <= 0) return {};
  return {
    surchargeStatus: "suggested",
    surchargeAmount: settings.lateSurchargeFee,
    surchargeOverKm: overKm,
  };
}

/**
 * Auto-create the initial job card when a booking lands (walk-in intake).
 * Inherits technician, pay type, hours and schedule from the case. Swallows
 * the one-active-card-per-asset conflict — the booking itself still stands.
 */
async function autoCreateJobCard(
  order: typeof serviceOrdersTable.$inferSelect,
): Promise<void> {
  const surcharge = await computeLateSurcharge(order);
  const customerPhoneSnapshot = (order as any).customerPhoneSnapshot ?? await resolveCustomerPhoneSnapshot(
    order.customerId,
    order.dealerId,
  );
  try {
    await db.insert(jobCardsTable).values({
      dealerId: order.dealerId,
      serviceOrderId: order.id,
      assetId: order.assetId ?? null,
      title:
        order.complaint?.trim() ||
        `${order.type.replace(/_/g, " ")} — ${order.vehicleInfo}`,
      status: "open",
      payType: order.payType,
      technicianUserId: order.technicianUserId,
      technicianName: order.technician,
      scheduledAt: new Date(`${order.scheduledDate}T09:00:00`),
      durationMins: Math.round(order.estimatedHours * 60),
      customerPhoneSnapshot,
      ...surcharge,
    });
  } catch (err) {
    // Partial unique index: one active job card per asset — skip silently.
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      return;
    }
    throw err;
  }
}

/** Workshop contact snapshots come only from this dealer's linked customer. */
async function resolveCustomerPhoneSnapshot(
  customerId: number | null | undefined,
  dealerId: number,
): Promise<string | null> {
  if (customerId == null) return null;
  const [customer] = await db
    .select({ phone: customersTable.phone })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, customerId),
        eq(customersTable.dealerId, dealerId),
      ),
    )
    .limit(1);
  const phone = customer?.phone?.trim();
  return phone && validPhone(phone) ? phone : null;
}

/** Permissive for international formatting, but rejects short/textual values. */
function validPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 && /^[+\d\s().-]+$/.test(value);
}

/** Whole seconds elapsed since `from` (never negative). */
function elapsedSeconds(from: Date): number {
  return Math.max(0, Math.round((Date.now() - from.getTime()) / 1000));
}

/** SQL fragment: accumulated timer seconds plus the running segment, folded
 * atomically from the row's CURRENT values (immune to read-then-write races). */
const foldedTimerSeconds = sql<number>`${jobCardsTable.timerSeconds} + coalesce(greatest(0, extract(epoch from (now() - ${jobCardsTable.timerStartedAt})))::int, 0)`;

/** Timer/reopen are edit-actions on an existing card: allowed for service
 * managers/management, or the technician the card is assigned to. */
function canActOnJobCard(
  user:
    | { id?: number; roleName?: string | null; isSuperAdmin?: boolean }
    | undefined
    | null,
  card: { technicianUserId: number | null },
): boolean {
  if (isServiceApprover(user)) return true;
  return card.technicianUserId != null && user?.id === card.technicianUserId;
}

// Service-history lookup: technicians search past job cards across ALL
// customers/vehicles (view permission on service is enforced by the router
// middleware). Newest first, capped at 100 rows.
router.get("/job-cards/history", async (req, res): Promise<void> => {
  const query = ListJobCardHistoryQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const q = query.data.q?.trim();
  const like = q ? `%${q}%` : null;
  const rows = await db
    .select({
      id: jobCardsTable.id,
      serviceOrderId: jobCardsTable.serviceOrderId,
      title: jobCardsTable.title,
      status: jobCardsTable.status,
      technicianName: jobCardsTable.technicianName,
      customerName: serviceOrdersTable.customerName,
      vehicleInfo: serviceOrdersTable.vehicleInfo,
      laborHours: jobCardsTable.laborHours,
      timerSeconds: jobCardsTable.timerSeconds,
      serviceAnalysis: jobCardsTable.serviceAnalysis,
      workPerformed: jobCardsTable.workPerformed,
      startedAt: jobCardsTable.startedAt,
      completedAt: jobCardsTable.completedAt,
      createdAt: jobCardsTable.createdAt,
    })
    .from(jobCardsTable)
    .innerJoin(
      serviceOrdersTable,
      and(
        eq(jobCardsTable.serviceOrderId, serviceOrdersTable.id),
        // Tenancy: constrain the joined table too, never trust the FK alone.
        eq(serviceOrdersTable.dealerId, jobCardsTable.dealerId),
      ),
    )
    .where(
      and(
        eq(jobCardsTable.dealerId, activeDealerId(res)),
        like
          ? or(
              ilike(serviceOrdersTable.customerName, like),
              ilike(serviceOrdersTable.vehicleInfo, like),
              ilike(jobCardsTable.title, like),
            )
          : undefined,
      ),
    )
    .orderBy(desc(jobCardsTable.createdAt))
    .limit(100);
  res.json(ListJobCardHistoryResponse.parse(rows));
});

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
  const surcharge = await computeLateSurcharge(order);
  const submittedPhone =
    typeof req.body?.customerPhoneSnapshot === "string"
      ? req.body.customerPhoneSnapshot.trim()
      : undefined;
  if (submittedPhone !== undefined && submittedPhone !== "" && !validPhone(submittedPhone)) {
    res.status(400).json({
      error: "Customer phone must contain 7–15 digits and sensible phone punctuation only",
    });
    return;
  }
  // An explicitly supplied job-card contact is a snapshot override, never a
  // customer-master update. Otherwise prefill from the dealer-scoped order's
  // snapshot or linked customer.
  const customerPhoneSnapshot =
    submittedPhone || (order as any).customerPhoneSnapshot || (await resolveCustomerPhoneSnapshot(order.customerId, order.dealerId));

  let card: typeof jobCardsTable.$inferSelect | undefined;
  try {
    // Asset + pay type flow down from the case unless explicitly overridden.
    [card] = await db
      .insert(jobCardsTable)
      .values({
        ...parsed.data,
        ...surcharge,
        assetId: order.assetId ?? null,
        payType: parsed.data.payType ?? order.payType,
        scheduledAt: parsed.data.scheduledAt
          ? new Date(parsed.data.scheduledAt)
          : null,
        customerPhoneSnapshot,
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

const JobCardNoteParams = z.object({ id: z.coerce.number().int().positive() });
const CreateJobCardNoteBody = z.object({
  body: z.string().trim().min(1).max(4000),
});

router.get("/job-cards/:id/technician-notes", async (req, res): Promise<void> => {
  const params = JobCardNoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [card] = await db.select().from(jobCardsTable).where(
    and(eq(jobCardsTable.id, params.data.id), eq(jobCardsTable.dealerId, dealerId)),
  );
  if (!card || !canActOnJobCard(res.locals.user, card)) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  const notes = await db.select().from(jobCardTechnicianNotesTable).where(
    and(
      eq(jobCardTechnicianNotesTable.dealerId, dealerId),
      eq(jobCardTechnicianNotesTable.jobCardId, card.id),
    ),
  ).orderBy(jobCardTechnicianNotesTable.createdAt);
  res.json(notes);
});

router.post("/job-cards/:id/technician-notes", async (req, res): Promise<void> => {
  const params = JobCardNoteParams.safeParse(req.params);
  const parsed = CreateJobCardNoteBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [card] = await db.select().from(jobCardsTable).where(
    and(eq(jobCardsTable.id, params.data.id), eq(jobCardsTable.dealerId, dealerId)),
  );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (card.status !== "in_progress") {
    res.status(422).json({ error: "Technician notes can only be added while work is in progress" });
    return;
  }
  if (!canActOnJobCard(res.locals.user, card)) {
    res.status(403).json({ error: "Only the assigned technician or a service approver can add notes" });
    return;
  }
  const author = res.locals.user?.name ?? res.locals.user?.email ?? "Unknown";
  const [note] = await db.insert(jobCardTechnicianNotesTable).values({
    dealerId, jobCardId: card.id, body: parsed.data.body,
    authorUserId: res.locals.user?.id ?? null, authorName: author,
  }).returning();
  const [order] = await db.select({ customerId: serviceOrdersTable.customerId }).from(serviceOrdersTable)
    .where(and(eq(serviceOrdersTable.id, card.serviceOrderId), eq(serviceOrdersTable.dealerId, dealerId)));
  if (order?.customerId != null) {
    await db.insert(timelineEventsTable).values({
      dealerId, customerId: order.customerId, domain: "service", kind: "job_card_technician_note",
      title: `Technician note added to job card #${card.id}`, detail: parsed.data.body,
      actor: author, isAgent: false, cause: `Job card #${card.id}`,
      refType: "job_card", refId: card.id,
    });
  }
  res.status(201).json(note);
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

  const {
    approveQuote,
    scheduledAt,
    customerPhoneSnapshot: _immutablePhoneSnapshot,
    ...updateFields
  } = parsed.data as typeof parsed.data & { customerPhoneSnapshot?: unknown };
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
  // Work timer follows the status machine: entering in_progress starts a
  // segment (unless one is already running); leaving it folds the running
  // segment into the accumulated total.
  if (parsed.data.status && parsed.data.status !== existing.status) {
    if (parsed.data.status === "in_progress") {
      // Start a segment unless one is already running (SQL keeps this
      // race-free against a concurrent resume).
      patch.timerStartedAt = sql`coalesce(${jobCardsTable.timerStartedAt}, now())`;
    } else {
      // Leaving in_progress folds any running segment atomically from the
      // row's current values — a racing resume cannot strand a segment.
      patch.timerSeconds = foldedTimerSeconds;
      patch.timerStartedAt = null;
    }
  }
  if (parsed.data.status === "completed" && existing.status !== "completed") {
    // Completion write-up is mandatory: the technician must record their
    // analysis of the service AND what work was performed before the card
    // can be marked completed (either in this request or already saved).
    const analysis =
      parsed.data.serviceAnalysis?.trim() || existing.serviceAnalysis?.trim();
    const performed =
      parsed.data.workPerformed?.trim() || existing.workPerformed?.trim();
    const missing: string[] = [];
    if (!analysis) missing.push("service_analysis_required");
    if (!performed) missing.push("work_performed_required");
    if (missing.length > 0) {
      res.status(422).json({
        error:
          "Completion write-up required — record the service analysis and the work performed before marking this job card completed.",
        unmet: missing,
      });
      return;
    }
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

  // Service completed → automatically issue the invoice and email it to the
  // customer (PDF attached). Best-effort: an undecided surcharge or an
  // already-existing invoice leaves the manual "Generate invoice" path open.
  if (card && parsed.data.status === "completed" && existing.status !== "completed") {
    const result = await issueServiceInvoice(card).catch((err) => {
      logger.error({ err, jobCardId: card.id }, "auto-invoice on completion failed");
      return null;
    });
    if (result && !result.ok && result.status !== 409) {
      logger.warn(
        { jobCardId: card.id, reason: result.error },
        "auto-invoice skipped on completion",
      );
    }
  }

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
// Work timer: technicians pause/resume without changing the card's status
// ---------------------------------------------------------------------------

router.post("/job-cards/:id/timer", async (req, res): Promise<void> => {
  const params = ToggleJobCardTimerParams.safeParse(req.params);
  const body = ToggleJobCardTimerBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: (params.success ? body : params).error?.message ?? "Invalid",
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
  if (!canActOnJobCard(res.locals.user, existing)) {
    res.status(403).json({
      error:
        "Only the assigned technician or the Service Manager can control this job's timer",
    });
    return;
  }
  if (existing.status !== "in_progress") {
    res.status(409).json({
      error: "Timer only runs while the job is in progress",
    });
    return;
  }
  // Compare-and-set: the UPDATE only lands when the card is still in progress
  // AND the timer is in the expected state, so concurrent pause/resume/status
  // requests cannot double-fold or drop a running segment.
  const pausing = body.data.action === "pause";
  const [card] = await db
    .update(jobCardsTable)
    .set(
      pausing
        ? { timerSeconds: foldedTimerSeconds, timerStartedAt: null }
        : { timerStartedAt: new Date() },
    )
    .where(
      and(
        eq(jobCardsTable.id, existing.id),
        eq(jobCardsTable.dealerId, existing.dealerId),
        eq(jobCardsTable.status, "in_progress"),
        pausing
          ? sql`${jobCardsTable.timerStartedAt} is not null`
          : isNull(jobCardsTable.timerStartedAt),
      ),
    )
    .returning();
  if (!card) {
    res.status(409).json({
      error: pausing ? "Timer is already paused" : "Timer is already running",
    });
    return;
  }
  res.json(ToggleJobCardTimerResponse.parse(card));
});

// ---------------------------------------------------------------------------
// Reopen: completed/closed card goes back to in-progress for more work
// ---------------------------------------------------------------------------

router.post("/job-cards/:id/reopen", async (req, res): Promise<void> => {
  const params = ReopenJobCardParams.safeParse(req.params);
  const body = ReopenJobCardBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({
      error: (params.success ? body : params).error?.message ?? "Invalid",
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
  if (!canActOnJobCard(res.locals.user, existing)) {
    res.status(403).json({
      error:
        "Only the assigned technician or the Service Manager can reopen this job card",
    });
    return;
  }
  if (existing.status !== "completed" && existing.status !== "closed") {
    res
      .status(409)
      .json({ error: "Only completed or closed job cards can be reopened" });
    return;
  }
  // A PAID invoice locks the card shut — reopening would let more work land
  // on a bill the customer already settled. Issued (unpaid) invoices keep
  // the adjustments path open, so they don't block a reopen.
  const [paidInvoice] = await db
    .select({ id: serviceInvoicesTable.id })
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.jobCardId, existing.id),
        eq(serviceInvoicesTable.dealerId, existing.dealerId),
        eq(serviceInvoicesTable.status, "paid"),
      ),
    );
  if (paidInvoice) {
    res.status(409).json({
      error:
        "This job's invoice is already paid — open a new job card for additional work instead of reopening this one.",
    });
    return;
  }
  let card: JobCard | undefined;
  try {
    [card] = await db
      .update(jobCardsTable)
      .set({
        status: "in_progress",
        completedAt: null,
        timerStartedAt: new Date(),
        ...(body.data?.reason
          ? {
              notes: existing.notes
                ? `${existing.notes}\nReopened: ${body.data.reason}`
                : `Reopened: ${body.data.reason}`,
            }
          : {}),
      })
      .where(eq(jobCardsTable.id, existing.id))
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
          "This vehicle already has another active job card — complete or close it before reopening this one.",
      });
      return;
    }
    throw err;
  }
  if (card) {
    const [order] = await db
      .select()
      .from(serviceOrdersTable)
      .where(eq(serviceOrdersTable.id, card.serviceOrderId));
    await db.insert(timelineEventsTable).values({
      dealerId: card.dealerId,
      customerId: order?.customerId ?? null,
      domain: "service",
      kind: "job_card_reopened",
      title: `Job card #${card.id} reopened`,
      detail: body.data?.reason ?? null,
      actor: res.locals.user?.name ?? "Service",
    });
    if (card.technicianUserId != null) {
      void notifyUser({
        userId: card.technicianUserId,
        dealerId: card.dealerId,
        type: "assignment",
        title: `Job card #${card.id} reopened`,
        body: card.title,
        link: "/workshop",
      });
    }
  }
  res.json(ReopenJobCardResponse.parse(card));
});

// ---------------------------------------------------------------------------
// Multi-day rollover (FR-SR-06): dual sign-off before a card carries over
// ---------------------------------------------------------------------------

const ACTIVE_CARD_STATUSES = new Set(["open", "in_progress", "on_hold"]);

router.post("/job-cards/:id/rollover", async (req, res): Promise<void> => {
  const params = RolloverJobCardParams.safeParse(req.params);
  const parsed = RolloverJobCardBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(eq(jobCardsTable.id, params.data.id), eq(jobCardsTable.dealerId, dealerId)),
    );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  if (!ACTIVE_CARD_STATUSES.has(card.status)) {
    res.status(422).json({
      error: `Only an active job card can be rolled over (this one is ${card.status})`,
    });
    return;
  }
  const toDate = toDateString(parsed.data.toDate);
  const today = zonedDayKey(new Date(), await dealerTimezone(dealerId));
  if (!toDate || toDate <= today) {
    res.status(422).json({ error: "Rollover date must be a future day" });
    return;
  }
  // Sign-offs are immutable: a pending rollover (including one with partial
  // signatures) can never be replaced or have its signatures cleared by a new
  // request. Only "none" (never requested) or "approved" (fully signed and
  // executed) cards accept a new request — and an approved record is archived
  // into the card's notes as an append-only audit line first.
  if (card.rolloverStatus === "pending") {
    res.status(422).json({
      error:
        "A rollover is already awaiting sign-off — it must be fully approved before another can be requested",
    });
    return;
  }
  const auditLine =
    card.rolloverStatus === "approved"
      ? `[Rollover audit] carried to ${card.rolloverToDate ?? "?"} — manager: ${card.rolloverManagerApprovedBy ?? "?"} @ ${card.rolloverManagerApprovedAt?.toISOString() ?? "?"}; technician: ${card.rolloverTechApprovedBy ?? "?"} @ ${card.rolloverTechApprovedAt?.toISOString() ?? "?"}`
      : null;
  // CAS on the observed rollover status so a concurrent request or sign-off
  // can't be raced past the guard above.
  const [updated] = await db
    .update(jobCardsTable)
    .set({
      rolloverStatus: "pending",
      rolloverToDate: toDate,
      rolloverReason: parsed.data.reason ?? null,
      rolloverRequestedBy: res.locals.user?.name ?? res.locals.user?.email ?? "Staff",
      rolloverRequestedAt: new Date(),
      rolloverManagerApprovedBy: null,
      rolloverManagerApprovedAt: null,
      rolloverTechApprovedBy: null,
      rolloverTechApprovedAt: null,
      ...(auditLine
        ? { notes: card.notes ? `${card.notes}\n${auditLine}` : auditLine }
        : {}),
    })
    .where(
      and(
        eq(jobCardsTable.id, card.id),
        eq(jobCardsTable.dealerId, dealerId),
        eq(jobCardsTable.rolloverStatus, card.rolloverStatus),
      ),
    )
    .returning();
  if (!updated) {
    res.status(409).json({ error: "Job card changed — reload and retry" });
    return;
  }
  res.json(RolloverJobCardResponse.parse(updated));
});

router.post(
  "/job-cards/:id/rollover/approve",
  async (req, res): Promise<void> => {
    const params = ApproveJobCardRolloverParams.safeParse(req.params);
    const parsed = ApproveJobCardRolloverBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: (params.success ? parsed : params).error?.message ?? "Invalid",
      });
      return;
    }
    const dealerId = activeDealerId(res);
    const user = res.locals.user;
    const [card] = await db
      .select()
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.id, params.data.id),
          eq(jobCardsTable.dealerId, dealerId),
        ),
      );
    if (!card) {
      res.status(404).json({ error: "Job card not found" });
      return;
    }
    if (card.rolloverStatus !== "pending") {
      res.status(422).json({ error: "No pending rollover on this job card" });
      return;
    }
    const signer = user?.name ?? user?.email ?? "Staff";
    if (parsed.data.as === "manager") {
      if (!isServiceApprover(user)) {
        res.status(403).json({
          error: "Only the Service Manager or Management can sign off as manager",
        });
        return;
      }
    } else if (
      card.technicianUserId == null ||
      user?.id !== card.technicianUserId
    ) {
      // Technician sign-off must come from the assigned technician.
      res.status(403).json({
        error: "Only the assigned technician can sign off as technician",
      });
      return;
    }

    // Sign-offs are immutable: the UPDATE only lands when the rollover is
    // still pending AND this capacity's slot is empty, so a concurrent
    // duplicate cannot overwrite who signed or when.
    const updated = await db.transaction(async (tx) => {
      const slotPredicate =
        parsed.data.as === "manager"
          ? isNull(jobCardsTable.rolloverManagerApprovedAt)
          : isNull(jobCardsTable.rolloverTechApprovedAt);
      const signPatch: Partial<typeof jobCardsTable.$inferInsert> =
        parsed.data.as === "manager"
          ? {
              rolloverManagerApprovedBy: signer,
              rolloverManagerApprovedAt: new Date(),
            }
          : {
              rolloverTechApprovedBy: signer,
              rolloverTechApprovedAt: new Date(),
            };
      const [signed] = await tx
        .update(jobCardsTable)
        .set(signPatch)
        .where(
          and(
            eq(jobCardsTable.id, card.id),
            eq(jobCardsTable.dealerId, dealerId),
            eq(jobCardsTable.rolloverStatus, "pending"),
            slotPredicate,
          ),
        )
        .returning();
      if (!signed) return null;

      // Second signature completes the rollover: the card's scheduled date
      // moves to the approved carry-over day.
      if (
        signed.rolloverManagerApprovedAt != null &&
        signed.rolloverTechApprovedAt != null
      ) {
        const finalPatch: Partial<typeof jobCardsTable.$inferInsert> = {
          rolloverStatus: "approved",
        };
        if (signed.rolloverToDate) {
          // Keep the card's original wall-clock time on the approved
          // carry-over day, evaluated in the dealership timezone.
          const tz = await dealerTimezone(dealerId);
          const prev = zonedParts(signed.scheduledAt ?? new Date(), tz);
          const [ry, rm, rd] = signed.rolloverToDate.split("-").map(Number);
          finalPatch.scheduledAt = zonedTimeToUtc(
            tz,
            ry!,
            rm!,
            rd!,
            prev.hour,
            prev.minute,
          );
        }
        const [finalized] = await tx
          .update(jobCardsTable)
          .set(finalPatch)
          .where(
            and(
              eq(jobCardsTable.id, card.id),
              eq(jobCardsTable.dealerId, dealerId),
              eq(jobCardsTable.rolloverStatus, "pending"),
            ),
          )
          .returning();
        if (finalized) {
          // FR-COM-01: tell the customer their job carries to another day.
          const [parent] = await tx
            .select()
            .from(serviceOrdersTable)
            .where(
              and(
                eq(serviceOrdersTable.id, finalized.serviceOrderId),
                eq(serviceOrdersTable.dealerId, dealerId),
              ),
            );
          if (parent) {
            onJobCardRolloverApproved({
              dealerId,
              jobCardId: finalized.id,
              serviceOrderId: parent.id,
              customerId: parent.customerId,
              vehicleInfo: parent.vehicleInfo,
              serviceType: parent.type,
              toDate: finalized.rolloverToDate,
              reason: finalized.rolloverReason,
            });
          }
        }
        return finalized ?? signed;
      }
      return signed;
    });
    if (!updated) {
      res.status(409).json({
        error:
          parsed.data.as === "manager"
            ? "Manager sign-off already recorded (or rollover no longer pending)"
            : "Technician sign-off already recorded (or rollover no longer pending)",
      });
      return;
    }
    res.json(ApproveJobCardRolloverResponse.parse(updated));
  },
);

// ---------------------------------------------------------------------------
// Late-service surcharge decision (FR-SR-07): apply or waive
// ---------------------------------------------------------------------------

router.post("/job-cards/:id/surcharge", async (req, res): Promise<void> => {
  const params = DecideJobCardSurchargeParams.safeParse(req.params);
  const parsed = DecideJobCardSurchargeBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(eq(jobCardsTable.id, params.data.id), eq(jobCardsTable.dealerId, dealerId)),
    );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  // Invoiced cards are settled — the surcharge decision must precede billing.
  const [invoiced] = await db
    .select({ id: serviceInvoicesTable.id })
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.jobCardId, card.id),
        eq(serviceInvoicesTable.dealerId, dealerId),
      ),
    )
    .limit(1);
  if (invoiced) {
    res.status(422).json({
      error: `Invoice #${invoiced.id} already issued — adjust the invoice instead`,
    });
    return;
  }
  const settings = await getServiceSettings(dealerId);
  const decidedBy = res.locals.user?.name ?? res.locals.user?.email ?? "Staff";
  const apply = parsed.data.action === "apply";
  const amount = apply
    ? parsed.data.amount ??
      (card.surchargeAmount > 0 ? card.surchargeAmount : settings.lateSurchargeFee)
    : card.surchargeAmount;
  const [updated] = await db
    .update(jobCardsTable)
    .set({
      surchargeStatus: apply ? "applied" : "waived",
      surchargeAmount: amount,
      surchargeDecidedBy: decidedBy,
      surchargeDecidedAt: new Date(),
    })
    .where(
      and(eq(jobCardsTable.id, card.id), eq(jobCardsTable.dealerId, dealerId)),
    )
    .returning();
  res.json(DecideJobCardSurchargeResponse.parse(updated));
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

  let backorderPoId: number | null = null;
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
      // Raise a formal PO linked back to the originating job card — receiving
      // it increments stock, fills this backordered line and releases the card.
      const [po] = await tx
        .insert(purchaseOrdersTable)
        .values({
          dealerId: card.dealerId,
          supplierId: currentPart.supplierId,
          status: "ordered",
          reference: `Backorder — job card #${card.id}`,
        })
        .returning();
      await tx.insert(purchaseOrderLinesTable).values({
        dealerId: card.dealerId,
        purchaseOrderId: po.id,
        partId: currentPart.id,
        partName: currentPart.name,
        quantity: Math.max(shortfall, currentPart.reorderLevel),
        unitCost: currentPart.unitCost,
        jobCardId: card.id,
      });
      backorderPoId = po.id;
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

  // Collision cycle-time pause: a backordered part on a claim's repair order
  // stops the clock until parts arrive (auto-resume on PO receipt or the
  // explicit resume endpoint). Purely a measurement pause — the workshop
  // lifecycle above is untouched (Task 279).
  if (backordered) {
    await db.transaction(async (tx) => {
      const [claim] = await tx
        .select()
        .from(collisionClaimsTable)
        .where(
          and(
            eq(collisionClaimsTable.serviceOrderId, card.serviceOrderId),
            eq(collisionClaimsTable.dealerId, card.dealerId),
          ),
        )
        .for("update");
      if (
        claim &&
        claim.pausedAt == null &&
        !["closed", "denied", "total_loss"].includes(claim.status)
      ) {
        await tx
          .update(collisionClaimsTable)
          .set({
          pausedAt: new Date(),
          history: [
            ...claim.history,
            {
              kind: "pause" as const,
              note: `${currentPart.name} backordered — cycle time paused`,
              byUserId: res.locals.user?.id ?? null,
              byName: res.locals.user?.name ?? res.locals.user?.email ?? "System",
              at: new Date().toISOString(),
            },
          ],
          })
          .where(eq(collisionClaimsTable.id, claim.id));
      }
    });
  }

  // MRQ alert: fire only when this issuance CROSSES the reorder threshold.
  if (!backordered && kind === "issue") {
    checkLowStockCrossing(
      currentPart,
      currentPart.stock,
      currentPart.stock - parsed.data.quantity,
    );
  }

  // ERPNext: issues/returns are Stock Entries; the backorder path moved no
  // stock but raised a PO that must sync instead.
  if (backorderPoId != null) {
    enqueuePurchaseOrderSync(card.dealerId, backorderPoId, "insert");
  } else {
    enqueueStockEntrySync({
      dealerId: card.dealerId,
      partId: currentPart.id,
      qty: parsed.data.quantity,
      direction: kind === "issue" ? "out" : "in",
      entityType: "job_card_part",
      entityId: line.id,
      remark: `AURA job card #${card.id} — part ${kind} (${currentPart.sku})`,
      dedupeKey: `erp:se:jcp:${card.dealerId}:${line.id}`,
    });
  }

  res.status(201).json(AddJobCardPartResponse.parse(line));
});

// ---------------------------------------------------------------------------
// Credit notes (FR-PI-09): returned/unused parts restore stock and reduce the
// job's parts total — internal adjustment only, no cash refund.
// ---------------------------------------------------------------------------

router.get("/job-cards/:id/credit-notes", async (req, res): Promise<void> => {
  const params = ListJobCardCreditNotesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(partCreditNotesTable)
    .where(
      and(
        eq(partCreditNotesTable.jobCardId, params.data.id),
        eq(partCreditNotesTable.dealerId, activeDealerId(res)),
      ),
    )
    .orderBy(desc(partCreditNotesTable.createdAt));
  res.json(ListJobCardCreditNotesResponse.parse(rows));
});

router.post("/job-cards/:id/credit-notes", async (req, res): Promise<void> => {
  const params = CreateJobCardCreditNoteParams.safeParse(req.params);
  const parsed = CreateJobCardCreditNoteBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, params.data.id),
        eq(jobCardsTable.dealerId, dealerId),
      ),
    );
  if (!card) {
    res.status(404).json({ error: "Job card not found" });
    return;
  }
  const [line] = await db
    .select()
    .from(jobCardPartsTable)
    .where(
      and(
        eq(jobCardPartsTable.id, parsed.data.jobCardPartId),
        eq(jobCardPartsTable.jobCardId, card.id),
        eq(jobCardPartsTable.dealerId, dealerId),
      ),
    );
  if (!line || line.kind !== "issue") {
    res.status(404).json({ error: "Issued part line not found on this job card" });
    return;
  }
  if (line.backordered) {
    res.status(422).json({
      error: "This line is still backordered — nothing was issued to credit",
    });
    return;
  }
  const [{ credited }] = await db
    .select({
      credited: sql<number>`coalesce(sum(${partCreditNotesTable.quantity}), 0)::int`,
    })
    .from(partCreditNotesTable)
    .where(
      and(
        eq(partCreditNotesTable.jobCardPartId, line.id),
        eq(partCreditNotesTable.dealerId, dealerId),
      ),
    );
  const remaining = line.quantity - credited;
  if (parsed.data.quantity > remaining) {
    res.status(422).json({
      error: `Only ${remaining} unit(s) of ${line.partName} left to credit on this line`,
    });
    return;
  }

  const note = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(partCreditNotesTable)
      .values({
        dealerId,
        jobCardId: card.id,
        jobCardPartId: line.id,
        partId: line.partId,
        partName: line.partName,
        quantity: parsed.data.quantity,
        unitPrice: line.unitPrice,
        amount:
          Math.round(line.unitPrice * parsed.data.quantity * 100) / 100,
        reason: parsed.data.reason,
        createdBy: res.locals.user?.name ?? null,
      })
      .returning();
    // The paired return line restores stock and is what reduces the job's
    // parts total (and any invoice issued later) — it also shows in history.
    await tx.insert(jobCardPartsTable).values({
      dealerId,
      jobCardId: card.id,
      partId: line.partId,
      partName: line.partName,
      kind: "return",
      quantity: parsed.data.quantity,
      unitPrice: line.unitPrice,
      unitCost: line.unitCost,
      backordered: false,
    });
    await tx
      .update(partsTable)
      .set({ stock: sql`${partsTable.stock} + ${parsed.data.quantity}` })
      .where(
        and(eq(partsTable.id, line.partId), eq(partsTable.dealerId, dealerId)),
      );
    return inserted;
    // (ERPNext Material Receipt for this return is enqueued after commit.)
  });

  // ERPNext: the credited return restores stock → Material Receipt.
  enqueueStockEntrySync({
    dealerId,
    partId: line.partId,
    qty: parsed.data.quantity,
    direction: "in",
    entityType: "part_credit_note",
    entityId: note.id,
    remark: `AURA job card #${card.id} — credit note return (${line.partName})`,
    dedupeKey: `erp:se:credit:${dealerId}:${note.id}`,
  });

  res.status(201).json(CreateJobCardCreditNoteResponse.parse(note));
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Compute totals and issue the invoice for a job card. Shared by the manual
 * "Generate invoice" endpoint and the automatic issue-on-completion path.
 * Fires the customer invoice email (deduped per invoice) on success.
 */
async function issueServiceInvoice(
  card: JobCard,
): Promise<
  | { ok: true; invoice: ServiceInvoice }
  | { ok: false; status: number; error: string }
> {
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
    return {
      ok: false,
      status: 409,
      error: `Invoice #${existing.id} already exists for this job card`,
    };
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
    return { ok: false, status: 404, error: "Service order not found" };
  }

  // Collision claims gate invoicing on insurer sign-off: the invoice defines
  // the insurer/deductible split, so it cannot be issued before the insurer
  // has signed off on the completed repair (Task 279).
  const [claim] = await db
    .select()
    .from(collisionClaimsTable)
    .where(
      and(
        eq(collisionClaimsTable.serviceOrderId, order.id),
        eq(collisionClaimsTable.dealerId, order.dealerId),
      ),
    );
  if (claim && !["insurer_signoff", "invoiced"].includes(claim.status)) {
    return {
      ok: false,
      status: 422,
      error:
        "This repair has a collision claim awaiting insurer sign-off — the claim must reach Insurer Sign-off before invoicing",
    };
  }
  if (claim) {
    const [pendingSupplement] = await db
      .select({ id: collisionSupplementsTable.id })
      .from(collisionSupplementsTable)
      .where(
        and(
          eq(collisionSupplementsTable.claimId, claim.id),
          eq(collisionSupplementsTable.dealerId, claim.dealerId),
          eq(collisionSupplementsTable.status, "pending"),
        ),
      )
      .limit(1);
    if (pendingSupplement) {
      return {
        ok: false,
        status: 422,
        error:
          "Decide all pending collision supplements before generating the invoice",
      };
    }
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
  // A suggested-but-undecided surcharge blocks invoicing: staff must apply
  // or waive it so the decision is on record before totals lock.
  if (card.surchargeStatus === "suggested") {
    return {
      ok: false,
      status: 422,
      error:
        "Late-service surcharge is still undecided — apply or waive it before invoicing",
    };
  }
  const surchargeTotal =
    card.surchargeStatus === "applied" ? card.surchargeAmount : 0;
  // Deterministic tax engine: same per-dealer configured rules as sales
  // quotes (dealer_taxes VAT rule) — no hardcoded rate.
  const taxRules = await ensureDealerTaxes(card.dealerId);
  const { tax, total } = computeServiceTax(
    Math.round((partsTotal + laborTotal + surchargeTotal) * 100) / 100,
    taxRules,
  );

  // Issue + collision binding in ONE transaction with the claim row locked
  // FOR UPDATE: the invoice can never exist while the split stamping loses a
  // race to a concurrent claim transition — if the stamp cannot apply, the
  // whole issue rolls back.
  let issued: ServiceInvoice | undefined;
  try {
    issued = await db.transaction(async (tx) => {
      // Serialize against collision-claim intake on the shared repair order,
      // then re-read the claim after the lock. This closes the "both observed
      // no row" race between normal invoicing and claim creation.
      const [lockedOrder] = await tx
        .select({ id: serviceOrdersTable.id })
        .from(serviceOrdersTable)
        .where(
          and(
            eq(serviceOrdersTable.id, order.id),
            eq(serviceOrdersTable.dealerId, order.dealerId),
          ),
        )
        .for("update");
      if (!lockedOrder) {
        throw Object.assign(new Error("service-order-missing"), {
          issueCode: 404,
        });
      }
      const [lockedClaim] = await tx
        .select()
        .from(collisionClaimsTable)
        .where(
          and(
            eq(collisionClaimsTable.serviceOrderId, lockedOrder.id),
            eq(collisionClaimsTable.dealerId, order.dealerId),
          ),
        )
        .for("update");
      if (lockedClaim) {
        // Only an exactly insurer_signoff claim with no bound invoice may be
        // invoiced: a concurrent issue that already stamped the claim leaves
        // it invoiced/bound, and this second attempt must not create an
        // unbound duplicate receivable.
        if (
          !lockedClaim ||
          lockedClaim.status !== "insurer_signoff" ||
          lockedClaim.serviceInvoiceId != null
        ) {
          const code =
            lockedClaim &&
            (lockedClaim.status === "invoiced" ||
              lockedClaim.serviceInvoiceId != null)
              ? 409
              : 422;
          throw Object.assign(new Error("collision-gate"), { issueCode: code });
        }
        const [pendingSupplement] = await tx
          .select({ id: collisionSupplementsTable.id })
          .from(collisionSupplementsTable)
          .where(
            and(
              eq(collisionSupplementsTable.claimId, lockedClaim.id),
              eq(collisionSupplementsTable.dealerId, lockedClaim.dealerId),
              eq(collisionSupplementsTable.status, "pending"),
            ),
          )
          .limit(1);
        if (pendingSupplement) {
          throw Object.assign(new Error("pending-supplements"), {
            issueCode: 422,
          });
        }
      }
      // Re-check the one-invoice-per-job-card invariant AFTER taking the
      // claim lock: two concurrent issues both pass the pre-transaction
      // check, but the loser serializes behind the winner here and bails
      // without inserting. The service_invoices_job_card_unique DB index
      // backstops the non-collision path.
      const [dupe] = await tx
        .select({ id: serviceInvoicesTable.id })
        .from(serviceInvoicesTable)
        .where(
          and(
            eq(serviceInvoicesTable.jobCardId, card.id),
            eq(serviceInvoicesTable.dealerId, card.dealerId),
          ),
        );
      if (dupe) {
        throw Object.assign(new Error("invoice-exists"), { issueCode: 409 });
      }
      const [created] = await tx
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
          surchargeTotal: Math.round(surchargeTotal * 100) / 100,
          tax,
          total,
          status: "issued",
          // Totals lock at issue (FR-SR-09); discount approval and the
          // adjustment endpoint are the only sanctioned paths that change them.
          lockedAt: new Date(),
        })
        .returning();

      // Stamp the collision split on the claim: the customer owes the
      // deductible (capped at the invoice total); the insurer owes the rest.
      // The claim auto-advances insurer_signoff → invoiced with an audit event.
      if (created && lockedClaim && lockedClaim.status === "insurer_signoff") {
        const deductibleDue =
          Math.round(Math.min(lockedClaim.deductible, created.total) * 100) /
          100;
        const insurerDue =
          Math.round((created.total - deductibleDue) * 100) / 100;
        const [stamped] = await tx
          .update(collisionClaimsTable)
          .set({
            status: "invoiced",
            serviceInvoiceId: created.id,
            insurerDue,
            deductibleDue,
            history: [
              ...lockedClaim.history,
              {
                kind: "status" as const,
                from: "insurer_signoff",
                to: "invoiced",
                note: `Invoice #${created.id} issued — insurer ${insurerDue.toFixed(2)}, deductible ${deductibleDue.toFixed(2)}`,
                byUserId: null,
                byName: "System",
                at: new Date().toISOString(),
              },
            ],
          })
          .where(
            and(
              eq(collisionClaimsTable.id, lockedClaim.id),
              eq(collisionClaimsTable.dealerId, lockedClaim.dealerId),
              eq(collisionClaimsTable.status, "insurer_signoff"),
            ),
          )
          .returning();
        // Row is locked, so a miss means something is deeply wrong — roll the
        // invoice back rather than leave it unbound.
        if (!stamped) {
          throw Object.assign(new Error("collision-race"), { issueCode: 409 });
        }
      }
      return created;
    });
  } catch (err) {
    const code = (err as { issueCode?: number }).issueCode;
    if (code === 404) {
      return { ok: false, status: 404, error: "Service order not found" };
    }
    if (code === 422) {
      return {
        ok: false,
        status: 422,
        error:
          (err as Error).message === "pending-supplements"
            ? "Decide all pending collision supplements before generating the invoice"
            : "This repair has a collision claim awaiting insurer sign-off — the claim must reach Insurer Sign-off before invoicing",
      };
    }
    if (code === 409) {
      return {
        ok: false,
        status: 409,
        error:
          (err as Error).message === "invoice-exists"
            ? "An invoice already exists for this job card"
            : "This repair's collision claim is already invoiced",
      };
    }
    // DB unique backstop (service_invoices_job_card_unique) for concurrent
    // issues that slipped past every check — drizzle wraps pg in err.cause.
    const pg = err as { code?: string; cause?: { code?: string } };
    if (pg?.code === "23505" || pg?.cause?.code === "23505") {
      return {
        ok: false,
        status: 409,
        error: "An invoice already exists for this job card",
      };
    }
    throw err;
  }
  const invoice = issued;

  // FR-COM: customer gets the invoice PDF by email (deduped per invoice).
  if (invoice) onServiceInvoiceIssued(invoice);
  if (invoice && claim) {
    coordinateCollisionClaim({
      id: claim.id,
      dealerId: claim.dealerId,
      vehicleInfo: claim.vehicleInfo,
      status: "invoiced",
      event: "status",
      eventKey: "status:insurer_signoff:invoiced",
      detail: `Invoice #${invoice.id} generated; insurer and deductible collection can begin.`,
    });
  }

  return { ok: true, invoice };
}

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
  const result = await issueServiceInvoice(card);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(CreateJobCardInvoiceResponse.parse(result.invoice));
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
  // Locked totals (FR-SR-09): PATCH only ever touches lifecycle status and
  // the signed-copy acknowledgement — monetary fields are not accepted here.
  const dealerId = activeDealerId(res);
  const { signedCopyFiled, status } = parsed.data;
  // One transaction with the invoice row locked FOR UPDATE: the collision
  // advance route locks the same row before binding it to a claim, so a
  // manual void can never slip in between "claim reads issued invoice" and
  // "claim binds it" — one of the two serializes behind the other.
  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(serviceInvoicesTable)
      .where(
        and(
          eq(serviceInvoicesTable.id, params.data.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
        ),
      )
      .for("update");
    if (!current) return { code: 404 as const, error: "Invoice not found" };
    // Irreversible lifecycle: issued → paid | void only. Paid and void are
    // terminal — a paid invoice can never be reopened into an adjustable state.
    if (status !== undefined && status !== current.status) {
      const allowed =
        current.status === "issued" && (status === "paid" || status === "void");
      if (!allowed) {
        return {
          code: 422 as const,
          error: `Invalid status transition ${current.status} → ${status}; paid and void invoices are final`,
        };
      }
    }
    if (signedCopyFiled !== undefined && current.status === "void") {
      return {
        code: 422 as const,
        error: "Cannot record acknowledgements on a void invoice",
      };
    }
    // Collision-claim invoices settle through the split receivable (insurer +
    // deductible settlements), not a manual flip: paid requires both shares
    // collected, and void is blocked outright while a live claim exists on
    // this repair — linked already or still awaiting binding (Task 279).
    if (status !== undefined && status !== current.status) {
      const [claim] = await tx
        .select()
        .from(collisionClaimsTable)
        .where(
          and(
            eq(collisionClaimsTable.serviceOrderId, current.serviceOrderId),
            eq(collisionClaimsTable.dealerId, dealerId),
          ),
        );
      if (
        claim &&
        (claim.serviceInvoiceId === current.id ||
          !["denied", "total_loss", "closed"].includes(claim.status))
      ) {
        if (status === "void") {
          return {
            code: 422 as const,
            error:
              "Cannot void a collision-claim invoice — resolve it through the claim (denied / total loss) instead",
          };
        }
        const [sums] = await tx
          .select({
            insurerPaid: sql<number>`coalesce(sum(case when ${collisionSettlementsTable.payer} = 'insurer' then ${collisionSettlementsTable.amount} else 0 end), 0)`,
            deductiblePaid: sql<number>`coalesce(sum(case when ${collisionSettlementsTable.payer} = 'customer' then ${collisionSettlementsTable.amount} else 0 end), 0)`,
          })
          .from(collisionSettlementsTable)
          .where(
            and(
              eq(collisionSettlementsTable.claimId, claim.id),
              eq(collisionSettlementsTable.dealerId, dealerId),
            ),
          );
        if (
          status === "paid" &&
          (claim.serviceInvoiceId !== current.id ||
            (sums?.insurerPaid ?? 0) < (claim.insurerDue ?? 0) - 0.005 ||
            (sums?.deductiblePaid ?? 0) < (claim.deductibleDue ?? 0) - 0.005)
        ) {
          return {
            code: 422 as const,
            error:
              "This invoice belongs to a collision claim — record the insurer and deductible settlements on the claim; it flips to paid automatically once both are collected",
          };
        }
      }
    }
    const patch: Partial<typeof serviceInvoicesTable.$inferInsert> = {};
    if (status !== undefined) patch.status = status;
    if (signedCopyFiled) {
      patch.signedCopyFiledBy =
        res.locals.user?.name ?? res.locals.user?.email ?? "Staff";
      patch.signedCopyFiledAt = new Date();
    } else if (signedCopyFiled === false) {
      patch.signedCopyFiledBy = null;
      patch.signedCopyFiledAt = null;
    }
    if (Object.keys(patch).length === 0) {
      return { code: 200 as const, invoice: current };
    }
    const [invoice] = await tx
      .update(serviceInvoicesTable)
      .set(patch)
      .where(
        and(
          eq(serviceInvoicesTable.id, current.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
        ),
      )
      .returning();
    return { code: 200 as const, invoice: invoice! };
  });
  if (outcome.code !== 200) {
    res.status(outcome.code).json({ error: outcome.error });
    return;
  }
  res.json(UpdateServiceInvoiceResponse.parse(outcome.invoice));
});

// ---------------------------------------------------------------------------
// Discount approval workflow (FR-SR-08)
// ---------------------------------------------------------------------------

router.post(
  "/service-invoices/:id/discount",
  async (req, res): Promise<void> => {
    const params = RequestServiceInvoiceDiscountParams.safeParse(req.params);
    const parsed = RequestServiceInvoiceDiscountBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: (params.success ? parsed : params).error?.message ?? "Invalid",
      });
      return;
    }
    const dealerId = activeDealerId(res);
    const [invoice] = await db
      .select()
      .from(serviceInvoicesTable)
      .where(
        and(
          eq(serviceInvoicesTable.id, params.data.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
        ),
      );
    if (!invoice) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    const [collisionClaim] = await db
      .select({ id: collisionClaimsTable.id })
      .from(collisionClaimsTable)
      .where(
        and(
          eq(collisionClaimsTable.serviceInvoiceId, invoice.id),
          eq(collisionClaimsTable.dealerId, dealerId),
        ),
      )
      .limit(1);
    if (collisionClaim) {
      res.status(422).json({
        error:
          "Collision invoice totals are locked to the insurer/deductible split; use the claim supplement and settlement workflow",
      });
      return;
    }
    if (invoice.status !== "issued") {
      res.status(422).json({
        error: `Discounts can only be requested on issued invoices (this one is ${invoice.status})`,
      });
      return;
    }
    if (invoice.discountStatus === "pending") {
      res.status(422).json({ error: "A discount request is already pending" });
      return;
    }
    if (invoice.discountStatus === "approved") {
      res.status(422).json({ error: "A discount has already been approved" });
      return;
    }
    const preDiscount =
      invoice.partsTotal + invoice.laborTotal + invoice.surchargeTotal + invoice.tax;
    if (parsed.data.amount > preDiscount) {
      res.status(422).json({
        error: "Discount cannot exceed the invoice total",
      });
      return;
    }
    const [updated] = await db
      .update(serviceInvoicesTable)
      .set({
        discountStatus: "pending",
        discountRequestedAmount: parsed.data.amount,
        discountReason: parsed.data.reason ?? null,
        discountRequestedBy:
          res.locals.user?.name ?? res.locals.user?.email ?? "Staff",
        discountRequestedAt: new Date(),
        discountDecidedBy: null,
        discountDecidedAt: null,
      })
      .where(
        and(
          eq(serviceInvoicesTable.id, invoice.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
        ),
      )
      .returning();
    res.json(RequestServiceInvoiceDiscountResponse.parse(updated));
  },
);

router.post(
  "/service-invoices/:id/discount/decision",
  async (req, res): Promise<void> => {
    const params = DecideServiceInvoiceDiscountParams.safeParse(req.params);
    const parsed = DecideServiceInvoiceDiscountBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: (params.success ? parsed : params).error?.message ?? "Invalid",
      });
      return;
    }
    const user = res.locals.user;
    if (!isServiceApprover(user)) {
      res.status(403).json({
        error: "Only the Service Manager or Management can decide discounts",
      });
      return;
    }
    const dealerId = activeDealerId(res);
    const [invoice] = await db
      .select()
      .from(serviceInvoicesTable)
      .where(
        and(
          eq(serviceInvoicesTable.id, params.data.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
        ),
      );
    if (!invoice) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    const [collisionClaim] = await db
      .select({ id: collisionClaimsTable.id })
      .from(collisionClaimsTable)
      .where(
        and(
          eq(collisionClaimsTable.serviceInvoiceId, invoice.id),
          eq(collisionClaimsTable.dealerId, dealerId),
        ),
      )
      .limit(1);
    if (collisionClaim) {
      res.status(422).json({
        error:
          "Collision invoice totals are locked to the insurer/deductible split; use the claim supplement and settlement workflow",
      });
      return;
    }
    if (invoice.discountStatus !== "pending") {
      res.status(422).json({ error: "No pending discount on this invoice" });
      return;
    }
    const approve = parsed.data.action === "approve";
    const requested = invoice.discountRequestedAmount ?? 0;
    const preDiscount =
      Math.round(
        (invoice.partsTotal +
          invoice.laborTotal +
          invoice.surchargeTotal +
          invoice.tax) *
          100,
      ) / 100;
    const discount = approve ? Math.min(requested, preDiscount) : 0;
    const adjustmentSum = (invoice.adjustments ?? []).reduce(
      (s, a) => s + a.amount,
      0,
    );
    const [updated] = await db
      .update(serviceInvoicesTable)
      .set({
        discountStatus: approve ? "approved" : "rejected",
        discountTotal: discount,
        discountDecidedBy: user?.name ?? user?.email ?? "Manager",
        discountDecidedAt: new Date(),
        ...(approve
          ? {
              total:
                Math.round((preDiscount - discount + adjustmentSum) * 100) /
                100,
            }
          : {}),
      })
      .where(
        and(
          eq(serviceInvoicesTable.id, invoice.id),
          eq(serviceInvoicesTable.dealerId, dealerId),
        ),
      )
      .returning();
    res.json(DecideServiceInvoiceDiscountResponse.parse(updated));
  },
);

// ---------------------------------------------------------------------------
// Post-issue adjustments (FR-SR-09): the only way locked totals change
// ---------------------------------------------------------------------------

router.post("/service-invoices/:id/adjust", async (req, res): Promise<void> => {
  const params = AdjustServiceInvoiceParams.safeParse(req.params);
  const parsed = AdjustServiceInvoiceBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [invoice] = await db
    .select()
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.id, params.data.id),
        eq(serviceInvoicesTable.dealerId, dealerId),
      ),
    );
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const [collisionClaim] = await db
    .select({ id: collisionClaimsTable.id })
    .from(collisionClaimsTable)
    .where(
      and(
        eq(collisionClaimsTable.serviceInvoiceId, invoice.id),
        eq(collisionClaimsTable.dealerId, dealerId),
      ),
    )
    .limit(1);
  if (collisionClaim) {
    res.status(422).json({
      error:
        "Collision invoice totals are locked to the insurer/deductible split; use the claim supplement and settlement workflow",
    });
    return;
  }
  // Adjustments change a locked financial record, so they are restricted to
  // Service Manager / Management — not the standard service:create grant.
  if (!isServiceApprover(res.locals.user)) {
    res.status(403).json({
      error: "Only the Service Manager or Management can record adjustments",
    });
    return;
  }
  if (invoice.status !== "issued") {
    res.status(422).json({
      error:
        invoice.status === "paid"
          ? "Invoice is already paid — settle differences through a credit note, not an adjustment"
          : "Cannot adjust a void invoice",
    });
    return;
  }
  const entry = {
    amount: Math.round(parsed.data.amount * 100) / 100,
    reason: parsed.data.reason,
    by: res.locals.user?.name ?? res.locals.user?.email ?? "Staff",
    at: new Date().toISOString(),
  };
  const nextTotal = Math.round((invoice.total + entry.amount) * 100) / 100;
  if (nextTotal < 0) {
    res.status(422).json({ error: "Adjustment would make the total negative" });
    return;
  }
  // Conditional on status + unchanged total so a concurrent adjustment or
  // payment can't be silently overwritten; the loser gets a 409 to retry.
  const [updated] = await db
    .update(serviceInvoicesTable)
    .set({
      adjustments: [...(invoice.adjustments ?? []), entry],
      total: nextTotal,
    })
    .where(
      and(
        eq(serviceInvoicesTable.id, invoice.id),
        eq(serviceInvoicesTable.dealerId, dealerId),
        eq(serviceInvoicesTable.status, "issued"),
        eq(serviceInvoicesTable.total, invoice.total),
      ),
    )
    .returning();
  if (!updated) {
    res.status(409).json({
      error: "Invoice changed while recording the adjustment — reload and retry",
    });
    return;
  }
  res.json(AdjustServiceInvoiceResponse.parse(updated));
});

router.get(
  "/service-invoices/:id/receipt-pdf",
  async (req, res): Promise<void> => {
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
    const pdf = await buildServiceReceiptPdf(
      invoice,
      await dealerTimezone(invoice.dealerId),
      await getDealerPdfBranding(invoice.dealerId),
    );
    res
      .setHeader("Content-Type", "application/pdf")
      .setHeader(
        "Content-Disposition",
        `inline; filename="SR-${String(invoice.id).padStart(5, "0")}-receipt.pdf"`,
      )
      .send(pdf);
  },
);

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
  const pdf = await buildServiceInvoicePdf(
    invoice,
    rate,
    await dealerTimezone(invoice.dealerId),
    await getDealerPdfBranding(invoice.dealerId),
  );
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
  const pdf = await buildCoverageCertificatePdf(
    plan,
    await dealerTimezone(plan.dealerId),
    await getDealerPdfBranding(plan.dealerId),
  );
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
