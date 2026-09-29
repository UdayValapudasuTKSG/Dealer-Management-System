import { Router, type IRouter } from "express";
import { sql, and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, jobCardsTable, serviceInvoicesTable } from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import { buildServiceEstimateBreakdown } from "../lib/service-estimate-breakdown";
import { clearEstimateStaffAcknowledgement } from "../lib/service-estimate-gate";
import { invalidateServiceEstimate } from "../lib/service-estimate-invalidation";

const router: IRouter = Router();
const amount = z.number().finite().nonnegative().refine(n => Math.abs(Math.round(n * 100) - n * 100) < 0.000001, "GYD amounts must have at most 2 decimals");
const litres = z.number().finite().positive().refine(n => Math.abs(n * 1000 - Math.round(n * 1000)) < 0.000001, "Litres must have at most 3 decimals");
const nonnegativeLitres = z.number().finite().nonnegative().refine(n => Math.abs(n * 1000 - Math.round(n * 1000)) < 0.000001);
const oilInput = z.object({
  name: z.string().trim().min(1).max(160), grade: z.string().trim().max(80).default(""),
  specification: z.string().trim().max(200).default(""), brand: z.string().trim().max(100).default(""),
  purchaseCostPerLitre: amount, sellingPricePerLitre: amount,
  stockLitres: nonnegativeLitres.default(0), reorderLitres: nonnegativeLitres.default(0),
  active: z.boolean().default(true),
});
const oilUpdate = oilInput.partial();
const ids = z.object({ id: z.coerce.number().int().positive() });
const requestIds = ids.extend({ requestId: z.coerce.number().int().positive(),
  action: z.enum(["approve", "issue", "return", "cancel"]) });
const fail = (message: string, status = 422): never => { throw Object.assign(new Error(message), { status }); };
const handle = (res: any, error: unknown) => {
  const e = error as Error & { status?: number };
  res.status(e.status ?? 409).json({ error: e.message });
};
const oilOut = (r: Record<string, unknown>) => ({
  id: Number(r.id), name: String(r.name), grade: String(r.grade), specification: String(r.specification),
  brand: String(r.brand), purchaseCostPerLitre: Number(r.purchase_cost_per_litre),
  sellingPricePerLitre: Number(r.selling_price_per_litre), stockLitres: Number(r.stock_litres),
  reorderLitres: Number(r.reorder_litres), active: Boolean(r.active),
});
const requestOut = (r: Record<string, unknown>) => ({
  id: Number(r.id), jobCardId: Number(r.job_card_id), oilId: Number(r.oil_id),
  name: String(r.name_snapshot), requestedLitres: Number(r.requested_litres),
  issuedLitres: Number(r.issued_litres), returnedLitres: Number(r.returned_litres),
  unitPricePerLitre: Number(r.unit_price_per_litre), status: String(r.status),
});
const has = (user: NonNullable<Express.Locals["user"]> | undefined, module: string, category: string) =>
  !!user && (user.isSuperAdmin || user.permissions.some(p => p.module === module && p.category === category));
const canProcessOil = (user: NonNullable<Express.Locals["user"]> | undefined) =>
  has(user, "parts", "edit") &&
  !!user && (user.isSuperAdmin || /parts|service manager|general manager|leadership|management|owner.?admin|admin/i.test(user.roleName ?? ""));

router.get("/parts/oils", async (_req, res) => {
  const rows = await db.execute(sql`SELECT * FROM workshop_oils WHERE dealer_id=${activeDealerId(res)} ORDER BY name, id`);
  res.json(rows.rows.map(r => oilOut(r)));
});
router.post("/parts/oils", async (req, res) => {
  const body = oilInput.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const dealerId = activeDealerId(res), b = body.data;
  try {
    const result = await db.transaction(async tx => {
      const row = await tx.execute(sql`INSERT INTO workshop_oils (dealer_id,name,grade,specification,brand,
        purchase_cost_per_litre,selling_price_per_litre,stock_litres,reorder_litres,active)
        VALUES (${dealerId},${b.name},${b.grade},${b.specification},${b.brand},
        ${b.purchaseCostPerLitre.toFixed(2)},${b.sellingPricePerLitre.toFixed(2)},
        ${b.stockLitres.toFixed(3)},${b.reorderLitres.toFixed(3)},${b.active}) RETURNING *`);
      const oil = row.rows[0]!;
      if (b.stockLitres) await tx.execute(sql`INSERT INTO workshop_oil_movements
        (dealer_id, oil_id, delta_litres, reason, actor_id)
        VALUES (${dealerId},${oil.id},${b.stockLitres.toFixed(3)},'opening',${res.locals.user?.id ?? null})`);
      return oilOut(oil);
    });
    res.status(201).json(result);
  } catch (e) { handle(res, e); }
});
router.patch("/parts/oils/:id", async (req, res) => {
  const parsed = ids.safeParse(req.params), body = oilUpdate.safeParse(req.body);
  if (!parsed.success || !body.success || !Object.keys(body.data).length) {
    res.status(400).json({ error: "Invalid oil update" }); return;
  }
  const dealerId = activeDealerId(res);
  if (!has(res.locals.user, "parts", "edit")) { res.status(403).json({ error: "Parts edit permission required" }); return; }
  try {
    const updated = await db.transaction(async tx => {
      const result = await tx.execute(sql`SELECT * FROM workshop_oils WHERE dealer_id=${dealerId}
        AND id=${parsed.data.id} FOR UPDATE`);
      const old = result.rows[0];
      if (!old) return null;
      const b = { ...oilOut(old), ...body.data };
      const oldStock = Number(old.stock_litres);
      // Never overwrite stock without a serialized adjustment movement.
      const adjustment = Math.round((b.stockLitres - oldStock) * 1000) / 1000;
      const reserved = await tx.execute(sql`SELECT coalesce(sum(r.requested_litres-r.issued_litres),0) AS litres
        FROM workshop_oil_requests r JOIN job_cards j ON j.id=r.job_card_id AND j.dealer_id=r.dealer_id
        WHERE r.dealer_id=${dealerId} AND r.oil_id=${parsed.data.id} AND r.status <> 'cancelled'
        AND j.status IN ('open','in_progress','on_hold','completed')
        AND NOT EXISTS (SELECT 1 FROM service_invoices i WHERE i.dealer_id=r.dealer_id AND i.job_card_id=j.id)`);
      if (b.stockLitres + 0.000001 < Number(reserved.rows[0]?.litres ?? 0))
        return fail("Cannot adjust stock below reserved, unissued oil litres");
      const row = await tx.execute(sql`UPDATE workshop_oils SET name=${b.name},grade=${b.grade},
        specification=${b.specification},brand=${b.brand},
        purchase_cost_per_litre=${b.purchaseCostPerLitre.toFixed(2)},
        selling_price_per_litre=${b.sellingPricePerLitre.toFixed(2)},
        stock_litres=${b.stockLitres.toFixed(3)},reorder_litres=${b.reorderLitres.toFixed(3)},
        active=${b.active},updated_at=now() WHERE dealer_id=${dealerId} AND id=${parsed.data.id} RETURNING *`);
      if (adjustment) await tx.execute(sql`INSERT INTO workshop_oil_movements
        (dealer_id,oil_id,delta_litres,reason,actor_id) VALUES
        (${dealerId},${parsed.data.id},${adjustment.toFixed(3)},'adjustment',${res.locals.user?.id ?? null})`);
      return oilOut(row.rows[0]!);
    });
    if (!updated) { res.status(404).json({ error: "Oil not found" }); return; }
    res.json(updated);
  } catch (e) { handle(res, e); }
});

router.get("/job-cards/:id/oils/catalog", async (req, res) => {
  const parsed = ids.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid job id" }); return; }
  const dealerId = activeDealerId(res);
  const [card] = await db.select({ id: jobCardsTable.id, technicianUserId: jobCardsTable.technicianUserId })
    .from(jobCardsTable).where(and(eq(jobCardsTable.id, parsed.data.id), eq(jobCardsTable.dealerId, dealerId)));
  if (!card) { res.status(404).json({ error: "Job not found" }); return; }
  const user = res.locals.user;
  if (user && /technician/i.test(user.roleName ?? "") && card.technicianUserId !== user.id) {
    res.status(403).json({ error: "This job is not assigned to you" }); return;
  }
  const rows = await db.execute(sql`SELECT o.id,o.name,o.grade,o.stock_litres,o.selling_price_per_litre,
    greatest(0, o.stock_litres-coalesce((
      SELECT sum(r.requested_litres-r.issued_litres) FROM workshop_oil_requests r
      JOIN job_cards j ON j.id=r.job_card_id AND j.dealer_id=r.dealer_id
      WHERE r.dealer_id=o.dealer_id AND r.oil_id=o.id AND r.status <> 'cancelled'
      AND j.status IN ('open','in_progress','on_hold','completed')
      AND NOT EXISTS (SELECT 1 FROM service_invoices i WHERE i.dealer_id=r.dealer_id AND i.job_card_id=j.id)
    ),0)) AS available_litres FROM workshop_oils o WHERE o.dealer_id=${dealerId} AND o.active=true ORDER BY o.name`);
  res.json(rows.rows.map(r => ({ id: Number(r.id), name: String(r.name), grade: String(r.grade),
    stockLitres: Number(r.stock_litres), availableLitres: Number(r.available_litres),
    sellingPricePerLitre: Number(r.selling_price_per_litre) })));
});

router.get("/job-cards/:id/oils", async (req, res) => {
  const parsed = ids.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid job id" }); return; }
  const dealerId = activeDealerId(res);
  const [card] = await db.select({ id: jobCardsTable.id }).from(jobCardsTable)
    .where(and(eq(jobCardsTable.id, parsed.data.id), eq(jobCardsTable.dealerId, dealerId)));
  if (!card) { res.status(404).json({ error: "Job not found" }); return; }
  const result = await db.execute(sql`SELECT * FROM workshop_oil_requests
    WHERE dealer_id=${dealerId} AND job_card_id=${card.id} ORDER BY id DESC`);
  res.json(result.rows.map(r => requestOut(r)));
});

router.post("/job-cards/:id/oils", async (req, res) => {
  const parsed = ids.safeParse(req.params);
  const body = z.object({ oilId: z.number().int().positive(), litres }).safeParse(req.body);
  if (!parsed.success || !body.success) { res.status(400).json({ error: "Invalid oil request" }); return; }
  const dealerId = activeDealerId(res);
  try {
    const row = await db.transaction(async tx => {
      const [card] = await tx.select().from(jobCardsTable).where(and(
        eq(jobCardsTable.id, parsed.data.id), eq(jobCardsTable.dealerId, dealerId))).for("update");
      if (!card) return fail("Job not found", 404);
      if (!["open", "in_progress", "on_hold"].includes(card.status)) return fail("Job is not active");
      const user = res.locals.user;
      if (!user || (card.technicianUserId !== user.id && !/service manager|general manager|management|owner.?admin|admin/i.test(user.roleName ?? "") && !user.isSuperAdmin))
        return fail("Only the assigned technician or service manager can request oil", 403);
      const [invoiced] = await tx.select({ id: serviceInvoicesTable.id }).from(serviceInvoicesTable)
        .where(and(eq(serviceInvoicesTable.jobCardId, card.id), eq(serviceInvoicesTable.dealerId, dealerId)));
      if (invoiced) return fail("Invoiced job cannot request oil");
      const oil = await tx.execute(sql`SELECT * FROM workshop_oils WHERE dealer_id=${dealerId}
        AND id=${body.data.oilId} AND active=true FOR UPDATE`);
      if (!oil.rows[0]) return fail("Oil not found or inactive", 404);
      const o = oil.rows[0];
      const reserved = await tx.execute(sql`SELECT coalesce(sum(r.requested_litres-r.issued_litres),0) AS litres
        FROM workshop_oil_requests r JOIN job_cards j ON j.id=r.job_card_id AND j.dealer_id=r.dealer_id
        WHERE r.dealer_id=${dealerId} AND r.oil_id=${body.data.oilId} AND r.status <> 'cancelled'
        AND j.status IN ('open','in_progress','on_hold','completed')
        AND NOT EXISTS (SELECT 1 FROM service_invoices i WHERE i.dealer_id=r.dealer_id AND i.job_card_id=j.id)`);
      if (Number(o.stock_litres) - Number(reserved.rows[0]?.litres ?? 0) + 0.000001 < body.data.litres)
        return fail("Insufficient available oil stock to reserve requested litres");
      // The oil row lock serializes reservations with all issues and adjustments.
      // Reservation changes available stock, never on-hand or an invoice.
      const result = await tx.execute(sql`INSERT INTO workshop_oil_requests
        (dealer_id,job_card_id,oil_id,requested_litres,name_snapshot,unit_price_per_litre,requested_by)
        VALUES (${dealerId},${card.id},${body.data.oilId},${body.data.litres.toFixed(3)},
        ${o.name},${o.selling_price_per_litre},${user.id}) RETURNING *`);
      return requestOut(result.rows[0]!);
    });
    res.status(201).json(row);
  } catch (e) { handle(res, e); }
});

router.post("/job-cards/:id/oils/:requestId/:action", async (req, res) => {
  const parsed = requestIds.safeParse(req.params);
  const body = z.object({ litres: litres.optional() }).safeParse(req.body ?? {});
  if (!parsed.success || !body.success) { res.status(400).json({ error: "Invalid oil movement" }); return; }
  const { id, requestId, action } = parsed.data, dealerId = activeDealerId(res);
  if (!canProcessOil(res.locals.user)) {
    res.status(403).json({ error: "Parts staff or service management with parts edit permission required to process oil" }); return;
  }
  try {
    const result = await db.transaction(async tx => {
      const [card] = await tx.select().from(jobCardsTable).where(and(
        eq(jobCardsTable.id, id), eq(jobCardsTable.dealerId, dealerId))).for("update");
      if (!card) return fail("Job not found", 404);
      const [invoiced] = await tx.select({ id: serviceInvoicesTable.id }).from(serviceInvoicesTable)
        .where(and(eq(serviceInvoicesTable.jobCardId, id), eq(serviceInvoicesTable.dealerId, dealerId)));
      if (invoiced && action !== "return") return fail("Invoiced oil cannot be issued or cancelled");
      if (["closed", "cancelled"].includes(card.status) && action !== "return") return fail("Job is not active");
      const request = await tx.execute(sql`SELECT * FROM workshop_oil_requests
        WHERE dealer_id=${dealerId} AND job_card_id=${id} AND id=${requestId} FOR UPDATE`);
      const r = request.rows[0];
      if (!r) return fail("Oil request not found", 404);
      if (r.status === "cancelled") return fail("Request already cancelled");
      if (action === "approve") {
        if (body.data.litres !== undefined) return fail("Approval does not take litres", 400);
        if (r.status !== "requested") return fail("Only pending requests can be approved");
        const approved = await tx.execute(sql`UPDATE workshop_oil_requests SET status='approved',
          approved_by=${res.locals.user?.id ?? null}, approved_at=now(), updated_at=now()
          WHERE dealer_id=${dealerId} AND id=${requestId} RETURNING *`);
        return requestOut(approved.rows[0]!);
      }
      const oil = await tx.execute(sql`SELECT * FROM workshop_oils
        WHERE dealer_id=${dealerId} AND id=${r.oil_id} FOR UPDATE`);
      const o = oil.rows[0];
      if (!o) return fail("Oil not found", 404);
      const issued = Number(r.issued_litres), returned = Number(r.returned_litres),
        requested = Number(r.requested_litres), delta = body.data.litres;
      if (action === "issue" && r.status === "requested") return fail("Oil must be approved before issue");
      if (action === "cancel") {
        if (delta !== undefined) return fail("Cancellation does not take litres", 400);
        // Cancellation releases outstanding demand; physically issued oil must first be returned.
        if (issued !== returned) return fail("Return all issued oil before cancelling");
        const updated = await tx.execute(sql`UPDATE workshop_oil_requests SET status='cancelled',
          updated_at=now() WHERE id=${requestId} AND dealer_id=${dealerId} RETURNING *`);
        return requestOut(updated.rows[0]!);
      }
      const quantity = delta ?? (action === "issue" ? requested - issued : issued - returned);
      if (quantity <= 0) return fail("No litres remaining");
      if (action === "issue" && Math.round((issued + quantity) * 1000) > Math.round(requested * 1000))
        return fail("Cannot issue more than requested");
      if (action === "return" && Math.round((returned + quantity) * 1000) > Math.round(issued * 1000))
        return fail("Cannot return more than issued");
      if (action === "issue" && Number(o.stock_litres) + 0.000001 < quantity)
        return fail("Insufficient oil stock");
      const stockDelta = action === "issue" ? -quantity : quantity;
      await tx.execute(sql`UPDATE workshop_oils SET stock_litres=stock_litres+${stockDelta.toFixed(3)},
        updated_at=now() WHERE dealer_id=${dealerId} AND id=${r.oil_id}`);
      await tx.execute(sql`INSERT INTO workshop_oil_movements
        (dealer_id,oil_id,request_id,delta_litres,reason,actor_id)
        VALUES (${dealerId},${r.oil_id},${requestId},${stockDelta.toFixed(3)},
        ${action},${res.locals.user?.id ?? null})`);
      const nextIssued = issued + (action === "issue" ? quantity : 0);
      const nextReturned = returned + (action === "return" ? quantity : 0);
      const status = Math.round(nextIssued * 1000) === Math.round(requested * 1000) ? "issued" : nextIssued ? "partial" : "requested";
      const updated = await tx.execute(sql`UPDATE workshop_oil_requests SET
        issued_litres=${nextIssued.toFixed(3)}, returned_litres=${nextReturned.toFixed(3)},
        status=${status}, updated_at=now() WHERE id=${requestId} AND dealer_id=${dealerId} RETURNING *`);
      // Physical returns after invoice restore stock only. The invoice's
      // immutable oil snapshot remains unchanged; staff must separately issue
      // an authorized financial invoice credit (never restock it twice).
      if (invoiced) return requestOut(updated.rows[0]!);
      const breakdown = await buildServiceEstimateBreakdown(tx, card);
      await tx.update(jobCardsTable).set({
        quoteTotal: breakdown.total, estimateVersion: sql`${jobCardsTable.estimateVersion} + 1`,
        estimateApprovedVersion: null, estimateApprovalAt: null, estimateApprovalEvidence: null,
        quoteApprovedAt: null, ...clearEstimateStaffAcknowledgement,
      }).where(and(eq(jobCardsTable.id, id), eq(jobCardsTable.dealerId, dealerId)));
      await invalidateServiceEstimate(tx, dealerId, id);
      return requestOut(updated.rows[0]!);
    });
    res.json(result);
  } catch (e) { handle(res, e); }
});
export default router;