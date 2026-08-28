import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { db, capacityBlocksTable, vehiclesTable } from "@workspace/db";
import { zonedDayKey, zonedParts } from "./timezone";

// ---------------------------------------------------------------------------
// Manager capacity-plan blocks (test drives) — shared between the staff
// scheduling path and the public self-service booking link so both always
// agree on which slots an advisor/vehicle can take.
// ---------------------------------------------------------------------------

/** Local-timezone YYYY-MM-DD of a slot/booking time. */
export function localDateStr(d: Date, tz: string): string {
  return zonedDayKey(d, tz);
}

/** date -> hour windows; an empty array means the whole day is blocked. */
export type BlockedDays = Map<
  string,
  Array<{ startHour: number; endHour: number }>
>;

export function isSlotBlocked(
  blocked: BlockedDays,
  start: Date,
  tz: string,
): boolean {
  const windows = blocked.get(localDateStr(start, tz));
  if (!windows) return false;
  if (windows.length === 0) return true; // full-day block
  // Slots are generated with dealership wall-clock hours, so compare in the
  // same timezone as localDateStr. 30-minute
  // slots fall inside their containing hour block (9:30 → hour 9).
  const hour = zonedParts(start, tz).hour;
  return windows.some((w) => hour >= w.startHour && hour < w.endHour);
}

/**
 * Days blocked in the manager capacity plan for a vehicle and/or advisor
 * (test drives).
 */
export async function capacityBlockedDays(
  dealerId: number,
  refs: { vehicleIds?: number[]; advisorUserId?: number | null },
): Promise<BlockedDays> {
  const conds: SQL[] = [];
  if (refs.vehicleIds && refs.vehicleIds.length > 0) {
    // A block on ANY unit of the model blocks the model's test drives — the
    // capacity planner shows one representative demo unit per model line.
    conds.push(
      and(
        eq(capacityBlocksTable.kind, "vehicle"),
        inArray(capacityBlocksTable.refId, refs.vehicleIds),
      )!,
    );
  }
  if (refs.advisorUserId != null) {
    conds.push(
      and(
        eq(capacityBlocksTable.kind, "advisor"),
        eq(capacityBlocksTable.refId, refs.advisorUserId),
      )!,
    );
  }
  if (conds.length === 0) return new Map();
  const rows = await db
    .select({
      date: capacityBlocksTable.date,
      startHour: capacityBlocksTable.startHour,
      endHour: capacityBlocksTable.endHour,
    })
    .from(capacityBlocksTable)
    .where(and(eq(capacityBlocksTable.dealerId, dealerId), or(...conds)));
  const map: BlockedDays = new Map();
  for (const r of rows) {
    const existing = map.get(r.date);
    if (r.startHour == null || r.endHour == null) {
      map.set(r.date, []); // full day wins
      continue;
    }
    if (existing && existing.length === 0) continue; // already full-day
    map.set(r.date, [
      ...(existing ?? []),
      { startHour: r.startHour, endHour: r.endHour },
    ]);
  }
  return map;
}

/**
 * All unit ids of the same make+model as the given vehicle (capacity blocks
 * on any unit of the model block the whole model line).
 */
export async function modelUnitIds(
  dealerId: number,
  vehicleId: number,
): Promise<number[]> {
  const [iv] = await db
    .select({ make: vehiclesTable.make, model: vehiclesTable.model })
    .from(vehiclesTable)
    .where(and(eq(vehiclesTable.id, vehicleId), eq(vehiclesTable.dealerId, dealerId)));
  if (!iv) return [vehicleId];
  const units = await db
    .select({ id: vehiclesTable.id })
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.dealerId, dealerId),
        eq(vehiclesTable.make, iv.make),
        eq(vehiclesTable.model, iv.model),
      ),
    );
  return units.length > 0 ? units.map((u) => u.id) : [vehicleId];
}
