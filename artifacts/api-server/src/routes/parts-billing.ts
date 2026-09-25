import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, jobCardsTable, serviceInvoicesTable, auditLogsTable, invoicesTable, customersTable, serviceOrdersTable } from "@workspace/db";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import { loadPartsEstimateCharges } from "../lib/parts-estimate-charges";
import { decimalMoney, moneyMinor } from "../lib/parts-billing-money";
import { buildServiceEstimateBreakdown } from "../lib/service-estimate-breakdown";
import { clearEstimateStaffAcknowledgement } from "../lib/service-estimate-gate";
import { invalidateServiceEstimate } from "../lib/service-estimate-invalidation";
import { existingPartsInvoice, partsBillingPreview, partsBillingFingerprint, generatePartsCustomerInvoice, type PartsBillingSource } from "../lib/parts-customer-billing";
import { queueInvoiceSync } from "../lib/erpnext/entities";
import { buildInvoicePdfFromPayload } from "../lib/document-pdfs";
import { getDealerPdfBranding } from "../lib/dealer-branding";
import { dealerTimezone } from "../lib/timezone";
import { enqueueEmail } from "../lib/email";

const router: IRouter = Router();
function canBill(user: any) {
  return user && (hasPermission(user, "parts", "create") || hasPermission(user, "service", "edit") || hasPermission(user, "finance", "create"));
}
function sourceParams(req: any) {
  const type = req.params.type as PartsBillingSource;
  const id = Number(req.params.id);
  if (!["requisition", "special_order"].includes(type) || !Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("Invalid billing source"), { status: 400 });
  return { type, id };
}
function invoicePayload(invoice: typeof invoicesTable.$inferSelect) {
  return { invoiceNumber: invoice.invoiceNumber, customerName: invoice.customerName,
    amount: String(invoice.amount), total: `GY$${invoice.amount.toFixed(2)}`, kind: invoice.kind,
    description: invoice.description ?? "", dueDate: invoice.dueDate ?? "", issuedAt: invoice.createdAt.toISOString(),
    exchangeRate: String(invoice.exchangeRate ?? 1),
    taxLines: JSON.stringify(invoice.taxLines.map(t => ({ ...t, label: t.name }))),
  };
}
async function scopedPartsInvoice(dealerId: number, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const source = await db.execute(sql`SELECT invoice_id FROM parts_invoice_sources WHERE dealer_id=${dealerId} AND invoice_id=${id}`);
  if (!source.rows.length) return null;
  const [invoice] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, id), eq(invoicesTable.dealerId, dealerId)));
  return invoice ?? null;
}

router.get("/parts/billing/:type/:id", async (req, res): Promise<void> => {
  if (!canBill(res.locals.user)) { res.status(403).json({ error: "Customer invoice permission required" }); return; }
  try {
    const dealerId = activeDealerId(res);
    const { type, id } = sourceParams(req);
    const invoice = await existingPartsInvoice(db, dealerId, type, id);
    if (invoice) { res.json({ invoice }); return; }
    const preview = await partsBillingPreview(db, dealerId, type, id);
    const deposits = await db.execute(sql`SELECT i.id, i.invoice_number AS "invoiceNumber", round(sum(p.amount)::numeric,2) AS available
      FROM invoices i JOIN payments p ON p.invoice_id=i.id AND p.dealer_id=i.dealer_id
      WHERE i.dealer_id=${dealerId} AND i.customer_id=${preview.customer.id} AND i.kind='reservation'
        AND i.status <> 'void' AND i.deal_id IS NULL AND i.application_id IS NULL
        AND coalesce(i.description,'') !~* '\\(booking #[0-9]+\\)'
      GROUP BY i.id HAVING sum(p.amount)>0`);
    res.json({ ...preview, customer: { id: preview.customer.id, name: preview.customer.name }, invoice: null,
      previewFingerprint: partsBillingFingerprint(preview), deposits: deposits.rows, canApplyDeposit: hasPermission(res.locals.user!, "finance", "edit") });
  } catch (error) { res.status((error as any).status ?? 500).json({ error: (error as Error).message }); }
});

router.post("/parts/billing/:type/:id", async (req, res): Promise<void> => {
  if (!canBill(res.locals.user)) { res.status(403).json({ error: "Customer invoice permission required" }); return; }
  try {
    const { type, id } = sourceParams(req);
    if (typeof req.body?.previewFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(req.body.previewFingerprint)) {
      res.status(400).json({ error: "Review the current invoice preview before generating" }); return;
    }
    let deposit: { invoiceId: number; amount: number } | undefined;
    if (req.body?.depositInvoiceId != null) {
      if (!hasPermission(res.locals.user!, "finance", "edit")) { res.status(403).json({ error: "Finance edit permission is required to authorize deposit credit" }); return; }
      const invoiceId = Number(req.body.depositInvoiceId);
      if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) { res.status(400).json({ error: "Invalid deposit invoice" }); return; }
      try { deposit = { invoiceId, amount: moneyMinor(req.body.depositAmount) / 100 }; }
      catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
    }
    const invoice = await generatePartsCustomerInvoice(activeDealerId(res), type, id, res.locals.user!, req.body.previewFingerprint, deposit);
    queueInvoiceSync(invoice.dealerId, invoice.id, "create");
    res.status(201).json({ invoice });
  } catch (error) { res.status((error as any).status ?? 500).json({ error: (error as Error).message, invoice: (error as any).invoice }); }
});

router.get("/parts/customer-invoices/:id/pdf", async (req, res): Promise<void> => {
  if (!canBill(res.locals.user)) { res.status(403).json({ error: "Customer invoice permission required" }); return; }
  const dealerId = activeDealerId(res);
  const invoice = await scopedPartsInvoice(dealerId, Number(req.params.id));
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }
  const pdf = await buildInvoicePdfFromPayload(invoicePayload(invoice), await dealerTimezone(dealerId), await getDealerPdfBranding(dealerId));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
  res.send(pdf);
});

router.post("/parts/customer-invoices/:id/email", async (req, res): Promise<void> => {
  if (!canBill(res.locals.user)) { res.status(403).json({ error: "Customer invoice permission required" }); return; }
  const dealerId = activeDealerId(res);
  const invoice = await scopedPartsInvoice(dealerId, Number(req.params.id));
  if (!invoice?.customerId) { res.status(404).json({ error: "Customer invoice not found" }); return; }
  const [customer] = await db.select().from(customersTable).where(and(eq(customersTable.id, invoice.customerId), eq(customersTable.dealerId, dealerId)));
  if (!customer?.email) { res.status(422).json({ error: "Customer has no email address" }); return; }
  const result = await db.transaction(async tx => {
    const log = await enqueueEmail({ template: "invoice.generated", to: customer.email!, dealerId,
      customerId: customer.id, data: invoicePayload(invoice), dedupeKey: `parts-invoice:${invoice.id}:email`,
      tx, deferProcessing: true, notifyUserId: res.locals.user!.id });
    await tx.insert(auditLogsTable).values({ dealerId, actorUserId: res.locals.user!.id,
      action: "create", module: "parts", entityType: "invoice", entityId: String(invoice.id),
      summary: "Customer invoice email queued", details: { before: "issued", after: "email_queued", emailLogId: log.id } });
    return log;
  });
  res.status(202).json({ status: result.status, emailLogId: result.id });
});

router.get("/job-cards/:id/parts-estimate.pdf", async (req, res): Promise<void> => {
  if (!res.locals.user || !(hasPermission(res.locals.user, "service", "view") || hasPermission(res.locals.user, "parts", "view"))) {
    res.status(403).json({ error: "Service or parts view permission required" }); return;
  }
  const dealerId = activeDealerId(res);
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid job card" }); return; }
  const preview = await db.transaction(async tx => {
    const [card] = await tx.select().from(jobCardsTable).where(and(eq(jobCardsTable.id, id), eq(jobCardsTable.dealerId, dealerId))).for("share");
    if (!card) return null;
    const [order] = await tx.select().from(serviceOrdersTable).where(and(eq(serviceOrdersTable.id, card.serviceOrderId), eq(serviceOrdersTable.dealerId, dealerId)));
    if (!order) return null;
    return { card, order, breakdown: await buildServiceEstimateBreakdown(tx, card) };
  });
  if (!preview) { res.status(404).json({ error: "Service estimate not found" }); return; }
  const { card, order, breakdown } = preview;
  const lines = breakdown.lines.filter(line => line.kind !== "tax" && !["Shipping", "Duties"].includes(line.description));
  const payload = {
    documentType: "estimate", invoiceNumber: `EST-${card.id}-V${card.estimateVersion}`, customerName: order.customerName ?? "Customer",
    amount: String(breakdown.total), kind: "service and parts estimate", issuedAt: new Date().toISOString(),
    description: [
      ...lines.map(line => `${line.description}${line.quantity != null ? ` × ${line.quantity}` : ""}: ${line.amount.toFixed(2)}`),
      `Parts subtotal: ${(breakdown.internalPartsTotal + breakdown.externalPartsTotal).toFixed(2)}`,
      ...(breakdown.shippingTotal ? [`Shipping (non-taxable): ${breakdown.shippingTotal.toFixed(2)}`] : []),
      ...(breakdown.dutiesTotal ? [`Duties (non-taxable): ${breakdown.dutiesTotal.toFixed(2)}`] : []),
    ].join("\n"), taxLines: JSON.stringify([{ label: "Tax", amount: breakdown.tax }]),
  };
  const pdf = await buildInvoicePdfFromPayload(payload, await dealerTimezone(dealerId), await getDealerPdfBranding(dealerId));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${payload.invoiceNumber}.pdf"`);
  res.send(pdf);
});

router.get("/job-cards/:id/parts-charges", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  if (!res.locals.user || !(hasPermission(res.locals.user, "service", "view") || hasPermission(res.locals.user, "parts", "view"))) {
    res.status(403).json({ error: "Service or parts view permission required" }); return;
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid job card" }); return; }
  const [card] = await db.select({ id: jobCardsTable.id }).from(jobCardsTable)
    .where(and(eq(jobCardsTable.dealerId, dealerId), eq(jobCardsTable.id, id)));
  if (!card) { res.status(404).json({ error: "Job card not found" }); return; }
  res.json(await loadPartsEstimateCharges(db, dealerId, id));
});

router.put("/job-cards/:id/parts-charges", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const actor = res.locals.user;
  if (!actor || !(hasPermission(actor, "service", "edit") || hasPermission(actor, "parts", "edit"))) {
    res.status(403).json({ error: "Service or parts edit permission required" }); return;
  }
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("Invalid job card"), { status: 400 });
    let shipping: string, duties: string;
    try {
      shipping = decimalMoney(moneyMinor(req.body.shippingAmount));
      duties = decimalMoney(moneyMinor(req.body.dutiesAmount));
    } catch (error) { throw Object.assign(error as Error, { status: 400 }); }
    const result = await db.transaction(async tx => {
      const [card] = await tx.select().from(jobCardsTable)
        .where(and(eq(jobCardsTable.dealerId, dealerId), eq(jobCardsTable.id, id))).for("update");
      if (!card) throw Object.assign(new Error("Job card not found"), { status: 404 });
      const [invoice] = await tx.select({ id: serviceInvoicesTable.id }).from(serviceInvoicesTable)
        .where(and(eq(serviceInvoicesTable.dealerId, dealerId), eq(serviceInvoicesTable.jobCardId, id)));
      if (invoice) throw Object.assign(new Error("Issued invoice charges are immutable; use an authorized adjustment"), { status: 409 });
      const before = await loadPartsEstimateCharges(tx, dealerId, id);
      if (before.shippingTotal === Number(shipping) && before.dutiesTotal === Number(duties)) return before;
      await tx.execute(sql`INSERT INTO parts_estimate_charges (dealer_id, job_card_id, shipping_amount, duties_amount, updated_by)
        VALUES (${dealerId}, ${id}, ${shipping}, ${duties}, ${actor.id})
        ON CONFLICT (dealer_id, job_card_id) DO UPDATE SET shipping_amount = excluded.shipping_amount,
        duties_amount = excluded.duties_amount, updated_by = excluded.updated_by, updated_at = now()`);
      const breakdown = await buildServiceEstimateBreakdown(tx, card);
      await invalidateServiceEstimate(tx, dealerId, id);
      await tx.update(jobCardsTable).set({
        quoteTotal: breakdown.total, estimateVersion: card.estimateVersion + 1,
        estimateApprovedVersion: null, estimateApprovalAt: null, estimateApprovalEvidence: null,
        quoteApprovedAt: null, ...clearEstimateStaffAcknowledgement,
      }).where(and(eq(jobCardsTable.id, id), eq(jobCardsTable.dealerId, dealerId)));
      const after = { shippingTotal: Number(shipping), dutiesTotal: Number(duties) };
      await tx.insert(auditLogsTable).values({
        dealerId, actorUserId: actor.id, actorName: actor.name,
        action: "update", module: "parts", entityType: "job_card", entityId: String(id),
        summary: "Updated non-taxable estimate Shipping and Duties; customer approval superseded",
        details: { before, after, beforeVersion: card.estimateVersion, afterVersion: card.estimateVersion + 1 },
      });
      return after;
    });
    res.json(result);
  } catch (error) {
    res.status((error as any).status ?? 500).json({ error: (error as Error).message });
  }
});

export default router;