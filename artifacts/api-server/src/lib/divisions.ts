import { db, divisionsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";

const cache = new Map<number, number>();

/**
 * Default division for a dealer (first by id). New records are stamped with
 * it when the caller does not specify one. Cached per process; divisions are
 * effectively static reference data.
 */
export async function defaultDivisionId(
  dealerId: number,
): Promise<number | null> {
  const cached = cache.get(dealerId);
  if (cached != null) return cached;
  const [row] = await db
    .select({ id: divisionsTable.id })
    .from(divisionsTable)
    .where(eq(divisionsTable.dealerId, dealerId))
    .orderBy(asc(divisionsTable.id))
    .limit(1);
  const id = row?.id ?? null;
  // Only cache hits — a dealer without divisions yet should be re-checked
  // on the next insert instead of being stuck unstamped until restart.
  if (id != null) cache.set(dealerId, id);
  return id;
}
