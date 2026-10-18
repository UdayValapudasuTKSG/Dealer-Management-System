/**
 * Isolated DEV-only prerequisite fixture for a real lead-to-close browser run.
 *   NODE_ENV=development pnpm exec tsx src/scripts/seed-lead-to-close-dev-fixture.ts
 *   NODE_ENV=development pnpm exec tsx src/scripts/seed-lead-to-close-dev-fixture.ts cleanup
 * Creates only a labelled dealer, two personas, and one available test vehicle.
 * No leads, quotes, deals, payments, approvals, or ERP connection are seeded.
 */
import { assertDevelopmentDatabase } from "./dev-db-guard";
const target = await assertDevelopmentDatabase();
const {
  db, dealersTable, usersTable, dealerUsersTable, rolesTable, rolePermissionsTable,
  vehiclesTable, leadsTable, leadVehicleInterestsTable, quotesTable, quoteItemsTable,
  quoteNumbersTable, dealsTable, dealItemsTable, bookingsTable, reservationAllocationsTable, gatesTable,
  deliveriesTable, invoicesTable, paymentsTable, timelineEventsTable, tasksTable,
  customersTable, documentsTable, auditLogsTable, emailLogsTable, notificationsTable,
  leadSourcesTable, agentRunsTable,
} = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");

const DEALER = "Lead-to-Close (dev-only blocked test)";
const PERSONAS = [
  { email: "ltc-sales@aura-fixture.invalid", name: "LTC Dev Sales (no contact)", role: "LTC Dev Sales", approve: false },
  { email: "ltc-finance-approver@aura-fixture.invalid", name: "LTC Dev Finance Approver", role: "LTC Dev Finance Approver", approve: true },
];

async function cleanup() {
  const [dealer] = await db.select().from(dealersTable).where(eq(dealersTable.name, DEALER));
  if (dealer) {
    for (const table of [
      reservationAllocationsTable, paymentsTable, invoicesTable, deliveriesTable,
      dealItemsTable, dealsTable, bookingsTable, gatesTable, quoteItemsTable,
      quoteNumbersTable, quotesTable, leadVehicleInterestsTable, tasksTable, timelineEventsTable,
      agentRunsTable, leadSourcesTable,
      documentsTable, emailLogsTable, notificationsTable, auditLogsTable,
      leadsTable, customersTable, vehiclesTable, dealerUsersTable,
    ]) await db.delete(table).where(eq(table.dealerId, dealer.id));
    await db.delete(dealersTable).where(eq(dealersTable.id, dealer.id));
  }
  await db.delete(usersTable).where(inArray(usersTable.email, PERSONAS.map(p => p.email)));
  const roles = await db.select().from(rolesTable).where(inArray(rolesTable.name, PERSONAS.map(p => p.role)));
  if (roles.length) {
    await db.delete(rolePermissionsTable).where(inArray(rolePermissionsTable.roleId, roles.map(r => r.id)));
    await db.delete(rolesTable).where(inArray(rolesTable.id, roles.map(r => r.id)));
  }
}

if (process.argv[2] === "cleanup") {
  await cleanup();
  console.log(`Cleaned ${DEALER} on development database ${target.database}`);
  process.exit(0);
}

await cleanup();
const [dealer] = await db.insert(dealersTable).values({
  name: DEALER, status: "active", city: "Georgetown", country: "Guyana",
  timezone: "America/Guyana", whatsappShowroomAddress: null, servicePhone: null,
}).returning();
const perms = ["view", "create", "edit"];
for (const p of PERSONAS) {
  const [role] = await db.insert(rolesTable).values({
    name: p.role, description: "DEV test persona only; isolated lead-to-close policy test",
  }).returning();
  const modules = ["dashboard", "inventory", "leads", "deals", "finance", "deliveries", "customers", "approvals"];
  await db.insert(rolePermissionsTable).values(modules.flatMap(module => [
    ...perms.map(category => ({ roleId: role!.id, module, category })),
    ...(p.approve && module === "finance" ? [{ roleId: role!.id, module, category: "approve" }] : []),
  ]));
  const [user] = await db.insert(usersTable).values({
    clerkId: `fixture-${p.email}`, email: p.email, name: p.name,
  }).returning();
  await db.insert(dealerUsersTable).values({
    dealerId: dealer!.id, userId: user!.id, roleId: role!.id,
    status: "active", isGeneralManager: p.approve,
  });
}
const [vehicle] = await db.insert(vehiclesTable).values({
  dealerId: dealer!.id, make: "BYD", model: "Atto 3", year: 2026,
  price: 7_450_000, powertrain: "ev", mileageKm: 0, exteriorColor: "LTC Test Blue",
  bodyType: "SUV", vin: "LTCDEV26ATTO00001", status: "available",
  description: "Clearly labelled DEV-only test unit; not a customer vehicle.",
}).returning();
console.log(JSON.stringify({
  database: target.database, dealerId: dealer!.id, dealerName: DEALER,
  personas: PERSONAS.map(p => ({ email: p.email, role: p.role })),
  vehicleId: vehicle!.id, vin: vehicle!.vin,
  cleanup: "NODE_ENV=development pnpm exec tsx src/scripts/seed-lead-to-close-dev-fixture.ts cleanup",
}, null, 2));
process.exit(0);
