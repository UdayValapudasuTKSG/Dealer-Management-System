/**
 * Isolated DEV-ONLY browser fixture for the sales finance desk.
 *   seed:    tsx src/scripts/seed-sales-finance-browser-fixture.ts
 *   cleanup: tsx src/scripts/seed-sales-finance-browser-fixture.ts cleanup
 * No ERPNext connection is created (postings stay queued); the lead/customer
 * have no email or phone, so no fixture communication can be sent.
 */
import { assertDevelopmentDatabase } from "./dev-db-guard";
const target = await assertDevelopmentDatabase();
const {
  db, dealersTable, usersTable, dealerUsersTable, rolesTable, rolePermissionsTable, leadsTable, vehiclesTable, dealsTable,
  invoicesTable, paymentsTable, erpnextConnectionsTable, erpnextSyncJobsTable, erpnextRefsTable, auditLogsTable,
  salesAccountingSettingsTable, salesAccountingWorkflowsTable, salesAccountingEntriesTable, salesFinanceRequestsTable,
} = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");

const DEALER = "Sales Finance (dev fixture browser)";
const PERSONAS = [
  { email: "sfr-requester@aura-fixture.invalid", name: "Rhea Persaud (SFR requester)", role: "SFR Fixture Requester", perms: ["view", "create", "edit"] },
  { email: "sfr-approver@aura-fixture.invalid", name: "Devon Bacchus (SFR approver)", role: "SFR Fixture Approver", perms: ["view", "create", "edit", "approve"] },
];

async function cleanup() {
  const [d] = await db.select().from(dealersTable).where(eq(dealersTable.name, DEALER));
  if (d) {
    for (const t of [salesFinanceRequestsTable, salesAccountingEntriesTable, paymentsTable, erpnextRefsTable, erpnextSyncJobsTable, invoicesTable,
      salesAccountingWorkflowsTable, salesAccountingSettingsTable, dealsTable, vehiclesTable, leadsTable, auditLogsTable, erpnextConnectionsTable, dealerUsersTable]) {
      await db.delete(t).where(eq(t.dealerId, d.id));
    }
    await db.delete(dealersTable).where(eq(dealersTable.id, d.id));
  }
  await db.delete(usersTable).where(inArray(usersTable.email, PERSONAS.map((p) => p.email)));
  const roles = await db.select().from(rolesTable).where(inArray(rolesTable.name, PERSONAS.map((p) => p.role)));
  if (roles.length) {
    await db.delete(rolePermissionsTable).where(inArray(rolePermissionsTable.roleId, roles.map((r) => r.id)));
    await db.delete(rolesTable).where(inArray(rolesTable.id, roles.map((r) => r.id)));
  }
}

if (process.argv[2] === "cleanup") {
  await cleanup();
  console.log(`Cleaned browser fixture on ${target.database}`);
  process.exit(0);
}
await cleanup(); // idempotent reseed
const [dealer] = await db.insert(dealersTable).values({ name: DEALER, status: "active", city: "Georgetown", country: "Guyana" }).returning();
const D = dealer!.id;
const users: Record<string, number> = {};
for (const p of PERSONAS) {
  const [role] = await db.insert(rolesTable).values({ name: p.role, description: "Dev fixture persona for the sales finance desk" }).returning();
  await db.insert(rolePermissionsTable).values([
    ...p.perms.map((c) => ({ roleId: role!.id, module: "finance", category: c })),
    { roleId: role!.id, module: "leads", category: "view" }, { roleId: role!.id, module: "deals", category: "view" },
    { roleId: role!.id, module: "inventory", category: "view" },
  ]);
  const [u] = await db.insert(usersTable).values({ clerkId: `fixture-${p.email}`, email: p.email, name: p.name }).returning();
  users[p.email] = u!.id;
  await db.insert(dealerUsersTable).values({ dealerId: D, userId: u!.id, roleId: role!.id, status: "active" });
}
const requesterId = users[PERSONAS[0]!.email]!;
await db.insert(salesAccountingSettingsTable).values({ dealerId: D, updatedBy: requesterId, revision: 1,
  // Fake but well-formed mappings, marked valid so the approval path is exercisable.
  validation: { state: "valid", errors: [] },
  config: {
    accounts: [
      { key: "receivables", account: "Debtors - CMDF" }, { key: "vatOutput", account: "VAT Output 14% - CMDF" },
      { key: "registration", account: "Registration Expense - CMDF" }, { key: "fuel", account: "Fuel Expense - CMDF" },
      { key: "detailing", account: "PDI & Detailing - CMDF" }, { key: "deposits", account: "Customer Deposits - CMDF" },
    ],
    sources: [
      { id: "rbl-ops", label: "Republic Bank operating", kind: "bank", account: "Republic Bank 4471 - CMDF" },
      { id: "front-cash", label: "Showroom cash drawer", kind: "cash", account: "Cash - CMDF" },
      { id: "sales-float", label: "Sales team float", kind: "float", account: "Petty Float - CMDF" },
      { id: "gra-agent", label: "Licensing agent (supplier)", kind: "supplier", account: "Creditors - CMDF" },
    ],
    models: [{ make: "BYD", model: "Atto 3", income: "Vehicle Sales BYD - CMDF", dutyFreeIncome: "", inventory: "Vehicle Stock - CMDF", cogs: "Vehicle COGS - CMDF", discount: "Sales Discounts - CMDF" }],
    customerCharges: [{ category: "fuel", incomeAccount: "Fuel Recharge Income - CMDF", taxTreatment: "taxable", vatRate: 14, amountIncludesVat: true, approved: true, approvalReference: "FIN-POL-0917" }],
  } });
const [lead] = await db.insert(leadsTable).values({ dealerId: D, name: "Anjali Ramdass (fixture)", channel: "walkin", source: "showroom", phase: "negotiation", status: "qualified", emailOptOut: true }).returning();
const [veh] = await db.insert(vehiclesTable).values({ dealerId: D, make: "BYD", model: "Atto 3", year: 2026, price: 7_450_000, powertrain: "ev", mileageKm: 0, exteriorColor: "Surf Blue", bodyType: "SUV", vin: "LGXCE4CB0S0FX7731" }).returning();
const [deal] = await db.insert(dealsTable).values({ dealerId: D, vehicleId: veh!.id, leadId: lead!.id, customerName: "Anjali Ramdass (fixture)", vehiclePrice: 7_450_000, otdPrice: 8_493_000, stage: "committed" }).returning();
await db.insert(salesAccountingWorkflowsTable).values({ dealerId: D, dealId: deal!.id, startedBy: requesterId });
const [inv] = await db.insert(invoicesTable).values({ dealerId: D, invoiceNumber: "CMDF-INV-0001", customerName: "Anjali Ramdass (fixture)", dealId: deal!.id, kind: "final", status: "issued",
  description: "BYD Atto 3 2026 (VIN LGXCE4CB0S0FX7731)", amount: 8_493_000, currency: "GYD",
  taxLines: [{ code: "VAT", name: "VAT 14%", kind: "percent", rate: 14, amount: 1_043_000 }] }).returning();
const [conn] = await db.select({ id: erpnextConnectionsTable.id }).from(erpnextConnectionsTable).where(eq(erpnextConnectionsTable.dealerId, D));
if (conn) throw new Error("Fixture dealer unexpectedly has an ERPNext connection");
console.log(JSON.stringify({ database: target.database, dealerId: D, leadId: lead!.id, dealId: deal!.id, invoiceId: inv!.id, users }, null, 2));
process.exit(0);
