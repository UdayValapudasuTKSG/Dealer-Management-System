import { and, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  db,
  bookingsTable,
  dealsTable,
  dealItemsTable,
  reservationAllocationsTable,
  timelineEventsTable,
  vehiclesTable,
  VIN_LENGTH,
  REGISTRATION_PATTERN,
} from "@workspace/db";
import { logger } from "./logger";
import { notifyUsers } from "./email";
import { generalManagers } from "./notify-matrix";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Default reservation hold horizon when no booking expiry exists. */
const RESERVATION_HOLD_HOURS = 72;

/**
 * All-or-nothing soft lock of one distinct matching VIN per requested
 * deal-item unit after a reservation invoice is FULLY paid.
 *
 * Runs its OWN transaction (never inside the payment transaction) so an
 * inventory shortfall can never unwind a recorded payment. Idempotent:
 * duplicate payment callbacks see the existing complete active set and
 * no-op. Concurrency-safe via a per-deal advisory lock, FOR UPDATE
 * SKIP LOCKED candidate picks, and the partial unique indexes on active
 * (deal_item_id, deal_item_unit) and active (vehicle_id).
 */
export async function allocateReservationInventory(opts: {
  dealId: number;
  dealerId: number;
  invoiceId: number | null;
  actor?: string | null;
}): Promise<"held" | "already_held" | "unfulfilled" | "skipped"> {
  let missing: string | null = null;
  try {
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`reservation-alloc:${opts.dealerId}:${opts.dealId}`}))`,
      );
      const [deal] = await tx
        .select()
        .from(dealsTable)
        .where(and(
          eq(dealsTable.id, opts.dealId),
          eq(dealsTable.dealerId, opts.dealerId),
        ))
        .for("update");
      if (!deal || deal.stage !== "desking") return "skipped" as const;

      const items = await tx
        .select()
        .from(dealItemsTable)
        .where(and(
          eq(dealItemsTable.dealId, deal.id),
          eq(dealItemsTable.dealerId, opts.dealerId),
        ))
        .orderBy(dealItemsTable.position);
      if (!items.length) return "skipped" as const;
      const totalUnits = items.reduce((sum, item) => sum + item.quantity, 0);

      const active = await tx
        .select()
        .from(reservationAllocationsTable)
        .where(and(
          eq(reservationAllocationsTable.dealId, deal.id),
          eq(reservationAllocationsTable.dealerId, opts.dealerId),
          eq(reservationAllocationsTable.status, "active"),
        ));
      if (active.length >= totalUnits) return "already_held" as const;
      if (active.length > 0) {
        // Should never happen (all-or-nothing) — repair by releasing the
        // partial set before re-allocating, keeping the invariant intact.
        await releaseHoldsInTx(tx, deal.id, opts.dealerId, "partial_repair");
      }

      // Expiry: mirror the linked active booking's expiry when present.
      const [booking] = await tx
        .select({ expiresAt: bookingsTable.expiresAt })
        .from(bookingsTable)
        .where(and(
          eq(bookingsTable.dealId, deal.id),
          eq(bookingsTable.dealerId, opts.dealerId),
          eq(bookingsTable.status, "active"),
        ))
        .limit(1);
      const expiresAt =
        booking?.expiresAt && booking.expiresAt.getTime() > Date.now()
          ? booking.expiresAt
          : new Date(Date.now() + RESERVATION_HOLD_HOURS * 60 * 60 * 1000);

      for (const item of items) {
        const spec = {
          make: item.make,
          model: item.model,
          year: item.modelYear,
          variant: item.variant ?? null,
          color: item.color ?? null,
        };
        if (!spec.make || !spec.model || !spec.year) {
          missing = `Deal item #${item.id} has no allocatable vehicle specification`;
          throw new ReservationShortfall();
        }
        for (let unit = 0; unit < item.quantity; unit += 1) {
          const [candidate] = await tx
            .select()
            .from(vehiclesTable)
            .where(and(
              eq(vehiclesTable.dealerId, opts.dealerId),
              sql`lower(${vehiclesTable.make}) = lower(${spec.make})`,
              sql`lower(${vehiclesTable.model}) = lower(${spec.model})`,
              eq(vehiclesTable.year, spec.year),
              sql`lower(coalesce(${vehiclesTable.trim}, ${vehiclesTable.variant}, 'Base')) =
                lower(${spec.variant ?? "Base"})`,
              spec.color == null
                ? sql`coalesce(${vehiclesTable.exteriorColor}, '') = ''`
                : sql`lower(coalesce(${vehiclesTable.exteriorColor}, '')) = lower(${spec.color})`,
              eq(vehiclesTable.status, "available"),
              eq(vehiclesTable.recallFlag, false),
              eq(vehiclesTable.damageFlag, false),
              isNull(vehiclesTable.deletedAt),
              // A unit already actively held for ANOTHER deal is not stock.
              sql`not exists (select 1 from ${reservationAllocationsTable}
                where ${reservationAllocationsTable.vehicleId} = ${vehiclesTable.id}
                  and ${reservationAllocationsTable.status} = 'active')`,
              // Nor is a unit an active booking already claims (the booking
              // row can exist momentarily before its vehicle status update).
              sql`not exists (select 1 from ${bookingsTable}
                where ${bookingsTable.vehicleId} = ${vehiclesTable.id}
                  and ${bookingsTable.status} = 'active')`,
            ))
            .orderBy(vehiclesTable.id)
            .limit(1)
            .for("update", { skipLocked: true });
          const identityValid =
            candidate?.vin?.length === VIN_LENGTH &&
            candidate.engineNumber?.length === VIN_LENGTH &&
            (!candidate.registration ||
              REGISTRATION_PATTERN.test(candidate.registration));
          if (!candidate || !identityValid) {
            missing = `${spec.year} ${spec.make} ${spec.model}${spec.variant ? ` ${spec.variant}` : ""}${spec.color ? ` in ${spec.color}` : ""}`;
            throw new ReservationShortfall();
          }
          const [held] = await tx
            .update(vehiclesTable)
            .set({
              status: "reserved",
              holdUntil: expiresAt,
              holdReason: "reservation_hold",
            })
            .where(and(
              eq(vehiclesTable.id, candidate.id),
              eq(vehiclesTable.dealerId, opts.dealerId),
              eq(vehiclesTable.status, "available"),
            ))
            .returning({ id: vehiclesTable.id });
          if (!held) {
            missing = `${spec.year} ${spec.make} ${spec.model}`;
            throw new ReservationShortfall();
          }
          await tx.insert(reservationAllocationsTable).values({
            dealerId: opts.dealerId,
            dealId: deal.id,
            invoiceId: opts.invoiceId,
            dealItemId: item.id,
            dealItemUnit: unit,
            vehicleId: candidate.id,
            status: "active",
            expiresAt,
            createdBy: opts.actor ?? "AURA",
          });
        }
      }
      await tx
        .update(dealsTable)
        .set({ reservationHoldStatus: "held" })
        .where(and(
          eq(dealsTable.id, deal.id),
          eq(dealsTable.dealerId, opts.dealerId),
        ));
      await tx.insert(timelineEventsTable).values({
        dealerId: opts.dealerId,
        customerId: deal.customerId,
        domain: "deal",
        kind: "reservation_hold",
        title: `Reservation paid — ${totalUnits} vehicle(s) soft-locked`,
        detail: `Every requested unit on deal #${deal.id} now has a distinct VIN temporarily held until ${expiresAt.toISOString().slice(0, 10)} or final commitment.`,
        actor: "AURA",
        isAgent: true,
        refType: "deal",
        refId: deal.id,
      });
      return "held" as const;
    });
    return outcome;
  } catch (err) {
    if (!(err instanceof ReservationShortfall)) throw err;
    // Whole transaction rolled back: no partial holds. Record the visible
    // inventory-resolution state; the payment itself is already committed.
    await db
      .update(dealsTable)
      .set({ reservationHoldStatus: "unfulfilled" })
      .where(and(
        eq(dealsTable.id, opts.dealId),
        eq(dealsTable.dealerId, opts.dealerId),
      ));
    const [deal] = await db
      .select()
      .from(dealsTable)
      .where(and(
        eq(dealsTable.id, opts.dealId),
        eq(dealsTable.dealerId, opts.dealerId),
      ));
    await db.insert(timelineEventsTable).values({
      dealerId: opts.dealerId,
      customerId: deal?.customerId ?? null,
      domain: "deal",
      kind: "reservation_hold_unfulfilled",
      title: "Reservation paid but stock could not be fully held",
      detail: `Complete matching inventory was unavailable (first shortfall: ${missing ?? "unknown"}). The payment remains recorded; no partial holds were made. Resolve inventory before commitment.`,
      actor: "AURA",
      isAgent: true,
      refType: "deal",
      refId: opts.dealId,
    });
    try {
      const managers = await generalManagers(opts.dealerId);
      await notifyUsers(managers, {
        dealerId: opts.dealerId,
        type: "reservation.pending",
        entityType: "deal",
        entityId: opts.dealId,
        title: `Reservation paid — inventory resolution needed (deal #${opts.dealId})`,
        body: `The reservation fee is fully paid but complete matching stock could not be held (${missing ?? "shortfall"}). No partial holds were made.`,
        link: "/pipeline",
      });
    } catch (notifyErr) {
      logger.error({ err: notifyErr }, "reservation shortfall notify failed");
    }
    return "unfulfilled";
  }
}

class ReservationShortfall extends Error {}

/** Active holds for a deal, ordered by item/unit. */
export async function activeReservationAllocations(
  dealId: number,
  dealerId: number,
  tx: Tx | typeof db = db,
) {
  return tx
    .select()
    .from(reservationAllocationsTable)
    .where(and(
      eq(reservationAllocationsTable.dealId, dealId),
      eq(reservationAllocationsTable.dealerId, dealerId),
      eq(reservationAllocationsTable.status, "active"),
    ))
    .orderBy(
      reservationAllocationsTable.dealItemId,
      reservationAllocationsTable.dealItemUnit,
    );
}

/**
 * True when a vehicle is still claimed by an active booking or an active
 * reservation allocation (optionally excluding one deal's own claims).
 */
export async function vehicleOtherwiseClaimed(
  tx: Tx | typeof db,
  vehicleId: number,
  dealerId: number,
  excludeDealId?: number,
): Promise<boolean> {
  const bookingWhere = [
    eq(bookingsTable.vehicleId, vehicleId),
    eq(bookingsTable.dealerId, dealerId),
    eq(bookingsTable.status, "active"),
  ];
  if (excludeDealId != null) {
    bookingWhere.push(sql`coalesce(${bookingsTable.dealId}, -1) <> ${excludeDealId}`);
  }
  const [booking] = await tx
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(and(...bookingWhere))
    .limit(1);
  if (booking) return true;
  const allocWhere = [
    eq(reservationAllocationsTable.vehicleId, vehicleId),
    eq(reservationAllocationsTable.dealerId, dealerId),
    eq(reservationAllocationsTable.status, "active"),
  ];
  if (excludeDealId != null) {
    allocWhere.push(ne(reservationAllocationsTable.dealId, excludeDealId));
  }
  const [alloc] = await tx
    .select({ id: reservationAllocationsTable.id })
    .from(reservationAllocationsTable)
    .where(and(...allocWhere))
    .limit(1);
  return Boolean(alloc);
}

/** True when a paid reservation actively soft-locks this vehicle. Inventory
 * edits that would invalidate the hold (status change, delete) must refuse. */
export async function vehicleActivelyAllocated(
  vehicleId: number,
  dealerId: number,
  tx: Tx | typeof db = db,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: reservationAllocationsTable.id })
    .from(reservationAllocationsTable)
    .where(and(
      eq(reservationAllocationsTable.vehicleId, vehicleId),
      eq(reservationAllocationsTable.dealerId, dealerId),
      eq(reservationAllocationsTable.status, "active"),
    ))
    .limit(1);
  return Boolean(row);
}

/** Shared in-transaction release core (marks rows + frees unclaimed units). */
async function releaseHoldsInTx(
  tx: Tx,
  dealId: number,
  dealerId: number,
  reason: string,
  dealStatusAfter: "unfulfilled" | null = null,
): Promise<number> {
  const released = await tx
    .update(reservationAllocationsTable)
    .set({
      status: "released",
      releasedReason: reason,
      releasedAt: new Date(),
    })
    .where(and(
      eq(reservationAllocationsTable.dealId, dealId),
      eq(reservationAllocationsTable.dealerId, dealerId),
      eq(reservationAllocationsTable.status, "active"),
    ))
    .returning({ vehicleId: reservationAllocationsTable.vehicleId });
  for (const row of [...new Set(released.map((r) => r.vehicleId))].map(
    (vehicleId) => ({ vehicleId }),
  )) {
    if (await vehicleOtherwiseClaimed(tx, row.vehicleId, dealerId)) continue;
    await tx
      .update(vehiclesTable)
      .set({ status: "available", holdUntil: null, holdReason: null })
      .where(and(
        eq(vehiclesTable.id, row.vehicleId),
        eq(vehiclesTable.dealerId, dealerId),
        inArray(vehiclesTable.status, ["reserved", "booked"]),
      ));
  }
  if (released.length) {
    // Expiry keeps the deal blocked ("unfulfilled") so commitment cannot
    // silently pick replacement stock; terminal paths clear the flag.
    await tx
      .update(dealsTable)
      .set({ reservationHoldStatus: dealStatusAfter })
      .where(and(
        eq(dealsTable.id, dealId),
        eq(dealsTable.dealerId, dealerId),
      ));
  }
  return released.length;
}

/**
 * Release every active hold for a deal (cancellation, refund approval,
 * lead closure, expiry). Safe when another live claim still holds a unit —
 * the allocation row is closed but the vehicle stays unavailable.
 */
export async function releaseReservationHolds(opts: {
  dealId: number;
  dealerId: number;
  reason: string;
  tx?: Tx;
  /** Deal hold status left behind: null (terminal paths) or "unfulfilled"
   * (expiry — keeps commitment blocked until the units are re-held). */
  dealStatusAfter?: "unfulfilled" | null;
}): Promise<number> {
  const after = opts.dealStatusAfter ?? null;
  if (opts.tx) {
    return releaseHoldsInTx(opts.tx, opts.dealId, opts.dealerId, opts.reason, after);
  }
  return db.transaction((tx) =>
    releaseHoldsInTx(tx, opts.dealId, opts.dealerId, opts.reason, after),
  );
}

/** Lazy sweep: expire lapsed active holds for deals that never committed. */
export async function expireLapsedReservationHolds(): Promise<void> {
  const lapsed = await db
    .select({
      dealId: reservationAllocationsTable.dealId,
      dealerId: reservationAllocationsTable.dealerId,
    })
    .from(reservationAllocationsTable)
    .where(and(
      eq(reservationAllocationsTable.status, "active"),
      lt(reservationAllocationsTable.expiresAt, new Date()),
    ));
  const seen = new Set<string>();
  for (const row of lapsed) {
    const key = `${row.dealerId}:${row.dealId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const [deal] = await db
        .select({ stage: dealsTable.stage })
        .from(dealsTable)
        .where(and(
          eq(dealsTable.id, row.dealId),
          eq(dealsTable.dealerId, row.dealerId),
        ));
      // Committed deals adopt their holds at commit; never expire them out
      // from under a committed deal.
      if (!deal || deal.stage === "committed" || deal.stage === "delivered")
        continue;
      const count = await releaseReservationHolds({
        dealId: row.dealId,
        dealerId: row.dealerId,
        reason: "expired",
        // A lapsed paid reservation stays blocked from commitment until the
        // units are re-held (inventory resolution) — never silently swapped.
        dealStatusAfter: "unfulfilled",
      });
      if (count) {
        logger.info(
          { dealId: row.dealId, released: count },
          "reservation holds expired and released",
        );
      }
    } catch (err) {
      logger.error(
        { err, dealId: row.dealId },
        "reservation hold expiry sweep failed",
      );
    }
  }
}
