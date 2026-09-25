/**
 * Isolated temporary schema only, development connection and explicit allowlist.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!url || process.env.NODE_ENV !== "development" || process.env.TEST_PARTS_BILLING_DB !== "yes" || process.env.EXTERNAL_DATABASE_URL) {
  throw new Error("Requires NODE_ENV=development TEST_PARTS_BILLING_DB=yes; external connections prohibited.");
}
const schema = `parts_billing_fixture_${randomUUID().replaceAll("-", "")}`;
const isolatedUrl = new URL(url);
isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
// Dynamic import only after replacing the connection with the explicit test URL.
process.env.DATABASE_URL = isolatedUrl.toString();
const { pool } = await import("@workspace/db");
await pool.query(`CREATE SCHEMA "${schema}"`);
try {
  // Minimal real relational fixtures. No application/customer records touched.
  for (const table of ["customers", "job_cards", "invoices", "service_invoices", "part_requisition_lines", "payments", "job_card_parts"]) {
    await pool.query(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
    await pool.query(`INSERT INTO ${table} VALUES (1),(2),(3),(4)`);
  }
  await pool.query(readFileSync(new URL("../../../../lib/db/migrations/2026-09-27-parts-customer-billing.sql", import.meta.url), "utf8"));
  const a = await pool.connect(), b = await pool.connect();
  try {
    await a.query("BEGIN");
    await b.query("BEGIN");
    await a.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["parts-billing:1"]);
    await a.query(`INSERT INTO parts_invoice_sources (dealer_id,source_type,source_id,customer_id,invoice_id,lines,created_by)
      VALUES (1,'requisition',1,1,1,'[]',1)`);
    let secondAcquired = false;
    const secondLock = b.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["parts-billing:1"])
      .then(() => { secondAcquired = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(secondAcquired, false, "second generation waits for first transaction");
    await a.query("COMMIT");
    await secondLock;
    const existing = await b.query("SELECT invoice_id FROM parts_invoice_sources WHERE dealer_id=1 AND source_type='requisition' AND source_id=1");
    assert.equal(existing.rows[0].invoice_id, 1, "loser links to the first real invoice");
    await b.query("COMMIT");
    await assert.rejects(pool.query(`INSERT INTO parts_invoice_sources (dealer_id,source_type,source_id,customer_id,invoice_id,lines,created_by)
      VALUES (1,'requisition',1,1,2,'[]',1)`), (error: any) => error.code === "23505");
    await pool.query("INSERT INTO parts_billed_requisition_lines VALUES (1,1,1)");
    await assert.rejects(pool.query("INSERT INTO parts_billed_requisition_lines VALUES (1,1,2)"), (error: any) => error.code === "23505");
    await pool.query("INSERT INTO parts_billed_requisition_lines VALUES (2,1,2)");
    const scoped = await pool.query("SELECT invoice_id FROM parts_billed_requisition_lines WHERE dealer_id=1 AND requisition_line_id=1");
    assert.deepEqual(scoped.rows, [{ invoice_id: 1 }], "dealer scope cannot pick another branch's invoice");
    await assert.rejects(pool.query("INSERT INTO parts_estimate_charges (dealer_id,job_card_id,shipping_amount) VALUES (1,1,-1)"), (error: any) => error.code === "23514");
    await pool.query("INSERT INTO parts_estimate_charges (dealer_id,job_card_id,shipping_amount,duties_amount) VALUES (1,1,12.34,5.67)");
    const charges = await pool.query("SELECT shipping_amount,duties_amount FROM parts_estimate_charges WHERE dealer_id=1 AND job_card_id=1");
    assert.deepEqual(charges.rows, [{ shipping_amount: "12.34", duties_amount: "5.67" }]);
  } finally {
    await a.query("ROLLBACK"); await b.query("ROLLBACK"); a.release(); b.release();
  }
  console.log("Parts billing isolated concurrent source, customer/dealer scope, decimal and duplicate guards passed.");
} finally {
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
}