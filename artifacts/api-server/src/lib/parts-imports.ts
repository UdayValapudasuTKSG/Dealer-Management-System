import { and, asc, eq, inArray, or, lt, sql } from "drizzle-orm";
import { db, partImportJobsTable as jobs, partPricingPoliciesTable as policies, partsTable } from "@workspace/db";
import { ensureInventory, moveStock } from "./parts-inventory";
import { enqueuePartItemSync, enqueueStockEntrySync } from "./erpnext/parts-sync";
import { validateImportRows, type ImportOptions, type ImportError, type ImportRow } from "./parts-import-validation";
import { logger } from "./logger";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Transaction-only write path, shared by the worker and isolated regression. No external sends. */
export async function persistImportedPart(tx: Tx, dealerId: number, jobId: number, row: ImportRow, options: ImportOptions, old?: typeof partsTable.$inferSelect, createdBy: number | null = null) {
  const { stock, reorderMin, ...fields } = row;
  if (old) await ensureInventory(tx, dealerId, old.id);
  const values = { ...fields, ...(fields.pricingDetails ? { pricingDetails: { ...old?.pricingDetails, ...fields.pricingDetails } } : {}), ...(reorderMin !== undefined ? { reorderLevel: Number(reorderMin) } : {}), updatedAt: new Date() } as Partial<typeof partsTable.$inferInsert>;
  const [part] = old
    ? await tx.update(partsTable).set(values).where(and(eq(partsTable.id, old.id), eq(partsTable.dealerId, dealerId))).returning()
    : await tx.insert(partsTable).values({ ...values, dealerId, sku: row.sku, name: row.name, unitCost: row.unitCost, unitPrice: row.unitPrice, stock: 0 }).returning();
  let delta = 0;
  if (options.applyStock && stock !== undefined) {
    await ensureInventory(tx, dealerId, part.id);
    delta = Number(stock) - part.stock;
    if (delta) await moveStock(tx, {
      dealerId, partId: part.id, type: "adjustment", quantityDelta: delta,
      referenceType: "parts_import", referenceId: String(jobId), unitCost: row.unitCost,
      idempotencyKey: `parts-import:${jobId}:${part.id}`, notes: "Explicit imported stock adjustment", createdBy,
    });
  }
  return { part, delta };
}
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;

async function context(tx: Tx, dealerId: number, source: Record<string, string>[]) {
  const skuList = [...new Set(source.map(r => r.sku).filter(Boolean))];
  const existing = skuList.length ? await tx.select().from(partsTable).where(and(eq(partsTable.dealerId, dealerId), inArray(partsTable.sku, skuList))).orderBy(asc(partsTable.id)).for("update") : [];
  const pricing = await tx.select().from(policies).where(eq(policies.dealerId, dealerId));
  return { existing, pricing, map: new Map(existing.map(p => [p.sku, { category: p.category, reorderMin: p.reorderLevel, reorderMax: p.reorderMax }])) };
}

/** One bounded worker; durable queue claims serialized across server instances. */
export async function processNextPartsImport(): Promise<boolean> {
  if (busy) return false;
  busy = true;
  let claimedId: number | undefined;
  let validationToken: Date | null = null;
  try {
    const validationJob = await db.transaction(async tx => {
      const [job] = await tx.select().from(jobs).where(or(
        eq(jobs.status, "pending"),
        and(eq(jobs.status, "validating"), lt(jobs.startedAt, new Date(Date.now() - 10 * 60_000))),
      )).orderBy(asc(jobs.id)).limit(1).for("update", { skipLocked: true });
      if (!job) return null;
      const [claimed] = await tx.update(jobs).set({ status: "validating", startedAt: new Date(), processedRows: 0 }).where(eq(jobs.id, job.id)).returning();
      return claimed;
    });
    if (validationJob) {
      claimedId = validationJob.id;
      validationToken = validationJob.startedAt;
      const source = validationJob.rows as Record<string, string>[];
      const options = validationJob.columnMapping as ImportOptions;
      const ctx = await db.transaction(tx => context(tx, validationJob.dealerId, source));
      const errors: ImportError[] = [], seen = new Map<string, number>();
      for (let offset = 0; offset < source.length; offset += 500) {
        const checked = validateImportRows(source.slice(offset, offset + 500), options, ctx.pricing, ctx.map, { offset, seen });
        errors.push(...checked.errors);
        // Heartbeat + token prevents a stale worker overwriting a reclaimed job.
        const updated = await db.update(jobs).set({ processedRows: Math.min(offset + 500, source.length), errors, startedAt: new Date() })
          .where(and(eq(jobs.id, validationJob.id), eq(jobs.status, "validating"), eq(jobs.startedAt, validationJob.startedAt!))).returning();
        if (!updated.length) return true;
        validationJob.startedAt = updated[0].startedAt;
        validationToken = validationJob.startedAt;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      await db.update(jobs).set({ status: errors.length ? "invalid" : "validated", errors })
        .where(and(eq(jobs.id, validationJob.id), eq(jobs.status, "validating"), eq(jobs.startedAt, validationJob.startedAt!)));
      return true;
    }
    // Session-independent transaction locks make a crash roll back both the claim
    // and work; the durable queued request remains available on restart.
    const result = await db.transaction(async tx => {
      const [job] = await tx.select().from(jobs)
        .where(eq(jobs.status, "queued"))
        .orderBy(asc(jobs.id)).limit(1).for("update", { skipLocked: true });
      if (!job) return null;
      claimedId = job.id;
      const payload = { source: job.rows as Record<string, string>[], options: job.columnMapping as ImportOptions };
      // Lock the dealer before reading its catalog: row locks alone cannot
      // serialize two imports introducing the same previously absent SKU.
      // Ordinary part creation remains protected by the dealer/SKU unique key.
      await tx.execute(sql`select pg_advisory_xact_lock(${job.dealerId}, 13014)`);
      await tx.update(jobs).set({ startedAt: new Date(), processedRows: 0 }).where(eq(jobs.id, job.id));
      const ctx = await context(tx, job.dealerId, payload.source);
      const checked = validateImportRows(payload.source, payload.options, ctx.pricing, ctx.map);
      if (checked.errors.length) {
        await tx.update(jobs).set({ status: "invalid", errors: checked.errors, processedRows: job.totalRows, completedAt: new Date() }).where(eq(jobs.id, job.id));
        return { changes: [] };
      }
      const changes: { dealerId: number; partId: number; operation: "insert" | "update"; delta: number; unitCost: number }[] = [];
      // Existing parts are locked in ascending id above, avoiding cross-job deadlocks.
      for (let i = 0; i < checked.rows.length; i++) {
        const row = checked.rows[i];
        const old = ctx.existing.find(p => p.sku === row.sku);
        const { part, delta } = await persistImportedPart(tx, job.dealerId, job.id, row, payload.options, old, job.createdBy);
        changes.push({ dealerId: job.dealerId, partId: part.id, operation: old ? "update" : "insert", delta, unitCost: row.unitCost });
      }
      await tx.update(jobs).set({ status: "completed", processedRows: job.totalRows, errors: [], completedAt: new Date(), errorMessage: null }).where(eq(jobs.id, job.id));
      return { changes };
    });
    // Never send ERP events for a rolled-back import.
    for (const change of result?.changes ?? []) {
      enqueuePartItemSync(change.dealerId, change.partId, change.operation);
      if (change.delta) enqueueStockEntrySync({
        dealerId: change.dealerId, partId: change.partId,
        qty: Math.abs(change.delta), direction: change.delta > 0 ? "in" : "out",
        entityType: "parts_import", entityId: claimedId!, remark: "Parts import stock adjustment",
        dedupeKey: `parts-import:${claimedId}:${change.partId}`,
      });
    }
    return !!result;
  } catch (err) {
    logger.error({ err, jobId: claimedId }, "Parts import failed atomically");
    if (claimedId !== undefined) await db.update(jobs).set({ status: "failed", errorMessage: err instanceof Error ? err.message : "Import failed", completedAt: new Date() }).where(and(
      eq(jobs.id, claimedId),
      validationToken ? and(eq(jobs.status, "validating"), eq(jobs.startedAt, validationToken)) : eq(jobs.status, "queued"),
    ));
    return false;
  } finally { busy = false; }
}

export function startPartsImportWorker() {
  if (timer) return;
  timer = setInterval(() => { void processNextPartsImport().catch(err => logger.error({ err }, "Parts import worker unavailable")); }, 1000);
  timer.unref();
}
export function stopPartsImportWorker() { if (timer) clearInterval(timer); timer = undefined; }