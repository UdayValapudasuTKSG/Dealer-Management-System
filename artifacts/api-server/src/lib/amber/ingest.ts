import { and, eq, lt, sql } from "drizzle-orm";
import {
  db,
  amberDevicesTable,
  amberEventsTable,
  amberVehicleStatesTable,
  vehiclesTable,
  timelineEventsTable,
  dealerUsersTable,
  rolePermissionsTable,
  type AmberDevice,
} from "@workspace/db";
import type { AmberProviderEvent } from "./provider";
import { amberEntitled } from "./connection";
import { notifyUsers } from "../email";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Amber event ingestion core — shared by the signed webhook and the
// scheduled-sync seam. Idempotent (unique (dealerId, externalId) claim),
// monotonic (an older event never overwrites newer state), dealer-scoped.
// ---------------------------------------------------------------------------

/** Bounded history: events older than this are trimmed by the sweep. */
export const AMBER_EVENT_RETENTION_DAYS = 90;

export type AmberIngestOutcome =
  | "processed"
  | "duplicate"
  | "stale"
  | "unmapped"
  | "not_entitled"
  | "error";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Users of the dealer whose role has explicit amber:view (recipients). */
async function amberViewers(dealerId: number): Promise<number[]> {
  const rows = await db
    .select({ userId: dealerUsersTable.userId })
    .from(dealerUsersTable)
    .innerJoin(
      rolePermissionsTable,
      eq(rolePermissionsTable.roleId, dealerUsersTable.roleId),
    )
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(rolePermissionsTable.module, "amber"),
        eq(rolePermissionsTable.category, "view"),
      ),
    );
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * Ingest one normalized Amber event for a dealer. Fully idempotent: a repeat
 * externalId is a no-op. Called with the dealer already authenticated
 * (webhook secret verified / scheduled sync) — this re-checks the
 * entitlement so disabling the module stops processing immediately.
 */
export async function processAmberEvent(
  dealerId: number,
  event: AmberProviderEvent,
): Promise<AmberIngestOutcome> {
  if (!(await amberEntitled(dealerId))) return "not_entitled";

  // Atomic idempotency claim BEFORE any side effect.
  const claimed = await db
    .insert(amberEventsTable)
    .values({
      dealerId,
      deviceId: event.deviceId,
      externalId: event.externalId,
      type: event.type,
      occurredAt: event.occurredAt,
      payload: event.raw ?? null,
      status: "processed",
    })
    .onConflictDoNothing()
    .returning({ id: amberEventsTable.id });
  if (claimed.length === 0) return "duplicate";
  const eventRowId = claimed[0]!.id;

  const markEvent = async (status: string, error?: string) => {
    await db
      .update(amberEventsTable)
      .set({ status, ...(error ? { error: error.slice(0, 500) } : {}) })
      .where(eq(amberEventsTable.id, eventRowId))
      .catch(() => undefined);
  };

  try {
    // Auto-register unknown devices as unmatched so admins can map them.
    const device = await upsertDeviceSeen(dealerId, event);

    // State decision AND mapped-vehicle side effects run in ONE transaction
    // under the shared per-device advisory lock (also taken by map/unmap),
    // so a mapping change can never commit between the state decision and
    // the vehicle writes — telemetry cannot land on a former vehicle.
    const outcome = await db.transaction(async (tx) => {
      await acquireAmberDeviceLock(tx, dealerId, event.deviceId);

      const applied = await updateLatestState(tx, dealerId, event);
      if (!applied.any) return "stale" as const;
      if (applied.vehicleId == null) return "unmapped" as const;

      // Side effects gated on the SAME per-field application flags the state
      // write used, so a rejected (stale / equal-timestamp) value can never
      // touch the vehicle.
      await applyVehicleSideEffects(tx, dealerId, device, event, applied);
      return "processed" as const;
    });
    if (outcome !== "processed") await markEvent(outcome);
    return outcome;
  } catch (err) {
    logger.error(
      { err, dealerId, externalId: event.externalId },
      "Amber event processing failed",
    );
    await markEvent("error", err instanceof Error ? err.message : String(err));
    return "error";
  }
}

async function upsertDeviceSeen(
  dealerId: number,
  event: AmberProviderEvent,
): Promise<AmberDevice> {
  const [device] = await db
    .insert(amberDevicesTable)
    .values({
      dealerId,
      deviceId: event.deviceId,
      lastSeenAt: event.occurredAt,
      mappingStatus: "unmatched",
    })
    .onConflictDoUpdate({
      target: [amberDevicesTable.dealerId, amberDevicesTable.deviceId],
      set: {
        lastSeenAt: sql`greatest(coalesce(${amberDevicesTable.lastSeenAt}, 'epoch'::timestamptz), ${event.occurredAt.toISOString()}::timestamptz)`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return device!;
}

/** Drizzle transaction handle (subset used here). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Shared per-device advisory lock (transaction-scoped). Both event ingestion
 * and the map/unmap routes take this lock FIRST — before touching device,
 * state, or vehicle rows — giving one consistent lock order (advisory lock →
 * state row → vehicle row) that serializes mapping changes against telemetry
 * processing without deadlocks.
 */
export async function acquireAmberDeviceLock(
  tx: Tx,
  dealerId: number,
  deviceId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`amber:${dealerId}:${deviceId}`}))`,
  );
}

export interface AmberStateApplication {
  /** At least one telemetry field (or a bare newer heartbeat) applied. */
  any: boolean;
  location: boolean;
  odometer: boolean;
  ignition: boolean;
  health: boolean;
  /** Vehicle mapping AS OF the locked state write (fresh device read in-tx). */
  vehicleId: number | null;
}

/**
 * Monotonic per-field latest-state update, safe under concurrency.
 *
 * Runs in a transaction holding the state row's lock (SELECT ... FOR UPDATE),
 * so concurrent webhook/sync deliveries for the same device serialize and the
 * per-field newer-than decisions are made against committed truth — explicit
 * flags, never inferred from timestamp equality. The vehicle linkage is
 * re-read from the device row INSIDE the transaction, so a concurrent
 * map/unmap (which relinks the state row in its own transaction) always ends
 * consistent regardless of interleaving.
 */
async function updateLatestState(
  tx: Tx,
  dealerId: number,
  event: AmberProviderEvent,
): Promise<AmberStateApplication> {
  const at = event.occurredAt;

  const lat = num(event.latitude);
  const lng = num(event.longitude);
  const odo = num(event.odometerKm);
  const hasLocation = lat != null && lng != null;
  const hasOdo = odo != null && odo >= 0;
  const hasIgnition =
    event.type === "ignition_on" || event.type === "ignition_off";
  const hasHealth = typeof event.deviceHealth === "string" && !!event.deviceHealth;

  {
    // Ensure the row exists, then take its lock.
    await tx
      .insert(amberVehicleStatesTable)
      .values({ dealerId, deviceId: event.deviceId })
      .onConflictDoNothing();
    const [existing] = await tx
      .select()
      .from(amberVehicleStatesTable)
      .where(
        and(
          eq(amberVehicleStatesTable.dealerId, dealerId),
          eq(amberVehicleStatesTable.deviceId, event.deviceId),
        ),
      )
      .for("update");
    if (!existing) throw new Error("amber state row vanished under lock");

    // Fresh mapping read inside the transaction (read-committed sees the
    // latest committed map/unmap; a later map/unmap relinks the row itself).
    const [dev] = await tx
      .select({
        vehicleId: amberDevicesTable.vehicleId,
        mappingStatus: amberDevicesTable.mappingStatus,
      })
      .from(amberDevicesTable)
      .where(
        and(
          eq(amberDevicesTable.dealerId, dealerId),
          eq(amberDevicesTable.deviceId, event.deviceId),
        ),
      );
    const vehicleId =
      dev?.mappingStatus === "mapped" ? (dev.vehicleId ?? null) : null;

    const newer = (prev: Date | null) => !prev || at > prev;
    const set: Record<string, unknown> = {
      vehicleId,
      updatedAt: new Date(),
    };
    const applied: AmberStateApplication = {
      any: false,
      location: false,
      odometer: false,
      ignition: false,
      health: false,
      vehicleId,
    };
    if (hasLocation && newer(existing.locationAt)) {
      set["latitude"] = lat;
      set["longitude"] = lng;
      set["locationAt"] = at;
      applied.location = true;
    }
    if (
      hasOdo &&
      newer(existing.odometerAt) &&
      // Odometers never go backwards — reject regressions even if newer.
      (existing.odometerKm == null || odo! >= existing.odometerKm)
    ) {
      set["odometerKm"] = odo;
      set["odometerAt"] = at;
      applied.odometer = true;
    }
    if (hasIgnition && newer(existing.ignitionAt)) {
      set["ignitionOn"] = event.type === "ignition_on";
      set["ignitionAt"] = at;
      applied.ignition = true;
    }
    if (hasHealth && newer(existing.deviceHealthAt)) {
      set["deviceHealth"] = event.deviceHealth;
      set["deviceHealthAt"] = at;
      applied.health = true;
    }
    if (newer(existing.lastEventAt)) {
      set["lastEventAt"] = at;
    }

    const carriesTelemetry = hasLocation || hasOdo || hasIgnition || hasHealth;
    applied.any = carriesTelemetry
      ? applied.location || applied.odometer || applied.ignition || applied.health
      : newer(existing.lastEventAt); // bare heartbeat: newer-than-latest only

    await tx
      .update(amberVehicleStatesTable)
      .set(set)
      .where(eq(amberVehicleStatesTable.id, existing.id));
    return applied;
  }
}

async function applyVehicleSideEffects(
  tx: Tx,
  dealerId: number,
  device: AmberDevice,
  event: AmberProviderEvent,
  applied: AmberStateApplication,
): Promise<void> {
  const vehicleId = applied.vehicleId!;
  const odo = num(event.odometerKm);

  // Trusted odometer → vehicle mileage, but NEVER lower it (manual/newer
  // data wins; regressions are ignored, not silently overwritten). Only runs
  // when the canonical state accepted this event's odometer value.
  if (applied.odometer && odo != null && odo > 0) {
    const kmInt = Math.floor(odo);
    const [vehicle] = await tx
      .select({ id: vehiclesTable.id, mileageKm: vehiclesTable.mileageKm })
      .from(vehiclesTable)
      .where(
        and(eq(vehiclesTable.id, vehicleId), eq(vehiclesTable.dealerId, dealerId)),
      );
    if (vehicle && kmInt > vehicle.mileageKm) {
      await tx
        .update(vehiclesTable)
        .set({ mileageKm: kmInt })
        .where(
          and(
            eq(vehiclesTable.id, vehicleId),
            eq(vehiclesTable.dealerId, dealerId),
            lt(vehiclesTable.mileageKm, kmInt),
          ),
        );
      await tx.insert(timelineEventsTable).values({
        dealerId,
        domain: "vehicles",
        kind: "telematics",
        title: "Odometer updated from Amber Connect",
        detail: `Telematics reported ${kmInt.toLocaleString()} km (was ${vehicle.mileageKm.toLocaleString()} km).`,
        actor: "Amber Connect",
        isAgent: true,
        refType: "vehicle",
        refId: vehicleId,
      });
    }
  }

  // Device-health problems notify amber viewers (deduped on device entity).
  // Gated on the state having accepted this health reading (monotonic).
  if (
    applied.health &&
    event.type === "device_health" &&
    event.deviceHealth &&
    event.deviceHealth !== "ok"
  ) {
    const viewers = await amberViewers(dealerId);
    if (viewers.length > 0) {
      // notifyUsers uses its own connection; the mapping decision it depends
      // on was made under the advisory lock held by this transaction.
      await notifyUsers(viewers, {
        dealerId,
        type: "system",
        title: `Amber device ${device.deviceId} reported ${event.deviceHealth}`,
        body: `Telematics device on vehicle #${vehicleId} reported "${event.deviceHealth}".`,
        link: "/amber",
        entityType: "amber_device",
        entityId: device.id,
      });
    }
    await tx.insert(timelineEventsTable).values({
      dealerId,
      domain: "vehicles",
      kind: "telematics",
      title: `Amber device health: ${event.deviceHealth}`,
      detail: `Device ${device.deviceId} reported "${event.deviceHealth}".`,
      actor: "Amber Connect",
      isAgent: true,
      refType: "vehicle",
      refId: vehicleId,
    });
  }
}

/** Bounded history: trim events past retention (called by the sync sweep). */
export async function trimAmberEvents(dealerId: number): Promise<number> {
  const cutoff = new Date(
    Date.now() - AMBER_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const rows = await db
    .delete(amberEventsTable)
    .where(
      and(
        eq(amberEventsTable.dealerId, dealerId),
        lt(amberEventsTable.createdAt, cutoff),
      ),
    )
    .returning({ id: amberEventsTable.id });
  return rows.length;
}
