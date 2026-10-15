// Explicit one-time data operation; no schema changes and no ERPNext writes.
// Credentials/connection strings remain in the process environment, never logs.
import pg from "../lib/db/node_modules/pg/lib/index.js";
if (!process.argv.includes("--apply-approved-hold")) {
  throw new Error("Explicit --apply-approved-hold is required for this production data operation.");
}
const pool = new pg.Pool({ connectionString: process.env.PROD_DATABASE_URL, connectionTimeoutMillis: 10000 });
if (!process.env.PROD_DATABASE_URL) throw new Error("Production database secret is required.");
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '30s'");
  await client.query("SELECT pg_advisory_xact_lock(76042, 2)");
  const { rows } = await client.query(`
    SELECT d.name, c.site_url, c.company_name, c.enabled
    FROM dealers d JOIN erpnext_connections c ON c.dealer_id=d.id
    WHERE d.id=2 FOR UPDATE OF c
  `);
  const c = rows[0];
  if (rows.length !== 1 || c.name.trim().toLowerCase() !== "cam motors dummy" ||
    c.site_url.replace(/\/+$/, "") !== "https://erpnext-jcy-qlx.m.frappe.cloud" || c.company_name !== "GT AUTOMOTIVE") {
    throw new Error("Approved dummy dealership/company boundary does not match; no changes made.");
  }
  await client.query("UPDATE erpnext_connections SET enabled=false, updated_at=now() WHERE dealer_id=2");
  const result = await client.query(`
    UPDATE erpnext_sync_jobs
    SET payload = payload || jsonb_build_object('financeReviewHold',
          jsonb_build_object('heldAt', now(), 'previousStatus', status, 'previousError', last_error,
            'reason', 'User requested Finance review before reconnecting legacy financial queue')),
        status='dead', next_attempt_at=NULL,
        last_error='Finance review hold: legacy financial record must not be retried automatically.',
        updated_at=now()
    WHERE dealer_id=2 AND direction='outbound'
      AND doctype IN ('Sales Invoice','Payment Entry')
      AND status IN ('queued','failed','dead','processing')
      AND NOT (payload ? 'financeReviewHold')
    RETURNING id,doctype
  `);
  await client.query(`
    INSERT INTO audit_logs (dealer_id,action,module,entity_type,entity_id,summary,details)
    VALUES (2,'update','finance','erpnext_connection','2',$1,$2::jsonb)
  `, ["Paused dummy ERP sync and held legacy financial records for Finance review",
    JSON.stringify({ previousEnabled: c.enabled, jobIds: result.rows.map(r => r.id), credentialsChanged: false, postedDocumentsChanged: false })]);
  await client.query("COMMIT");
  console.log(JSON.stringify({ paused: true, held: result.rows.length,
    byType: result.rows.reduce((a, r) => ({ ...a, [r.doctype]: (a[r.doctype] ?? 0) + 1 }), {}) }));
} catch {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Hold operation failed or target guard rejected it. No credentials are logged.");
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
