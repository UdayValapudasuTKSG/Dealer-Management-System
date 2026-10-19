import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, partsPosSettingsTable as settings, partsPosRequestsTable as requests,
  partsTable, customersTable, auditLogsTable } from "@workspace/db";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import { posConfigSchema, posInputSchema, posGlLines, money, type PosSnapshot } from "../lib/parts-pos-policy";
import { posLock, posSettings, buildPosSnapshot, queuePos, seedPosParts, isPosDummy } from "../lib/parts-pos";
import { getErpnextConnection } from "../lib/erpnext/connection";

const router = Router();
const actionSchema = z.object({
  action: z.enum(["save_config", "validate", "submit", "approve", "reject", "retry", "reconcile", "seed"]),
  requestKey: z.string().trim().min(8).max(100).optional(),
  requestId: z.number().int().positive().optional(),
  revision: z.number().int().min(0).optional(),
  note: z.string().trim().max(500).optional(),
  config: posConfigSchema.optional(), input: posInputSchema.optional(),
});
router.get("/parts-pos", async (_req, res) => {
  const dealerId = activeDealerId(res);
  if (!res.locals.user || !hasPermission(res.locals.user, "parts", "view")) { res.status(403).json({ error: "Parts visibility required" }); return; }
  const { row, config } = await posSettings(db, dealerId);
  const [rows, parts, customers] = await Promise.all([
    db.select().from(requests).where(eq(requests.dealerId, dealerId)).orderBy(desc(requests.id)).limit(300),
    db.select({ id: partsTable.id, name: partsTable.name, sku: partsTable.sku, barcode: partsTable.barcode, make: partsTable.make,
      unitPrice: partsTable.unitPrice, stock: partsTable.stock }).from(partsTable).where(and(eq(partsTable.dealerId, dealerId), eq(partsTable.active, true))),
    db.select({ id: customersTable.id, name: customersTable.name }).from(customersTable).where(eq(customersTable.dealerId, dealerId)),
  ]);
  // Balance calculations must include the whole ledger, not just this page.
  const all = await db.select().from(requests).where(eq(requests.dealerId, dealerId));
  const presented = rows.map(r => {
    const s = r.snapshot as unknown as PosSnapshot;
    const children = all.filter(c => c.input.originalId === r.id && c.status !== "rejected");
    const receipts = children.filter(c => c.kind === "payment").reduce((n,c) => n + Number(c.snapshot.paid), s.paid);
    const returns = children.filter(c => c.kind === "return");
    const refunded = returns.reduce((n,c) => n + Number(c.snapshot.paid), 0);
    const credits = returns.reduce((n,c) => n + Number(c.snapshot.total), 0);
    return { ...r, snapshot: { ...s, glLines: posGlLines(posInputSchema.parse(r.input), s) },
      availableBalance: money(s.total - credits - receipts + refunded), receivedBalance: money(receipts - refunded),
      returnableLines: s.lines.map(l => ({ partId: l.partId, quantity: l.quantity - returns.reduce((n,c) =>
        n + ((c.snapshot as unknown as PosSnapshot).lines.find(v => v.partId === l.partId)?.quantity ?? 0), 0) })) };
  });
  res.json({ config, revision: row?.revision ?? 0, validation: row?.validation ?? { state: "unchecked", errors: [] },
    requests: presented, parts, customers, userId: res.locals.user.id, isDummy: await isPosDummy(dealerId),
    canEdit: hasPermission(res.locals.user, "finance", "edit"), canApprove: hasPermission(res.locals.user, "finance", "approve") });
});
router.post("/parts-pos", async (req, res) => {
  const parsed = actionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const a = parsed.data;
  const user = res.locals.user;
  if (!user || !hasPermission(user, "parts", "view") || !hasPermission(user, "finance", a.action === "submit" ? "edit" : "approve")) {
    res.status(403).json({ error: "The required Parts visibility and Finance permission are missing" }); return;
  }
  const dealerId = activeDealerId(res);
  try {
    const result = await db.transaction(async tx => {
      await posLock(tx, dealerId);
      const { row, config } = await posSettings(tx, dealerId);
      let output: Record<string, unknown> = {};
      if (a.action === "save_config") {
        if (!a.config || a.revision !== (row?.revision ?? 0)) throw new Error("Configuration changed; reload before saving");
        if (a.config.enabled && !await isPosDummy(dealerId)) throw new Error("F2 rollout is limited to CAM Motors Dummy for initial testing");
        const [busy] = await tx.select({ id: requests.id }).from(requests).where(and(eq(requests.dealerId, dealerId), eq(requests.status, "approved"))).limit(1);
        if (busy) throw new Error("Wait for approved transactions to finish before changing mappings");
        const [saved] = await tx.insert(settings).values({
          dealerId, config: a.config, revision: 1, updatedBy: user.id, validation: { state: "unchecked", errors: [] },
        }).onConflictDoUpdate({ target: settings.dealerId, set: {
          config: a.config, revision: (row?.revision ?? 0) + 1, updatedBy: user.id, updatedAt: new Date(),
          validation: { state: "unchecked", errors: [] },
        } }).returning();
        output = { revision: saved.revision };
      } else if (a.action === "validate") {
        if (!row) throw new Error("Save mappings first");
        const conn = await getErpnextConnection(dealerId);
        if (!conn?.enabled || !conn.companyName) throw new Error("Connect and test ERPNext before queuing validation");
        await tx.update(settings).set({ validation: { state: "queued", errors: [] } }).where(eq(settings.dealerId, dealerId));
        await queuePos(tx, dealerId, 0, true, row.revision);
        output = { queued: true };
      } else if (a.action === "seed") {
        output = { parts: await seedPosParts(tx, dealerId) };
      } else if (a.action === "submit") {
        if (!row || row.validation.state !== "valid") throw new Error("Save and validate the parts POS mappings first");
        if (!a.input || !a.requestKey) throw new Error("Input and a unique request key are required");
        const [existing] = await tx.select().from(requests).where(and(eq(requests.dealerId, dealerId), eq(requests.requestKey, a.requestKey)));
        if (existing) {
          if (canonical(existing.input) !== canonical(a.input))
            throw new Error("Request key belongs to a different transaction");
          return { request: existing };
        }
        const snapshot = await buildPosSnapshot(tx, dealerId, a.input, config);
        const [created] = await tx.insert(requests).values({ dealerId, kind: a.input.kind, requestKey: a.requestKey,
          revision: row.revision, input: a.input, snapshot, createdBy: user.id }).returning();
        output = { request: created };
      } else {
        const [r] = await tx.select().from(requests).where(and(eq(requests.dealerId, dealerId), eq(requests.id, a.requestId ?? 0))).for("update");
        if (!r) throw new Error("POS transaction not found in this dealership");
        if (["approve", "reject"].includes(a.action) && r.createdBy === user.id) throw new Error("A different Finance approver must decide this request");
        if (a.action === "approve") {
          if (r.status !== "pending") throw new Error("Only pending requests can be approved");
          if (!row || row.revision !== r.revision || row.validation.state !== "valid") throw new Error("Mappings changed or need validation; reject and resubmit this request");
          const current = await buildPosSnapshot(tx, dealerId, posInputSchema.parse(r.input), config, r.id);
          // JSONB key order is not stable; compare canonical JSON recursively.
          if (canonical(current) !== canonical(r.snapshot)) throw new Error("Prices, costs, balances or cash totals changed; reject and resubmit");
          await tx.update(requests).set({ status: "approved", decidedBy: user.id, decisionNote: a.note ?? null, updatedAt: new Date() }).where(eq(requests.id, r.id));
          await queuePos(tx, dealerId, r.id);
        } else if (a.action === "reject") {
          if (r.status !== "pending") throw new Error("Only unapproved pending requests may be rejected; failed posts require reconciliation/retry");
          if (!a.note) throw new Error("Enter a rejection reason");
          await tx.update(requests).set({ status: "rejected", decidedBy: user.id, decisionNote: a.note, updatedAt: new Date() }).where(eq(requests.id, r.id));
        } else if (a.action === "retry") {
          if (r.status !== "failed") throw new Error("Only failed requests can be retried");
          await tx.update(requests).set({ status: "approved", error: null, updatedAt: new Date() }).where(eq(requests.id, r.id));
          await queuePos(tx, dealerId, r.id);
        } else if (a.action === "reconcile") {
          if (r.status !== "posted" || !a.note) throw new Error("Reconciliation requires a posted transaction and statement reference");
          await tx.update(requests).set({ reconciliationReference: a.note, reconciledBy: user.id, reconciledAt: new Date(), updatedAt: new Date() }).where(eq(requests.id, r.id));
        }
        output = { id: r.id, action: a.action };
      }
      await tx.insert(auditLogsTable).values({ dealerId, actorUserId: user.id, action: "update", module: "finance",
        entityType: "parts_pos", entityId: String(a.requestId ?? dealerId), summary: `Parts POS: ${a.action}`,
        details: { ...a, output } });
      return output;
    });
    res.json(result);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Parts POS action failed" });
  }
});
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export default router;
