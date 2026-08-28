import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  dealersTable,
  dealsTable,
  dealItemsTable,
  deliveriesTable,
  financeApplicationsTable,
  invoicesTable,
  notificationsTable,
  usersTable,
  dealerUsersTable,
  rolePermissionsTable,
  timelineEventsTable,
  vehiclesTable,
} from "@workspace/db";
import { transitionFinanceStatus } from "../lib/finance-effects";
import { commitDealWithAllocations } from "../lib/deal-commit";

const marker = `finance-multi-item-${Date.now()}`;
const vehicleIds: number[] = [];
const dealIds: number[] = [];
const financeIds: number[] = [];
let server: import("node:http").Server | null = null;

async function vehicle(
  dealerId: number,
  model: string,
  variant: string,
  color: string,
  suffix: number,
) {
  const token = String(suffix).padStart(6, "0");
  const [row] = await db.insert(vehiclesTable).values({
    dealerId,
    make: "AURA-TEST",
    model,
    variant,
    year: 2026,
    vin: `TESTVIN0000${token}`.slice(0, 17),
    engineNumber: `TESTENG0000${token}`.slice(0, 17),
    price: 100,
    powertrain: "gasoline",
    mileageKm: 0,
    exteriorColor: color,
    bodyType: "test",
    status: "available",
    description: marker,
  }).returning();
  vehicleIds.push(row!.id);
  return row!;
}

async function fixture(
  dealerId: number,
  demand: Array<{ seedId: number; quantity: number; position: number }>,
) {
  const [deal] = await db.insert(dealsTable).values({
    dealerId,
    vehicleId: demand[0]!.seedId,
    customerName: marker,
    vehiclePrice: 100,
    otdPrice: demand.reduce((sum, item) => sum + item.quantity * 100, 0),
    finalPaymentMethod: "bank_financing",
  }).returning();
  dealIds.push(deal!.id);
  await db.insert(dealItemsTable).values(demand.map((item) => ({
    dealerId,
    dealId: deal!.id,
    vehicleId: item.seedId,
    quantity: item.quantity,
    position: item.position,
    vehiclePrice: 100,
    total: item.quantity * 100,
  })));
  const [finance] = await db.insert(financeApplicationsTable).values({
    dealerId,
    dealId: deal!.id,
    customerName: marker,
    amount: deal!.otdPrice,
    termMonths: 12,
    apr: 1,
    status: "approved",
  }).returning();
  financeIds.push(finance!.id);
  return { deal: deal!, finance: finance! };
}

try {
  const [dealer] = await db.select({ id: dealersTable.id }).from(dealersTable).limit(1);
  assert.ok(dealer, "A dealer fixture is required");

  const a1 = await vehicle(dealer.id, `${marker}-A`, "VX", "Blue", 1);
  await vehicle(dealer.id, `${marker}-A`, "VX", "Blue", 2);
  const b1 = await vehicle(dealer.id, `${marker}-B`, "GT", "White", 3);
  const success = await fixture(dealer.id, [
    { seedId: a1.id, quantity: 2, position: 0 },
    { seedId: b1.id, quantity: 1, position: 1 },
  ]);
  await transitionFinanceStatus(success.finance.id, "disbursed", "integration test");
  await transitionFinanceStatus(success.finance.id, "disbursed", "repeat callback");
  const deliveries = await db.select().from(deliveriesTable).where(and(
    eq(deliveriesTable.dealerId, dealer.id),
    eq(deliveriesTable.dealId, success.deal.id),
  ));
  assert.equal(deliveries.length, 3);
  assert.equal(new Set(deliveries.map((row) => row.vehicleId)).size, 3);
  assert.deepEqual(
    deliveries.map((row) => `${row.dealItemId}:${row.dealItemUnit}`).sort(),
    [...new Set(deliveries.map((row) => `${row.dealItemId}:${row.dealItemUnit}`))].sort(),
  );

  const lone = await vehicle(dealer.id, `${marker}-C`, "LX", "Red", 4);
  const failure = await fixture(dealer.id, [
    { seedId: lone.id, quantity: 2, position: 0 },
  ]);
  const [financeUser] = await db.select({ email: usersTable.email })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(usersTable.id, dealerUsersTable.userId))
    .innerJoin(
      rolePermissionsTable,
      eq(rolePermissionsTable.roleId, dealerUsersTable.roleId),
    )
    .where(and(
      eq(dealerUsersTable.dealerId, dealer.id),
      eq(usersTable.status, "active"),
      eq(rolePermissionsTable.module, "finance"),
      eq(rolePermissionsTable.category, "edit"),
    )).limit(1);
  assert.ok(financeUser?.email, "An active finance editor is required");
  process.env.AUTH_BYPASS = "1";
  process.env.NODE_ENV = "test";
  const app = (await import("../app")).default;
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  // Direct/lead-less POST must create its compatibility item, and the shared
  // manual commit operation must remain idempotent.
  const directVehicle = await vehicle(
    dealer.id,
    `${marker}-DIRECT`,
    "DX",
    "Black",
    5,
  );
  const [dealUser] = await db.select({ email: usersTable.email })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(usersTable.id, dealerUsersTable.userId))
    .innerJoin(
      rolePermissionsTable,
      eq(rolePermissionsTable.roleId, dealerUsersTable.roleId),
    )
    .where(and(
      eq(dealerUsersTable.dealerId, dealer.id),
      eq(usersTable.status, "active"),
      eq(rolePermissionsTable.module, "deals"),
      eq(rolePermissionsTable.category, "create"),
    )).limit(1);
  assert.ok(dealUser?.email, "An active deal creator is required");
  const directResponse = await fetch(`${baseUrl}/deals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-user-email": dealUser.email,
      "x-dealer-id": String(dealer.id),
    },
    body: JSON.stringify({
      vehicleId: directVehicle.id,
      vehiclePrice: 100,
      otdPrice: 100,
      customerName: marker,
    }),
  });
  const directBody = await directResponse.json() as { id?: number; items?: unknown[] };
  assert.equal(directResponse.status, 201);
  assert.ok(directBody.id);
  dealIds.push(directBody.id);
  assert.equal(directBody.items?.length, 1);
  await commitDealWithAllocations({ dealId: directBody.id, dealerId: dealer.id });
  await commitDealWithAllocations({ dealId: directBody.id, dealerId: dealer.id });
  const directDeliveries = await db.select().from(deliveriesTable)
    .where(eq(deliveriesTable.dealId, directBody.id));
  assert.equal(directDeliveries.length, 1);

  const endpoint = await fetch(
    `${baseUrl}/finance-applications/${failure.finance.id}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-test-user-email": financeUser.email,
        "x-dealer-id": String(dealer.id),
      },
      body: JSON.stringify({ status: "disbursed" }),
    },
  );
  const endpointBody = await endpoint.json() as { error?: string };
  assert.equal(endpoint.status, 409);
  assert.equal(endpointBody.error, "insufficient_inventory");
  const [failedDeal] = await db.select().from(dealsTable)
    .where(eq(dealsTable.id, failure.deal.id));
  const [failedFinance] = await db.select().from(financeApplicationsTable)
    .where(eq(financeApplicationsTable.id, failure.finance.id));
  const failedDeliveries = await db.select().from(deliveriesTable)
    .where(eq(deliveriesTable.dealId, failure.deal.id));
  const failedItems = await db.select().from(dealItemsTable)
    .where(eq(dealItemsTable.dealId, failure.deal.id));
  const [failedVehicle] = await db.select().from(vehiclesTable)
    .where(eq(vehiclesTable.id, lone.id));
  assert.equal(failedDeal?.stage, "desking");
  assert.equal(failedFinance?.status, "approved");
  assert.equal(failedDeliveries.length, 0);
  assert.deepEqual(failedItems.map((item) => item.status), ["open"]);
  assert.equal(failedVehicle?.status, "available");
  console.log("finance multi-item commit integration passed");
} finally {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => error ? reject(error) : resolve()),
    );
  }
  if (dealIds.length) {
    await db.delete(timelineEventsTable).where(and(
      eq(timelineEventsTable.refType, "deal"),
      inArray(timelineEventsTable.refId, dealIds),
    ));
    await db.delete(invoicesTable).where(inArray(invoicesTable.dealId, dealIds));
    await db.delete(deliveriesTable).where(inArray(deliveriesTable.dealId, dealIds));
  }
  if (financeIds.length) {
    await db.delete(timelineEventsTable).where(and(
      eq(timelineEventsTable.refType, "finance"),
      inArray(timelineEventsTable.refId, financeIds),
    ));
  }
  await db.delete(notificationsTable).where(
    eq(notificationsTable.body, `${marker} — GY$300 / 12 mo. integration test`),
  );
  if (financeIds.length)
    await db.delete(financeApplicationsTable).where(inArray(financeApplicationsTable.id, financeIds));
  if (dealIds.length) await db.delete(dealsTable).where(inArray(dealsTable.id, dealIds));
  if (vehicleIds.length) await db.delete(vehiclesTable).where(inArray(vehiclesTable.id, vehicleIds));
  await pool.end();
}