import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  bookingsTable,
  dealsTable,
  deliveriesTable,
  gatesTable,
  invoicesTable,
  paymentsTable,
  timelineEventsTable,
  vehiclesTable,
  type Booking,
  type Deal,
  type GateEvidenceItem,
} from "@workspace/db";

const money = (n: number) =>
  `GY$${Math.round(n).toLocaleString("en-US")}`;

/**
 * L9 refundable-until-registration rule: once the delivery's registration
 * step is completed (or the unit is delivered/sold), the standard automated
 * refund path is closed — returns a human-readable block reason, else null.
 */
export async function refundBlockReason(opts: {
  dealerId: number;
  dealId?: number | null;
  vehicleId?: number | null;
}): Promise<string | null> {
  if (opts.dealId != null) {
    const [delivery] = await db
      .select()
      .from(deliveriesTable)
      .where(
        and(
          eq(deliveriesTable.dealId, opts.dealId),
          eq(deliveriesTable.dealerId, opts.dealerId),
        ),
      );
    if (delivery && delivery.status !== "cancelled") {
      const registrationDone = delivery.steps.some(
        (s) => s.key === "registration" && s.status === "completed",
      );
      if (registrationDone || delivery.status === "completed") {
        return "Registration has already been completed for this vehicle — the refundable window is closed. Handle any goodwill refund manually with leadership approval.";
      }
    }
  }
  if (opts.vehicleId != null) {
    const [vehicle] = await db
      .select({ status: vehiclesTable.status })
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, opts.vehicleId),
          eq(vehiclesTable.dealerId, opts.dealerId),
        ),
      );
    if (vehicle && (vehicle.status === "delivered" || vehicle.status === "sold")) {
      return "The vehicle has already been delivered/sold — the refundable window is closed. Handle any goodwill refund manually with leadership approval.";
    }
  }
  return null;
}

/** Captured (net) funds across all invoices linked to a deal. */
export async function capturedFundsForDeal(
  deal: Deal,
): Promise<{ amount: number; invoiceIds: number[]; invoiceNumbers: string[] }> {
  const invoices = await db
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.dealId, deal.id),
        eq(invoicesTable.dealerId, deal.dealerId),
      ),
    );
  const ids = invoices.map((i) => i.id);
  if (ids.length === 0) return { amount: 0, invoiceIds: [], invoiceNumbers: [] };
  const payments = await db
    .select()
    .from(paymentsTable)
    .where(
      and(
        inArray(paymentsTable.invoiceId, ids),
        eq(paymentsTable.dealerId, deal.dealerId),
      ),
    );
  const amount = payments.reduce((sum, p) => sum + p.amount, 0);
  return {
    amount: Math.round(amount * 100) / 100,
    invoiceIds: ids,
    invoiceNumbers: invoices.map((i) => i.invoiceNumber),
  };
}

/**
 * Raise the L9 refund_release approval gate for a cancellation with captured
 * funds. Money never moves here — a manager must approve, then finance posts
 * the refund (negative payment referencing this gate).
 */
export async function raiseRefundReleaseGate(opts: {
  dealerId: number;
  refType: "deal" | "booking";
  refId: number;
  customerId: number | null;
  customerName: string | null;
  amount: number;
  reasonCode: string;
  reasonNote?: string | null;
  evidence: GateEvidenceItem[];
}): Promise<number> {
  // Idempotent per record: reuse a still-pending refund gate.
  const [existing] = await db
    .select({ id: gatesTable.id })
    .from(gatesTable)
    .where(
      and(
        eq(gatesTable.dealerId, opts.dealerId),
        eq(gatesTable.type, "refund_release"),
        eq(gatesTable.refType, opts.refType),
        eq(gatesTable.refId, opts.refId),
        eq(gatesTable.status, "pending"),
      ),
    );
  if (existing) return existing.id;

  const [gate] = await db
    .insert(gatesTable)
    .values({
      dealerId: opts.dealerId,
      type: "refund_release",
      status: "pending",
      priority: "high",
      customerId: opts.customerId,
      customerName: opts.customerName,
      refType: opts.refType,
      refId: opts.refId,
      title: `Refund release — ${opts.customerName ?? `${opts.refType} #${opts.refId}`}`,
      summary: `Cancellation (${opts.reasonCode.replace(/_/g, " ")}) with ${money(opts.amount)} captured. Manager approval releases the vehicle hold and authorizes finance to execute the refund.`,
      recommendation:
        "Verify the cancellation reason and refund amount, then approve to release the hold and route the refund to finance.",
      amount: opts.amount,
      evidence: [
        { label: "Reason", value: opts.reasonCode },
        ...(opts.reasonNote ? [{ label: "Note", value: opts.reasonNote }] : []),
        { label: "Captured funds", value: money(opts.amount) },
        { label: "Retained fees", value: money(0) },
        { label: "Computed refund", value: money(opts.amount) },
        ...opts.evidence,
      ],
    })
    .returning({ id: gatesTable.id });
  return gate!.id;
}

/** Releases the vehicle back to available if no other active booking holds it. */
export async function releaseVehicleIfUnheld(
  vehicleId: number,
  dealerId: number,
): Promise<boolean> {
  const [other] = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.vehicleId, vehicleId),
        eq(bookingsTable.status, "active"),
        eq(bookingsTable.dealerId, dealerId),
      ),
    );
  if (other) return false;
  const [v] = await db
    .select({ status: vehiclesTable.status })
    .from(vehiclesTable)
    .where(
      and(eq(vehiclesTable.id, vehicleId), eq(vehiclesTable.dealerId, dealerId)),
    );
  if (v && (v.status === "reserved" || v.status === "booked")) {
    await db
      .update(vehiclesTable)
      .set({ status: "available", holdUntil: null, holdReason: null })
      .where(
        and(
          eq(vehiclesTable.id, vehicleId),
          eq(vehiclesTable.dealerId, dealerId),
        ),
      );
    return true;
  }
  return false;
}

/**
 * Downstream effects of a confirmed deal cancellation: cancel active
 * bookings, void the delivery workflow, and (optionally) release the unit.
 * History is retained — nothing is deleted.
 */
export async function cascadeDealCancellation(opts: {
  deal: Deal;
  reasonCode: string;
  reasonNote?: string | null;
  releaseVehicle: boolean;
  actor: string;
}): Promise<{ vehicleReleased: boolean }> {
  const { deal } = opts;
  await db
    .update(bookingsTable)
    .set({
      status: "cancelled",
      cancellationReason: opts.reasonCode,
      cancellationNote: opts.reasonNote ?? null,
    })
    .where(
      and(
        eq(bookingsTable.dealId, deal.id),
        eq(bookingsTable.dealerId, deal.dealerId),
        eq(bookingsTable.status, "active"),
      ),
    );
  await db
    .update(deliveriesTable)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(deliveriesTable.dealId, deal.id),
        eq(deliveriesTable.dealerId, deal.dealerId),
        eq(deliveriesTable.status, "in_progress"),
      ),
    );
  let vehicleReleased = false;
  if (opts.releaseVehicle) {
    vehicleReleased = await releaseVehicleIfUnheld(deal.vehicleId, deal.dealerId);
  }
  return { vehicleReleased };
}

/** Timeline receipt for cancellation lifecycle moments (history retained). */
export async function logCancellationEvent(opts: {
  dealerId: number;
  customerId: number | null;
  refType: "deal" | "booking";
  refId: number;
  title: string;
  detail: string;
  actor: string;
}): Promise<void> {
  await db.insert(timelineEventsTable).values({
    dealerId: opts.dealerId,
    customerId: opts.customerId,
    domain: "deal",
    kind: "cancellation",
    title: opts.title,
    detail: opts.detail,
    actor: opts.actor,
    isAgent: false,
    cause: "Cancellation & refund workflow (L9)",
    refType: opts.refType,
    refId: opts.refId,
  });
}

/** Look up a booking scoped to a dealer. */
export async function dealerBooking(
  bookingId: number,
  dealerId: number,
): Promise<Booking | null> {
  const [b] = await db
    .select()
    .from(bookingsTable)
    .where(
      and(eq(bookingsTable.id, bookingId), eq(bookingsTable.dealerId, dealerId)),
    );
  return b ?? null;
}

/** Look up the deal linked to a booking (if any). */
export async function bookingDeal(booking: Booking): Promise<Deal | null> {
  if (booking.dealId == null) return null;
  const [d] = await db
    .select()
    .from(dealsTable)
    .where(
      and(
        eq(dealsTable.id, booking.dealId),
        eq(dealsTable.dealerId, booking.dealerId),
      ),
    );
  return d ?? null;
}
