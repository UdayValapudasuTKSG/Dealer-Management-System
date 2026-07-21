import { asc, eq } from "drizzle-orm";
import {
  db,
  leadSourcesTable,
  DEFAULT_LEAD_SOURCES,
  type LeadSourceRecord,
} from "@workspace/db";

/**
 * Lead-source config is lazily seeded: the first read for a dealer inserts
 * the platform defaults so every dealer (including future ones) starts with
 * a sensible dropdown without a migration script.
 */
export async function ensureLeadSources(
  dealerId: number,
): Promise<LeadSourceRecord[]> {
  const rows = await db
    .select()
    .from(leadSourcesTable)
    .where(eq(leadSourcesTable.dealerId, dealerId))
    .orderBy(asc(leadSourcesTable.sortOrder), asc(leadSourcesTable.id));
  if (rows.length > 0) return rows;
  await db
    .insert(leadSourcesTable)
    .values(
      DEFAULT_LEAD_SOURCES.map((s, i) => ({
        dealerId,
        code: s.code,
        name: s.name,
        isSocial: s.isSocial,
        active: true,
        sortOrder: i,
      })),
    )
    .onConflictDoNothing();
  return db
    .select()
    .from(leadSourcesTable)
    .where(eq(leadSourcesTable.dealerId, dealerId))
    .orderBy(asc(leadSourcesTable.sortOrder), asc(leadSourcesTable.id));
}

export function slugifyCode(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}
