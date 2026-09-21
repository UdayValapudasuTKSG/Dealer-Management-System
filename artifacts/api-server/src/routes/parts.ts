import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { ensureInventory, moveStock } from "../lib/parts-inventory";
import { reserveJobPart } from "../lib/job-part-stock";
import { createPartsImport } from "./parts-imports";
import { postPartsReceipt, validateLocation } from "../lib/parts-operations";
import { calculateLandedUnitCost, purchaseOrderReceiptUnitCost } from "../lib/parts-landed-cost";
import { z } from "zod";
import multer from "multer";
import ExcelJS from "exceljs";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import { idempotent } from "../middlewares/idempotency";
import { dealerExchangeRate } from "../lib/invoicing";
import { dealerTimezone, zonedParts } from "../lib/timezone";
import { computeTaxes, ensureDealerTaxes } from "../lib/taxes";
import { queueInvoiceSync } from "../lib/erpnext/entities";
import { and, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  db,
  partsTable,
  inventoryLevelsTable,
  inventoryHoldsTable,
  inventoryTransactionsTable,
  invoicesTable,
  customersTable,
  suppliersTable,
  partPurchasesTable,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  purchaseOrderReceiptsTable,
  purchaseOrderReceiptLinesTable,
  partRequisitionPoAllocationsTable,
  partRequisitionLinesTable,
  partRequisitionFulfillmentsTable,
  partRequisitionsTable,
  externalJobCardPartsTable,
  serviceInvoicesTable,
  serviceOrdersTable,
  dealersTable,
  type Part,
} from "@workspace/db";
import {
  ListPartsQueryParams,
  ListPartsResponse,
  CreatePartBody,
  CreatePartResponse,
  UpdatePartParams,
  UpdatePartBody,
  UpdatePartResponse,
  ListSuppliersResponse,
  CreateSupplierBody,
  CreateSupplierResponse,
  GetSupplierDeliveryHistoryParams,
  GetSupplierDeliveryHistoryResponse,
  ListPartPurchasesResponse,
  CreatePartPurchaseBody,
  CreatePartPurchaseResponse,
  ReceivePartPurchaseParams,
  ReceivePartPurchaseBody,
  ReceivePartPurchaseResponse,
  ImportPartsResponse,
  GetPartsSettingsResponse,
  UpdatePartsSettingsBody,
  UpdatePartsSettingsResponse,
  ListPurchaseOrdersResponse,
  CreatePurchaseOrderBody,
  CreatePurchaseOrderResponse,
  UpdatePurchaseOrderParams,
  UpdatePurchaseOrderBody,
  UpdatePurchaseOrderResponse,
  ReceivePurchaseOrderParams,
  ReceivePurchaseOrderBody,
  ReceivePurchaseOrderResponse,
} from "@workspace/api-zod";
import {
  jobCardPartsTable,
  jobCardsTable,
  collisionClaimsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { notifyPartLowStock } from "../lib/notify-triggers";
import { coordinateCollisionClaim } from "../lib/collision-coordinator";
import { buildServiceEstimateBreakdown } from "../lib/service-estimate-breakdown";
import {
  clearEstimateStaffAcknowledgement,
} from "../lib/service-estimate-gate";
import { invalidateServiceEstimate } from "../lib/service-estimate-invalidation";
import {
  enqueuePartItemSync,
  enqueueSupplierSync,
  enqueueStockEntrySync,
  enqueuePurchaseOrderSync,
  enqueuePurchaseReceiptSync,
} from "../lib/erpnext/parts-sync";

const router: IRouter = Router();
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

router.post("/parts/otc-invoices", idempotent("parts.otc-invoice"), async (req, res): Promise<void> => {
  if (!res.locals.user || !hasPermission(res.locals.user, "finance", "create")) {
    res.status(403).json({ error: "Finance invoice-create permission is required" }); return;
  }
  const requestKey = req.header("x-idempotency-key")?.trim();
  if (!requestKey || requestKey.length > 200) {
    res.status(400).json({ error: "A unique X-Idempotency-Key header is required" }); return;
  }
  const parsed = z.object({
    customerId: z.number().int().positive().optional(),
    customerName: z.string().trim().min(1).max(300),
    lines: z.array(z.object({
      partId: z.number().int().positive(), quantity: z.number().int().positive(),
      locationId: z.number().int().positive().optional(), binId: z.number().int().positive().nullable().optional(),
    })).min(1).max(100),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const dealerId = activeDealerId(res);
  const fingerprint = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
  const taxes = (await ensureDealerTaxes(dealerId)).filter(t => t.code === "vat");
  const exchangeRate = await dealerExchangeRate(dealerId);
  const year = zonedParts(new Date(), await dealerTimezone(dealerId)).year;
  try {
    const result = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`otc:${dealerId}:${requestKey}`}))`);
      const [prior] = await tx.select().from(inventoryTransactionsTable).where(and(
        eq(inventoryTransactionsTable.dealerId, dealerId),
        eq(inventoryTransactionsTable.idempotencyKey, `otc-invoice:${dealerId}:${requestKey}:0`),
      ));
      if (prior) {
        if (prior.notes !== fingerprint) throw Object.assign(new Error("Idempotency key was used for a different sale"), { status: 422 });
        const [invoice] = await tx.select().from(invoicesTable).where(and(
          eq(invoicesTable.id, Number(prior.referenceId)), eq(invoicesTable.dealerId, dealerId),
        ));
        if (!invoice) throw new Error("Stock issue has no linked invoice; reconciliation required");
        const movements = await tx.select().from(inventoryTransactionsTable).where(and(
          eq(inventoryTransactionsTable.dealerId, dealerId), eq(inventoryTransactionsTable.referenceType, "otc_invoice"),
          eq(inventoryTransactionsTable.referenceId, String(invoice.id)),
        ));
        return { invoice, movements };
      }
      if (parsed.data.customerId) {
        const [customer] = await tx.select({ id: customersTable.id }).from(customersTable).where(and(
          eq(customersTable.id, parsed.data.customerId), eq(customersTable.dealerId, dealerId),
        ));
        if (!customer) throw Object.assign(new Error("Customer not found in dealership"), { status: 404 });
      }
      const lines = [];
      for (const input of [...parsed.data.lines].sort((a, b) => a.partId - b.partId)) {
        const [part] = await tx.select().from(partsTable).where(and(
          eq(partsTable.id, input.partId), eq(partsTable.dealerId, dealerId),
        )).for("update");
        if (!part || !part.active) throw Object.assign(new Error("Active part not found in dealership"), { status: 404 });
        lines.push({ ...input, sku: part.sku, name: part.name, unitPrice: part.unitPrice });
      }
      const subtotal = Math.round(lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0) * 100) / 100;
      const tax = computeTaxes(subtotal, taxes);
      const [invoice] = await tx.insert(invoicesTable).values({
        dealerId, invoiceNumber: "PENDING", customerId: parsed.data.customerId,
        customerName: parsed.data.customerName, kind: "final", status: "issued",
        description: `OTC parts sale\n${lines.map(l => `${l.sku} — ${l.name}: ${l.quantity} × ${l.unitPrice}`).join("\n")}`,
        amount: tax.totalWithTax, taxLines: tax.lines, currency: "GYD", exchangeRate,
      }).returning();
      const movements = [];
      for (const [index, line] of lines.entries()) {
        movements.push(await moveStock(tx, {
          dealerId, partId: line.partId, locationId: line.locationId, binId: line.binId,
          type: "issue", quantityDelta: -line.quantity,
          referenceType: "otc_invoice", referenceId: String(invoice.id),
          idempotencyKey: `otc-invoice:${dealerId}:${requestKey}:${index}`,
          createdBy: res.locals.user?.id,
          notes: fingerprint,
        }));
      }
      const [numbered] = await tx.update(invoicesTable).set({
        invoiceNumber: `INV-${year}-${String(invoice.id).padStart(4, "0")}`,
      }).where(and(eq(invoicesTable.id, invoice.id), eq(invoicesTable.dealerId, dealerId))).returning();
      return { invoice: numbered, movements };
    });
    queueInvoiceSync(dealerId, result.invoice.id, "create");
    for (const movement of result.movements) enqueueStockEntrySync({
      dealerId, partId: movement.partId, qty: -movement.quantityDelta, direction: "out",
      entityType: "invoice", entityId: result.invoice.id,
      remark: `AURA OTC invoice #${result.invoice.id}`,
      dedupeKey: `erp:se:otc:${dealerId}:${movement.id}`,
    });
    res.status(201).json(result);
  } catch (error) {
    const failure = error as Error & { status?: number };
    res.status(failure.status ?? 409).json({ error: failure.message });
  }
});

export type BackorderRelease = {
  available: number;
  /** Job-card lines filled by this release — each is a stock issue. */
  filledLines: { id: number; partId: number; quantity: number; jobCardId: number }[];
  resumedClaims: {
    id: number;
    dealerId: number;
    vehicleInfo: string;
    status: string;
    pausedSeconds: number;
  }[];
};

async function lockReceiptInventory(tx: Tx, dealerId: number, partIds: number[]) {
  const ids = [...new Set(partIds)].sort((a, b) => a - b);
  if (!ids.length) return;
  const waiting = await tx.select({ jobCardId: jobCardPartsTable.jobCardId }).from(jobCardPartsTable)
    .where(and(eq(jobCardPartsTable.dealerId, dealerId), inArray(jobCardPartsTable.partId, ids),
      eq(jobCardPartsTable.backordered, true)));
  // Same order as attach/issue/billing: card first, then parts in ascending order.
  for (const id of [...new Set(waiting.map(l => l.jobCardId))].sort((a, b) => a - b)) {
    await tx.select({ id: jobCardsTable.id }).from(jobCardsTable).where(and(
      eq(jobCardsTable.id, id), eq(jobCardsTable.dealerId, dealerId),
    )).for("update");
  }
  for (const id of ids) {
    await tx.select({ id: partsTable.id }).from(partsTable).where(and(
      eq(partsTable.id, id), eq(partsTable.dealerId, dealerId),
    )).for("update");
  }
}

/**
 * Make reserved backorders ready without physical issuance, and flip touched on_hold job cards back to
 * in_progress once none of their lines wait. A receipt never starts work:
 * released cards remain timer-paused and require an explicit technician
 * resume, so one stock transaction cannot conflict with an unassigned/busy
 * technician or start several of their cards at once. Returns the units left
 * over plus the filled lines (so callers can post ERPNext stock issues on
 * commit).
 */
export async function releaseBackorders(
  tx: Tx,
  dealerId: number,
  partId: number,
  available: number,
): Promise<BackorderRelease> {
  const waiting = await tx
    .select()
    .from(jobCardPartsTable)
    .where(
      and(
        eq(jobCardPartsTable.dealerId, dealerId),
        eq(jobCardPartsTable.partId, partId),
        eq(jobCardPartsTable.backordered, true),
        sql`exists (select 1 from ${jobCardsTable} where ${jobCardsTable.id} = ${jobCardPartsTable.jobCardId}
          and ${jobCardsTable.dealerId} = ${dealerId} and ${jobCardsTable.status} not in ('cancelled','closed'))`,
      ),
    )
    .orderBy(jobCardPartsTable.createdAt);
  const touchedCards = new Set<number>();
  const filledLines: BackorderRelease["filledLines"] = [];
  const resumedClaims: BackorderRelease["resumedClaims"] = [];
  for (const line of waiting) {
    // Receipt fulfils availability, not physical issuance. Legacy backorders
    // never deducted stock, so they too become explicitly unissued holds.
    const hold = line.inventoryHoldId
      ? (await tx.select().from(inventoryHoldsTable).where(and(
        eq(inventoryHoldsTable.id, line.inventoryHoldId), eq(inventoryHoldsTable.dealerId, dealerId),
      )))[0]
      : await reserveJobPart(tx, line);
    if (!hold || hold.status !== "active") continue;
    const [level] = await tx.select().from(inventoryLevelsTable).where(and(
      eq(inventoryLevelsTable.dealerId, dealerId), eq(inventoryLevelsTable.partId, partId),
      eq(inventoryLevelsTable.locationId, hold.locationId),
      hold.binId == null ? isNull(inventoryLevelsTable.binId) : eq(inventoryLevelsTable.binId, hold.binId),
    ));
    if (!level || level.quantityOnHand - level.quantityNonSellable - level.quantityReserved < 0) continue;
    await tx.update(inventoryHoldsTable).set({ backorderRisk: false }).where(and(
      eq(inventoryHoldsTable.id, hold.id), eq(inventoryHoldsTable.dealerId, dealerId),
    ));
    await tx
      .update(jobCardPartsTable)
      .set({ backordered: false })
      .where(eq(jobCardPartsTable.id, line.id));
    touchedCards.add(line.jobCardId);
  }
  if (touchedCards.size > 0) {
    const stillWaiting = await tx
      .select({ jobCardId: jobCardPartsTable.jobCardId })
      .from(jobCardPartsTable)
      .where(
        and(
          eq(jobCardPartsTable.dealerId, dealerId),
          inArray(jobCardPartsTable.jobCardId, [...touchedCards]),
          eq(jobCardPartsTable.backordered, true),
        ),
      );
    const blocked = new Set(stillWaiting.map((r) => r.jobCardId));
    const releasable = [...touchedCards].filter((id) => !blocked.has(id));
    if (releasable.length > 0) {
      const cardsToConsider = await tx.select().from(jobCardsTable).where(and(
        eq(jobCardsTable.dealerId, dealerId),
        inArray(jobCardsTable.id, releasable),
        eq(jobCardsTable.status, "on_hold"),
      )).for("update");
      for (const card of cardsToConsider) {
        // A stock receipt may only lift the hold it caused. Explicit staff
        // holds and rollover holds retain their own gates.
        if (card.waitingReason !== "ordered_parts") continue;
        if (card.rolloverStatus === "pending") continue;
        await tx.update(jobCardsTable).set({
          status: "in_progress",
          waitingReason: null,
          // Receipt fulfillment releases the workflow hold only. Timer
          // control stays an explicit technician/manager action guarded by
          // the job-card timer CAS and ledger trigger.
          timerStartedAt: null,
        }).where(and(
          eq(jobCardsTable.id, card.id),
          eq(jobCardsTable.dealerId, dealerId),
          eq(jobCardsTable.status, "on_hold"),
          eq(jobCardsTable.waitingReason, "ordered_parts"),
          eq(jobCardsTable.estimateVersion, card.estimateVersion),
        ));
      }
    }
    // Collision cycle-time auto-resume (Task 279): when a paused claim's
    // repair order no longer has ANY backordered line waiting, fold the open
    // pause segment so cycle time starts accruing again.
    const cards = await tx
      .select({
        id: jobCardsTable.id,
        serviceOrderId: jobCardsTable.serviceOrderId,
      })
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.dealerId, dealerId),
          inArray(jobCardsTable.id, [...touchedCards]),
        ),
      );
    const orderIds = [...new Set(cards.map((c) => c.serviceOrderId))];
    if (orderIds.length > 0) {
      const pausedClaims = await tx
        .select()
        .from(collisionClaimsTable)
        .where(
          and(
            eq(collisionClaimsTable.dealerId, dealerId),
            inArray(collisionClaimsTable.serviceOrderId, orderIds),
            isNotNull(collisionClaimsTable.pausedAt),
          ),
        )
        .for("update");
      for (const claim of pausedClaims) {
        const [stillBackordered] = await tx
          .select({ id: jobCardPartsTable.id })
          .from(jobCardPartsTable)
          .innerJoin(
            jobCardsTable,
            eq(jobCardsTable.id, jobCardPartsTable.jobCardId),
          )
          .where(
            and(
              eq(jobCardPartsTable.dealerId, dealerId),
              eq(jobCardsTable.serviceOrderId, claim.serviceOrderId),
              eq(jobCardPartsTable.backordered, true),
            ),
          )
          .limit(1);
        if (stillBackordered || !claim.pausedAt) continue;
        const now = new Date();
        const [resumed] = await tx
          .update(collisionClaimsTable)
          .set({
            pausedSeconds:
              claim.pausedSeconds +
              Math.max(
                0,
                Math.floor((now.getTime() - claim.pausedAt.getTime()) / 1000),
              ),
            pausedAt: null,
            history: [
              ...claim.history,
              {
                kind: "resume" as const,
                note: "Backordered parts received — cycle time resumed",
                byUserId: null,
                byName: "System",
                at: now.toISOString(),
              },
            ],
          })
          .where(
            and(
              eq(collisionClaimsTable.id, claim.id),
              eq(collisionClaimsTable.dealerId, dealerId),
            ),
          )
          .returning({
            id: collisionClaimsTable.id,
            dealerId: collisionClaimsTable.dealerId,
            vehicleInfo: collisionClaimsTable.vehicleInfo,
            status: collisionClaimsTable.status,
            pausedSeconds: collisionClaimsTable.pausedSeconds,
          });
        if (resumed) resumedClaims.push(resumed);
      }
    }
  }
  return { available, filledLines, resumedClaims };
}

/** Post ERPNext Material Issues for job-card lines filled by a backorder
 * release (dedupe key per line — a line only ever fills once). */
function syncFilledBackorderLines(
  dealerId: number,
  filled: BackorderRelease["filledLines"],
): void {
  for (const line of filled) {
    enqueueStockEntrySync({
      dealerId,
      partId: line.partId,
      qty: line.quantity,
      direction: "out",
      entityType: "job_card_part",
      entityId: line.id,
      remark: `AURA job card #${line.jobCardId} — backordered issue filled`,
      dedupeKey: `erp:se:jcp:${dealerId}:${line.id}`,
    });
  }
}

/** Fire the MRQ alert only when stock CROSSES to at-or-below the reorder level. */
export function checkLowStockCrossing(
  part: Pick<Part, "id" | "dealerId" | "sku" | "name" | "reorderLevel">,
  prevStock: number,
  newStock: number,
): void {
  void (async () => {
    if (newStock > part.reorderLevel) {
      await db
        .update(partsTable)
        .set({ lowStockAlertActive: false })
        .where(
          and(
            eq(partsTable.id, part.id),
            eq(partsTable.dealerId, part.dealerId),
            eq(partsTable.lowStockAlertActive, true),
          ),
        );
      return;
    }
    if (prevStock <= part.reorderLevel) return;
    const [claimed] = await db
      .update(partsTable)
      .set({
        lowStockAlertActive: true,
        lowStockAlertCycle: sql`${partsTable.lowStockAlertCycle} + 1`,
      })
      .where(
        and(
          eq(partsTable.id, part.id),
          eq(partsTable.dealerId, part.dealerId),
          eq(partsTable.lowStockAlertActive, false),
          sql`${partsTable.stock} <= ${partsTable.reorderLevel}`,
        ),
      )
      .returning({ alertCycle: partsTable.lowStockAlertCycle });
    if (!claimed) return;
    notifyPartLowStock({
      id: part.id,
      dealerId: part.dealerId,
      sku: part.sku,
      name: part.name,
      stock: newStock,
      reorderLevel: part.reorderLevel,
      alertCycle: claimed.alertCycle,
    });
  })().catch((err) => {
    console.error("Failed to evaluate low-stock email crossing", err);
  });
}

router.get("/parts", async (req, res): Promise<void> => {
  const query = ListPartsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const filters = [eq(partsTable.dealerId, activeDealerId(res))];
  if (query.data.search) {
    const term = `%${query.data.search}%`;
    filters.push(
      or(ilike(partsTable.name, term), ilike(partsTable.sku, term), ilike(partsTable.barcode, term))!,
    );
  }
  if (query.data.lowStock === "1") {
    filters.push(sql`${partsTable.stock} <= ${partsTable.reorderLevel}`);
  }
  const rows = await db
    .select()
    .from(partsTable)
    .where(sql.join(filters, sql` and `))
    .orderBy(partsTable.name);
  const quantities = await db.select({
    partId: inventoryLevelsTable.partId,
    reserved: sql<number>`coalesce(sum(${inventoryLevelsTable.quantityReserved}),0)::integer`,
    nonSellable: sql<number>`coalesce(sum(${inventoryLevelsTable.quantityNonSellable}),0)::integer`,
  }).from(inventoryLevelsTable).where(eq(inventoryLevelsTable.dealerId, activeDealerId(res)))
    .groupBy(inventoryLevelsTable.partId);
  const byPart = new Map(quantities.map(row => [row.partId, row]));
  const parsedRows = ListPartsResponse.parse(rows);
  res.json(parsedRows.map(row => ({
    ...row, quantityReserved: byPart.get(row.id)?.reserved ?? 0,
    quantityAvailable: row.stock - (byPart.get(row.id)?.reserved ?? 0) - (byPart.get(row.id)?.nonSellable ?? 0),
  })));
});

router.post("/parts", async (req, res): Promise<void> => {
  const parsed = CreatePartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const part = await db.transaction(async tx => {
    if (parsed.data.supplierId != null) {
      const [supplier] = await tx.select({ id: suppliersTable.id }).from(suppliersTable).where(and(
        eq(suppliersTable.id, parsed.data.supplierId), eq(suppliersTable.dealerId, activeDealerId(res)),
      ));
      if (!supplier) throw Object.assign(new Error("Supplier not found in dealership"), { status: 422 });
    }
    const [created] = await tx.insert(partsTable)
      .values({ ...parsed.data, stock: 0, dealerId: activeDealerId(res) }).returning();
    await ensureInventory(tx, created.dealerId, created.id);
    if ((parsed.data.stock ?? 0) > 0) await moveStock(tx, {
      dealerId: created.dealerId, partId: created.id, type: "opening",
      quantityDelta: parsed.data.stock!, unitCost: created.unitCost,
      referenceType: "part_opening", referenceId: String(created.id),
      idempotencyKey: `part-opening:${created.dealerId}:${created.id}`,
    });
    const [result] = await tx.select().from(partsTable).where(eq(partsTable.id, created.id));
    return result;
  });
  enqueuePartItemSync(part.dealerId, part.id, "insert");
  // A part created with opening stock is an opening Material Receipt.
  if (part.stock > 0) {
    enqueueStockEntrySync({
      dealerId: part.dealerId,
      partId: part.id,
      qty: part.stock,
      direction: "in",
      entityType: "part",
      entityId: part.id,
      remark: `AURA part ${part.sku} — opening stock`,
      dedupeKey: `erp:se:part-open:${part.dealerId}:${part.id}`,
    });
  }
  res.status(201).json(CreatePartResponse.parse(part));
});

router.patch("/parts/:id", async (req, res): Promise<void> => {
  const params = UpdatePartParams.safeParse(req.params);
  const parsed = UpdatePartBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const { before, part } = await db.transaction(async tx => {
    const [before] = await tx.select().from(partsTable).where(and(
      eq(partsTable.id, params.data.id), eq(partsTable.dealerId, dealerId),
    )).for("update");
    if (!before) return { before, part: undefined };
    const { stock, ...metadata } = parsed.data;
    if (metadata.supplierId != null) {
      const [supplier] = await tx.select({ id: suppliersTable.id }).from(suppliersTable).where(and(
        eq(suppliersTable.id, metadata.supplierId), eq(suppliersTable.dealerId, dealerId),
      ));
      if (!supplier) throw Object.assign(new Error("Supplier not found in dealership"), { status: 422 });
    }
    await ensureInventory(tx, dealerId, before.id);
    if (stock !== undefined && stock !== before.stock) await moveStock(tx, {
      dealerId, partId: before.id, type: "adjustment", quantityDelta: stock - before.stock,
      referenceType: "manual_adjustment", referenceId: String(before.id),
      unitCost: metadata.unitCost ?? before.unitCost,
    });
    const [part] = await tx.update(partsTable).set(metadata).where(and(
      eq(partsTable.id, before.id), eq(partsTable.dealerId, dealerId),
    )).returning();
    return { before, part };
  });
  if (!part) {
    res.status(404).json({ error: "Part not found" });
    return;
  }
  // MRQ alert: a manual stock/reorder adjustment can also cross the line.
  if (before) checkLowStockCrossing(part, before.stock, part.stock);
  enqueuePartItemSync(dealerId, part.id, "update");
  // Manual stock adjustment → ERPNext Stock Entry for the delta.
  if (before && parsed.data.stock !== undefined && part.stock !== before.stock) {
    const delta = part.stock - before.stock;
    enqueueStockEntrySync({
      dealerId,
      partId: part.id,
      qty: Math.abs(delta),
      direction: delta > 0 ? "in" : "out",
      entityType: "part",
      entityId: part.id,
      remark: `AURA manual stock adjustment ${before.stock} → ${part.stock} (${part.sku})`,
      dedupeKey: `erp:se:adjust:${dealerId}:${part.id}:${before.stock}:${part.stock}:${Date.now()}`,
    });
  }
  res.json(UpdatePartResponse.parse(part));
});

router.get("/suppliers", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.dealerId, activeDealerId(res)))
    .orderBy(suppliersTable.name);
  res.json(ListSuppliersResponse.parse(rows));
});

router.post("/suppliers", async (req, res): Promise<void> => {
  const parsed = CreateSupplierBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [supplier] = await db
    .insert(suppliersTable)
    .values({ ...parsed.data, dealerId: activeDealerId(res) })
    .returning();
  enqueueSupplierSync(supplier.dealerId, supplier.id, "insert");
  res.status(201).json(CreateSupplierResponse.parse(supplier));
});

router.get("/suppliers/:id/delivery-history", async (req, res): Promise<void> => {
  const params = GetSupplierDeliveryHistoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const [supplier] = await db
    .select()
    .from(suppliersTable)
    .where(and(eq(suppliersTable.id, params.data.id), eq(suppliersTable.dealerId, dealerId)));
  if (!supplier) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const receipts = await db
    .select({
      id: purchaseOrderReceiptsTable.id,
      purchaseOrderId: purchaseOrderReceiptsTable.purchaseOrderId,
      purchaseOrderReference: purchaseOrdersTable.reference,
      receivedAt: purchaseOrderReceiptsTable.receivedAt,
      receivedByName: purchaseOrderReceiptsTable.receivedByName,
      deliveryNoteNumber: purchaseOrderReceiptsTable.deliveryNoteNumber,
      supplierInvoiceNumber: purchaseOrderReceiptsTable.supplierInvoiceNumber,
      warehouseLocation: purchaseOrderReceiptsTable.warehouseLocation,
      condition: purchaseOrderReceiptsTable.condition,
      notes: purchaseOrderReceiptsTable.notes,
      documents: purchaseOrderReceiptsTable.documents,
    })
    .from(purchaseOrderReceiptsTable)
    .innerJoin(
      purchaseOrdersTable,
      and(
        eq(purchaseOrdersTable.id, purchaseOrderReceiptsTable.purchaseOrderId),
        eq(purchaseOrdersTable.dealerId, dealerId),
      ),
    )
    .where(
      and(
        eq(purchaseOrderReceiptsTable.dealerId, dealerId),
        eq(purchaseOrdersTable.supplierId, supplier.id),
      ),
    )
    .orderBy(desc(purchaseOrderReceiptsTable.receivedAt));

  const receiptIds = receipts.map((receipt) => receipt.id);
  const receiptLines = receiptIds.length > 0
    ? await db
        .select({
          receiptId: purchaseOrderReceiptLinesTable.receiptId,
          purchaseOrderLineId: purchaseOrderReceiptLinesTable.purchaseOrderLineId,
          partId: purchaseOrderLinesTable.partId,
          partName: purchaseOrderLinesTable.partName,
          quantity: purchaseOrderReceiptLinesTable.quantity,
          unitCost: purchaseOrderLinesTable.unitCost,
        })
        .from(purchaseOrderReceiptLinesTable)
        .innerJoin(
          purchaseOrderLinesTable,
          and(
            eq(purchaseOrderLinesTable.id, purchaseOrderReceiptLinesTable.purchaseOrderLineId),
            eq(purchaseOrderLinesTable.dealerId, dealerId),
          ),
        )
        .where(
          and(
            eq(purchaseOrderReceiptLinesTable.dealerId, dealerId),
            inArray(purchaseOrderReceiptLinesTable.receiptId, receiptIds),
          ),
        )
    : [];
  const linesByReceipt = new Map<number, typeof receiptLines>();
  for (const line of receiptLines) {
    const current = linesByReceipt.get(line.receiptId) ?? [];
    current.push(line);
    linesByReceipt.set(line.receiptId, current);
  }

  res.json(
    GetSupplierDeliveryHistoryResponse.parse({
      supplier,
      deliveries: receipts.map((receipt) => ({
        ...receipt,
        documents: receipt.documents ?? [],
        lines: linesByReceipt.get(receipt.id) ?? [],
      })),
    }),
  );
});

router.get("/part-purchases", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(partPurchasesTable)
    .where(eq(partPurchasesTable.dealerId, activeDealerId(res)))
    .orderBy(desc(partPurchasesTable.createdAt));
  res.json(ListPartPurchasesResponse.parse(rows));
});

router.post("/part-purchases", async (req, res): Promise<void> => {
  const parsed = CreatePartPurchaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [part] = await db
    .select()
    .from(partsTable)
    .where(
      and(
        eq(partsTable.id, parsed.data.partId),
        eq(partsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!part) {
    res.status(404).json({ error: "Part not found" });
    return;
  }
  // status "ordered" creates an open PO awaiting goods; the legacy default
  // ("received") keeps the old immediate-receipt behavior intact.
  const isOrdered = parsed.data.status === "ordered";
  const [purchase] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(partPurchasesTable)
      .values({
        ...parsed.data,
        // date({mode:"string"}) column: the generated Zod coerces to Date.
        expectedDate:
          parsed.data.expectedDate instanceof Date
            ? parsed.data.expectedDate.toISOString().slice(0, 10)
            : (parsed.data.expectedDate ?? null),
        qtyReceived: isOrdered ? 0 : parsed.data.quantity,
        status: isOrdered ? "ordered" : "received",
        dealerId: part.dealerId,
      })
      .returning();
    if (!isOrdered) {
      await moveStock(tx, {
        dealerId: part.dealerId, partId: part.id, type: "receipt",
        quantityDelta: parsed.data.quantity, unitCost: parsed.data.unitCost ?? part.unitCost,
        referenceType: "part_purchase", referenceId: String(inserted[0].id),
        idempotencyKey: `part-purchase:${part.dealerId}:${inserted[0].id}:initial`,
      });
    }
    return inserted;
  });
  // Immediate-receipt purchases move stock now → ERPNext Material Receipt.
  if (!isOrdered) {
    checkLowStockCrossing(part, part.stock, part.stock + parsed.data.quantity);
    enqueueStockEntrySync({
      dealerId: part.dealerId,
      partId: part.id,
      qty: parsed.data.quantity,
      direction: "in",
      entityType: "part_purchase",
      entityId: purchase.id,
      remark: `AURA part purchase #${purchase.id} (${part.sku})`,
      dedupeKey: `erp:se:pp:${part.dealerId}:${purchase.id}:init`,
    });
  }
  res.status(201).json(CreatePartPurchaseResponse.parse(purchase));
});

router.post("/part-purchases/:id/receive", async (req, res): Promise<void> => {
  const params = ReceivePartPurchaseParams.safeParse(req.params);
  const parsed = ReceivePartPurchaseBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [purchase] = await db
    .select()
    .from(partPurchasesTable)
    .where(
      and(
        eq(partPurchasesTable.id, params.data.id),
        eq(partPurchasesTable.dealerId, dealerId),
      ),
    );
  if (!purchase) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }
  if (purchase.status !== "ordered" && purchase.status !== "partially_received") {
    res.status(422).json({
      error: `Purchase is ${purchase.status} — nothing left to receive`,
    });
    return;
  }
  const remaining = purchase.quantity - purchase.qtyReceived;
  if (parsed.data.qtyReceived > remaining) {
    res.status(422).json({
      error: `Over-receipt: only ${remaining} unit(s) outstanding on this order`,
    });
    return;
  }
  const [part] = await db
    .select()
    .from(partsTable)
    .where(
      and(eq(partsTable.id, purchase.partId), eq(partsTable.dealerId, dealerId)),
    );
  if (!part) {
    res.status(404).json({ error: "Part not found" });
    return;
  }

  const received = parsed.data.qtyReceived;
  const newQtyReceived = purchase.qtyReceived + received;
  // Weighted-average cost: blend the on-hand value with the receipt value.
  const onHand = Math.max(part.stock, 0);
  const newCost =
    purchase.unitCost > 0 && onHand + received > 0
      ? Math.round(
          ((onHand * part.unitCost + received * purchase.unitCost) /
            (onHand + received)) *
            100,
        ) / 100
      : part.unitCost;

  const updated = await db.transaction(async (tx) => {
    const [lockedPurchase] = await tx.select().from(partPurchasesTable).where(and(
      eq(partPurchasesTable.id, purchase.id), eq(partPurchasesTable.dealerId, dealerId),
    )).for("update");
    if (!lockedPurchase || lockedPurchase.qtyReceived !== purchase.qtyReceived ||
        received > lockedPurchase.quantity - lockedPurchase.qtyReceived) {
      throw Object.assign(new Error("Purchase receipt changed; reload and retry"), { status: 409 });
    }
    await lockReceiptInventory(tx, dealerId, [part.id]);
    const [po] = await tx
      .update(partPurchasesTable)
      .set({
        qtyReceived: newQtyReceived,
        status: newQtyReceived >= purchase.quantity ? "received" : "partially_received",
      })
      .where(
        and(
          eq(partPurchasesTable.id, purchase.id),
          eq(partPurchasesTable.dealerId, dealerId),
        ),
      )
      .returning();
    await moveStock(tx, {
      dealerId, partId: part.id, type: "receipt", quantityDelta: received,
      unitCost: purchase.unitCost, referenceType: "part_purchase", referenceId: String(purchase.id),
      idempotencyKey: `part-purchase:${dealerId}:${purchase.id}:${newQtyReceived}`,
    });

    // Backorder resolution: fill waiting job-card lines oldest-first while
    // stock lasts, and release job cards that no longer wait on any part.
    const release = await releaseBackorders(
      tx,
      dealerId,
      part.id,
      onHand + received,
    );
    return {
      po,
      leftover: release.available,
      filled: release.filledLines,
      resumedClaims: release.resumedClaims,
    };
  });

  checkLowStockCrossing(part, part.stock, updated.leftover);
  // ERPNext: the received units are a Material Receipt; backordered job-card
  // lines filled by this receipt are Material Issues.
  enqueueStockEntrySync({
    dealerId,
    partId: part.id,
    qty: received,
    direction: "in",
    entityType: "part_purchase",
    entityId: purchase.id,
    remark: `AURA part purchase #${purchase.id} received (${part.sku})`,
    dedupeKey: `erp:se:pp:${dealerId}:${purchase.id}:${newQtyReceived}`,
  });
  syncFilledBackorderLines(dealerId, updated.filled);
  for (const claim of updated.resumedClaims) {
    coordinateCollisionClaim({
      ...claim,
      event: "resumed",
      eventKey: `resume:${claim.pausedSeconds}`,
    });
  }
  res.json(ReceivePartPurchaseResponse.parse(updated.po));
});

// ---------------------------------------------------------------------------
// Parts pricing settings (cost-plus markup used by bulk import)
// ---------------------------------------------------------------------------

router.get("/parts-settings", async (_req, res): Promise<void> => {
  const [dealer] = await db
    .select({ markupPercent: dealersTable.partsMarkupPercent })
    .from(dealersTable)
    .where(eq(dealersTable.id, activeDealerId(res)));
  res.json(
    GetPartsSettingsResponse.parse({
      markupPercent: dealer?.markupPercent ?? 25,
    }),
  );
});

router.patch("/parts-settings", async (req, res): Promise<void> => {
  const parsed = UpdatePartsSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [dealer] = await db
    .update(dealersTable)
    .set({ partsMarkupPercent: parsed.data.markupPercent })
    .where(eq(dealersTable.id, activeDealerId(res)))
    .returning({ markupPercent: dealersTable.partsMarkupPercent });
  res.json(UpdatePartsSettingsResponse.parse(dealer));
});

// ---------------------------------------------------------------------------
// Bulk parts import (FR-PI-01/02): CSV or XLSX master list, upsert by part
// number, dealer markup auto-fills missing sell prices.
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function handleUpload(
  req: Parameters<ReturnType<typeof upload.single>>[0],
  res: Parameters<ReturnType<typeof upload.single>>[1],
): Promise<boolean> {
  return new Promise((resolve) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        const status =
          (err as { code?: string }).code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({
          error:
            status === 413
              ? "File too large (max 10 MB)"
              : "Could not read the uploaded file",
        });
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/** Normalized header → canonical field. */
const PART_HEADER_MAP: Record<string, string> = {
  partnumber: "sku",
  partno: "sku",
  sku: "sku",
  number: "sku",
  description: "name",
  name: "name",
  partname: "name",
  category: "category",
  supplier: "supplier",
  vendor: "supplier",
  suppliername: "supplier",
  cost: "unitCost",
  unitcost: "unitCost",
  costprice: "unitCost",
  price: "unitPrice",
  sellprice: "unitPrice",
  unitprice: "unitPrice",
  sellingprice: "unitPrice",
  quantity: "stock",
  qty: "stock",
  stock: "stock",
  onhand: "stock",
  reorderlevel: "reorderLevel",
  reorder: "reorderLevel",
  minstock: "reorderLevel",
  mrq: "reorderLevel",
  location: "location",
  bin: "location",
  binlocation: "location",
};

const normalizeHeader = (h: string): string =>
  h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function excelCellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    if ("richText" in value)
      return value.richText.map((r) => r.text).join("");
    if ("text" in value) return String(value.text);
    if ("result" in value) return String(value.result ?? "");
    if (value instanceof Date) return value.toISOString();
  }
  return String(value).trim();
}

// Legacy URL delegates to the same durable preview/commit import API. The
// There is no second raw-stock import write path.
router.post("/parts/import", createPartsImport);

// Current parts inventory as Excel — same columns as the import template so
// the exported file can be edited and re-imported (round-trip updates).
router.get("/parts/export", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const rows = await db
    .select({
      sku: partsTable.sku,
      name: partsTable.name,
      category: partsTable.category,
      supplier: suppliersTable.name,
      unitCost: partsTable.unitCost,
      unitPrice: partsTable.unitPrice,
      stock: partsTable.stock,
      reorderLevel: partsTable.reorderLevel,
      location: partsTable.location,
      status: partsTable.status,
    })
    .from(partsTable)
    .leftJoin(
      suppliersTable,
      and(
        eq(partsTable.supplierId, suppliersTable.id),
        // Tenancy: constrain the joined table too, never trust the FK alone.
        eq(suppliersTable.dealerId, partsTable.dealerId),
      ),
    )
    .where(eq(partsTable.dealerId, dealerId))
    .orderBy(partsTable.sku);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Parts");
  const headers = [
    "Part Number",
    "Description",
    "Category",
    "Supplier",
    "Unit Cost",
    "Sell Price",
    "Quantity",
    "Reorder Level",
    "Bin Location",
    "Status",
  ];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const r of rows) {
    sheet.addRow([
      r.sku,
      r.name,
      r.category,
      r.supplier ?? "",
      r.unitCost,
      r.unitPrice,
      r.stock,
      r.reorderLevel,
      r.location ?? "",
      r.status,
    ]);
  }
  sheet.columns.forEach((col, i) => {
    col.width = Math.max(14, headers[i].length + 4);
  });
  const notes = workbook.addWorksheet("Notes");
  notes.addRow(["Edit and re-import this file to bulk-update parts."]);
  notes.addRow(["Existing parts are matched by Part Number; the Status column is ignored on import."]);
  const buffer = await workbook.xlsx.writeBuffer();
  res
    .setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    .setHeader(
      "Content-Disposition",
      'attachment; filename="aura-parts-inventory.xlsx"',
    )
    .send(Buffer.from(buffer));
});

const PART_TEMPLATE_COLUMNS: { header: string; example: string | number }[] = [
  { header: "Part Number", example: "BRK-PAD-BMW-X5" },
  { header: "Description", example: "Front brake pad set" },
  { header: "Category", example: "Brakes" },
  { header: "Supplier", example: "Bosch Guyana Ltd" },
  { header: "Unit Cost", example: 8500 },
  { header: "Sell Price", example: "" },
  { header: "Quantity", example: 10 },
  { header: "Reorder Level", example: 3 },
  { header: "Bin Location", example: "A-04" },
];

router.get("/parts/import/template", async (_req, res): Promise<void> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Parts");
  sheet.addRow(PART_TEMPLATE_COLUMNS.map((c) => c.header));
  sheet.getRow(1).font = { bold: true };
  sheet.addRow(PART_TEMPLATE_COLUMNS.map((c) => c.example));
  sheet.columns.forEach((col, i) => {
    col.width = Math.max(14, PART_TEMPLATE_COLUMNS[i].header.length + 4);
  });
  const notes = workbook.addWorksheet("Notes");
  notes.addRow(["Parts import notes"]);
  notes.addRow(["Required columns: Part Number, Description."]);
  notes.addRow([
    "Sell Price is optional — when blank it is derived from Unit Cost using your dealership's markup percentage.",
  ]);
  notes.addRow(["Existing parts are updated by Part Number; new ones are created."]);
  notes.addRow(["Unknown suppliers are created automatically by name."]);
  notes.addRow(["CSV files with the same headers are accepted too."]);
  const buffer = await workbook.xlsx.writeBuffer();
  res
    .setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    .setHeader(
      "Content-Disposition",
      'attachment; filename="aura-parts-import-template.xlsx"',
    )
    .send(Buffer.from(buffer));
});

// ---------------------------------------------------------------------------
// Formal purchase orders (FR-PI-06/07): multi-line POs with a
// draft → ordered → partially_received → received lifecycle. Receiving
// increments stock, weighted-averages cost and releases backordered job lines.
// ---------------------------------------------------------------------------

async function loadPurchaseOrder(dealerId: number, id: number) {
  const [order] = await db
    .select()
    .from(purchaseOrdersTable)
    .where(
      and(
        eq(purchaseOrdersTable.id, id),
        eq(purchaseOrdersTable.dealerId, dealerId),
      ),
    );
  if (!order) return null;
  const lines = await db
    .select()
    .from(purchaseOrderLinesTable)
    .where(
      and(
        eq(purchaseOrderLinesTable.purchaseOrderId, id),
        eq(purchaseOrderLinesTable.dealerId, dealerId),
      ),
    )
    .orderBy(purchaseOrderLinesTable.id);
  const contexts = await db
    .select({
      purchaseOrderLineId: partRequisitionPoAllocationsTable.purchaseOrderLineId,
      requisitionId: partRequisitionPoAllocationsTable.requisitionId,
      requisitionLineId: partRequisitionPoAllocationsTable.requisitionLineId,
      source: partRequisitionLinesTable.source,
      jobCardId: partRequisitionsTable.jobCardId,
      serviceOrderId: partRequisitionsTable.serviceOrderId,
      quantityOrdered: partRequisitionPoAllocationsTable.quantityOrdered,
      quantityReceived: partRequisitionPoAllocationsTable.quantityReceived,
    })
    .from(partRequisitionPoAllocationsTable)
    .innerJoin(
      partRequisitionLinesTable,
      and(
        eq(partRequisitionLinesTable.id, partRequisitionPoAllocationsTable.requisitionLineId),
        eq(partRequisitionLinesTable.dealerId, partRequisitionPoAllocationsTable.dealerId),
      ),
    )
    .innerJoin(
      partRequisitionsTable,
      and(
        eq(partRequisitionsTable.id, partRequisitionPoAllocationsTable.requisitionId),
        eq(partRequisitionsTable.dealerId, partRequisitionPoAllocationsTable.dealerId),
      ),
    )
    .where(
      and(
        eq(partRequisitionPoAllocationsTable.dealerId, dealerId),
        eq(partRequisitionPoAllocationsTable.purchaseOrderId, id),
      ),
    );
  const contextByLine = new Map(contexts.map((context) => [context.purchaseOrderLineId, context]));
  return {
    ...order,
    lines: lines.map((line) => ({
      ...line,
      requisitionContext: contextByLine.get(line.id) ?? null,
    })),
  };
}

router.get("/purchase-orders", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const orders = await db
    .select()
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.dealerId, dealerId))
    .orderBy(desc(purchaseOrdersTable.createdAt));
  const ids = orders.map((o) => o.id);
  const lines = ids.length
    ? await db
        .select()
        .from(purchaseOrderLinesTable)
        .where(
          and(
            eq(purchaseOrderLinesTable.dealerId, dealerId),
            inArray(purchaseOrderLinesTable.purchaseOrderId, ids),
          ),
        )
        .orderBy(purchaseOrderLinesTable.id)
    : [];
  const byOrder = new Map<number, typeof lines>();
  for (const l of lines) {
    const list = byOrder.get(l.purchaseOrderId) ?? [];
    list.push(l);
    byOrder.set(l.purchaseOrderId, list);
  }
  const contexts = ids.length
    ? await db
        .select({
          purchaseOrderId: partRequisitionPoAllocationsTable.purchaseOrderId,
          purchaseOrderLineId: partRequisitionPoAllocationsTable.purchaseOrderLineId,
          requisitionId: partRequisitionPoAllocationsTable.requisitionId,
          requisitionLineId: partRequisitionPoAllocationsTable.requisitionLineId,
          source: partRequisitionLinesTable.source,
          jobCardId: partRequisitionsTable.jobCardId,
          serviceOrderId: partRequisitionsTable.serviceOrderId,
          quantityOrdered: partRequisitionPoAllocationsTable.quantityOrdered,
          quantityReceived: partRequisitionPoAllocationsTable.quantityReceived,
        })
        .from(partRequisitionPoAllocationsTable)
        .innerJoin(
          partRequisitionLinesTable,
          and(
            eq(partRequisitionLinesTable.id, partRequisitionPoAllocationsTable.requisitionLineId),
            eq(partRequisitionLinesTable.dealerId, partRequisitionPoAllocationsTable.dealerId),
          ),
        )
        .innerJoin(
          partRequisitionsTable,
          and(
            eq(partRequisitionsTable.id, partRequisitionPoAllocationsTable.requisitionId),
            eq(partRequisitionsTable.dealerId, partRequisitionPoAllocationsTable.dealerId),
          ),
        )
        .where(
          and(
            eq(partRequisitionPoAllocationsTable.dealerId, dealerId),
            inArray(partRequisitionPoAllocationsTable.purchaseOrderId, ids),
          ),
        )
    : [];
  const contextByLine = new Map(contexts.map((context) => [context.purchaseOrderLineId, context]));
  res.json(
    ListPurchaseOrdersResponse.parse(
      orders.map((o) => ({
        ...o,
        lines: (byOrder.get(o.id) ?? []).map((line) => ({
          ...line,
          requisitionContext: contextByLine.get(line.id) ?? null,
        })),
      })),
    ),
  );
});

router.post("/purchase-orders", async (req, res): Promise<void> => {
  const parsed = CreatePurchaseOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  if (parsed.data.supplierId != null) {
    const [supplier] = await db
      .select({ id: suppliersTable.id })
      .from(suppliersTable)
      .where(
        and(
          eq(suppliersTable.id, parsed.data.supplierId),
          eq(suppliersTable.dealerId, dealerId),
        ),
      );
    if (!supplier) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }
  }
  const partIds = [...new Set(parsed.data.lines.map((l) => l.partId))];
  const parts = await db
    .select()
    .from(partsTable)
    .where(
      and(eq(partsTable.dealerId, dealerId), inArray(partsTable.id, partIds)),
    );
  const partById = new Map(parts.map((p) => [p.id, p]));
  const missing = partIds.filter((id) => !partById.has(id));
  if (missing.length > 0) {
    res.status(404).json({ error: `Part #${missing[0]} not found` });
    return;
  }
  let pricedLines;
  try {
    pricedLines = parsed.data.lines.map(line => {
      const part = partById.get(line.partId)!;
      const unitCost = line.unitCost ?? part.unitCost;
      return { ...line, unitCost, partName: part.name,
        landedCostComponents: line.landedCostComponents ?? {},
        landedUnitCost: calculateLandedUnitCost(unitCost, line.quantity, line.landedCostComponents) };
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  const order = await db.transaction(async (tx) => {
    if (parsed.data.locationId != null) await validateLocation(tx, dealerId, parsed.data.locationId);
    const [po] = await tx
      .insert(purchaseOrdersTable)
      .values({
        dealerId,
        supplierId: parsed.data.supplierId ?? null,
        source: "manual",
        locationId: parsed.data.locationId ?? null,
        createdBy: res.locals.user?.id ?? null,
        needsSupplier: parsed.data.supplierId == null,
        status: parsed.data.status ?? "draft",
        expectedDate:
          parsed.data.expectedDate instanceof Date
            ? parsed.data.expectedDate.toISOString().slice(0, 10)
            : (parsed.data.expectedDate ?? null),
        reference: parsed.data.reference ?? null,
        notes: parsed.data.notes ?? null,
      })
      .returning();
    await tx.insert(purchaseOrderLinesTable).values(
      pricedLines.map((l) => {
        const part = partById.get(l.partId)!;
        return {
          dealerId,
          purchaseOrderId: po.id,
          partId: l.partId,
          partName: part.name,
          quantity: l.quantity,
          unitCost: l.unitCost ?? part.unitCost,
          landedCostComponents: l.landedCostComponents,
          landedUnitCost: l.landedUnitCost,
          jobCardId: l.jobCardId ?? null,
        };
      }),
    );
    return po;
  });
  enqueuePurchaseOrderSync(dealerId, order.id, "insert");
  res
    .status(201)
    .json(CreatePurchaseOrderResponse.parse(await loadPurchaseOrder(dealerId, order.id)));
});

router.patch("/purchase-orders/:id", async (req, res): Promise<void> => {
  const params = UpdatePurchaseOrderParams.safeParse(req.params);
  const parsed = UpdatePurchaseOrderBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const [order] = await db
    .select()
    .from(purchaseOrdersTable)
    .where(
      and(
        eq(purchaseOrdersTable.id, params.data.id),
        eq(purchaseOrdersTable.dealerId, dealerId),
      ),
    );
  if (!order) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }
  if (parsed.data.status === "ordered" && order.status !== "draft") {
    res.status(422).json({ error: `Only a draft PO can be placed — this one is ${order.status}` });
    return;
  }
  if (
    parsed.data.status === "cancelled" &&
    order.status !== "draft" &&
    order.status !== "ordered"
  ) {
    res.status(422).json({
      error: `A ${order.status} PO cannot be cancelled — goods were already received`,
    });
    return;
  }
  await db
    .update(purchaseOrdersTable)
    .set({
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.expectedDate !== undefined
        ? {
            expectedDate:
              parsed.data.expectedDate instanceof Date
                ? parsed.data.expectedDate.toISOString().slice(0, 10)
                : (parsed.data.expectedDate ?? null),
          }
        : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    })
    .where(
      and(
        eq(purchaseOrdersTable.id, order.id),
        eq(purchaseOrdersTable.dealerId, dealerId),
      ),
    );
  // Status transitions (place / cancel) must reach the ERPNext PO too.
  if (parsed.data.status && parsed.data.status !== order.status) {
    enqueuePurchaseOrderSync(dealerId, order.id, "update");
  }
  res.json(UpdatePurchaseOrderResponse.parse(await loadPurchaseOrder(dealerId, order.id)));
});

router.post("/purchase-orders/:id/receive", async (req, res): Promise<void> => {
  const params = ReceivePurchaseOrderParams.safeParse(req.params);
  const parsed = ReceivePurchaseOrderBody.safeParse(req.body ?? {});
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const dealerId = activeDealerId(res);
  const expectedObjectPrefix = `/objects/uploads/dealer-${dealerId}/`;
  if (
    parsed.data.documents.some(
      (document) => !document.objectPath.startsWith(expectedObjectPrefix),
    )
  ) {
    res.status(422).json({ error: "Every receipt document must belong to the active dealership" });
    return;
  }
  const order = await loadPurchaseOrder(dealerId, params.data.id);
  if (!order) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }
  // Explicit-line retries can be recognized before outstanding-quantity
  // validation (which would otherwise reject a completed PO as over-received).
  if (parsed.data.lines && parsed.data.lines.length > 0) {
    const replayFingerprint = JSON.stringify({
      lines: parsed.data.lines.map((line) => [line.lineId, line.qty]).sort(([a], [b]) => a - b),
      receivedAt: parsed.data.receivedAt,
      deliveryNoteNumber: parsed.data.deliveryNoteNumber.trim(),
      supplierInvoiceNumber: parsed.data.supplierInvoiceNumber?.trim() || null,
      warehouseLocation: parsed.data.warehouseLocation.trim(),
      condition: parsed.data.condition,
      notes: parsed.data.notes?.trim() || null,
      documents: parsed.data.documents,
    });
    const [prior] = await db.select({ fingerprint: purchaseOrderReceiptsTable.requestFingerprint })
      .from(purchaseOrderReceiptsTable)
      .where(and(
        eq(purchaseOrderReceiptsTable.dealerId, dealerId),
        eq(purchaseOrderReceiptsTable.purchaseOrderId, order.id),
        eq(purchaseOrderReceiptsTable.idempotencyKey, parsed.data.idempotencyKey),
      ));
    if (prior) {
      if (prior.fingerprint !== replayFingerprint) {
        res.status(409).json({ error: "Idempotency key was already used with different receipt quantities" });
        return;
      }
      res.json(ReceivePurchaseOrderResponse.parse(await loadPurchaseOrder(dealerId, params.data.id)));
      return;
    }
  }
  // Requested receipt per line — default: everything outstanding.
  const requested = new Map<number, number>();
  if (parsed.data.lines && parsed.data.lines.length > 0) {
    for (const l of parsed.data.lines) {
      const line = order.lines.find((x) => x.id === l.lineId);
      if (!line) {
        res.status(404).json({ error: `PO line #${l.lineId} not found on this order` });
        return;
      }
      const outstanding = line.quantity - line.qtyReceived;
      if (l.qty > outstanding) {
        res.status(422).json({
          error: `Over-receipt on ${line.partName}: only ${outstanding} unit(s) outstanding`,
        });
        return;
      }
      requested.set(line.id, l.qty);
    }
  } else {
    for (const line of order.lines) {
      const outstanding = line.quantity - line.qtyReceived;
      if (outstanding > 0) requested.set(line.id, outstanding);
    }
  }
  if (requested.size === 0) {
    res.status(422).json({ error: "Nothing outstanding to receive on this order" });
    return;
  }

  const lowStockChecks: { part: Part; prevStock: number; leftover: number }[] = [];
  const filledBackorderLines: BackorderRelease["filledLines"] = [];
  const resumedCollisionClaims: BackorderRelease["resumedClaims"] = [];
  const receivedForErpnext: {
    partId: number;
    qty: number;
    rate: number;
    cumulative: number;
    lineId: number;
  }[] = [];
  const receiptFingerprint = JSON.stringify({
    lines: [...requested.entries()].sort(([a], [b]) => a - b),
    receivedAt: parsed.data.receivedAt,
    deliveryNoteNumber: parsed.data.deliveryNoteNumber.trim(),
    supplierInvoiceNumber: parsed.data.supplierInvoiceNumber?.trim() || null,
    warehouseLocation: parsed.data.warehouseLocation.trim(),
    condition: parsed.data.condition,
    notes: parsed.data.notes?.trim() || null,
    documents: parsed.data.documents,
  });
  // Idempotent replay is accepted even after the receipt changed the PO to
  // received. Check it before lifecycle/outstanding validation so retries do
  // not look like attempted duplicate stock movement.
  const [priorReceipt] = await db.select({
    fingerprint: purchaseOrderReceiptsTable.requestFingerprint,
  }).from(purchaseOrderReceiptsTable).where(and(
    eq(purchaseOrderReceiptsTable.dealerId, dealerId),
    eq(purchaseOrderReceiptsTable.purchaseOrderId, order.id),
    eq(purchaseOrderReceiptsTable.idempotencyKey, parsed.data.idempotencyKey),
  ));
  if (priorReceipt) {
    if (priorReceipt.fingerprint !== receiptFingerprint) {
      res.status(409).json({ error: "Idempotency key was already used with different receipt quantities" });
      return;
    }
    res.json(ReceivePurchaseOrderResponse.parse(await loadPurchaseOrder(dealerId, params.data.id)));
    return;
  }
  if (order.status !== "ordered" && order.status !== "partially_received") {
    res.status(422).json({
      error: `PO is ${order.status} — ${order.status === "draft" ? "place the order first" : "nothing left to receive"}`,
    });
    return;
  }
  let receiptReplay = false;
  try {
    await db.transaction(async (tx) => {
    const [receiptClaim] = await tx
      .insert(purchaseOrderReceiptsTable)
      .values({
        dealerId,
        purchaseOrderId: order.id,
        idempotencyKey: parsed.data.idempotencyKey,
        requestFingerprint: receiptFingerprint,
        receivedAt: parsed.data.receivedAt,
        receivedByUserId: res.locals.user?.id ?? null,
        receivedByName: res.locals.user?.name ?? res.locals.user?.email ?? "Parts",
        deliveryNoteNumber: parsed.data.deliveryNoteNumber.trim(),
        supplierInvoiceNumber: parsed.data.supplierInvoiceNumber?.trim() || null,
        warehouseLocation: parsed.data.warehouseLocation.trim(),
        condition: parsed.data.condition,
        notes: parsed.data.notes?.trim() || null,
        documents: parsed.data.documents,
      })
      .onConflictDoNothing({
        target: [
          purchaseOrderReceiptsTable.dealerId,
          purchaseOrderReceiptsTable.purchaseOrderId,
          purchaseOrderReceiptsTable.idempotencyKey,
        ],
      })
      .returning({ id: purchaseOrderReceiptsTable.id });
    if (!receiptClaim) {
      const [prior] = await tx
        .select({ fingerprint: purchaseOrderReceiptsTable.requestFingerprint })
        .from(purchaseOrderReceiptsTable)
        .where(
          and(
            eq(purchaseOrderReceiptsTable.dealerId, dealerId),
            eq(purchaseOrderReceiptsTable.purchaseOrderId, order.id),
            eq(purchaseOrderReceiptsTable.idempotencyKey, parsed.data.idempotencyKey),
          ),
        );
      if (prior?.fingerprint !== receiptFingerprint) {
        throw Object.assign(
          new Error("Idempotency key was already used with different receipt quantities"),
          { status: 409 },
        );
      }
      receiptReplay = true;
      return;
    }
    await tx.insert(purchaseOrderReceiptLinesTable).values(
      [...requested.entries()].map(([purchaseOrderLineId, quantity]) => ({
        dealerId,
        receiptId: receiptClaim.id,
        purchaseOrderLineId,
        quantity,
      })),
    );
    await lockReceiptInventory(tx, dealerId, order.lines.flatMap(l =>
      requested.has(l.id) && l.partId != null ? [l.partId] : []));
    for (const line of order.lines) {
      const qty = requested.get(line.id);
      if (!qty) continue;
      const [lockedLine] = await tx
        .select()
        .from(purchaseOrderLinesTable)
        .where(
          and(
            eq(purchaseOrderLinesTable.id, line.id),
            eq(purchaseOrderLinesTable.purchaseOrderId, order.id),
            eq(purchaseOrderLinesTable.dealerId, dealerId),
          ),
        )
        .for("update");
      if (!lockedLine) {
        throw Object.assign(new Error(`PO line #${line.id} not found`), { status: 404 });
      }
      if (qty > lockedLine.quantity - lockedLine.qtyReceived) {
        throw Object.assign(
          new Error(`Over-receipt on ${lockedLine.partName}: only ${lockedLine.quantity - lockedLine.qtyReceived} unit(s) outstanding`),
          { status: 422 },
        );
      }
      const [allocation] = await tx
        .select()
        .from(partRequisitionPoAllocationsTable)
        .where(
          and(
            eq(partRequisitionPoAllocationsTable.dealerId, dealerId),
            eq(partRequisitionPoAllocationsTable.purchaseOrderLineId, lockedLine.id),
          ),
        )
        .for("update");
      if (lockedLine.source === "EXTERNAL") {
        if (!allocation) {
          throw Object.assign(new Error(`External PO line #${lockedLine.id} has no requisition allocation`), { status: 409 });
        }
        const [reqLine] = await tx
          .select()
          .from(partRequisitionLinesTable)
          .where(
            and(
              eq(partRequisitionLinesTable.id, allocation.requisitionLineId),
              eq(partRequisitionLinesTable.dealerId, dealerId),
            ),
          )
          .for("update");
        const [requisition] = await tx
          .select()
          .from(partRequisitionsTable)
          .where(
            and(
              eq(partRequisitionsTable.id, allocation.requisitionId),
              eq(partRequisitionsTable.dealerId, dealerId),
            ),
          )
          .for("update");
        if (!reqLine || !requisition) {
          throw Object.assign(new Error("Linked requisition was not found"), { status: 409 });
        }
        if (requisition.jobCardId == null) {
          throw Object.assign(
            new Error("Standalone inventory requisitions cannot contain external parts"),
            { status: 409 },
          );
        }
        const [jobCard] = await tx.select().from(jobCardsTable).where(and(
          eq(jobCardsTable.id, requisition.jobCardId),
          eq(jobCardsTable.dealerId, dealerId),
        )).for("update");
        if (!jobCard) {
          throw Object.assign(new Error("Linked job card was not found"), { status: 409 });
        }
        const [issuedInvoice] = await tx.select({ id: serviceInvoicesTable.id })
          .from(serviceInvoicesTable)
          .where(and(
            eq(serviceInvoicesTable.jobCardId, jobCard.id),
            eq(serviceInvoicesTable.dealerId, dealerId),
          ))
          .for("update");
        if (issuedInvoice) {
          throw Object.assign(
            new Error(`Job card #${jobCard.id} is already invoiced; receive this external part through a linked financial adjustment instead`),
            { status: 422 },
          );
        }
        const [fulfillment] = await tx
          .insert(partRequisitionFulfillmentsTable)
          .values({
            dealerId,
            requisitionId: requisition.id,
            lineId: reqLine.id,
            idempotencyKey: `po-receipt:${order.id}:${parsed.data.idempotencyKey}`,
            quantity: qty,
            fulfilledByUserId: res.locals.user?.id ?? null,
            fulfilledByName: res.locals.user?.name ?? res.locals.user?.email ?? "Parts",
          })
          .returning();
        let externalId = allocation.externalJobCardPartId;
        if (externalId == null) {
          const [external] = await tx
            .insert(externalJobCardPartsTable)
            .values({
              dealerId,
              jobCardId: requisition.jobCardId,
              requisitionLineId: reqLine.id,
              fulfillmentId: fulfillment.id,
              description: `External part — ${reqLine.descriptionSnapshot}`,
              supplierSnapshot: reqLine.supplierSnapshot,
              quantity: qty,
              unitCost: lockedLine.unitCost,
              unitPrice: reqLine.unitPrice,
              taxCost: reqLine.taxCost,
              freightCost: reqLine.freightCost,
            })
            .returning({ id: externalJobCardPartsTable.id });
          externalId = external.id;
        } else {
          const [updatedExternal] = await tx
            .update(externalJobCardPartsTable)
            .set({ quantity: sql`${externalJobCardPartsTable.quantity} + ${qty}` })
            .where(
              and(
                eq(externalJobCardPartsTable.id, externalId),
                eq(externalJobCardPartsTable.dealerId, dealerId),
                eq(externalJobCardPartsTable.jobCardId, jobCard.id),
                eq(externalJobCardPartsTable.requisitionLineId, reqLine.id),
              ),
            )
            .returning({ id: externalJobCardPartsTable.id });
          if (!updatedExternal) {
            throw Object.assign(new Error("External-part allocation does not match its job card or requisition line"), { status: 409 });
          }
        }
        // Receipt materializes a customer-billable external line. It therefore
        // always creates a new estimate version and invalidates any approval
        // atomically with fulfillment — an old customer link can never approve
        // an amount that did not include this received quantity.
        const breakdown = await buildServiceEstimateBreakdown(tx, jobCard);
        await tx.update(jobCardsTable).set({
          quoteTotal: breakdown.total,
          estimateVersion: sql`${jobCardsTable.estimateVersion} + 1`,
          estimateApprovedVersion: null,
          estimateApprovalAt: null,
          estimateApprovalEvidence: null,
          quoteApprovedAt: null,
          ...clearEstimateStaffAcknowledgement,
        }).where(and(eq(jobCardsTable.id, jobCard.id), eq(jobCardsTable.dealerId, dealerId)));
        await invalidateServiceEstimate(tx, dealerId, jobCard.id);
        await tx
          .update(partRequisitionFulfillmentsTable)
          .set({ externalJobCardPartId: externalId })
          .where(eq(partRequisitionFulfillmentsTable.id, fulfillment.id));
        await tx
          .update(partRequisitionLinesTable)
          .set({ fulfilledQuantity: reqLine.fulfilledQuantity + qty })
          .where(
            and(
              eq(partRequisitionLinesTable.id, reqLine.id),
              eq(partRequisitionLinesTable.dealerId, dealerId),
            ),
          );
        await tx
          .update(purchaseOrderLinesTable)
          .set({ qtyReceived: lockedLine.qtyReceived + qty })
          .where(eq(purchaseOrderLinesTable.id, lockedLine.id));
        await tx
          .update(partRequisitionPoAllocationsTable)
          .set({
            quantityReceived: allocation.quantityReceived + qty,
            externalJobCardPartId: externalId,
            updatedAt: new Date(),
          })
          .where(eq(partRequisitionPoAllocationsTable.id, allocation.id));
        continue;
      }
      if (lockedLine.partId == null) {
        throw Object.assign(new Error(`Internal PO line #${lockedLine.id} has no inventory part`), { status: 409 });
      }
      const [part] = await tx
        .select()
        .from(partsTable)
        .where(
          and(eq(partsTable.id, lockedLine.partId), eq(partsTable.dealerId, dealerId)),
        );
      if (!part) continue;
      // Weighted-average cost: blend on-hand value with the receipt value.
      const onHand = Math.max(part.stock, 0);
      const newCost =
        lockedLine.unitCost > 0 && onHand + qty > 0
          ? Math.round(
              ((onHand * part.unitCost + qty * lockedLine.unitCost) / (onHand + qty)) *
                100,
            ) / 100
          : part.unitCost;
      await tx
        .update(purchaseOrderLinesTable)
        .set({ qtyReceived: lockedLine.qtyReceived + qty })
        .where(eq(purchaseOrderLinesTable.id, lockedLine.id));
      if (allocation) {
        await tx
          .update(partRequisitionPoAllocationsTable)
          .set({
            quantityReceived: allocation.quantityReceived + qty,
            updatedAt: new Date(),
          })
          .where(eq(partRequisitionPoAllocationsTable.id, allocation.id));
        const [restockRequisition] = await tx
          .select({ jobCardId: partRequisitionsTable.jobCardId })
          .from(partRequisitionsTable)
          .where(
            and(
              eq(partRequisitionsTable.id, allocation.requisitionId),
              eq(partRequisitionsTable.dealerId, dealerId),
            ),
          );
        if (restockRequisition?.jobCardId == null) {
          const [restockLine] = await tx
            .select({ fulfilledQuantity: partRequisitionLinesTable.fulfilledQuantity })
            .from(partRequisitionLinesTable)
            .where(
              and(
                eq(partRequisitionLinesTable.id, allocation.requisitionLineId),
                eq(partRequisitionLinesTable.dealerId, dealerId),
              ),
            )
            .for("update");
          if (restockLine) {
            await tx
              .update(partRequisitionLinesTable)
              .set({ fulfilledQuantity: restockLine.fulfilledQuantity + qty })
              .where(eq(partRequisitionLinesTable.id, allocation.requisitionLineId));
          }
        }
      }
      await moveStock(tx, {
        dealerId, partId: part.id, type: "receipt", quantityDelta: qty,
        locationId: order.locationId ?? undefined,
        unitCost: purchaseOrderReceiptUnitCost(lockedLine),
        referenceType: "purchase_order_receipt", referenceId: String(receiptClaim.id),
        idempotencyKey: `po-receipt:${dealerId}:${receiptClaim.id}:${lockedLine.id}`,
      });
      // Fill backordered job-card lines — this is what links received parts
      // back to their originating job cards and takes them off hold.
      const release = await releaseBackorders(tx, dealerId, part.id, onHand + qty);
      lowStockChecks.push({
        part,
        prevStock: part.stock,
        leftover: release.available,
      });
      filledBackorderLines.push(...release.filledLines);
      resumedCollisionClaims.push(...release.resumedClaims);
      receivedForErpnext.push({
        partId: part.id,
        qty,
        rate: lockedLine.unitCost,
        cumulative: lockedLine.qtyReceived + qty,
        lineId: lockedLine.id,
      });
    }
    await postPartsReceipt(tx, { dealerId, purchaseOrderId: order.id, actorId: res.locals.user?.id });
    const fresh = await tx
      .select()
      .from(purchaseOrderLinesTable)
      .where(
        and(
          eq(purchaseOrderLinesTable.purchaseOrderId, order.id),
          eq(purchaseOrderLinesTable.dealerId, dealerId),
        ),
      );
    const complete = fresh.every((l) => l.qtyReceived >= l.quantity);
    await tx
      .update(purchaseOrdersTable)
      .set({ status: complete ? "received" : "partially_received" })
      .where(
        and(
          eq(purchaseOrdersTable.id, order.id),
          eq(purchaseOrdersTable.dealerId, dealerId),
        ),
      );
    const touchedRequisitions = [
      ...new Set(
        order.lines
          .map((line) => line.requisitionContext?.requisitionId)
          .filter((id): id is number => id != null),
      ),
    ];
    for (const requisitionId of touchedRequisitions) {
      const reqLines = await tx
        .select({
          quantity: partRequisitionLinesTable.quantity,
          fulfilledQuantity: partRequisitionLinesTable.fulfilledQuantity,
        })
        .from(partRequisitionLinesTable)
        .where(
          and(
            eq(partRequisitionLinesTable.dealerId, dealerId),
            eq(partRequisitionLinesTable.requisitionId, requisitionId),
          ),
        );
      const any = reqLines.some((line) => line.fulfilledQuantity > 0);
      const completeFulfillment =
        reqLines.length > 0 &&
        reqLines.every((line) => line.fulfilledQuantity >= line.quantity);
      if (any) {
        await tx
          .update(partRequisitionsTable)
          .set({
            status: completeFulfillment ? "fulfilled" : "partially_fulfilled",
            fulfilledAt: completeFulfillment ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(partRequisitionsTable.id, requisitionId),
              eq(partRequisitionsTable.dealerId, dealerId),
            ),
          );
      }
    }
    });
  } catch (error) {
    const failure = error as Error & { status?: number };
    if (failure.status) {
      res.status(failure.status).json({ error: failure.message });
      return;
    }
    throw error;
  }
  if (receiptReplay) {
    res.json(ReceivePurchaseOrderResponse.parse(await loadPurchaseOrder(dealerId, params.data.id)));
    return;
  }
  for (const c of lowStockChecks)
    checkLowStockCrossing(c.part, c.prevStock, c.leftover);

  // ERPNext: post a Purchase Receipt with the received line quantities (the
  // receipt moves ERPNext stock, so no separate Stock Entry is posted), plus
  // Material Issues for backordered job-card lines this receipt filled.
  enqueuePurchaseReceiptSync({
    dealerId,
    purchaseOrderId: order.id,
    lines: receivedForErpnext.map((r) => ({
      partId: r.partId,
      qty: r.qty,
      rate: r.rate,
    })),
    // Cumulative per-line totals make each distinct receipt event unique,
    // even when the same quantities are received twice on purpose.
    dedupeKey: `erp:pr:${dealerId}:${order.id}:${receivedForErpnext
      .map((r) => `${r.lineId}-${r.cumulative}`)
      .join(",")}`,
  });
  syncFilledBackorderLines(dealerId, filledBackorderLines);
  for (const claim of resumedCollisionClaims) {
    coordinateCollisionClaim({
      ...claim,
      event: "resumed",
      eventKey: `resume:${claim.pausedSeconds}`,
    });
  }

  res.json(ReceivePurchaseOrderResponse.parse(await loadPurchaseOrder(dealerId, params.data.id)));
});

export default router;
