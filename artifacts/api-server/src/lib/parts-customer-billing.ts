import { and, eq, sql } from "drizzle-orm";
import {
  db, partRequisitionsTable, partRequisitionLinesTable, purchaseOrderLinesTable,
  partsTable, customersTable, serviceOrdersTable, jobCardsTable, invoicesTable,
  serviceInvoicesTable, partRequisitionFulfillmentsTable, jobCardPartsTable, auditLogsTable,
  collisionClaimsTable, partCreditNotesTable, purchaseOrdersTable, externalJobCardPartsTable,
} from "@workspace/db";
import { loadPartsEstimateCharges } from "./parts-estimate-charges";
import { computeTaxes, ensureDealerTaxes } from "./taxes";
import { dealerExchangeRate, applyPartsDepositCredit } from "./invoicing";
import { issueJobParts } from "./job-part-stock";
import { moveStock } from "./parts-inventory";
import { hasCurrentChargeableWorkAuthorization, clearEstimateStaffAcknowledgement } from "./service-estimate-gate";
import { invalidateServiceEstimate } from "./service-estimate-invalidation";
import { buildServiceEstimateBreakdown } from "./service-estimate-breakdown";
import { assertBillableRequisition, assertBillingCustomer } from "./parts-billing-policy";
import { enqueueStockEntrySync } from "./erpnext/parts-sync";
import { moneyMinor } from "./parts-billing-money";
import { createHash } from "node:crypto";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PartsBillingSource = "requisition" | "special_order";
const fail = (message: string, status = 422): never => { throw Object.assign(new Error(message), { status }); };

export async function existingPartsInvoice(tx: Pick<typeof db, "execute">, dealerId: number, type: PartsBillingSource, id: number) {
  const result = await tx.execute(sql`SELECT i.id, i.invoice_number AS "invoiceNumber"
    FROM parts_invoice_sources s JOIN invoices i ON i.id=s.invoice_id AND i.dealer_id=s.dealer_id
    WHERE s.dealer_id=${dealerId} AND s.source_type=${type} AND s.source_id=${id}`);
  if (result.rows[0]) return result.rows[0];
  const indirect = type === "requisition"
    ? await tx.execute(sql`SELECT i.id, i.invoice_number AS "invoiceNumber" FROM part_requisition_lines l
        JOIN parts_billed_requisition_lines b ON b.requisition_line_id=l.id AND b.dealer_id=l.dealer_id
        JOIN invoices i ON i.id=b.invoice_id AND i.dealer_id=b.dealer_id
        WHERE l.dealer_id=${dealerId} AND l.requisition_id=${id} LIMIT 1`)
    : await tx.execute(sql`SELECT i.id, i.invoice_number AS "invoiceNumber" FROM purchase_order_lines l
        JOIN parts_billed_requisition_lines b ON b.requisition_line_id=l.requisition_line_id AND b.dealer_id=l.dealer_id
        JOIN invoices i ON i.id=b.invoice_id AND i.dealer_id=b.dealer_id
        WHERE l.dealer_id=${dealerId} AND l.id=${id} LIMIT 1`);
  return indirect.rows[0] ?? null;
}

export async function partsBillingPreview(tx: Tx | typeof db, dealerId: number, type: PartsBillingSource, id: number) {
  let customerId: number | null = null;
  let jobCardId: number | null = null;
  let requisitionLines: typeof partRequisitionLinesTable.$inferSelect[] = [];
  let poLine: typeof purchaseOrderLinesTable.$inferSelect | undefined;
  let directJobLine: typeof jobCardPartsTable.$inferSelect | undefined;
  let locationId: number | null = null;
  if (type === "requisition") {
    const [req] = await tx.select().from(partRequisitionsTable).where(and(eq(partRequisitionsTable.id, id), eq(partRequisitionsTable.dealerId, dealerId)));
    if (!req) fail("Requisition not found", 404);
    assertBillableRequisition(req);
    const [order] = await tx.select().from(serviceOrdersTable).where(and(eq(serviceOrdersTable.id, req.serviceOrderId!), eq(serviceOrdersTable.dealerId, dealerId)));
    customerId = order?.customerId ?? null;
    jobCardId = req.jobCardId;
    requisitionLines = await tx.select().from(partRequisitionLinesTable).where(and(eq(partRequisitionLinesTable.requisitionId, id), eq(partRequisitionLinesTable.dealerId, dealerId))).orderBy(partRequisitionLinesTable.id);
  } else {
    [poLine] = await tx.select().from(purchaseOrderLinesTable).where(and(eq(purchaseOrderLinesTable.id, id), eq(purchaseOrderLinesTable.dealerId, dealerId)));
    if (!poLine) fail("Purchase order line not found", 404);
    const [po] = await tx.select().from(purchaseOrdersTable).where(and(eq(purchaseOrdersTable.id, poLine!.purchaseOrderId), eq(purchaseOrdersTable.dealerId, dealerId)));
    if (!po || !["sent", "ordered", "partially_received", "received", "closed"].includes(po.status)) fail("Only a sent or received special order can be customer-invoiced.");
    locationId = po.locationId;
    if (!poLine!.isSpecialOrder || !poLine!.customerId) fail("Only customer-linked special orders can be invoiced.");
    customerId = poLine!.customerId;
    jobCardId = poLine!.jobCardId;
    if (poLine!.requisitionLineId) {
      requisitionLines = await tx.select().from(partRequisitionLinesTable).where(and(eq(partRequisitionLinesTable.id, poLine!.requisitionLineId!), eq(partRequisitionLinesTable.dealerId, dealerId)));
      if (!requisitionLines.length || requisitionLines[0].quantity !== poLine!.quantity) fail("Split requisition procurement must be invoiced from the complete requisition.");
      const [req] = await tx.select().from(partRequisitionsTable).where(and(eq(partRequisitionsTable.id, requisitionLines[0].requisitionId), eq(partRequisitionsTable.dealerId, dealerId)));
      if (!req?.serviceOrderId || req.collisionClaimId) fail("Internal or collision procurement cannot be billed through this action.");
      const [order] = await tx.select().from(serviceOrdersTable).where(and(eq(serviceOrdersTable.id, req.serviceOrderId!), eq(serviceOrdersTable.dealerId, dealerId)));
      assertBillingCustomer(customerId, order?.customerId);
      if (req.status !== "fulfilled") fail("Fulfill the linked requisition before customer invoicing.");
      jobCardId = req.jobCardId;
    } else if (jobCardId) {
      const [linked] = await tx.select({ card: jobCardsTable, order: serviceOrdersTable })
        .from(jobCardsTable).innerJoin(serviceOrdersTable, and(eq(serviceOrdersTable.id, jobCardsTable.serviceOrderId), eq(serviceOrdersTable.dealerId, jobCardsTable.dealerId)))
        .where(and(eq(jobCardsTable.id, jobCardId), eq(jobCardsTable.dealerId, dealerId)));
      assertBillingCustomer(customerId, linked?.order.customerId);
      const matches = await tx.select().from(jobCardPartsTable).where(and(
        eq(jobCardPartsTable.dealerId, dealerId), eq(jobCardPartsTable.jobCardId, jobCardId),
        eq(jobCardPartsTable.partId, poLine!.partId ?? -1), eq(jobCardPartsTable.kind, "issue"),
        eq(jobCardPartsTable.quantity, poLine!.quantity),
        sql`NOT EXISTS (SELECT 1 FROM part_requisition_fulfillments f WHERE f.dealer_id=${dealerId} AND f.job_card_part_id=${jobCardPartsTable.id})`,
      ));
      if (matches.length !== 1) fail("The special order must identify exactly one matching job part; use a requisition link to resolve ambiguous or split job lines.");
      directJobLine = matches[0];
    }
  }
  if (!customerId) fail("A customer account must be linked before invoicing.");
  const [customer] = await tx.select().from(customersTable).where(and(eq(customersTable.id, customerId!), eq(customersTable.dealerId, dealerId)));
  if (!customer) fail("Customer not found in this dealership", 404);
  const lines = [];
  const inputs = requisitionLines.length ? requisitionLines.map(l => ({ partId: l.partId, name: l.descriptionSnapshot, quantity: l.quantity, unitPrice: l.unitPrice, requisitionLineId: l.id, jobCardPartId: null as number | null }))
    : [{ partId: poLine!.partId, name: poLine!.partName, quantity: poLine!.quantity, unitPrice: directJobLine?.unitPrice ?? null, requisitionLineId: null, jobCardPartId: directJobLine?.id ?? null }];
  for (const input of inputs) {
    const [part] = input.partId ? await tx.select().from(partsTable).where(and(eq(partsTable.id, input.partId), eq(partsTable.dealerId, dealerId))) : [];
    if (input.partId && !part) fail("Part is not in this dealership", 404);
    const unitPrice = part?.unitPrice ?? input.unitPrice;
    if (unitPrice == null || !Number.isFinite(unitPrice) || unitPrice < 0) fail("A valid selling price is required; supplier cost is never a selling price.");
    try { moneyMinor(unitPrice); } catch { fail("Selling prices must have at most two decimal places. Correct the price list before invoicing."); }
    if (jobCardId && Math.round(unitPrice * 100) !== Math.round((input.unitPrice ?? 0) * 100)) fail("Price list has changed since customer approval. Reprice the service estimate before invoicing.");
    lines.push({ ...input, unitPrice, sku: part?.sku ?? null });
  }
  if (!lines.length) fail("No billable lines.");
  const charges = jobCardId ? await loadPartsEstimateCharges(tx, dealerId, jobCardId) : { shippingTotal: 0, dutiesTotal: 0 };
  const subtotalMinor = lines.reduce((n, l) => n + moneyMinor(l.unitPrice) * l.quantity, 0);
  if (!Number.isSafeInteger(subtotalMinor)) fail("Invoice exceeds supported monetary precision.");
  const subtotal = subtotalMinor / 100;
  const tax = computeTaxes(subtotal, (await ensureDealerTaxes(dealerId)).filter(t => t.code === "vat"));
  return { customer: customer!, jobCardId, locationId, lines, subtotal, tax, ...charges, total: Math.round((tax.totalWithTax + charges.shippingTotal + charges.dutiesTotal) * 100) / 100 };
}

export function partsBillingFingerprint(preview: Awaited<ReturnType<typeof partsBillingPreview>>) {
  return createHash("sha256").update(JSON.stringify({
    customerId: preview.customer.id, jobCardId: preview.jobCardId, locationId: preview.locationId, lines: preview.lines,
    subtotal: preview.subtotal, tax: preview.tax, shipping: preview.shippingTotal, duties: preview.dutiesTotal, total: preview.total,
  })).digest("hex");
}

export async function generatePartsCustomerInvoice(dealerId: number, type: PartsBillingSource, id: number, actor: { id: number; name?: string | null }, expectedPreview: string, deposit?: { invoiceId: number; amount: number }) {
  const exchangeRate = await dealerExchangeRate(dealerId);
  const stockSync: Parameters<typeof enqueueStockEntrySync>[0][] = [];
  const result = await db.transaction(async tx => {
    // Serializes both source types, including requisition ↔ PO-line crossover.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`parts-billing:${dealerId}`}))`);
    if (type === "requisition") {
      await tx.select({ id: partRequisitionsTable.id }).from(partRequisitionsTable)
        .where(and(eq(partRequisitionsTable.id, id), eq(partRequisitionsTable.dealerId, dealerId))).for("update");
    } else {
      const [line] = await tx.select({ purchaseOrderId: purchaseOrderLinesTable.purchaseOrderId }).from(purchaseOrderLinesTable)
        .where(and(eq(purchaseOrderLinesTable.id, id), eq(purchaseOrderLinesTable.dealerId, dealerId)));
      if (line) await tx.select({ id: purchaseOrdersTable.id }).from(purchaseOrdersTable)
        .where(and(eq(purchaseOrdersTable.id, line.purchaseOrderId), eq(purchaseOrdersTable.dealerId, dealerId))).for("update");
      await tx.select({ id: purchaseOrderLinesTable.id }).from(purchaseOrderLinesTable)
        .where(and(eq(purchaseOrderLinesTable.id, id), eq(purchaseOrderLinesTable.dealerId, dealerId))).for("update");
    }
    const existing = await existingPartsInvoice(tx, dealerId, type, id);
    if (existing) throw Object.assign(new Error("This source has already been invoiced"), { status: 409, invoice: existing });
    const initial = await partsBillingPreview(tx, dealerId, type, id);
    let card: typeof jobCardsTable.$inferSelect | undefined;
    if (initial.jobCardId) {
      [card] = await tx.select().from(jobCardsTable).where(and(eq(jobCardsTable.id, initial.jobCardId), eq(jobCardsTable.dealerId, dealerId))).for("update");
      if (!card || !hasCurrentChargeableWorkAuthorization(card)) fail("Current customer approval and staff acknowledgement are required before invoicing.");
      if (initial.total > 0 && card!.quoteTotal <= 0) fail("These chargeable parts are not included in an approved service estimate.");
      if (card!.payType !== "customer") fail("Warranty and internal work are not customer-billable.");
      const [ownedOrder] = await tx.select().from(serviceOrdersTable).where(and(eq(serviceOrdersTable.id, card!.serviceOrderId), eq(serviceOrdersTable.dealerId, dealerId))).for("update");
      assertBillingCustomer(initial.customer.id, ownedOrder?.customerId);
      const [collision] = await tx.select({ id: collisionClaimsTable.id }).from(collisionClaimsTable)
        .where(and(eq(collisionClaimsTable.serviceOrderId, card!.serviceOrderId), eq(collisionClaimsTable.dealerId, dealerId)));
      if (collision) fail("Collision parts must be billed through the insurer-approved service invoice.");
      const currentEstimate = await buildServiceEstimateBreakdown(tx, card!);
      if (Math.abs(currentEstimate.total - card!.quoteTotal) > 0.005) fail("The approved estimate no longer matches current prices. Reprice and re-approve before invoicing.");
      const [serviceInvoice] = await tx.select({ id: serviceInvoicesTable.id }).from(serviceInvoicesTable).where(and(eq(serviceInvoicesTable.jobCardId, card!.id), eq(serviceInvoicesTable.dealerId, dealerId)));
      if (serviceInvoice) fail("This job already has a service invoice; parts cannot be billed again.", 409);
    }
    for (const partId of [...new Set(initial.lines.flatMap(line => line.partId == null ? [] : [line.partId]))].sort((a, b) => a - b)) {
      await tx.select({ id: partsTable.id }).from(partsTable).where(and(eq(partsTable.id, partId), eq(partsTable.dealerId, dealerId))).for("update");
    }
    const preview = await partsBillingPreview(tx, dealerId, type, id);
    if (partsBillingFingerprint(preview) !== expectedPreview) fail("Customer, quantities, prices or charges changed. Reload and review the invoice preview before generating.", 409);
    for (const line of preview.lines) {
      if (line.jobCardPartId) {
        const [credit] = await tx.select({ id: partCreditNotesTable.id }).from(partCreditNotesTable).where(and(eq(partCreditNotesTable.dealerId, dealerId), eq(partCreditNotesTable.jobCardPartId, line.jobCardPartId)));
        if (credit) fail("A returned job part cannot be invoiced at its original full quantity.");
        const billed = await tx.execute(sql`SELECT b.invoice_id AS id, i.invoice_number AS "invoiceNumber"
          FROM parts_billed_job_lines b JOIN invoices i ON i.id=b.invoice_id AND i.dealer_id=b.dealer_id
          WHERE b.dealer_id=${dealerId} AND b.job_card_part_id=${line.jobCardPartId}`);
        if (billed.rows.length) throw Object.assign(new Error("This job part is already invoiced"), { status: 409, invoice: billed.rows[0] });
      }
      if (!line.requisitionLineId) continue;
      const billed = await tx.execute(sql`SELECT b.invoice_id AS id, i.invoice_number AS "invoiceNumber"
        FROM parts_billed_requisition_lines b JOIN invoices i ON i.id=b.invoice_id AND i.dealer_id=b.dealer_id
        WHERE b.dealer_id=${dealerId} AND b.requisition_line_id=${line.requisitionLineId}`);
      if (billed.rows.length) throw Object.assign(new Error("A requisition line is already invoiced"), { status: 409, invoice: billed.rows[0] });
    }
    const description = [
      ...preview.lines.map(l => `${l.sku ?? ""} ${l.name}: ${l.quantity} × ${l.unitPrice.toFixed(2)}`),
      `Parts subtotal: ${preview.subtotal.toFixed(2)}`,
      ...(preview.shippingTotal ? [`Shipping (non-taxable): ${preview.shippingTotal.toFixed(2)}`] : []),
      ...(preview.dutiesTotal ? [`Duties (non-taxable): ${preview.dutiesTotal.toFixed(2)}`] : []),
    ].join("\n");
    const [invoice] = await tx.insert(invoicesTable).values({
      dealerId, invoiceNumber: "PENDING", customerId: preview.customer.id,
      customerName: preview.customer.name, description, amount: preview.total,
      taxLines: preview.tax.lines, currency: "GYD", exchangeRate, status: "issued", kind: "final",
    }).returning();
    const [numbered] = await tx.update(invoicesTable).set({ invoiceNumber: `INV-P-${String(invoice.id).padStart(6, "0")}` })
      .where(and(eq(invoicesTable.id, invoice.id), eq(invoicesTable.dealerId, dealerId))).returning();
    for (const line of preview.lines) {
      if (line.requisitionLineId) {
        const fulfillments = await tx.select().from(partRequisitionFulfillmentsTable).where(and(eq(partRequisitionFulfillmentsTable.dealerId, dealerId), eq(partRequisitionFulfillmentsTable.lineId, line.requisitionLineId)));
        if (fulfillments.reduce((n, f) => n + f.quantity, 0) !== line.quantity) fail("Requisition fulfillment does not match invoice quantity.");
        for (const f of fulfillments) {
          if (!f.jobCardPartId && !f.externalJobCardPartId) fail("Customer requisition fulfillment has no billable job-part trace.");
          if (f.jobCardPartId && card) {
            const [jobLine] = await tx.select().from(jobCardPartsTable).where(and(eq(jobCardPartsTable.dealerId, dealerId), eq(jobCardPartsTable.jobCardId, card.id), eq(jobCardPartsTable.id, f.jobCardPartId)));
            if (!jobLine || jobLine.unitPrice !== line.unitPrice || jobLine.quantity !== f.quantity) fail("Approved job price or quantity does not match the requisition.");
            const [credit] = await tx.select({ id: partCreditNotesTable.id }).from(partCreditNotesTable).where(and(eq(partCreditNotesTable.dealerId, dealerId), eq(partCreditNotesTable.jobCardPartId, f.jobCardPartId)));
            if (credit) fail("Returned requisition parts must be reconciled before invoicing.");
            // Shared helper uses issuedUnits; historical and physically-issued parts never deduct twice.
            const issued = await issueJobParts(tx, dealerId, card.id, jobLine.id);
            for (const item of issued) stockSync.push({ dealerId, partId: item.partId, qty: item.quantity, direction: "out",
              entityType: "job_card_part", entityId: item.id, remark: `AURA parts invoice #${invoice.id}`,
              dedupeKey: `erp:se:jcp:${dealerId}:${item.id}` });
          }
          if (f.externalJobCardPartId && card) {
            const [external] = await tx.select().from(externalJobCardPartsTable).where(and(
              eq(externalJobCardPartsTable.id, f.externalJobCardPartId), eq(externalJobCardPartsTable.dealerId, dealerId),
              eq(externalJobCardPartsTable.jobCardId, card.id), eq(externalJobCardPartsTable.requisitionLineId, line.requisitionLineId),
            ));
            if (!external || external.unitPrice !== line.unitPrice || external.quantity < f.quantity) fail("External fulfillment does not match the approved customer part.");
          }
        }
        await tx.execute(sql`INSERT INTO parts_billed_requisition_lines (dealer_id, requisition_line_id, invoice_id) VALUES (${dealerId}, ${line.requisitionLineId}, ${invoice.id})`);
      } else if (line.jobCardPartId && card) {
        const issued = await issueJobParts(tx, dealerId, card.id, line.jobCardPartId);
        for (const item of issued) stockSync.push({ dealerId, partId: item.partId, qty: item.quantity, direction: "out",
          entityType: "job_card_part", entityId: item.id, remark: `AURA parts invoice #${invoice.id}`,
          dedupeKey: `erp:se:jcp:${dealerId}:${item.id}` });
        await tx.execute(sql`INSERT INTO parts_billed_job_lines (dealer_id, job_card_part_id, invoice_id)
          VALUES (${dealerId}, ${line.jobCardPartId}, ${invoice.id})`);
      } else if (line.partId) {
        const movement = await moveStock(tx, { dealerId, partId: line.partId, locationId: preview.locationId ?? undefined, type: "issue", quantityDelta: -line.quantity,
          createdBy: actor.id, referenceType: "parts_customer_invoice", referenceId: String(invoice.id), idempotencyKey: `parts-bill:${dealerId}:${type}:${id}:${line.partId}` });
        stockSync.push({ dealerId, partId: line.partId, qty: line.quantity, direction: "out",
          entityType: "invoice", entityId: invoice.id, remark: `AURA parts invoice #${invoice.id}`,
          dedupeKey: `erp:se:parts-billing:${dealerId}:${movement.id}` });
      }
    }
    await tx.execute(sql`INSERT INTO parts_invoice_sources
      (dealer_id, source_type, source_id, customer_id, invoice_id, shipping_amount, duties_amount, lines, created_by)
      VALUES (${dealerId}, ${type}, ${id}, ${preview.customer.id}, ${invoice.id},
      ${preview.shippingTotal.toFixed(2)}, ${preview.dutiesTotal.toFixed(2)}, ${JSON.stringify(preview.lines.map(l => ({ ...l, unitPrice: l.unitPrice.toFixed(2) })))}::jsonb, ${actor.id})`);
    if (card) {
      // Charges move once to this invoice; the remaining job must be re-approved.
      await tx.execute(sql`UPDATE parts_estimate_charges SET shipping_amount=0, duties_amount=0, updated_at=now() WHERE dealer_id=${dealerId} AND job_card_id=${card.id}`);
      const remaining = await buildServiceEstimateBreakdown(tx, card);
      await invalidateServiceEstimate(tx, dealerId, card.id);
      await tx.update(jobCardsTable).set({ quoteTotal: remaining.total, estimateVersion: card.estimateVersion + 1,
        estimateApprovedVersion: null, estimateApprovalAt: null, estimateApprovalEvidence: null, quoteApprovedAt: null,
        ...clearEstimateStaffAcknowledgement })
        .where(and(eq(jobCardsTable.id, card.id), eq(jobCardsTable.dealerId, dealerId)));
    }
    const appliedDeposit = deposit ? await applyPartsDepositCredit(tx, {
      dealerId, customerId: preview.customer.id, depositInvoiceId: deposit.invoiceId, invoiceId: invoice.id,
      amount: deposit.amount, actorId: actor.id, actorName: actor.name ?? "Staff",
    }) : null;
    if (appliedDeposit) {
      await tx.update(invoicesTable).set({ description: `${description}\nDeposit credit applied (non-cash): ${appliedDeposit.amount.toFixed(2)}\nBalance at issue: ${(preview.total - appliedDeposit.amount).toFixed(2)}` })
        .where(and(eq(invoicesTable.id, invoice.id), eq(invoicesTable.dealerId, dealerId)));
    }
    await tx.insert(auditLogsTable).values({ dealerId, actorUserId: actor.id, actorName: actor.name,
      action: "create", module: "parts", entityType: "invoice", entityId: String(invoice.id),
      summary: `Generated customer invoice from ${type} ${id}`,
      details: { before: "uninvoiced", after: "issued", sourceType: type, sourceId: id, customerId: preview.customer.id, invoiceId: invoice.id, appliedDeposit },
    });
    const [finalInvoice] = await tx.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoice.id), eq(invoicesTable.dealerId, dealerId)));
    return { ...finalInvoice, appliedDeposit };
  });
  for (const stock of stockSync) enqueueStockEntrySync(stock);
  return result;
}