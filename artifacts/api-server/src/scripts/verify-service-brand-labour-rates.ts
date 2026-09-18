/**
 * Development-only brand labour fixture/regression. No app/workers are started
 * and no messaging connections are created. Default mode cleans up; pass
 * --keep-fixture for an isolated one-pass financial UI review.
 */
import assert from "node:assert/strict";

function refuse(reason: string): never {
  console.error(`verify-service-brand-labour-rates refuses to run: ${reason}`);
  process.exit(1);
}

if (process.env.NODE_ENV !== "development") refuse("NODE_ENV must be development");
process.env.OUTBOX_WORKER_DISABLED = "1";
const rawUrl = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!rawUrl) refuse("DATABASE_URL or DEV_DATABASE_URL is required");
const url = new URL(rawUrl);
if (!new Set(["helium", "localhost", "127.0.0.1"]).has(url.hostname.toLowerCase())) {
  refuse(`database host "${url.hostname}" is not development-allowlisted`);
}
if (process.env.PROD_DATABASE_URL) {
  const prod = new URL(process.env.PROD_DATABASE_URL);
  if (`${prod.host}${prod.pathname}` === `${url.host}${url.pathname}`) {
    refuse("development database matches PROD_DATABASE_URL");
  }
}

const { pool, db, serviceOrdersTable } = await import("@workspace/db");
const { ensureInitialJobCard } = await import("../lib/initial-job-card");
const { updateServiceSettings } = await import("../lib/service-settings");

const fixtureName = "DEV Brand Labour Fixture";
const fixtureEmail = "aura.brand-labour-fixture@example.test";
const keep = process.argv.includes("--keep-fixture");
const cleanupOnly = process.argv.includes("--cleanup-fixture");

async function cleanup(): Promise<void> {
  const dealer = await pool.query<{ id: number }>(
    "select id from dealers where name = $1",
    [fixtureName],
  );
  const user = await pool.query<{ id: number }>(
    "select id from users where lower(email) = lower($1)",
    [fixtureEmail],
  );
  for (const { id } of dealer.rows) {
    await pool.query("delete from service_invoices where dealer_id = $1", [id]);
    await pool.query("delete from job_cards where dealer_id = $1", [id]);
    await pool.query("delete from service_orders where dealer_id = $1", [id]);
    await pool.query("delete from customers where dealer_id = $1", [id]);
    await pool.query("delete from vehicles where dealer_id = $1", [id]);
    await pool.query("delete from dealer_service_settings where dealer_id = $1", [id]);
    await pool.query("delete from dealer_users where dealer_id = $1", [id]);
    await pool.query("delete from dealers where id = $1", [id]);
  }
  for (const { id } of user.rows) {
    await pool.query("delete from users where id = $1", [id]);
  }
}

if (cleanupOnly) {
  await cleanup();
  await pool.end();
  console.log("Brand labour DEV fixture removed.");
  process.exit(0);
}

await cleanup();
let dealerId: number | null = null;
try {
  const gmRole = await pool.query<{ id: number }>(
    "select id from roles where name = 'General Manager' limit 1",
  );
  assert.ok(gmRole.rows[0], "General Manager role must exist");
  dealerId = (await pool.query<{ id: number }>(
    `insert into dealers (name, status, entitlements, created_by)
     values ($1, 'active', '{"ai_agents":false,"whatsapp_bot":false,"gmail_intake":false}'::jsonb, 'brand-labour-verifier')
     returning id`,
    [fixtureName],
  )).rows[0]!.id;
  const userId = (await pool.query<{ id: number }>(
    `insert into users (clerk_id, email, name, role_id, last_active_dealer_id, created_by)
     values ($1, $2, 'Brand Labour Fixture GM', $3, $4, 'brand-labour-verifier')
     returning id`,
    [`fixture-brand-labour-${dealerId}`, fixtureEmail, gmRole.rows[0]!.id, dealerId],
  )).rows[0]!.id;
  await pool.query(
    `insert into dealer_users (dealer_id, user_id, role_id, is_general_manager)
     values ($1, $2, $3, true)`,
    [dealerId, userId, gmRole.rows[0]!.id],
  );
  await updateServiceSettings(dealerId, {
    labourUsdToGydRate: 209,
    brandLabourRates: [{ brand: " Fixture-Make ", labourUsdPerHour: 150 }],
  });
  const vehicleId = (await pool.query<{ id: number }>(
    `insert into vehicles
       (dealer_id, make, model, year, price, powertrain, mileage_km, exterior_color, body_type)
     values ($1, 'Fixture-Make', 'Verifier', 2099, 0, 'test', 0, 'test', 'test')
     returning id`,
    [dealerId],
  )).rows[0]!.id;
  const order = (await db.insert(serviceOrdersTable).values({
    dealerId,
    vehicleId,
    vehicleInfo: "2099 Fixture-Make Verifier",
    brand: "fixture-make",
    scheduledDate: "2099-01-15",
    customerPhoneSnapshot: "+5926000000",
  }).returning())[0]!;
  const card = await db.transaction((tx) => ensureInitialJobCard(tx, order));
  assert.equal(card?.laborRate, 31_350, "custom brand snapshot");

  await updateServiceSettings(dealerId, {
    brandLabourRates: [{ brand: "FIXTURE-MAKE", labourUsdPerHour: 160 }],
  });
  const historical = await pool.query<{ labor_rate: number }>(
    "select labor_rate from job_cards where id = $1 and dealer_id = $2",
    [card!.id, dealerId],
  );
  assert.equal(historical.rows[0]?.labor_rate, 31_350, "settings must not reprice history");

  const fallbackOrder = (await db.insert(serviceOrdersTable).values({
    dealerId,
    vehicleInfo: "Unknown make",
    brand: null,
    scheduledDate: "2099-01-16",
    customerPhoneSnapshot: "+5926000001",
  }).returning())[0]!;
  const fallbackCard = await db.transaction((tx) =>
    ensureInitialJobCard(tx, fallbackOrder),
  );
  assert.equal(fallbackCard?.laborRate, 25_080, "default USD 120 fallback");

  console.log("Brand labour DEV verification passed.");
  if (keep) {
    console.log(`dealerId=${dealerId}`);
    console.log(`test-user email=${fixtureEmail}`);
    console.log(`Open the UI with ?test-user=${encodeURIComponent(fixtureEmail)} and choose dealer ${dealerId}.`);
    console.log("Messaging is disabled for this isolated fixture dealer.");
    console.log("Cleanup: pnpm --filter @workspace/api-server exec tsx src/scripts/verify-service-brand-labour-rates.ts --cleanup-fixture");
  }
} finally {
  if (!keep) await cleanup();
  await pool.end();
}