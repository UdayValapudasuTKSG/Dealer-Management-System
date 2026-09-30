/**
 * Isolated, non-contactable fixture. Only a newly created dealer and users
 * are touched; all rows are removed even when a test fails. Requires an
 * already running local dev API. Never dispatches mail or background jobs.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pool } from "@workspace/db";

const dbUrl = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (process.env.NODE_ENV === "production" || !dbUrl ||
  !["helium", "localhost", "127.0.0.1"].includes(new URL(dbUrl).hostname) ||
  (process.env.PROD_DATABASE_URL && dbUrl === process.env.PROD_DATABASE_URL) ||
  (process.env.EXTERNAL_DATABASE_URL && dbUrl === process.env.EXTERNAL_DATABASE_URL)) {
  throw new Error("Refusing non-development database");
}
const base = process.env.REPORT_TEST_API_BASE ?? "http://localhost:8080/api";
const url = new URL(base);
if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/api")
  throw new Error("Only the existing loopback API is allowed");

const tag = randomUUID();
const rows = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) =>
  (await pool.query<T>(sql, args)).rows;
let dealerId: number | null = null;
const roleIds: number[] = [], userIds: number[] = [];
const money = "87,654,321";
async function request(email: string, type: string, format?: string) {
  const response = await fetch(`${base}/reports?type=${type}&from=2025-01-01&to=2026-12-31${format ? `&format=${format}` : ""}`, {
    headers: { "x-test-user-email": email, "x-dealer-id": String(dealerId) },
    cache: "no-store",
  });
  assert.equal(response.status, 200, `${type} ${format ?? "json"} HTTP ${response.status}`);
  return format
    ? execFileSync("pdftotext", ["-layout", "-", "-"], { input: Buffer.from(await response.arrayBuffer()) }).toString()
    : response.json() as Promise<any>;
}
try {
  const [dealer] = await rows<{ id: number }>(
    "INSERT INTO dealers(name,brand_name,timezone,usd_exchange_rate) VALUES ($1,$2,'America/Guyana',1) RETURNING id",
    [`pdf-safety-fixture-${tag}`, `DEMO PDF SAFETY ${tag.slice(0, 8)}`],
  );
  dealerId = dealer!.id;
  const identities: { email: string; roleId: number; userId: number }[] = [];
  for (const access of ["full", "hidden", "vehicle-only"]) {
    const [role] = await rows<{ id: number }>("INSERT INTO roles(name) VALUES ($1) RETURNING id", [`PDF fixture ${access} ${tag}`]);
    roleIds.push(role!.id);
    for (const module of ["leads", "deals", "inventory"])
      await rows("INSERT INTO role_permissions(role_id,module,category) VALUES ($1,$2,'view')", [role!.id, module]);
    if (access !== "full") for (const group of access === "hidden" ? ["deal_financials", "vehicle_pricing"] : ["vehicle_pricing"])
      await rows("INSERT INTO role_field_permissions(role_id,field_group,access) VALUES ($1,$2,'hidden')", [role!.id, group]);
    const email = `pdf-fixture-${access}-${tag}@example.invalid`;
    const [user] = await rows<{ id: number }>(
      "INSERT INTO users(clerk_id,email,name,status) VALUES ($1,$2,$3,'active') RETURNING id",
      [`pdf-fixture-${access}-${tag}`, email, "Demo PDF Fixture"],
    );
    userIds.push(user!.id);
    await rows("INSERT INTO dealer_users(dealer_id,user_id,role_id,is_general_manager) VALUES ($1,$2,$3,$4)",
      [dealerId, user!.id, role!.id, access === "vehicle-only"]);
    identities.push({ email, roleId: role!.id, userId: user!.id });
  }
  const [vehicle] = await rows<{ id: number }>(
    `INSERT INTO vehicles(dealer_id,make,model,year,price,powertrain,mileage_km,exterior_color,body_type)
     VALUES ($1,'Demo','Fictional',2025,87654321,'electric',0,'blue','sedan') RETURNING id`, [dealerId]);
  await rows(
    "INSERT INTO leads(dealer_id,name,phase,owner_user_id,interested_vehicle_id,email_opt_out) VALUES ($1,$2,'qualified',$3,$4,true)",
    [dealerId, "DEMO ONLY - NO CONTACT", identities[0]!.userId, vehicle!.id],
  );
  await rows(
    `INSERT INTO deals(dealer_id,vehicle_id,stage,vehicle_price,otd_price,discount,sales_advisor_user_id,sales_advisor)
     VALUES ($1,$2,'delivered',87654321,76543210,1234567,$3,'Demo PDF Fixture')`,
    [dealerId, vehicle!.id, identities[0]!.userId],
  );
  // Advisor scope for full actor's lead/deal matters only for the positive
  // comparison; hidden actor must also see the records to catch any leak.
  await rows("UPDATE leads SET owner_user_id=$1 WHERE dealer_id=$2", [identities[1]!.userId, dealerId]);
  await rows("UPDATE deals SET sales_advisor_user_id=$1 WHERE dealer_id=$2", [identities[1]!.userId, dealerId]);
  // Full actor is manager-tier without is_general_manager; grants are still
  // independent and can be compared with restricted actor in the same dealer.
  for (const type of ["sales_pipeline", "sales_performance", "inventory_aging"]) {
    const json = await request(identities[1]!.email, type);
    const pdf = await request(identities[1]!.email, type, "pdf") as string;
    const serialized = JSON.stringify(json);
    for (const sensitive of [money, "76,543,210", "1,234,567", "26,296,296"]) {
      assert.ok(!serialized.includes(sensitive), `${type} restricted JSON leaked financial value`);
      assert.ok(!pdf.includes(sensitive), `${type} restricted PDF leaked financial value`);
    }
    if (type === "sales_performance") {
      assert.deepEqual(json.chart.points, [], "restricted currency chart should contain no points");
      assert.equal(json.kpis.find((k: any) => k.label === "Gross (OTD)")?.value, "—");
    }
    if (type === "sales_pipeline") assert.ok(json.chart.points.some((p: any) => p.value > 0), "non-money counts should survive");
    console.log(`${type}: restricted JSON and PDF contain no money values; chart sanitized`);
  }
  // A separate full-access role in this dealer proves fixture money was
  // actually loaded, not simply absent. View via a leadership-tier membership
  // is unnecessary: compare raw inventory (dealer-scoped) instead.
  const full = await request(identities[0]!.email, "inventory_aging");
  assert.ok(JSON.stringify(full).includes(money), "positive control: full-access inventory must contain fixture price");
  console.log("positive control: full-access role sees fixture monetary values");
  const vehicleOnly = await request(identities[2]!.email, "sales_pipeline");
  assert.ok(!JSON.stringify(vehicleOnly).includes(money),
    "vehicle pricing restriction must also redact pipeline currency when deal figures remain viewable");
  assert.ok(!JSON.stringify(vehicleOnly).includes("76,543,210"),
    "pipeline monetary series must be redacted if either contributing group is restricted");
  const vehicleOnlyPdf = await request(identities[2]!.email, "sales_pipeline", "pdf") as string;
  assert.ok(!vehicleOnlyPdf.includes(money) && !vehicleOnlyPdf.includes("76,543,210"));
  console.log("vehicle-only pricing restriction: pipeline JSON and PDF suppress mixed-source currency");
} finally {
  if (dealerId) {
    for (const table of ["audit_logs", "activity", "deals", "leads", "vehicles", "dealer_users"])
      await rows(`DELETE FROM ${table} WHERE dealer_id=$1`, [dealerId]);
    await rows("DELETE FROM dealers WHERE id=$1", [dealerId]);
  }
  if (roleIds.length) {
    await rows("DELETE FROM role_field_permissions WHERE role_id=ANY($1::int[])", [roleIds]);
    await rows("DELETE FROM role_permissions WHERE role_id=ANY($1::int[])", [roleIds]);
    await rows("DELETE FROM roles WHERE id=ANY($1::int[])", [roleIds]);
  }
  if (userIds.length) await rows("DELETE FROM users WHERE id=ANY($1::int[])", [userIds]);
  await pool.end();
}