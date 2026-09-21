/**
 * DEV-only fixture for the Parts browser flow (catalog import → OTC invoice).
 *
 * This deliberately imports the database only after the environment/database
 * guards.  It does not start the API, workers, mail, messaging, or ERP
 * integrations.  Setup leaves the fixture in place for the browser; cleanup
 * is explicit and accepts only the printed synthetic email/dealer id.
 */
export {};

if (process.env.NODE_ENV !== "development") {
  throw new Error("parts-browser-fixture is development-only (set NODE_ENV=development)");
}
process.env.OUTBOX_WORKER_DISABLED = "1";

const rawUrl = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!rawUrl) throw new Error("DATABASE_URL or DEV_DATABASE_URL is required");
const databaseUrl = new URL(rawUrl);
if (!new Set(["helium", "localhost", "127.0.0.1"]).has(databaseUrl.hostname.toLowerCase())) {
  throw new Error(`Database host "${databaseUrl.hostname}" is not development-allowlisted`);
}
if (process.env.PROD_DATABASE_URL) {
  const productionUrl = new URL(process.env.PROD_DATABASE_URL);
  if (`${productionUrl.host}${productionUrl.pathname}` === `${databaseUrl.host}${databaseUrl.pathname}`) {
    throw new Error("Development database matches PROD_DATABASE_URL");
  }
}
process.env.DATABASE_URL = rawUrl;

const { randomUUID } = await import("node:crypto");
const { pool } = await import("@workspace/db");

const marker = `parts-browser-${randomUUID().slice(0, 12)}`;
const email = `${marker}@aura-test.local`;
const cleanupOnly = process.argv.includes("--cleanup-fixture");
const requestedEmail = process.argv.find((arg) => arg.startsWith("--email="))?.slice(8);
const requestedDealerId = process.argv.find((arg) => arg.startsWith("--dealer-id="))?.slice(12);

async function fixtureIds(client: any) {
  const dealers = await client.query(
    `select id from dealers
       where name like 'DEV Parts Browser Fixture %' and created_by = 'parts-browser-fixture'
         and (($1::int is not null and id = $1::int)
           or ($1::int is null and exists (
             select 1 from dealer_users du join users u on u.id = du.user_id
             where du.dealer_id = dealers.id and lower(u.email) = lower($2)
               and u.clerk_id like 'parts-browser-fixture-%'
           )))`,
    [requestedDealerId ? Number(requestedDealerId) : null, requestedEmail ?? email],
  );
  const users = await client.query(
    "select id from users where lower(email) = lower($1) and clerk_id like 'parts-browser-fixture-%'",
    [requestedEmail ?? email],
  );
  return {
    dealerIds: dealers.rows.map((row: { id: number }) => row.id),
    userIds: users.rows.map((row: { id: number }) => row.id),
  };
}

/**
 * Delete every tenant-scoped row that can be found, with savepoints around
 * tables whose children have not yet been visited. Repeating passes lets
 * PostgreSQL FK ordering settle without broad/unscoped deletes.
 */
async function cleanup(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ids = await fixtureIds(client);
    if (!ids.dealerIds.length && !ids.userIds.length) {
      await client.query("rollback");
      console.log("cleanup=none");
      return;
    }
    const tables = await client.query<{ table_name: string }>(
      `select distinct table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'dealer_id'
         and table_name <> 'dealers'`,
    );
    for (let pass = 0; pass < 8; pass += 1) {
      for (const { table_name } of tables.rows) {
        await client.query("savepoint fixture_delete");
        try {
          await client.query(`delete from "${table_name.replaceAll('"', '""')}" where dealer_id = any($1::int[])`, [ids.dealerIds]);
          await client.query("release savepoint fixture_delete");
        } catch {
          await client.query("rollback to savepoint fixture_delete");
          await client.query("release savepoint fixture_delete");
        }
      }
    }
    // Membership is deliberately fixture-only; never touch another user's
    // membership while removing the tenant.
    if (ids.dealerIds.length) await client.query("delete from dealer_users where dealer_id = any($1::int[])", [ids.dealerIds]);
    if (ids.dealerIds.length) await client.query(
      "delete from dealers where id = any($1::int[]) and name like 'DEV Parts Browser Fixture %' and created_by = 'parts-browser-fixture'",
      [ids.dealerIds],
    );
    if (ids.userIds.length) await client.query("delete from users where id = any($1::int[])", [ids.userIds]);
    await client.query(
      "delete from roles where created_by = 'parts-browser-fixture' and description = 'Parts browser fixture GM permissions'",
    );
    await client.query("commit");
    console.log(`cleanup=removed dealerId=${ids.dealerIds.join(",")}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

if (cleanupOnly) {
  if (!requestedEmail && !requestedDealerId) {
    throw new Error("Cleanup requires --email=<printed fixture email> or --dealer-id=<printed dealer id>");
  }
  await cleanup();
  await pool.end();
} else {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Remove a prior interrupted fixture only when it has our exact marker.
    const old = await client.query<{ id: number }>(
      "select id from dealers where name like 'DEV Parts Browser Fixture %' and created_by = 'parts-browser-fixture'",
    );
    if (old.rows.length) throw new Error("Existing Parts browser fixture found; run --cleanup-fixture first");
    const gm = await client.query<{ id: number }>("select id from roles where name = 'General Manager' limit 1");
    if (!gm.rows[0]) throw new Error("General Manager role must exist");
    const dealer = await client.query<{ id: number }>(
      `insert into dealers (name, status, entitlements, created_by)
       values ($1, 'active', $2::jsonb, 'parts-browser-fixture') returning id`,
      [`DEV Parts Browser Fixture ${marker}`, {
        parts_module: true, finance_los: true, service_module: true,
        ai_agents: false, whatsapp_bot: false, gmail_intake: false, amber_connect: false,
      }],
    );
    const dealerId = dealer.rows[0]!.id;
    // Clone GM permissions into a dedicated role. The shared GM role and its
    // memberships are never modified.
    const role = await client.query<{ id: number }>(
      "insert into roles (name, description, is_system, created_by) values ($1, 'Parts browser fixture GM permissions', false, 'parts-browser-fixture') returning id",
      [`${marker} GM`],
    );
    await client.query(
      `insert into role_permissions (role_id, module, category)
       select $1, module, category from role_permissions where role_id = $2`,
      [role.rows[0]!.id, gm.rows[0]!.id],
    );
    const user = await client.query<{ id: number }>(
      `insert into users (clerk_id, email, name, role_id, last_active_dealer_id, created_by)
       values ($1, $2, 'Parts Browser Fixture GM', $3, $4, 'parts-browser-fixture') returning id`,
      [`parts-browser-fixture-${dealerId}`, email, role.rows[0]!.id, dealerId],
    );
    await client.query(
      `insert into dealer_users (dealer_id, user_id, role_id, is_general_manager)
       values ($1, $2, $3, true)`,
      [dealerId, user.rows[0]!.id, role.rows[0]!.id],
    );
    // OTC invoice creation requires a customer, but this synthetic customer
    // intentionally has no contact email, phone, or marketing consent.
    await client.query(
      `insert into customers (dealer_id, name, account_type, tags)
       values ($1, 'Parts Browser OTC Customer', 'person', ARRAY['parts-browser-fixture'])`,
      [dealerId],
    );
    await client.query("commit");
    console.log(`email=${email}`);
    console.log(`dealerId=${dealerId}`);
    console.log(`command=pnpm --filter @workspace/api-server exec tsx src/scripts/parts-browser-fixture.ts --cleanup-fixture --email=${email}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}