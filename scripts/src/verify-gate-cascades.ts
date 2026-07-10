import { and, eq, gt } from "drizzle-orm";
import {
  db,
  pool,
  dealsTable,
  financeApplicationsTable,
  vehiclesTable,
  gatesTable,
  timelineEventsTable,
} from "@workspace/db";

// End-to-end verification that every never-list gate cascade advances the
// correct downstream record AND writes a matching timeline receipt when
// resolved through the real HTTP endpoint (POST /api/gates/:id/resolve).
//
// Each scenario builds its own isolated fixtures, resolves the gate over HTTP,
// asserts the downstream mutation + receipt, then cleans up after itself so the
// check is repeatable and does not pollute demo data.

const BASE = process.env.API_BASE ?? "http://localhost:80/api";

type ResolveBody = {
  action: "approve" | "adjust" | "dismiss";
  note?: string;
  adjustedAmount?: number;
  resolvedBy?: string;
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail: string) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(`${name} \u2014 ${detail}`);
    console.log(`  \u2717 ${name} \u2014 ${detail}`);
  }
}

async function resolveGate(id: number, body: ResolveBody) {
  const res = await fetch(`${BASE}/gates/${id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`resolve ${id} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// Returns the receipt row written for this gate resolution, if any. Scoped by
// refType/refId and a timestamp taken just before the resolve call so we never
// match a pre-existing receipt.
async function findReceipt(
  refType: string,
  refId: number,
  since: Date,
  kind: string,
) {
  const rows = await db
    .select()
    .from(timelineEventsTable)
    .where(
      and(
        eq(timelineEventsTable.refType, refType),
        eq(timelineEventsTable.refId, refId),
        eq(timelineEventsTable.kind, kind),
        gt(timelineEventsTable.createdAt, since),
      ),
    );
  return rows[0];
}

async function makeVehicle(status = "available"): Promise<number> {
  const [v] = await db
    .insert(vehiclesTable)
    .values({
      make: "TEST",
      model: "Cascade",
      year: 2026,
      price: 50000,
      powertrain: "ev",
      mileageKm: 0,
      exteriorColor: "White",
      bodyType: "suv",
      status,
    })
    .returning();
  return v.id;
}

async function cleanup(ids: {
  gateIds?: number[];
  dealIds?: number[];
  financeIds?: number[];
  vehicleIds?: number[];
  receiptIds?: number[];
}) {
  if (ids.receiptIds?.length)
    for (const id of ids.receiptIds)
      await db.delete(timelineEventsTable).where(eq(timelineEventsTable.id, id));
  if (ids.gateIds?.length)
    for (const id of ids.gateIds)
      await db.delete(gatesTable).where(eq(gatesTable.id, id));
  if (ids.financeIds?.length)
    for (const id of ids.financeIds)
      await db
        .delete(financeApplicationsTable)
        .where(eq(financeApplicationsTable.id, id));
  if (ids.dealIds?.length)
    for (const id of ids.dealIds)
      await db.delete(dealsTable).where(eq(dealsTable.id, id));
  if (ids.vehicleIds?.length)
    for (const id of ids.vehicleIds)
      await db.delete(vehiclesTable).where(eq(vehiclesTable.id, id));
}

// --- below_floor_price: approve and adjust both mutate the deal ------------
async function testBelowFloorPrice(action: "approve" | "adjust") {
  const label = `below_floor_price (${action})`;
  console.log(`\n${label}`);
  const vehicleId = await makeVehicle();
  const [deal] = await db
    .insert(dealsTable)
    .values({
      vehicleId,
      customerName: "Cascade Test",
      stage: "negotiation",
      vehiclePrice: 120000,
      discount: 0,
      tradeInValue: 10000,
      accessories: 2000,
      otdPrice: 112000,
    })
    .returning();

  const requested = 6500;
  const adjusted = 4000;
  const [gate] = await db
    .insert(gatesTable)
    .values({
      type: "below_floor_price",
      status: "pending",
      priority: "high",
      refType: "deal",
      refId: deal.id,
      title: "Cascade test below-floor",
      summary: "test",
      amount: requested,
      floorAmount: 113400,
      evidence: [],
    })
    .returning();

  const since = new Date();
  await resolveGate(
    gate.id,
    action === "adjust" ? { action, adjustedAmount: adjusted } : { action },
  );

  const expected = action === "adjust" ? adjusted : requested;
  const [after] = await db
    .select()
    .from(dealsTable)
    .where(eq(dealsTable.id, deal.id));
  const expectedOtd = 120000 - expected - 10000 + 2000;
  check(
    `${label}: deal.discount = ${expected}`,
    after.discount === expected,
    `got ${after.discount}`,
  );
  check(
    `${label}: deal.otdPrice recomputed = ${expectedOtd}`,
    after.otdPrice === expectedOtd,
    `got ${after.otdPrice}`,
  );

  const receipt = await findReceipt(
    "deal",
    deal.id,
    since,
    "gate_below_floor_price",
  );
  check(
    `${label}: receipt written with refType=deal refId=${deal.id}`,
    !!receipt,
    "no matching receipt",
  );

  await cleanup({
    receiptIds: receipt ? [receipt.id] : [],
    gateIds: [gate.id],
    dealIds: [deal.id],
    vehicleIds: [vehicleId],
  });
}

// --- credit_decline: approve -> declined, adjust -> under_review -----------
async function testCreditDecline(action: "approve" | "adjust") {
  const label = `credit_decline (${action})`;
  console.log(`\n${label}`);
  const [fin] = await db
    .insert(financeApplicationsTable)
    .values({
      customerName: "Cascade Test",
      amount: 56990,
      termMonths: 60,
      apr: 6.9,
      status: "under_review",
    })
    .returning();

  const [gate] = await db
    .insert(gatesTable)
    .values({
      type: "credit_decline",
      status: "pending",
      priority: "high",
      refType: "finance",
      refId: fin.id,
      title: "Cascade test credit",
      summary: "test",
      amount: 56990,
      evidence: [],
    })
    .returning();

  const since = new Date();
  await resolveGate(gate.id, { action });

  const expected = action === "adjust" ? "under_review" : "declined";
  const [after] = await db
    .select()
    .from(financeApplicationsTable)
    .where(eq(financeApplicationsTable.id, fin.id));
  check(
    `${label}: finance.status = ${expected}`,
    after.status === expected,
    `got ${after.status}`,
  );

  const receipt = await findReceipt(
    "finance",
    fin.id,
    since,
    "gate_credit_decline",
  );
  check(
    `${label}: receipt written with refType=finance refId=${fin.id}`,
    !!receipt,
    "no matching receipt",
  );

  await cleanup({
    receiptIds: receipt ? [receipt.id] : [],
    gateIds: [gate.id],
    financeIds: [fin.id],
  });
}

// --- capital_order: approve -> vehicle in_transit -------------------------
async function testCapitalOrder(action: "approve" | "adjust") {
  const label = `capital_order (${action})`;
  console.log(`\n${label}`);
  const vehicleId = await makeVehicle("available");
  const [gate] = await db
    .insert(gatesTable)
    .values({
      type: "capital_order",
      status: "pending",
      priority: "normal",
      refType: "vehicle",
      refId: vehicleId,
      title: "Cascade test capital",
      summary: "test",
      amount: 156900,
      evidence: [],
    })
    .returning();

  const since = new Date();
  await resolveGate(
    gate.id,
    action === "adjust" ? { action, adjustedAmount: 150000 } : { action },
  );

  const [after] = await db
    .select()
    .from(vehiclesTable)
    .where(eq(vehiclesTable.id, vehicleId));
  check(
    `${label}: vehicle.status = in_transit`,
    after.status === "in_transit",
    `got ${after.status}`,
  );

  const receipt = await findReceipt(
    "vehicle",
    vehicleId,
    since,
    "gate_capital_order",
  );
  check(
    `${label}: receipt written with refType=vehicle refId=${vehicleId}`,
    !!receipt,
    "no matching receipt",
  );

  await cleanup({
    receiptIds: receipt ? [receipt.id] : [],
    gateIds: [gate.id],
    vehicleIds: [vehicleId],
  });
}

// --- gra_filing: no downstream mutation, receipt only ---------------------
async function testGraFiling() {
  const label = `gra_filing (approve)`;
  console.log(`\n${label}`);
  const vehicleId = await makeVehicle();
  const [deal] = await db
    .insert(dealsTable)
    .values({
      vehicleId,
      customerName: "Cascade Test",
      stage: "delivered",
      vehiclePrice: 54000,
      otdPrice: 78300,
    })
    .returning();

  const [gate] = await db
    .insert(gatesTable)
    .values({
      type: "gra_filing",
      status: "pending",
      priority: "normal",
      refType: "deal",
      refId: deal.id,
      title: "Cascade test GRA",
      summary: "test",
      amount: 24300,
      evidence: [],
    })
    .returning();

  const before = { ...deal };
  const since = new Date();
  await resolveGate(gate.id, { action: "approve" });

  const [after] = await db
    .select()
    .from(dealsTable)
    .where(eq(dealsTable.id, deal.id));
  check(
    `${label}: deal left unchanged (no downstream mutation)`,
    after.stage === before.stage && after.otdPrice === before.otdPrice,
    `stage ${after.stage}, otd ${after.otdPrice}`,
  );

  const receipt = await findReceipt("deal", deal.id, since, "gate_gra_filing");
  check(
    `${label}: receipt written with refType=deal refId=${deal.id}`,
    !!receipt,
    "no matching receipt",
  );

  await cleanup({
    receiptIds: receipt ? [receipt.id] : [],
    gateIds: [gate.id],
    dealIds: [deal.id],
    vehicleIds: [vehicleId],
  });
}

// --- refund_release: vehicle refType -> available -------------------------
async function testRefundReleaseVehicle() {
  const label = `refund_release (approve, vehicle)`;
  console.log(`\n${label}`);
  const vehicleId = await makeVehicle("reserved");
  const [gate] = await db
    .insert(gatesTable)
    .values({
      type: "refund_release",
      status: "pending",
      priority: "low",
      refType: "vehicle",
      refId: vehicleId,
      title: "Cascade test refund vehicle",
      summary: "test",
      amount: 2500,
      evidence: [],
    })
    .returning();

  const since = new Date();
  await resolveGate(gate.id, { action: "approve" });

  const [after] = await db
    .select()
    .from(vehiclesTable)
    .where(eq(vehiclesTable.id, vehicleId));
  check(
    `${label}: vehicle.status = available`,
    after.status === "available",
    `got ${after.status}`,
  );

  const receipt = await findReceipt(
    "vehicle",
    vehicleId,
    since,
    "gate_refund_release",
  );
  check(
    `${label}: receipt written with refType=vehicle refId=${vehicleId}`,
    !!receipt,
    "no matching receipt",
  );

  await cleanup({
    receiptIds: receipt ? [receipt.id] : [],
    gateIds: [gate.id],
    vehicleIds: [vehicleId],
  });
}

// --- refund_release: deal refType -> depositPaid false --------------------
async function testRefundReleaseDeal() {
  const label = `refund_release (approve, deal)`;
  console.log(`\n${label}`);
  const vehicleId = await makeVehicle();
  const [deal] = await db
    .insert(dealsTable)
    .values({
      vehicleId,
      customerName: "Cascade Test",
      stage: "reserved",
      vehiclePrice: 50000,
      otdPrice: 50000,
      depositPaid: true,
    })
    .returning();

  const [gate] = await db
    .insert(gatesTable)
    .values({
      type: "refund_release",
      status: "pending",
      priority: "low",
      refType: "deal",
      refId: deal.id,
      title: "Cascade test refund deal",
      summary: "test",
      amount: 2500,
      evidence: [],
    })
    .returning();

  const since = new Date();
  await resolveGate(gate.id, { action: "approve" });

  const [after] = await db
    .select()
    .from(dealsTable)
    .where(eq(dealsTable.id, deal.id));
  check(
    `${label}: deal.depositPaid = false`,
    after.depositPaid === false,
    `got ${after.depositPaid}`,
  );

  const receipt = await findReceipt(
    "deal",
    deal.id,
    since,
    "gate_refund_release",
  );
  check(
    `${label}: receipt written with refType=deal refId=${deal.id}`,
    !!receipt,
    "no matching receipt",
  );

  await cleanup({
    receiptIds: receipt ? [receipt.id] : [],
    gateIds: [gate.id],
    dealIds: [deal.id],
    vehicleIds: [vehicleId],
  });
}

async function main() {
  console.log(`Verifying gate cascades against ${BASE} ...`);

  // Fail fast if the API server is not reachable.
  try {
    const ping = await fetch(`${BASE}/gates`, { method: "GET" });
    if (!ping.ok) throw new Error(`GET /gates returned ${ping.status}`);
  } catch (err) {
    console.error(
      `\nAPI server not reachable at ${BASE}. Start the api-server workflow first.`,
    );
    console.error(err);
    await pool.end();
    process.exit(1);
  }

  await testBelowFloorPrice("approve");
  await testBelowFloorPrice("adjust");
  await testCreditDecline("approve");
  await testCreditDecline("adjust");
  await testCapitalOrder("approve");
  await testCapitalOrder("adjust");
  await testGraFiling();
  await testRefundReleaseVehicle();
  await testRefundReleaseDeal();

  console.log(`\n${"=".repeat(48)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
