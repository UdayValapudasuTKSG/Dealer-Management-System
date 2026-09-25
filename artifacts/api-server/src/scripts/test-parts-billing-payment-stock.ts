import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.NODE_ENV !== "development" || process.env.TEST_PARTS_BILLING_DB !== "yes" || process.env.EXTERNAL_DATABASE_URL) {
  throw new Error("Development only: TEST_PARTS_BILLING_DB=yes required; external connections prohibited.");
}
const connection = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!connection) throw new Error("Development database is required");
const schema = `parts_money_stock_fixture_${randomUUID().replaceAll("-", "")}`;
const url = new URL(connection);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const { pool, db } = await import("@workspace/db");
const { applyPartsDepositCredit } = await import("../lib/invoicing");
const { issueJobParts } = await import("../lib/job-part-stock");
const q = async (text: string, values: any[] = []) => (await pool.query(text, values)).rows;
await q(`CREATE SCHEMA "${schema}"`);
try {
  const tables = ["invoices", "payments", "receipts", "parts_deposit_allocations", "parts",
    "job_card_parts", "inventory_locations", "inventory_bins", "inventory_levels",
    "inventory_transactions", "inventory_cost_layers", "inventory_cost_consumptions",
    "inventory_holds", "inventory_cycle_counts", "inventory_cycle_count_lines", "part_pricing_policies"];
  for (const table of tables) {
    // Copy schema only, never operational data. LIKE does not copy foreign keys.
    await q(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    const serials = await q(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 AND column_default LIKE 'nextval(%'`, [schema, table]);
    for (const row of serials) {
      const sequence = `${table}_${row.column_name}_fixture_seq`;
      await q(`CREATE SEQUENCE "${schema}"."${sequence}" START 10000`);
      await q(`ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${row.column_name}"
        SET DEFAULT nextval('"${schema}"."${sequence}"'::regclass)`);
    }
  }
  await q(`INSERT INTO invoices(id,dealer_id,invoice_number,customer_id,customer_name,amount,kind,status,currency)
    VALUES (1,1,'DEP-1',1,'Fixture customer',100,'reservation','paid','GYD'),
    (2,1,'PART-2',1,'Fixture customer',80,'final','issued','GYD'),
    (3,1,'PART-3',1,'Fixture customer',80,'final','issued','GYD'),
    (4,1,'PART-4',1,'Fixture customer',10,'final','issued','GYD'),
    (5,1,'PART-5',2,'Other fixture customer',10,'final','issued','GYD')`);
  await q(`INSERT INTO payments(id,dealer_id,invoice_id,customer_name,amount,method,reference)
    VALUES (1,1,1,'Fixture customer',100,'cash','Authentic fixture deposit')`);
  const credit = (invoiceId: number, amount: number, customerId = 1, dealerId = 1) => db.transaction(tx =>
    applyPartsDepositCredit(tx, { dealerId, customerId, depositInvoiceId: 1, invoiceId,
      amount, actorId: 1, actorName: "Fixture finance authorizer" }));
  const simultaneous = await Promise.allSettled([credit(2, 80), credit(3, 80)]);
  assert.equal(simultaneous.filter(r => r.status === "fulfilled").length, 1, "only one concurrent credit may consume the deposit");
  assert.equal(simultaneous.filter(r => r.status === "rejected").length, 1);
  assert.equal(Number((await q("SELECT sum(amount) AS paid FROM payments WHERE invoice_id=1"))[0].paid), 20);
  assert.equal((await q("SELECT count(*)::int AS n FROM parts_deposit_allocations"))[0].n, 1);
  assert.equal((await q("SELECT count(*)::int AS n FROM receipts"))[0].n, 0, "credit never fabricates cash receipts");
  assert.equal((await q("SELECT count(*)::int AS n FROM payments WHERE method='account_credit'"))[0].n, 2);
  await assert.rejects(credit(4, 15), /balance/, "target invoice caps are checked under lock");
  await assert.rejects(credit(4, 25), /balance/, "deposit availability caps are checked under lock");
  await assert.rejects(credit(5, 5), /same-customer/);
  await assert.rejects(credit(4, 5, 2), /same-customer/);
  await assert.rejects(credit(4, 5, 1, 2), /same-customer/);
  const winner = simultaneous[0].status === "fulfilled" ? 2 : 3;
  await assert.rejects(credit(winner, 1), /already applied/);
  await credit(4, 10);
  assert.equal((await q("SELECT status FROM invoices WHERE id=4"))[0].status, "paid");
  assert.equal(Number((await q("SELECT sum(amount) AS paid FROM payments WHERE invoice_id=1"))[0].paid), 10);
  console.log("PASS actual atomic deposit helper: concurrent cap, invoice cap, customer/dealer ownership, duplicate guard, no fabricated receipts.");

  await q("INSERT INTO parts(id,dealer_id,sku,name,stock,unit_cost,unit_price) VALUES(1,1,'FIXTURE','Fixture part',10,5,10)");
  await q(`INSERT INTO job_card_parts(id,dealer_id,job_card_id,part_id,part_name,kind,quantity,unit_price,issued_quantity,backordered)
    VALUES(1,1,1,1,'Fixture part','issue',2,10,0,false),
    (2,1,1,1,'Historical issued part','issue',3,10,NULL,false),
    (3,1,1,1,'Partially issued part','issue',5,10,2,false),
    (4,1,1,1,'Insufficient stock part','issue',100,10,0,false)`);
  const issue = (lineId: number, dealerId = 1) => db.transaction(tx => issueJobParts(tx, dealerId, 1, lineId));
  const issued = await Promise.all([issue(1), issue(1)]);
  assert.equal(issued.reduce((sum, result) => sum + result.length, 0), 1);
  assert.equal((await q("SELECT stock FROM parts WHERE id=1"))[0].stock, 8);
  assert.deepEqual(await issue(1), []);
  assert.deepEqual(await issue(2), [], "historical null issuedQuantity must never issue twice");
  assert.equal((await q("SELECT stock FROM parts WHERE id=1"))[0].stock, 8);
  const partial = await issue(3);
  assert.equal(partial[0].quantity, 3, "only the unissued remainder is deducted");
  assert.equal((await q("SELECT stock FROM parts WHERE id=1"))[0].stock, 5);
  await assert.rejects(issue(4), /Insufficient/);
  assert.equal((await q("SELECT issued_quantity FROM job_card_parts WHERE id=4"))[0].issued_quantity, 0);
  await assert.rejects(issue(1, 2), /not found/);
  assert.equal((await q("SELECT stock FROM parts WHERE id=1"))[0].stock, 5);
  assert.equal((await q("SELECT count(*)::int AS n FROM inventory_transactions WHERE type='issue'"))[0].n, 2);
  console.log("PASS actual stock helper: concurrent exactly-once issue, historical issuedUnits, partial issue, shortage rollback, dealer isolation.");
} finally {
  await q(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
}