/**
 * Development-only database integration test. All fixtures, imported POs,
 * parts and provenance are created within ONE transaction that always rolls
 * back. Does not start the app, contact providers, or send anything.
 */
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db, pool, suppliersTable, partsTable, customersTable, serviceOrdersTable,
  jobCardsTable, inventoryLocationsTable, purchaseOrdersTable, purchaseOrderLinesTable,
} from "@workspace/db";
import { parseOrderFile } from "../lib/purchase-order-import";
import { commitOrderImport, evaluateOrderImport } from "../routes/purchase-order-import";

if (process.env.NODE_ENV !== "development" || process.env.VERIFY_PO_IMPORT_DB !== "1" || process.env.EXTERNAL_DATABASE_URL) {
  throw new Error("Development-only rolled-back verifier: set NODE_ENV=development VERIFY_PO_IMPORT_DB=1; external production connections prohibited");
}
const rollback = new Error("VERIFICATION_ROLLBACK");
const dealerId = randomInt(100_000_000, 500_000_000);
const otherDealerId = dealerId + 1;
const importKey = `verification-${dealerId}`;
try {
  await db.transaction(async tx => {
    const [location] = await tx.insert(inventoryLocationsTable).values({ dealerId, name: "Import verification branch", type: "branch" }).returning();
    const [otherLocation] = await tx.insert(inventoryLocationsTable).values({ dealerId: otherDealerId, name: "Isolated branch", type: "branch" }).returning();
    const [supplierA] = await tx.insert(suppliersTable).values({ dealerId, name: "Import supplier A" }).returning();
    const [supplierB] = await tx.insert(suppliersTable).values({ dealerId, name: "Import supplier B" }).returning();
    const [foreignSupplier] = await tx.insert(suppliersTable).values({ dealerId: otherDealerId, name: "Foreign supplier" }).returning();
    await tx.execute(sql`update suppliers set supplier_code = 'VERIFY-A' where id in (${supplierA.id}, ${foreignSupplier.id})`);
    await tx.execute(sql`update suppliers set supplier_code = 'VERIFY-B' where id = ${supplierB.id}`);
    const [existing] = await tx.insert(partsTable).values({ dealerId, sku: "EXISTING", name: "Existing filter", supplierId: supplierA.id }).returning();
    const [customer] = await tx.insert(customersTable).values({ dealerId, name: "Verified customer", email: `po-import-${dealerId}@example.invalid` }).returning();
    const [order] = await tx.insert(serviceOrdersTable).values({ dealerId, customerId: customer.id, customerName: customer.name, vehicleInfo: "Test vehicle", scheduledDate: "2026-09-25" }).returning();
    const [job] = await tx.insert(jobCardsTable).values({ dealerId, serviceOrderId: order.id, title: "Verification job" }).returning();

    const file = [
      "supplier_code,part_number,part_name,qty,unit_cost,special_order,customer_ref,ro_number",
      `VERIFY-A,EXISTING,Existing filter,2,10.25,Y,CUST-${customer.id},JOB-${job.id}`,
      "VERIFY-A,NEW-CREATE,New created part,3,2.50,N,,",
      "VERIFY-A,NEW-SKIP,Skipped part,1,3.00,N,,",
      "VERIFY-B,B-NEW,Supplier B part,4,8.75,N,,",
      `SUP-${foreignSupplier.id},CROSS,Foreign supplier row,1,1.00,N,,`,
      "VERIFY-A,BAD-CUSTOMER,Bad customer,1,4.00,Y,CUST-2147483646,",
    ].join("\r\n");
    const rows = await parseOrderFile("verification.csv", Buffer.from(file));
    const decisions = { "3": "create", "4": "skip", "5": "create", "6": "create", "7": "create" } as const;
    const before = await tx.execute(sql`select
      (select count(*) from purchase_orders where dealer_id = ${dealerId})::int as orders,
      (select count(*) from parts where dealer_id = ${dealerId})::int as parts,
      (select count(*) from purchase_order_import_commits where dealer_id = ${dealerId})::int as commits`);
    const unresolved = await evaluateOrderImport(dealerId, rows, {}, tx);
    assert.match(unresolved[1].errors.join(" "), /choose Create or Skip/);
    const inspected = await evaluateOrderImport(dealerId, rows, decisions, tx);
    assert.equal(inspected.filter(r => !r.errors.length && !r.skipped).length, 3);
    assert.equal(inspected.filter(r => r.skipped).length, 1);
    assert.match(inspected[4].errors.join(" "), /Supplier code not found/);
    assert.match(inspected[5].errors.join(" "), /Customer reference not found/);
    const afterPreview = await tx.execute(sql`select
      (select count(*) from purchase_orders where dealer_id = ${dealerId})::int as orders,
      (select count(*) from parts where dealer_id = ${dealerId})::int as parts,
      (select count(*) from purchase_order_import_commits where dealer_id = ${dealerId})::int as commits`);
    assert.deepEqual(afterPreview.rows, before.rows, "preview must not write orders, parts or import ledger");

    const input = { dealerId, locationId: location.id, userId: null, fileName: "verification.csv", importKey, rows, decisions: { ...decisions }, inspected };
    const created = await commitOrderImport(tx, input);
    assert.equal(created.duplicate, false);
    assert.equal(created.orders.length, 2, "one draft PO per supplier");
    const purchaseOrders = await tx.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.dealerId, dealerId));
    assert.equal(purchaseOrders.length, 2);
    assert.deepEqual(purchaseOrders.map(po => po.supplierId).sort(), [supplierA.id, supplierB.id].sort());
    assert(purchaseOrders.every(po => po.status === "draft" && po.source === "import" && po.locationId === location.id));
    const lines = await tx.select().from(purchaseOrderLinesTable).where(eq(purchaseOrderLinesTable.dealerId, dealerId));
    assert.equal(lines.length, 3);
    const special = lines.find(line => line.partId === existing.id);
    assert(special?.isSpecialOrder && special.customerId === customer.id && special.jobCardId === job.id);
    const costs = await tx.execute(sql`select import_unit_cost::text as cost from purchase_order_lines where dealer_id = ${dealerId} order by import_unit_cost`);
    assert.deepEqual(costs.rows.map(row => row.cost), ["2.50", "8.75", "10.25"]);
    const links = await tx.execute(sql`select l.source_row_number, l.purchase_order_line_id
      from purchase_order_import_lines l join purchase_order_import_sources s on s.id=l.source_id where s.dealer_id=${dealerId}`);
    assert.deepEqual(links.rows.map(r => Number(r.source_row_number)).sort(), [2, 3, 5]);
    assert.equal((await tx.select().from(partsTable).where(and(eq(partsTable.dealerId, dealerId), eq(partsTable.sku, "NEW-SKIP")))).length, 0);
    assert.equal((await tx.select().from(partsTable).where(and(eq(partsTable.dealerId, dealerId), eq(partsTable.sku, "NEW-CREATE")))).length, 1);
    assert.equal((await commitOrderImport(tx, input)).duplicate, true, "same file must not import twice");
    assert.equal((await tx.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.dealerId, dealerId))).length, 2);
    // Identical idempotency key in another tenant must NOT collide. Its
    // supplier/customer references are resolved solely within that tenant.
    const foreignRows = await parseOrderFile("verification.csv", Buffer.from(
      "supplier_code,part_number,part_name,qty,unit_cost,special_order,customer_ref,ro_number\r\nVERIFY-A,FOREIGN-CREATE,Foreign part,1,1.00,N,,"
    ));
    const foreignPreview = await evaluateOrderImport(otherDealerId, foreignRows, { "2": "create" }, tx);
    assert.equal(foreignPreview[0].supplierId, foreignSupplier.id);
    const foreignResult = await commitOrderImport(tx, {
      dealerId: otherDealerId, locationId: otherLocation.id, userId: null,
      fileName: "verification.csv", importKey, rows: foreignRows,
      decisions: { "2": "create" }, inspected: foreignPreview,
    });
    assert.equal(foreignResult.duplicate, false, "dedupe ledger is dealer scoped");
    assert.equal((await tx.select().from(partsTable).where(and(eq(partsTable.dealerId, otherDealerId), eq(partsTable.sku, "NEW-CREATE")))).length, 0);
    console.log("P04 DB verified: preview no writes, invalid/cross-dealer rows, create/skip, supplier groups, decimal cost, linked draft lines, duplicate guard, tenant isolation.");
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
  const residue = await db.execute(sql`select
    (select count(*) from purchase_orders where dealer_id in (${dealerId}, ${otherDealerId}))::int as orders,
    (select count(*) from parts where dealer_id in (${dealerId}, ${otherDealerId}))::int as parts,
    (select count(*) from purchase_order_import_commits where dealer_id in (${dealerId}, ${otherDealerId}))::int as commits,
    (select count(*) from purchase_order_import_sources where dealer_id in (${dealerId}, ${otherDealerId}))::int as sources,
    (select count(*) from purchase_order_import_lines where dealer_id in (${dealerId}, ${otherDealerId}))::int as links`);
  assert.deepEqual(residue.rows[0], { orders: 0, parts: 0, commits: 0, sources: 0, links: 0 });
  console.log("P04 verification transaction rolled back.");
} finally {
  await pool.end();
}