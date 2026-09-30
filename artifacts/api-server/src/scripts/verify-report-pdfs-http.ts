/**
 * Against an ALREADY RUNNING loopback development API. Read-only source data;
 * exports write their normal audit trail. Never prints or persists user data.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pool } from "@workspace/db";

const base = process.env.REPORT_TEST_API_BASE ?? "http://localhost:8080/api";
const url = new URL(base);
assert.equal(url.protocol, "http:");
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
assert.equal(url.pathname, "/api");
const dbUrl = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
assert.ok(dbUrl && ["helium", "localhost", "127.0.0.1"].includes(new URL(dbUrl).hostname));
assert.notEqual(process.env.NODE_ENV, "production");

const types = [
  "sales_pipeline", "sales_performance", "sales_advisor_activity",
  "inventory_aging", "finance_applications", "service_workshop",
  "parts_inventory", "revenue_receivables", "tax_gra", "delivery_operations",
  "agent_activity", "collision_claims",
];
const modules = [
  "leads", "deals", "leads", "inventory", "finance", "service",
  "parts", "finance", "gra", "deliveries", "settings", "service",
];
const q = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) =>
  (await pool.query<T>(sql, args)).rows;
type Persona = { dealer_id: number; email: string; brand: string; role_id: number };
const people = await q<Persona>(`
  SELECT du.dealer_id, u.email, coalesce(nullif(d.brand_name,''), d.name) brand, du.role_id
    FROM dealer_users du JOIN users u ON u.id=du.user_id
    JOIN dealers d ON d.id=du.dealer_id
    JOIN roles r ON r.id=du.role_id
    WHERE u.email IS NOT NULL AND u.status='active' AND d.status='active'
      AND (du.is_general_manager OR r.name='General Manager' OR r.name='Leadership')
    ORDER BY (SELECT count(*) FROM leads l WHERE l.dealer_id=du.dealer_id) DESC`);
assert.ok(people.length, "No existing General Manager dev persona");
const actor = people[0]!;
const foreign = people.find(p => p.dealer_id !== actor.dealer_id);
const headers = (who: Persona, dealer = who.dealer_id) => ({
  "x-test-user-email": who.email, "x-dealer-id": String(dealer),
  "Cache-Control": "no-store",
});
const from = "2025-01-01", to = "2026-12-31";
async function get(who: Persona, path: string, dealer = who.dealer_id) {
  return fetch(`${base}${path}`, { headers: headers(who, dealer), cache: "no-store" });
}
function pdfText(data: Buffer): string {
  return execFileSync("pdftotext", ["-layout", "-", "-"], {
    input: data, maxBuffer: 20_000_000,
  }).toString("utf8");
}
function contains(text: string, value: string) {
  // PDFKit may line-break long user-entered values; test short KPI values and
  // all labels against whitespace-normalized extracted text.
  const normalize = (s: string) => s.replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");
  return normalize(text).includes(normalize(value));
}
const prefix = `/reports?from=${from}&to=${to}`;
for (const type of types) {
  const path = `${prefix}&type=${type}`;
  const jsonResponse = await get(actor, path);
  assert.equal(jsonResponse.status, 200, `${type} JSON HTTP ${jsonResponse.status}`);
  const data = await jsonResponse.json() as {
    label: string; kpis: { label: string; value: string }[];
    table: { columns: string[]; rows: string[][] };
  };
  const pdfResponse = await get(actor, `${path}&format=pdf&_export=${Date.now()}`);
  assert.equal(pdfResponse.status, 200, `${type} PDF HTTP ${pdfResponse.status}`);
  assert.ok(pdfResponse.headers.get("content-type")?.includes("application/pdf"));
  assert.ok(pdfResponse.headers.get("cache-control")?.includes("no-store"));
  const bytes = Buffer.from(await pdfResponse.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
  if (type === "delivery_operations") await writeFile("/tmp/aura-report-delivery.pdf", bytes);
  const text = pdfText(bytes);
  assert.ok(contains(text, actor.brand), `${type} branding differs from active dealer`);
  assert.ok(contains(text, data.label), `${type} missing report title`);
  for (const kpi of data.kpis) {
    assert.ok(contains(text, kpi.label.toUpperCase()), `${type} missing KPI label`);
    if (kpi.value.length < 22 && kpi.value !== "—")
      assert.ok(contains(text, kpi.value), `${type} KPI ${kpi.label} value differs from JSON`);
  }
  assert.ok(data.table.rows.length === 0 || contains(text, data.table.rows[0]![0]!), `${type} detail differs from JSON`);
  if (type === "sales_pipeline") await writeFile("/tmp/aura-report-live.pdf", bytes);
  console.log(`${type}: 200 PDF · branded · ${data.kpis.length} KPIs · ${data.table.rows.length} JSON detail rows`);
}
const call = await get(actor, "/reports/call-centre");
assert.equal(call.status, 200, `call-centre JSON HTTP ${call.status}`);
const callJson = await call.json() as { activeFollowUp: number; qualifiedTransferred: number };
const callPdf = await get(actor, `/reports/call-centre?format=pdf&_export=${Date.now()}`);
assert.equal(callPdf.status, 200, `call-centre PDF HTTP ${callPdf.status}`);
const callText = pdfText(Buffer.from(await callPdf.arrayBuffer()));
assert.ok(contains(callText, actor.brand));
assert.ok(contains(callText, "Call Centre Qualification"));
assert.ok(contains(callText, String(callJson.activeFollowUp)));
assert.ok(contains(callText, String(callJson.qualifiedTransferred)));
console.log("call_centre: 200 PDF · branded · scoped counts equal JSON");

if (foreign) {
  const cross = await get(actor, `${prefix}&type=sales_pipeline&format=pdf`, foreign.dealer_id);
  assert.ok([403, 404].includes(cross.status), `cross-dealer export unexpectedly returned ${cross.status}`);
  const own = await get(foreign, `${prefix}&type=sales_pipeline&format=pdf`);
  assert.equal(own.status, 200);
  const otherText = pdfText(Buffer.from(await own.arrayBuffer()));
  assert.ok(contains(otherText, foreign.brand));
  assert.ok(!contains(otherText, actor.brand) || actor.brand === foreign.brand);
  console.log(`cross-dealer: foreign membership denied HTTP ${cross.status}; other dealer's own branded PDF HTTP 200`);
} else {
  console.log("cross-dealer: only one existing eligible GM persona; no fixture created");
}
await pool.end();