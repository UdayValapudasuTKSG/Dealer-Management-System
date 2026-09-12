import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  bookingsTable,
  dealsTable,
  dealItemsTable,
  deliveriesTable,
  invoicesTable,
  reservationAllocationsTable,
  vehiclesTable,
  defaultDeliverySteps,
  DEFAULT_PDI_ITEMS,
  isValidEngineNumberLength,
  isValidVinLength,
  REGISTRATION_PATTERN,
} from "@workspace/db";

export type DealTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class InventoryAllocationError extends Error {
  constructor(
    readonly itemId: number,
    readonly requested: number,
    readonly allocated: number,
    readonly description: string,
  ) {
    super("INSUFFICIENT_ITEM_INVENTORY");
  }
}

export class DealCommitConflictError extends Error {
  constructor(message = "The deal changed concurrently") {
    super(message);
  }
}

const HOLD_HOURS = 72;

async function existingAllocationIsComplete(
  tx: DealTransaction,
  dealId: number,
  dealerId: number,
): Promise<boolean> {
  const items = await tx.select({
    id: dealItemsTable.id,
    quantity: dealItemsTable.quantity,
  }).from(dealItemsTable).where(and(
    eq(dealItemsTable.dealId, dealId),
    eq(dealItemsTable.dealerId, dealerId),
  ));
  if (!items.length) return false;
  const deliveries = await tx.select({
    dealItemId: deliveriesTable.dealItemId,
    unit: deliveriesTable.dealItemUnit,
    vehicleId: deliveriesTable.vehicleId,
  }).from(deliveriesTable).where(and(
    eq(deliveriesTable.dealId, dealId),
    eq(deliveriesTable.dealerId, dealerId),
  ));
  if (deliveries.length !== items.reduce((sum, item) => sum + item.quantity, 0))
    return false;
  if (new Set(deliveries.map((delivery) => delivery.vehicleId)).size !== deliveries.length)
    return false;
  return items.every((item) => {
    const units = deliveries
      .filter((delivery) => delivery.dealItemId === item.id)
      .map((delivery) => delivery.unit)
      .sort((a, b) => (a ?? -1) - (b ?? -1));
    return units.length === item.quantity &&
      units.every((unit, index) => unit === index);
  });
}

/** Shared transaction core used by manual and finance-driven commits. */
export async function commitDealInTransaction(
  tx: DealTransaction,
  opts: {
    dealId: number;
    dealerId: number;
    updates?: Partial<typeof dealsTable.$inferInsert>;
  },
): Promise<{
  before: typeof dealsTable.$inferSelect;
  deal: typeof dealsTable.$inferSelect;
  newlyCommitted: boolean;
}> {
  // Serialize with the reservation allocator (same advisory key): payment
  // settlement, hold creation, and commitment on one deal never interleave.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`reservation-alloc:${opts.dealerId}:${opts.dealId}`}))`,
  );
  const [before] = await tx.select().from(dealsTable).where(and(
    eq(dealsTable.id, opts.dealId),
    eq(dealsTable.dealerId, opts.dealerId),
  )).for("update");
  if (!before) throw new DealCommitConflictError("Deal not found");

  if (before.stage === "committed" || before.stage === "delivered") {
    if (!(await existingAllocationIsComplete(tx, before.id, opts.dealerId))) {
      throw new DealCommitConflictError(
        "Committed deal has incomplete physical-unit allocations",
      );
    }
    return { before, deal: before, newlyCommitted: false };
  }
  if (before.stage !== "desking") {
    throw new DealCommitConflictError(
      `Deal in ${before.stage} cannot be committed`,
    );
  }

  const items = await tx.select().from(dealItemsTable).where(and(
    eq(dealItemsTable.dealId, before.id),
    eq(dealItemsTable.dealerId, opts.dealerId),
  )).orderBy(dealItemsTable.position).for("update");
  if (!items.length) {
    throw new InventoryAllocationError(0, 1, 0, "The deal has no item commitments");
  }
  const [booking] = await tx.select({
    id: bookingsTable.id,
    vehicleId: bookingsTable.vehicleId,
  }).from(bookingsTable).where(and(
    eq(bookingsTable.dealId, before.id),
    eq(bookingsTable.dealerId, opts.dealerId),
    eq(bookingsTable.status, "active"),
  )).limit(1);
  const holdUntil = new Date(Date.now() + HOLD_HOURS * 60 * 60 * 1000);
  let primaryVehicleId: number | null = null;

  // Paid-reservation adoption: a fully paid reservation soft-locked one VIN
  // per requested unit. Commitment must adopt EXACTLY those vehicles rather
  // than silently swapping inventory. Active holds that do not form a
  // complete set are a conflict — resolve the reservation first.
  const activeHolds = await tx.select().from(reservationAllocationsTable)
    .where(and(
      eq(reservationAllocationsTable.dealId, before.id),
      eq(reservationAllocationsTable.dealerId, opts.dealerId),
      eq(reservationAllocationsTable.status, "active"),
    )).for("update");
  const holdByItemUnit = new Map<string, typeof activeHolds[number]>();
  for (const hold of activeHolds) {
    holdByItemUnit.set(`${hold.dealItemId}:${hold.dealItemUnit}`, hold);
  }
  // Lapsed holds must not be adoptable: the lazy expiry sweep may not have
  // run yet, so check expiry here, at the moment of commitment.
  const now = Date.now();
  if (
    activeHolds.some(
      (hold) => hold.expiresAt != null && hold.expiresAt.getTime() <= now,
    )
  ) {
    throw new DealCommitConflictError(
      "The paid reservation's inventory holds have lapsed — re-hold the units before committing",
    );
  }
  if (activeHolds.length === 0 && before.reservationHoldStatus == null) {
    // Race guard: a fully paid reservation invoice whose post-payment
    // allocation hasn't run yet (payment tx committed, allocator pending)
    // must not commit with ordinary replacement stock. Block until the
    // allocator records holds or an explicit unfulfilled state.
    const [paidReservation] = await tx.select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(and(
        eq(invoicesTable.dealId, before.id),
        eq(invoicesTable.dealerId, opts.dealerId),
        eq(invoicesTable.kind, "reservation"),
        eq(invoicesTable.status, "paid"),
      )).limit(1);
    if (paidReservation) {
      throw new DealCommitConflictError(
        "The reservation fee is paid but its inventory hold hasn't been recorded yet — retry in a moment",
      );
    }
  }
  if (activeHolds.length === 0 && before.reservationHoldStatus != null) {
    // A fully paid reservation whose holds were never made (unfulfilled) or
    // have since lapsed must NOT commit by silently picking replacement
    // stock — inventory has to be resolved (re-held) first.
    throw new DealCommitConflictError(
      before.reservationHoldStatus === "unfulfilled"
        ? "The reservation fee is paid but matching stock could not be held — resolve inventory before committing"
        : "The paid reservation's inventory holds have lapsed — re-hold the units before committing",
    );
  }
  if (activeHolds.length > 0) {
    const totalUnits = items.reduce((sum, item) => sum + item.quantity, 0);
    const complete =
      activeHolds.length === totalUnits &&
      new Set(activeHolds.map((h) => h.vehicleId)).size === activeHolds.length &&
      items.every((item) =>
        Array.from({ length: item.quantity }, (_, unit) =>
          holdByItemUnit.has(`${item.id}:${unit}`),
        ).every(Boolean),
      );
    if (!complete) {
      throw new DealCommitConflictError(
        "The paid reservation's inventory holds are incomplete — resolve the reservation holds before committing",
      );
    }
  }

  for (const item of items) {
    const [legacySeed] = item.vehicleId
      ? await tx.select().from(vehiclesTable).where(and(
          eq(vehiclesTable.id, item.vehicleId),
          eq(vehiclesTable.dealerId, opts.dealerId),
          isNull(vehiclesTable.deletedAt),
        )).for("update")
      : [];
    const spec = {
      make: item.make ?? legacySeed?.make,
      model: item.model ?? legacySeed?.model,
      year: item.modelYear ?? legacySeed?.year,
      variant: item.variant ?? legacySeed?.trim ?? legacySeed?.variant ?? null,
      color: item.color ?? legacySeed?.exteriorColor ?? null,
    };
    if (!spec.make || !spec.model || !spec.year) {
      throw new InventoryAllocationError(
        item.id, item.quantity, 0,
        `Deal item #${item.id} has no allocatable vehicle specification`,
      );
    }
    let allocated = 0;
    for (let unit = 0; unit < item.quantity; unit += 1) {
      const hold = holdByItemUnit.get(`${item.id}:${unit}`);
      if (hold) {
        // Adopt the reservation's held VIN. The unit was locked FOR this
        // deal — validate identity/flags, promote it to booked, create the
        // delivery with the SAME vehicle, and finalize the hold row.
        const [heldVehicle] = await tx.select().from(vehiclesTable).where(and(
          eq(vehiclesTable.id, hold.vehicleId),
          eq(vehiclesTable.dealerId, opts.dealerId),
          isNull(vehiclesTable.deletedAt),
        )).for("update");
        const heldIdentityValid =
          isValidVinLength(heldVehicle?.vin) &&
          isValidEngineNumberLength(heldVehicle.engineNumber) &&
          (!heldVehicle.registration || REGISTRATION_PATTERN.test(heldVehicle.registration));
        // A conflicting claim by ANOTHER deal (active booking or another
        // deal's active allocation) means the hold was subverted — refuse.
        const [conflict] = await tx.select({ id: bookingsTable.id })
          .from(bookingsTable)
          .where(and(
            eq(bookingsTable.vehicleId, hold.vehicleId),
            eq(bookingsTable.status, "active"),
            sql`${bookingsTable.dealId} is distinct from ${before.id}`,
          )).limit(1);
        if (
          !heldVehicle || !heldIdentityValid || conflict ||
          heldVehicle.recallFlag || heldVehicle.damageFlag ||
          !["reserved", "booked", "available"].includes(heldVehicle.status)
        ) {
          throw new InventoryAllocationError(
            item.id, item.quantity, allocated,
            `Reserved unit ${heldVehicle?.vin ?? `#${hold.vehicleId}`} is no longer eligible — resolve the reservation hold`,
          );
        }
        if (heldVehicle.status !== "booked") {
          await tx.update(vehiclesTable).set({
            status: "booked", holdUntil, holdReason: "vin_lock",
          }).where(and(
            eq(vehiclesTable.id, heldVehicle.id),
            eq(vehiclesTable.dealerId, opts.dealerId),
          ));
        }
        await tx.update(reservationAllocationsTable).set({
          status: "finalized", finalizedAt: new Date(),
        }).where(and(
          eq(reservationAllocationsTable.id, hold.id),
          eq(reservationAllocationsTable.dealerId, opts.dealerId),
          eq(reservationAllocationsTable.status, "active"),
        ));
        await tx.insert(deliveriesTable).values({
          dealerId: opts.dealerId,
          dealId: before.id,
          dealItemId: item.id,
          dealItemUnit: unit,
          bookingId: booking?.vehicleId === heldVehicle.id ? booking.id : null,
          vehicleId: heldVehicle.id,
          customerId: before.customerId,
          customerName: before.customerName,
          status: "in_progress",
          currentStep: "sales_order",
          steps: defaultDeliverySteps(),
          pdiItems: DEFAULT_PDI_ITEMS,
        });
        allocated += 1;
        primaryVehicleId ??= heldVehicle.id;
        continue;
      }
      let chosen =
        unit === 0 && item.position === 0 &&
        legacySeed && booking?.vehicleId === legacySeed.id &&
        legacySeed.status === "booked" &&
        legacySeed.make.toLowerCase() === spec.make.toLowerCase() &&
        legacySeed.model.toLowerCase() === spec.model.toLowerCase() &&
        legacySeed.year === spec.year &&
        (legacySeed.trim ?? legacySeed.variant ?? "Base").toLowerCase() === (spec.variant ?? "Base").toLowerCase() &&
        (legacySeed.exteriorColor ?? "").toLowerCase() === (spec.color ?? "").toLowerCase()
          ? legacySeed
          : null;
      if (!chosen) {
        const [candidate] = await tx.select().from(vehiclesTable).where(and(
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
          // Never adopt stock another paid reservation actively soft-locks
          // or an active booking claims (even if its status was manually
          // flipped back to available).
          sql`not exists (select 1 from ${reservationAllocationsTable}
            where ${reservationAllocationsTable.vehicleId} = ${vehiclesTable.id}
              and ${reservationAllocationsTable.status} = 'active')`,
          sql`not exists (select 1 from ${bookingsTable}
            where ${bookingsTable.vehicleId} = ${vehiclesTable.id}
              and ${bookingsTable.status} = 'active'
              and ${bookingsTable.dealId} is distinct from ${before.id})`,
        )).orderBy(vehiclesTable.id).limit(1).for("update", { skipLocked: true });
        chosen = candidate ?? null;
      }
      const identityValid =
        isValidVinLength(chosen?.vin) &&
        isValidEngineNumberLength(chosen.engineNumber) &&
        (!chosen.registration || REGISTRATION_PATTERN.test(chosen.registration));
      if (!chosen || !identityValid || chosen.recallFlag || chosen.damageFlag) {
        throw new InventoryAllocationError(
          item.id, item.quantity, allocated,
           `${spec.year} ${spec.make} ${spec.model}${spec.variant ? ` ${spec.variant}` : ""}${spec.color ? ` in ${spec.color}` : ""}`,
        );
      }
      if (chosen.status !== "booked") {
        const [locked] = await tx.update(vehiclesTable).set({
          status: "booked", holdUntil, holdReason: "vin_lock",
        }).where(and(
          eq(vehiclesTable.id, chosen.id),
          eq(vehiclesTable.dealerId, opts.dealerId),
          eq(vehiclesTable.status, "available"),
        )).returning({ id: vehiclesTable.id });
        if (!locked) {
          throw new InventoryAllocationError(
            item.id, item.quantity, allocated,
             `${spec.year} ${spec.make} ${spec.model}${spec.variant ? ` ${spec.variant}` : ""}${spec.color ? ` in ${spec.color}` : ""}`,
          );
        }
      }
      await tx.insert(deliveriesTable).values({
        dealerId: opts.dealerId,
        dealId: before.id,
        dealItemId: item.id,
        dealItemUnit: unit,
        bookingId: booking?.vehicleId === chosen.id ? booking.id : null,
        vehicleId: chosen.id,
        customerId: before.customerId,
        customerName: before.customerName,
        status: "in_progress",
        currentStep: "sales_order",
        steps: defaultDeliverySteps(),
        pdiItems: DEFAULT_PDI_ITEMS,
      });
      allocated += 1;
      primaryVehicleId ??= chosen.id;
    }
    await tx.update(dealItemsTable).set({ status: "allocated" }).where(and(
      eq(dealItemsTable.id, item.id),
      eq(dealItemsTable.dealerId, opts.dealerId),
    ));
  }

  const [deal] = await tx.update(dealsTable).set({
    ...(opts.updates ?? {}),
    stage: "committed",
    vehicleId: primaryVehicleId!,
    // Reservation soft-locks are consumed (finalized) by commitment.
    reservationHoldStatus: null,
  }).where(and(
    eq(dealsTable.id, before.id),
    eq(dealsTable.dealerId, opts.dealerId),
    eq(dealsTable.stage, "desking"),
  )).returning();
  if (!deal) throw new DealCommitConflictError();
  return { before, deal, newlyCommitted: true };
}

/** Atomic public operation for finance and other non-route commit callers. */
export function commitDealWithAllocations(opts: {
  dealId: number;
  dealerId: number;
  updates?: Partial<typeof dealsTable.$inferInsert>;
}) {
  return db.transaction((tx) => commitDealInTransaction(tx, opts));
}