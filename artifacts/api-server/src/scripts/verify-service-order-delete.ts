/** Development-only SQL regression; all fixture writes are rolled back. */
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
export {};
function refuse(reason: string): never {
  console.error(`verify-service-order-delete refuses to run: ${reason}`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  refuse("NODE_ENV=production — this is a dev-only fixture suite.");
}
const rawDatabaseUrl = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!rawDatabaseUrl) refuse("DATABASE_URL or DEV_DATABASE_URL is not set.");
let databaseHost: string;
try {
  databaseHost = new URL(rawDatabaseUrl).hostname.toLowerCase();
} catch {
  refuse("The development database URL is not parseable.");
}
if (!new Set(["helium", "localhost", "127.0.0.1"]).has(databaseHost)) {
  refuse(
    `Database host "${databaseHost}" is not the allowlisted development host (helium/localhost).`,
  );
}
if (process.env.PROD_DATABASE_URL) {
  try {
    const production = new URL(process.env.PROD_DATABASE_URL);
    const development = new URL(rawDatabaseUrl);
    if (
      production.hostname === development.hostname &&
      production.port === development.port &&
      production.pathname === development.pathname
    ) {
      refuse("The development database URL matches PROD_DATABASE_URL.");
    }
  } catch {
    // The hard development-host allowlist remains the effective guard.
  }
}

const routeSource = await readFile(
  new URL("../routes/service.ts", import.meta.url),
  "utf8",
);
const invoiceStart = routeSource.indexOf("const [invoice]");
const transactionStart = routeSource.indexOf("await db.transaction", invoiceStart);
const invoiceGuard = routeSource.slice(invoiceStart, transactionStart);
assert(invoiceStart >= 0 && transactionStart > invoiceStart, "invoice guard moved or disappeared");
assert(invoiceGuard.includes("eq(serviceInvoicesTable.dealerId, dealerId)"));
assert(invoiceGuard.includes("eq(serviceInvoicesTable.serviceOrderId, order.id)"));
assert(invoiceGuard.includes("if (invoice)"));
const detachStart = routeSource.indexOf("update(webhookEventsTable)", transactionStart);
const serviceDeleteStart = routeSource.indexOf("delete(serviceOrdersTable)", transactionStart);
assert(detachStart >= 0, "service-order webhook ledger detach is missing");
assert(serviceDeleteStart > detachStart, "service order is deleted before webhook ledger detach");
assert(routeSource.slice(detachStart, serviceDeleteStart).includes("set({ serviceOrderId: null })"));

const { pool } = await import("@workspace/db");
let passed = 0;
function check(condition: unknown, message: string): void {
  assert(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}

async function main() {
  const client = await pool.connect();
  const dealerA = 2147000001;
  const dealerB = 2147000002;
  const marker = `verify-sod-${Date.now()}`;

  try {
    await client.query("BEGIN");
    const order = async (dealerId: number, label: string) => {
      const result = await client.query<{ id: number }>(
        `INSERT INTO service_orders
           (dealer_id, vehicle_info, scheduled_date, status)
         VALUES ($1, $2, CURRENT_DATE, 'acknowledged')
         RETURNING id`,
        [dealerId, `${marker}-${label}`],
      );
      return result.rows[0]!.id;
    };
    const ledger = async (
      dealerId: number,
      externalId: string,
      serviceOrderId: number,
    ) => {
      await client.query(
        `INSERT INTO webhook_events
           (dealer_id, channel, external_id, service_order_id)
         VALUES ($1, 'gmail_service_form', $2, $3)`,
        [dealerId, externalId, serviceOrderId],
      );
    };

    const targetOrder = await order(dealerA, "target");
    const sameDealerOrder = await order(dealerA, "same-dealer");
    const otherDealerOrder = await order(dealerB, "other-dealer");
    const targetExternalId = `${marker}-target-message`;
    await ledger(dealerA, targetExternalId, targetOrder);
    await ledger(dealerA, `${marker}-same-dealer-message`, sameDealerOrder);
    await ledger(dealerB, `${marker}-other-dealer-message`, otherDealerOrder);

    console.log("Service-order delete regression (uncommitted transaction)");
    console.log("\n1. Failed delete restores the detached FK reference");
    await client.query("SAVEPOINT failed_delete");
    let failed = false;
    try {
      await client.query(
        `UPDATE webhook_events
            SET service_order_id = NULL
          WHERE dealer_id = $1 AND service_order_id = $2`,
        [dealerA, targetOrder],
      );
      await client.query(
        "DELETE FROM service_orders WHERE dealer_id = $1 AND id = $2",
        [dealerA, targetOrder],
      );
      await client.query("SELECT 1 / 0");
    } catch {
      failed = true;
      await client.query("ROLLBACK TO SAVEPOINT failed_delete");
    }
    check(failed, "intentional transaction failure was observed");
    const restored = await client.query<{ service_order_id: number }>(
      `SELECT service_order_id FROM webhook_events
        WHERE channel = 'gmail_service_form' AND external_id = $1`,
      [targetExternalId],
    );
    check(restored.rows[0]?.service_order_id === targetOrder, "rollback restored ledger FK reference");
    await client.query("RELEASE SAVEPOINT failed_delete");

    console.log("\n2. Successful detach/delete preserves the idempotency ledger");
    await client.query(
      `UPDATE webhook_events
          SET service_order_id = NULL
        WHERE dealer_id = $1 AND service_order_id = $2`,
      [dealerA, targetOrder],
    );
    await client.query(
      "DELETE FROM service_orders WHERE dealer_id = $1 AND id = $2",
      [dealerA, targetOrder],
    );
    const deleted = await client.query("SELECT 1 FROM service_orders WHERE id = $1", [targetOrder]);
    check(deleted.rowCount === 0, "service order was deleted after FK detach");
    const detached = await client.query<{ service_order_id: number | null }>(
      `SELECT service_order_id FROM webhook_events
        WHERE channel = 'gmail_service_form' AND external_id = $1`,
      [targetExternalId],
    );
    check(detached.rows[0]?.service_order_id === null, "target ledger row was retained and detached");

    console.log("\n3. Other order/dealer references remain untouched");
    const untouched = await client.query<{ dealer_id: number; service_order_id: number }>(
      `SELECT dealer_id, service_order_id FROM webhook_events
        WHERE external_id LIKE $1 ORDER BY dealer_id`,
      [`${marker}-%message`],
    );
    check(
      untouched.rows.some((row) => row.dealer_id === dealerA && row.service_order_id === sameDealerOrder),
      "same-dealer ledger reference remains attached",
    );
    check(
      untouched.rows.some((row) => row.dealer_id === dealerB && row.service_order_id === otherDealerOrder),
      "other-dealer ledger reference remains attached",
    );

    console.log("\n4. Retained ledger still dedupes the same external message");
    await client.query("SAVEPOINT duplicate_ledger");
    let duplicateRejected = false;
    try {
      await client.query(
        `INSERT INTO webhook_events (dealer_id, channel, external_id, service_order_id)
         VALUES ($1, 'gmail_service_form', $2, NULL)`,
        [dealerA, targetExternalId],
      );
    } catch (error) {
      duplicateRejected = (error as { code?: string }).code === "23505";
      await client.query("ROLLBACK TO SAVEPOINT duplicate_ledger");
    }
    check(duplicateRejected, "same channel/externalId remains unique after deletion");
    await client.query("RELEASE SAVEPOINT duplicate_ledger");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

main()
  .then(async () => {
    console.log(`\n${passed} passed`);
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });