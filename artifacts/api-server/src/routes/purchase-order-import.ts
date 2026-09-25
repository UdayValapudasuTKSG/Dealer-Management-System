import { createHash } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, suppliersTable, partsTable, customersTable, jobCardsTable, serviceOrdersTable, inventoryLocationsTable, purchaseOrdersTable, purchaseOrderLinesTable } from "@workspace/db";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import { orderImportColumns, parseOrderFile, validateOrderFields, type OrderImportRow } from "../lib/purchase-order-import";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } }).single("file");
export type Decision = "create" | "skip";
export type Evaluated = { row: OrderImportRow; errors: string[]; supplierId: number | null; partId: number | null; customerId: number | null; jobCardId: number | null; unknownPart: boolean; skipped: boolean };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function parseDecisions(input: unknown): Record<string, Decision> {
  if (!input) return {};
  const parsed = JSON.parse(String(input));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.entries(parsed).some(([key, value]) => !/^[1-9]\d*$/.test(key) || !["create", "skip"].includes(String(value))))
    throw new Error("Decisions must map row numbers to create or skip");
  return parsed;
}
function uniqueId(ids: number[]) { return ids.length === 1 ? ids[0] : null; }
function key(value: string) { return value.trim().toLowerCase(); }

export async function evaluateOrderImport(dealerId: number, rows: OrderImportRow[], decisions: Record<string, Decision>, query: Pick<Tx, "select" | "execute"> = db): Promise<Evaluated[]> {
  // Run in sequence: this same helper is used inside a single pg transaction.
  // Concurrent queries on a transaction's single connection are unsafe.
  const suppliers = await query.select().from(suppliersTable).where(eq(suppliersTable.dealerId, dealerId));
  const parts = await query.select().from(partsTable).where(eq(partsTable.dealerId, dealerId));
  const customers = await query.select({ id: customersTable.id, name: customersTable.name, email: customersTable.email, phone: customersTable.phone }).from(customersTable).where(and(eq(customersTable.dealerId, dealerId), isNull(customersTable.deletedAt), isNull(customersTable.erasedAt)));
  const jobs = await query.select({ id: jobCardsTable.id, serviceOrderId: jobCardsTable.serviceOrderId }).from(jobCardsTable).where(eq(jobCardsTable.dealerId, dealerId));
  const orders = await query.select({ id: serviceOrdersTable.id, customerId: serviceOrdersTable.customerId }).from(serviceOrdersTable).where(eq(serviceOrdersTable.dealerId, dealerId));
  const codes = await query.execute(sql`select id, supplier_code from suppliers where dealer_id = ${dealerId}`);
  const supplierCodes = new Map<number, string>((codes.rows as Array<{ id: number; supplier_code: string | null }>).map(r => [r.id, r.supplier_code ?? `SUP-${r.id}`]));
  const orderCustomers = new Map(orders.map(o => [o.id, o.customerId]));
  return rows.map(row => {
    const errors = validateOrderFields(row);
    const supplierMatches = suppliers.filter(s => key(supplierCodes.get(s.id) ?? "") === key(row.supplier_code));
    const supplierId = uniqueId(supplierMatches.map(s => s.id));
    if (row.supplier_code && !supplierId) errors.push(supplierMatches.length ? "Ambiguous supplier code" : "Supplier code not found for this dealer");
    const partMatches = parts.filter(p => key(p.sku) === key(row.part_number));
    const partId = uniqueId(partMatches.map(p => p.id));
    if (partMatches.length > 1) errors.push("Ambiguous part number");
    const unknownPart = !!row.part_number && partMatches.length === 0;
    const decision = decisions[String(row.rowNumber)];
    if (unknownPart && !decision) errors.push("Unknown part: choose Create or Skip");
    if (unknownPart && decision === "create" && !row.part_name) errors.push("Part name required when creating a part");
    if (partId && supplierId && partMatches[0].supplierId && partMatches[0].supplierId !== supplierId) errors.push("Part belongs to a different supplier");
    const customerMatches = row.customer_ref ? customers.filter(c => [String(c.id), `CUST-${c.id}`, c.email ?? "", c.phone ?? ""].some(v => v && key(v) === key(row.customer_ref))) : [];
    const customerId = row.customer_ref ? uniqueId(customerMatches.map(c => c.id)) : null;
    if (row.customer_ref && !customerId) errors.push(customerMatches.length ? "Ambiguous customer reference" : "Customer reference not found for this dealer");
    const jobMatches = row.ro_number ? jobs.filter(j => key(row.ro_number) === key(`JOB-${j.id}`) || key(row.ro_number) === key(`RO-${j.serviceOrderId}`)) : [];
    const jobCardId = row.ro_number ? uniqueId(jobMatches.map(j => j.id)) : null;
    if (row.ro_number && !jobCardId) errors.push(jobMatches.length ? "Ambiguous RO: use JOB-<job card id>" : "RO not found for this dealer");
    if (jobCardId && customerId) {
      const job = jobs.find(j => j.id === jobCardId)!;
      if (orderCustomers.get(job.serviceOrderId) !== customerId) errors.push("RO does not belong to the selected customer");
    }
    return { row, errors, supplierId, partId, customerId, jobCardId, unknownPart, skipped: unknownPart && decision === "skip" };
  });
}

/** Execute inside the caller's transaction. All provenance, parts, orders and lines
 * are rolled back together on any failure. The duplicate key is file+branch,
 * independent of UI decisions; a repeat file must never create another PO. */
export async function commitOrderImport(tx: Tx, input: {
  dealerId: number; locationId: number; userId: number | null; fileName: string;
  importKey: string; rows: OrderImportRow[]; decisions: Record<string, Decision>;
  inspected: Evaluated[];
}): Promise<{ duplicate: boolean; orders: number[] }> {
  const { dealerId, locationId, userId, fileName, importKey, rows, decisions, inspected } = input;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`po-import:${dealerId}:${importKey}`}))`);
  const prior = await tx.execute(sql`select id from purchase_order_import_commits where dealer_id = ${dealerId} and fingerprint = ${importKey}`);
  if (prior.rows.length) return { duplicate: true, orders: [] };
  // References and branch are checked again under the transaction before any write.
  const current = await evaluateOrderImport(dealerId, rows, decisions, tx);
  if (JSON.stringify(current) !== JSON.stringify(inspected)) throw new Error("References changed since preview. Preview again before confirming.");
  const [location] = await tx.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.dealerId, dealerId), eq(inventoryLocationsTable.id, locationId), eq(inventoryLocationsTable.active, true)));
  if (!location) throw new Error("Branch/location changed since preview. Preview again.");
  const ready = current.filter(r => !r.errors.length && !r.skipped);
  if (!ready.length) throw new Error("No valid rows to import");
  const created = await tx.execute(sql`insert into purchase_order_import_commits (dealer_id, fingerprint, created_by) values (${dealerId}, ${importKey}, ${userId}) returning id`);
  const commitId = Number((created.rows[0] as { id: string }).id);
  const ordersCreated: number[] = [];
  const createdParts = new Map<string, number>();
  for (const supplierId of [...new Set(ready.map(r => r.supplierId!))]) {
    const [po] = await tx.insert(purchaseOrdersTable).values({ dealerId, locationId, supplierId, status: "draft", source: "import", createdBy: userId }).returning();
    ordersCreated.push(po.id);
    const source = await tx.execute(sql`insert into purchase_order_import_sources (dealer_id, commit_id, purchase_order_id, source_file_name) values (${dealerId}, ${commitId}, ${po.id}, ${fileName}) returning id`);
    const sourceId = Number((source.rows[0] as { id: string }).id);
    for (const item of ready.filter(r => r.supplierId === supplierId)) {
      let partId = item.partId ?? createdParts.get(item.row.part_number.toLowerCase()) ?? null;
      if (!partId) {
        const [part] = await tx.insert(partsTable).values({ dealerId, sku: item.row.part_number, name: item.row.part_name, supplierId, unitCost: Number(item.row.unit_cost) }).onConflictDoNothing().returning();
        if (!part) throw new Error(`Part ${item.row.part_number} was created concurrently. Preview again.`);
        partId = part.id;
        createdParts.set(item.row.part_number.toLowerCase(), partId);
      }
      const [line] = await tx.insert(purchaseOrderLinesTable).values({
        dealerId, purchaseOrderId: po.id, partId, partName: (await tx.select({ name: partsTable.name }).from(partsTable).where(and(eq(partsTable.id, partId), eq(partsTable.dealerId, dealerId))))[0].name,
        quantity: Number(item.row.qty), unitCost: Number(item.row.unit_cost), isSpecialOrder: item.row.special_order.toUpperCase() === "Y",
        customerId: item.customerId, jobCardId: item.jobCardId,
      }).returning();
      await tx.execute(sql`update purchase_order_lines set import_unit_cost = ${item.row.unit_cost}::numeric where id = ${line.id}`);
      await tx.execute(sql`insert into purchase_order_import_lines (dealer_id, source_id, purchase_order_line_id, source_row_number) values (${dealerId}, ${sourceId}, ${line.id}, ${item.row.rowNumber})`);
    }
  }
  return { duplicate: false, orders: ordersCreated };
}

router.get("/purchase-orders/import/template", (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="purchase-order-import-template.csv"');
  res.send(orderImportColumns.join(",") + "\r\n");
});

router.post("/purchase-orders/import/:action", (req, res, next) => {
  if (!res.locals.user || !hasPermission(res.locals.user, "parts", "create")) { res.status(403).json({ error: "Parts create permission is required" }); return; }
  if (!["preview", "commit"].includes(String(req.params.action))) { res.status(404).json({ error: "Unknown import action" }); return; }
  upload(req, res, async error => {
    if (error) { res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: error.message }); return; }
    try {
      if (!req.file) { res.status(400).json({ error: "Attach a CSV or XLSX file" }); return; }
      const file = req.file;
      const dealerId = activeDealerId(res);
      const locationId = Number(req.body.locationId);
      if (!Number.isSafeInteger(locationId) || locationId < 1) { res.status(400).json({ error: "Choose a branch/location" }); return; }
      const [location] = await db.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.dealerId, dealerId), eq(inventoryLocationsTable.id, locationId), eq(inventoryLocationsTable.active, true)));
      if (!location) { res.status(404).json({ error: "Branch/location not found for this dealer" }); return; }
      const decisions = parseDecisions(req.body.decisions);
      const rows = await parseOrderFile(file.originalname, file.buffer);
      const fileHash = createHash("sha256").update(file.buffer).digest("hex");
      const importKey = createHash("sha256").update(JSON.stringify({ locationId, fileHash })).digest("hex");
      const fingerprint = createHash("sha256").update(JSON.stringify({ dealerId, locationId, fileHash, decisions })).digest("hex");
      const inspected = await evaluateOrderImport(dealerId, rows, decisions);
      const report = inspected.map(item => ({
        ...item.row, errors: item.errors, status: item.errors.length ? "invalid" : item.skipped ? "skipped" : "ready",
        unknownPart: item.unknownPart, supplierId: item.supplierId, partId: item.partId, customerId: item.customerId, jobCardId: item.jobCardId,
      }));
      if (req.params.action === "preview") {
        res.json({ fingerprint, rows: report, ready: report.filter(r => r.status === "ready").length, invalid: report.filter(r => r.status === "invalid").length, skipped: report.filter(r => r.status === "skipped").length });
        return;
      }
      if (req.body.fingerprint !== fingerprint) { res.status(409).json({ error: "Preview changed. Preview this file and these decisions again." }); return; }
      const ready = inspected.filter(r => !r.errors.length && !r.skipped);
      if (!ready.length) { res.status(400).json({ error: "No valid rows to import" }); return; }
      const result = await db.transaction(tx => commitOrderImport(tx, { dealerId, locationId, userId: res.locals.user?.id ?? null, fileName: file.originalname, importKey, rows, decisions, inspected }));
      res.status(result.duplicate ? 409 : 201).json(result.duplicate ? { error: "This exact file and set of decisions was already imported" } : { purchaseOrderIds: result.orders, importedRows: ready.length, invalidRows: report.filter(r => r.status === "invalid").length });
    } catch (err) {
      if (err instanceof Error && !("code" in err)) { res.status(400).json({ error: err.message }); return; }
      next(err);
    }
  });
});
export default router;