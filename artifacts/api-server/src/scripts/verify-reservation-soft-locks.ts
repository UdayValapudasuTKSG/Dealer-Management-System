// Multi-unit reservation soft locks.
// Verifies: full reservation payment holds one distinct VIN per requested
// unit (all-or-nothing), duplicate callbacks are idempotent, competing
// reservations never double-lock, insufficient stock leaves no partial
// holds while the payment stays recorded, commitment adopts the held VINs,
// cancellation releases holds safely, expiry sweeps lapse holds, and
// everything stays dealer-scoped.
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  dealersTable,
  dealsTable,
  dealItemsTable,
  dealerUsersTable,
  bookingsTable,
  deliveriesTable,
  gatesTable,
  invoicesTable,
  usersTable,
  rolePermissionsTable,
  leadsTable,
  leadVehicleInterestsTable,
  quotesTable,
  notificationsTable,
  paymentsTable,
  receiptsTable,
  reservationAllocationsTable,
  timelineEventsTable,
  vehiclesTable,
} from "@workspace/db";
import { issueInvoice, applyPayment } from "../lib/invoicing";
import {
  allocateReservationInventory,
  expireLapsedReservationHolds,
  releaseReservationHolds,
} from "../lib/reservation-allocations";
import { commitDealWithAllocations } from "../lib/deal-commit";
import { cascadeDealCancellation } from "../lib/cancellation";

// The imported app starts background workers on timers; once cleanup calls
// pool.end() their in-flight queries reject with "Cannot use a pool after
// calling end on the pool". That race is harmless here — ignore only it.
process.on("unhandledRejection", (err) => {
  const texts = [
    String(err),
    String((err as { cause?: unknown } | null)?.cause ?? ""),
  ];
  if (texts.some((t) => t.includes("after calling end on the pool"))) return;
  throw err;
});

const marker = `resv-lock-${Date.now()}`;
const vehicleIds: number[] = [];
const dealIds: number[] = [];
const invoiceIds: number[] = [];
const bookingIds: number[] = [];
const gateIds: number[] = [];
let swapLeadId: number | null = null;
let server: import("node:http").Server | null = null;

async function vehicle(
  dealerId: number,
  model: string,
  suffix: number,
  overrides: Partial<typeof vehiclesTable.$inferInsert> = {},
) {
  const token = String(suffix).padStart(6, "0");
  const [row] = await db.insert(vehiclesTable).values({
    dealerId,
    make: "RESV-TEST",
    model,
    variant: "VX",
    year: 2026,
    vin: `RESVVIN0000${token}`.slice(0, 17),
    engineNumber: `RESVENG0000${token}`.slice(0, 17),
    price: 100,
    powertrain: "gasoline",
    mileageKm: 0,
    exteriorColor: "Blue",
    bodyType: "test",
    status: "available",
    description: marker,
    ...overrides,
  }).returning();
  vehicleIds.push(row!.id);
  return row!;
}

async function dealFixture(
  dealerId: number,
  demand: Array<{ model: string; quantity: number; position: number }>,
) {
  // deals.vehicle_id is a legacy NOT NULL provenance column; allocation
  // matches the frozen deal-item specification, never this seed.
  const [seed] = await db.select({ id: vehiclesTable.id }).from(vehiclesTable)
    .where(eq(vehiclesTable.dealerId, dealerId)).limit(1);
  assert.ok(seed, "A seed vehicle is required");
  const [deal] = await db.insert(dealsTable).values({
    dealerId,
    vehicleId: seed.id,
    customerName: marker,
    vehiclePrice: 100,
    otdPrice: demand.reduce((sum, item) => sum + item.quantity * 100, 0),
  }).returning();
  dealIds.push(deal!.id);
  const items = await db.insert(dealItemsTable).values(demand.map((line) => ({
    dealerId,
    dealId: deal!.id,
    make: "RESV-TEST",
    model: line.model,
    modelYear: 2026,
    variant: "VX",
    color: "Blue",
    quantity: line.quantity,
    position: line.position,
    vehiclePrice: 100,
    total: line.quantity * 100,
  }))).returning();
  return { deal: deal!, items };
}

async function payReservation(dealerId: number, dealId: number, amount: number, reference: string) {
  const invoice = await issueInvoice({
    dealerId,
    kind: "reservation",
    dealId,
    customerName: marker,
    amount,
    description: `${marker} reservation`,
  });
  invoiceIds.push(invoice.id);
  await applyPayment({
    invoice,
    amount,
    method: "cash",
    reference,
    receivedBy: marker,
  });
  return invoice;
}

const activeHolds = (dealId: number) =>
  db.select().from(reservationAllocationsTable).where(and(
    eq(reservationAllocationsTable.dealId, dealId),
    eq(reservationAllocationsTable.status, "active"),
  ));

try {
  const dealers = await db.select({ id: dealersTable.id }).from(dealersTable).limit(2);
  const dealer = dealers[0];
  assert.ok(dealer, "A dealer fixture is required");

  // ── 1. Multi-line hold: 2×A + 1×B, all-or-nothing, distinct VINs ──
  await vehicle(dealer.id, `${marker}-A`, 1);
  await vehicle(dealer.id, `${marker}-A`, 2);
  await vehicle(dealer.id, `${marker}-B`, 3);
  const multi = await dealFixture(dealer.id, [
    { model: `${marker}-A`, quantity: 2, position: 0 },
    { model: `${marker}-B`, quantity: 1, position: 1 },
  ]);
  await payReservation(dealer.id, multi.deal.id, 300, `${marker}-pay-1`);
  let holds = await activeHolds(multi.deal.id);
  assert.equal(holds.length, 3, "every requested unit is held");
  assert.equal(new Set(holds.map((h) => h.vehicleId)).size, 3, "held VINs are distinct");
  const heldVehicles = await db.select().from(vehiclesTable)
    .where(inArray(vehiclesTable.id, holds.map((h) => h.vehicleId)));
  assert.ok(heldVehicles.every((v) => v.status === "reserved" && v.holdReason === "reservation_hold"));
  const [multiDeal] = await db.select().from(dealsTable).where(eq(dealsTable.id, multi.deal.id));
  assert.equal(multiDeal?.reservationHoldStatus, "held");
  assert.equal(multiDeal?.depositPaid, true);

  // ── 2. Duplicate callback is idempotent ──
  const again = await allocateReservationInventory({
    dealId: multi.deal.id, dealerId: dealer.id, invoiceId: null,
  });
  assert.equal(again, "already_held");
  assert.equal((await activeHolds(multi.deal.id)).length, 3);

  // ── 3. Competing reservation cannot double-lock the same stock ──
  const rival = await dealFixture(dealer.id, [
    { model: `${marker}-A`, quantity: 1, position: 0 },
  ]);
  await payReservation(dealer.id, rival.deal.id, 100, `${marker}-pay-2`);
  const [rivalDeal] = await db.select().from(dealsTable).where(eq(dealsTable.id, rival.deal.id));
  assert.equal(rivalDeal?.reservationHoldStatus, "unfulfilled", "no free A units remain");
  assert.equal((await activeHolds(rival.deal.id)).length, 0, "no partial/duplicate holds");
  const [rivalInvoicePaid] = await db.select().from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceIds[1]!));
  assert.equal(rivalInvoicePaid?.status, "paid", "payment stays recorded");

  // ── 4. Insufficient stock for multi-line: NO partial holds ──
  await vehicle(dealer.id, `${marker}-C`, 4);
  const short = await dealFixture(dealer.id, [
    { model: `${marker}-C`, quantity: 1, position: 0 },
    { model: `${marker}-D`, quantity: 1, position: 1 }, // no D stock at all
  ]);
  await payReservation(dealer.id, short.deal.id, 200, `${marker}-pay-3`);
  assert.equal((await activeHolds(short.deal.id)).length, 0, "all-or-nothing");
  const [freeC] = await db.select().from(vehiclesTable).where(and(
    eq(vehiclesTable.dealerId, dealer.id),
    eq(vehiclesTable.model, `${marker}-C`),
  ));
  assert.equal(freeC?.status, "available", "C unit was not partially locked");
  const [shortDeal] = await db.select().from(dealsTable).where(eq(dealsTable.id, short.deal.id));
  assert.equal(shortDeal?.reservationHoldStatus, "unfulfilled");

  // ── 5. Commitment adopts the held VINs exactly ──
  const heldIds = new Set(holds.map((h) => h.vehicleId));
  await commitDealWithAllocations({ dealId: multi.deal.id, dealerId: dealer.id });
  const deliveries = await db.select().from(deliveriesTable)
    .where(eq(deliveriesTable.dealId, multi.deal.id));
  assert.equal(deliveries.length, 3);
  assert.deepEqual(
    [...new Set(deliveries.map((d) => d.vehicleId))].sort(),
    [...heldIds].sort(),
    "commit adopted the SAME held VINs",
  );
  const finalized = await db.select().from(reservationAllocationsTable).where(and(
    eq(reservationAllocationsTable.dealId, multi.deal.id),
    eq(reservationAllocationsTable.status, "finalized"),
  ));
  assert.equal(finalized.length, 3, "holds were finalized, not released");
  assert.equal((await activeHolds(multi.deal.id)).length, 0);
  const [committed] = await db.select().from(dealsTable).where(eq(dealsTable.id, multi.deal.id));
  assert.equal(committed?.stage, "committed");
  assert.equal(committed?.reservationHoldStatus, null);

  // ── 6. Cancellation releases holds safely ──
  await vehicle(dealer.id, `${marker}-E`, 5);
  const cancelMe = await dealFixture(dealer.id, [
    { model: `${marker}-E`, quantity: 1, position: 0 },
  ]);
  await payReservation(dealer.id, cancelMe.deal.id, 100, `${marker}-pay-4`);
  assert.equal((await activeHolds(cancelMe.deal.id)).length, 1);
  const [cancelDeal] = await db.select().from(dealsTable).where(eq(dealsTable.id, cancelMe.deal.id));
  await cascadeDealCancellation({
    deal: cancelDeal!,
    reasonCode: "customer_changed_mind",
    releaseVehicle: true,
    actor: marker,
  });
  assert.equal((await activeHolds(cancelMe.deal.id)).length, 0);
  const [freedE] = await db.select().from(vehiclesTable).where(and(
    eq(vehiclesTable.dealerId, dealer.id), eq(vehiclesTable.model, `${marker}-E`),
  ));
  assert.equal(freedE?.status, "available", "cancelled reservation freed its unit");

  // ── 7. Expiry sweep releases lapsed holds ──
  await vehicle(dealer.id, `${marker}-F`, 6);
  const lapse = await dealFixture(dealer.id, [
    { model: `${marker}-F`, quantity: 1, position: 0 },
  ]);
  await payReservation(dealer.id, lapse.deal.id, 100, `${marker}-pay-5`);
  await db.update(reservationAllocationsTable)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(reservationAllocationsTable.dealId, lapse.deal.id));
  // Direct commit BEFORE any sweep runs must reject the lapsed holds and
  // mutate nothing — commitment never depends on the lazy expiry sweep.
  await assert.rejects(
    () => commitDealWithAllocations({ dealId: lapse.deal.id, dealerId: dealer.id }),
    /lapsed|re-hold/i,
    "lapsed active holds must block commitment even before the sweep",
  );
  assert.equal(
    (await db.select().from(deliveriesTable)
      .where(eq(deliveriesTable.dealId, lapse.deal.id))).length,
    0,
    "no deliveries were created for the lapsed reservation",
  );
  assert.equal((await activeHolds(lapse.deal.id)).length, 1, "rejection did not mutate the ledger");
  await expireLapsedReservationHolds();
  assert.equal((await activeHolds(lapse.deal.id)).length, 0);
  const lapsedRows = await db.select().from(reservationAllocationsTable).where(and(
    eq(reservationAllocationsTable.dealId, lapse.deal.id),
    eq(reservationAllocationsTable.status, "released"),
  ));
  assert.equal(lapsedRows[0]?.releasedReason, "expired");
  const [freedF] = await db.select().from(vehiclesTable).where(and(
    eq(vehiclesTable.dealerId, dealer.id), eq(vehiclesTable.model, `${marker}-F`),
  ));
  assert.equal(freedF?.status, "available");
  // A lapsed paid reservation stays blocked: it must NOT commit by picking
  // replacement stock — the deal is marked unfulfilled until re-held.
  const [lapsedDeal] = await db.select().from(dealsTable)
    .where(eq(dealsTable.id, lapse.deal.id));
  assert.equal(lapsedDeal?.reservationHoldStatus, "unfulfilled");
  await assert.rejects(
    () => commitDealWithAllocations({ dealId: lapse.deal.id, dealerId: dealer.id }),
    /re-hold|resolve inventory/i,
    "expired holds must block commitment",
  );
  const [fStillFree] = await db.select().from(vehiclesTable).where(and(
    eq(vehiclesTable.dealerId, dealer.id), eq(vehiclesTable.model, `${marker}-F`),
  ));
  assert.equal(fStillFree?.status, "available", "blocked commit took no stock");

  // ── 8. Dealer isolation: another dealer's identical stock is untouchable ──
  const otherDealer = dealers[1];
  if (otherDealer) {
    await vehicle(otherDealer.id, `${marker}-G`, 7);
    const cross = await dealFixture(dealer.id, [
      { model: `${marker}-G`, quantity: 1, position: 0 },
    ]);
    const outcome = await allocateReservationInventory({
      dealId: cross.deal.id, dealerId: dealer.id, invoiceId: null,
    });
    assert.equal(outcome, "unfulfilled", "cross-dealer stock is never held");
    const [foreign] = await db.select().from(vehiclesTable).where(and(
      eq(vehiclesTable.dealerId, otherDealer.id), eq(vehiclesTable.model, `${marker}-G`),
    ));
    assert.equal(foreign?.status, "available");
  }

  // ── 9. Release helper honors another live claim on the same unit ──
  await vehicle(dealer.id, `${marker}-H`, 8);
  const holder = await dealFixture(dealer.id, [
    { model: `${marker}-H`, quantity: 1, position: 0 },
  ]);
  assert.equal(await allocateReservationInventory({
    dealId: holder.deal.id, dealerId: dealer.id, invoiceId: null,
  }), "held");
  // Simulate a stale second allocation row set for another deal on the same
  // vehicle being released — the unit must stay reserved for `holder`.
  const rival2 = await dealFixture(dealer.id, [
    { model: `${marker}-H`, quantity: 1, position: 0 },
  ]);
  const [holdRow] = await activeHolds(holder.deal.id);
  await db.insert(reservationAllocationsTable).values({
    dealerId: dealer.id,
    dealId: rival2.deal.id,
    dealItemId: rival2.items[0]!.id,
    dealItemUnit: 0,
    vehicleId: holdRow!.vehicleId,
    status: "released",
    releasedReason: "seed",
  });
  await releaseReservationHolds({
    dealId: rival2.deal.id, dealerId: dealer.id, reason: "test",
  });
  const [stillHeld] = await db.select().from(vehiclesTable)
    .where(eq(vehiclesTable.id, holdRow!.vehicleId));
  assert.equal(stillHeld?.status, "reserved", "live claim kept the unit locked");

  // ── 10. Refund-gate approval frees EVERY held VIN of a booking-linked,
  // uncommitted multi-unit reservation (plus the booking's own unit) ──
  process.env.AUTH_BYPASS = "1";
  process.env.NODE_ENV = "test";
  const app = (await import("../app")).default;
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  const [approver] = await db.select({ email: usersTable.email })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(usersTable.id, dealerUsersTable.userId))
    .innerJoin(
      rolePermissionsTable,
      eq(rolePermissionsTable.roleId, dealerUsersTable.roleId),
    )
    .where(and(
      eq(dealerUsersTable.dealerId, dealer.id),
      eq(usersTable.status, "active"),
      eq(rolePermissionsTable.module, "approvals"),
      eq(rolePermissionsTable.category, "approve"),
    )).limit(1);
  assert.ok(approver?.email, "An active approvals manager is required");

  await vehicle(dealer.id, `${marker}-J`, 9);
  await vehicle(dealer.id, `${marker}-J`, 10);
  const bookedUnit = await vehicle(dealer.id, `${marker}-K`, 11, {
    status: "booked",
  });
  const refunded = await dealFixture(dealer.id, [
    { model: `${marker}-J`, quantity: 2, position: 0 },
  ]);
  const [linkedBooking] = await db.insert(bookingsTable).values({
    dealerId: dealer.id,
    vehicleId: bookedUnit.id,
    customerName: marker,
    dealId: refunded.deal.id,
    bookingAmount: 100,
    amountPaid: 100,
    paymentStatus: "paid",
    status: "active",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning();
  bookingIds.push(linkedBooking!.id);
  await payReservation(dealer.id, refunded.deal.id, 200, `${marker}-pay-6`);
  const refundedHolds = await activeHolds(refunded.deal.id);
  assert.equal(refundedHolds.length, 2);
  await db.update(dealsTable).set({
    stage: "cancelled",
    cancellationReason: "customer_changed_mind",
  }).where(eq(dealsTable.id, refunded.deal.id));
  const [refundGate] = await db.insert(gatesTable).values({
    dealerId: dealer.id,
    type: "refund_release",
    title: `${marker} refund`,
    summary: marker,
    amount: 200,
    priority: "high",
    evidence: [],
    refType: "deal",
    refId: refunded.deal.id,
    customerName: marker,
  }).returning();
  gateIds.push(refundGate!.id);
  const resolveResponse = await fetch(`${baseUrl}/gates/${refundGate!.id}/resolve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-user-email": approver.email,
      "x-dealer-id": String(dealer.id),
    },
    body: JSON.stringify({ action: "approve", note: `${marker} approved` }),
  });
  assert.equal(resolveResponse.status, 200, await resolveResponse.text());
  assert.equal((await activeHolds(refunded.deal.id)).length, 0);
  const freedAfterRefund = await db.select().from(vehiclesTable)
    .where(inArray(vehiclesTable.id, [
      ...refundedHolds.map((h) => h.vehicleId),
      bookedUnit.id,
    ]));
  assert.ok(
    freedAfterRefund.every((v) => v.status === "available"),
    `every formerly held VIN is available after refund approval: ${JSON.stringify(freedAfterRefund.map((v) => [v.id, v.status]))}`,
  );
  const [cancelledBooking] = await db.select().from(bookingsTable)
    .where(eq(bookingsTable.id, linkedBooking!.id));
  assert.equal(cancelledBooking?.status, "cancelled");

  // ── 11. Shortfall recovery: the retry route re-holds once stock arrives ──
  const editorFor = async (module: string, category: string) => {
    const [row] = await db.select({ email: usersTable.email })
      .from(dealerUsersTable)
      .innerJoin(usersTable, eq(usersTable.id, dealerUsersTable.userId))
      .innerJoin(
        rolePermissionsTable,
        eq(rolePermissionsTable.roleId, dealerUsersTable.roleId),
      )
      .where(and(
        eq(dealerUsersTable.dealerId, dealer.id),
        eq(usersTable.status, "active"),
        eq(rolePermissionsTable.module, module),
        eq(rolePermissionsTable.category, category),
      )).limit(1);
    assert.ok(row?.email, `An active user with ${module}:${category} is required`);
    return row.email;
  };
  const dealEditor = await editorFor("deals", "edit");
  const retryDeal = await dealFixture(dealer.id, [
    { model: `${marker}-M`, quantity: 1, position: 0 },
  ]);
  await payReservation(dealer.id, retryDeal.deal.id, 100, `${marker}-pay-7`);
  const [blockedDeal] = await db.select().from(dealsTable)
    .where(eq(dealsTable.id, retryDeal.deal.id));
  assert.equal(blockedDeal?.reservationHoldStatus, "unfulfilled");
  const retryHeaders = {
    "content-type": "application/json",
    "x-test-user-email": dealEditor,
    "x-dealer-id": String(dealer.id),
  };
  const retryUrl = `${baseUrl}/deals/${retryDeal.deal.id}/reservation-hold/retry`;
  const failedRetry = await fetch(retryUrl, { method: "POST", headers: retryHeaders });
  assert.equal(failedRetry.status, 409, "retry without stock stays blocked");
  const arrival = await vehicle(dealer.id, `${marker}-M`, 12);
  const okRetry = await fetch(retryUrl, { method: "POST", headers: retryHeaders });
  assert.equal(okRetry.status, 200, await okRetry.text());
  const retryHolds = await activeHolds(retryDeal.deal.id);
  assert.equal(retryHolds.length, 1);
  assert.equal(retryHolds[0]!.vehicleId, arrival.id);
  const [recovered] = await db.select().from(dealsTable)
    .where(eq(dealsTable.id, retryDeal.deal.id));
  assert.equal(recovered?.reservationHoldStatus, "held");

  // ── 12. Vehicle-ref refund gate must not free an actively allocated VIN ──
  const [vehicleGate] = await db.insert(gatesTable).values({
    dealerId: dealer.id,
    type: "refund_release",
    title: `${marker} vehicle refund`,
    summary: marker,
    amount: 50,
    priority: "high",
    evidence: [],
    refType: "vehicle",
    refId: arrival.id,
    customerName: marker,
  }).returning();
  gateIds.push(vehicleGate!.id);
  const vehicleResolve = await fetch(`${baseUrl}/gates/${vehicleGate!.id}/resolve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-user-email": approver.email,
      "x-dealer-id": String(dealer.id),
    },
    body: JSON.stringify({ action: "approve", note: `${marker} approved` }),
  });
  assert.equal(vehicleResolve.status, 200, await vehicleResolve.text());
  const [stillHeldVehicle] = await db.select().from(vehiclesTable)
    .where(eq(vehiclesTable.id, arrival.id));
  assert.equal(
    stillHeldVehicle?.status,
    "reserved",
    "vehicle-ref refund gate must honor another deal's active allocation",
  );
  assert.equal((await activeHolds(retryDeal.deal.id)).length, 1);

  // ── 13. Lead interest swap must not free an actively allocated VIN ──
  const leadEditor = await editorFor("leads", "edit");
  const [swapLead] = await db.insert(leadsTable).values({
    dealerId: dealer.id,
    name: marker,
    phone: "+5926000001",
    channel: "walkin",
    source: marker,
    interestedVehicleId: arrival.id,
  }).returning();
  swapLeadId = swapLead!.id;
  const swapResponse = await fetch(`${baseUrl}/leads/${swapLead!.id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-test-user-email": leadEditor,
      "x-dealer-id": String(dealer.id),
    },
    body: JSON.stringify({
      vehicleInterests: [{
        make: "RESV-TEST",
        model: `${marker}-N`,
        modelYear: 2026,
        unitPrice: 100,
        quantity: 1,
        position: 0,
      }],
    }),
  });
  assert.equal(swapResponse.status, 200, await swapResponse.text());
  const [afterSwapVehicle] = await db.select().from(vehiclesTable)
    .where(eq(vehiclesTable.id, arrival.id));
  assert.equal(
    afterSwapVehicle?.status,
    "reserved",
    "lead swap release must honor another deal's active allocation",
  );

  // ── 14. Inventory edits cannot subvert an active hold ──
  const invEditor = await editorFor("inventory", "edit");
  const heldVinId = retryHolds[0]!.vehicleId;
  const invHeaders = {
    "content-type": "application/json",
    "x-test-user-email": invEditor,
    "x-dealer-id": String(dealer.id),
  };
  const patchAttempt = await fetch(`${baseUrl}/vehicles/${heldVinId}`, {
    method: "PATCH",
    headers: invHeaders,
    body: JSON.stringify({ status: "available" }),
  });
  assert.equal(patchAttempt.status, 409, "manual status edit on a held VIN is refused");
  const invDeleter = await editorFor("inventory", "delete");
  const deleteAttempt = await fetch(`${baseUrl}/vehicles/${heldVinId}`, {
    method: "DELETE",
    headers: { ...invHeaders, "x-test-user-email": invDeleter },
  });
  assert.equal(deleteAttempt.status, 409, "deleting a held VIN is refused");
  // Bulk import: a status change row targeting the held VIN must be a row error.
  const [heldAfterEdits0] = await db.select().from(vehiclesTable)
    .where(eq(vehiclesTable.id, heldVinId));
  assert.ok(heldAfterEdits0);
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Vehicles");
  ws.addRow([
    "Inventory ID", "Make", "Model", "Year", "Price", "Powertrain",
    "Mileage Km", "Exterior Color", "Body Type", "Status",
  ]);
  ws.addRow([
    String(heldVinId), heldAfterEdits0.make, heldAfterEdits0.model,
    heldAfterEdits0.year, heldAfterEdits0.price, heldAfterEdits0.powertrain,
    heldAfterEdits0.mileageKm, heldAfterEdits0.exteriorColor,
    heldAfterEdits0.bodyType, "available",
  ]);
  const buffer = await wb.xlsx.writeBuffer();
  const form = new FormData();
  form.append(
    "file",
    new Blob([buffer as ArrayBuffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "import.xlsx",
  );
  const importAttempt = await fetch(`${baseUrl}/vehicles/import?mode=apply`, {
    method: "POST",
    headers: {
      "x-test-user-email": invEditor,
      "x-dealer-id": String(dealer.id),
    },
    body: form,
  });
  const importResult = (await importAttempt.json()) as {
    errors?: Array<{ message?: string }>;
    rowErrors?: Array<{ message?: string }>;
  };
  const importErrors = importResult.rowErrors ?? importResult.errors ?? [];
  assert.ok(
    importErrors.some((e) => /held for a paid reservation/i.test(e.message ?? "")),
    `import status change on a held VIN is a row error: ${JSON.stringify(importResult).slice(0, 400)}`,
  );
  const [heldAfterEdits] = await db.select().from(vehiclesTable)
    .where(eq(vehiclesTable.id, heldVinId));
  assert.equal(heldAfterEdits?.status, "reserved");
  assert.equal(heldAfterEdits?.deletedAt, null);

  // ── 15. A competing deal's fresh commit allocation never takes a held
  // VIN, even if its status were manually forced back to available ──
  await db.update(vehiclesTable).set({ status: "available" })
    .where(eq(vehiclesTable.id, heldVinId));
  const competitor = await dealFixture(dealer.id, [
    { model: `${marker}-M`, quantity: 1, position: 0 },
  ]);
  await assert.rejects(
    () => commitDealWithAllocations({ dealId: competitor.deal.id, dealerId: dealer.id }),
    /INSUFFICIENT_ITEM_INVENTORY/,
    "competing commit must not adopt another deal's actively held VIN",
  );
  const [heldAfterCompete] = await db.select().from(vehiclesTable)
    .where(eq(vehiclesTable.id, heldVinId));
  assert.equal(heldAfterCompete?.status, "available", "competitor took nothing");
  assert.equal((await activeHolds(retryDeal.deal.id)).length, 1);
  // Restore the held status the manual override subverted.
  await db.update(vehiclesTable).set({ status: "reserved" })
    .where(eq(vehiclesTable.id, heldVinId));

  // ── 16. Payment→hold gap: commit is blocked while a paid reservation
  // invoice has no recorded holds yet (allocator pending) ──
  await vehicle(dealer.id, `${marker}-P`, 13);
  const gapDeal = await dealFixture(dealer.id, [
    { model: `${marker}-P`, quantity: 1, position: 0 },
  ]);
  // Reproduce the exact interleaving: invoice paid + depositPaid committed,
  // but the post-payment allocator has NOT run yet.
  const gapInvoice = await issueInvoice({
    dealerId: dealer.id,
    kind: "reservation",
    dealId: gapDeal.deal.id,
    customerName: marker,
    amount: 100,
    description: `${marker} reservation`,
  });
  invoiceIds.push(gapInvoice.id);
  await db.update(invoicesTable).set({ status: "paid" })
    .where(eq(invoicesTable.id, gapInvoice.id));
  await assert.rejects(
    () => commitDealWithAllocations({ dealId: gapDeal.deal.id, dealerId: dealer.id }),
    /hold hasn't been recorded yet/i,
    "commit inside the payment→hold gap must be blocked",
  );
  assert.equal(
    (await db.select().from(deliveriesTable)
      .where(eq(deliveriesTable.dealId, gapDeal.deal.id))).length,
    0,
  );
  // Once the allocator runs, commit adopts the ledger VIN exactly.
  const gapOutcome = await allocateReservationInventory({
    dealId: gapDeal.deal.id,
    dealerId: dealer.id,
    invoiceId: gapInvoice.id,
  });
  assert.equal(gapOutcome, "held");
  const gapHolds = await activeHolds(gapDeal.deal.id);
  await commitDealWithAllocations({ dealId: gapDeal.deal.id, dealerId: dealer.id });
  const gapDeliveries = await db.select().from(deliveriesTable)
    .where(eq(deliveriesTable.dealId, gapDeal.deal.id));
  assert.equal(gapDeliveries.length, 1);
  assert.equal(gapDeliveries[0]!.vehicleId, gapHolds[0]!.vehicleId);

  // ── 17. True race: full payment vs concurrent commit attempts — the
  // commit either adopts the ledger VINs or is blocked; never plain stock ──
  await vehicle(dealer.id, `${marker}-Q`, 14);
  await vehicle(dealer.id, `${marker}-Q`, 15);
  const raceDeal = await dealFixture(dealer.id, [
    { model: `${marker}-Q`, quantity: 1, position: 0 },
  ]);
  const commitAttempts = (async () => {
    const results: Array<"committed" | "blocked"> = [];
    for (let i = 0; i < 8; i += 1) {
      try {
        await commitDealWithAllocations({ dealId: raceDeal.deal.id, dealerId: dealer.id });
        results.push("committed");
        break;
      } catch {
        results.push("blocked");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return results;
  })();
  await Promise.all([
    payReservation(dealer.id, raceDeal.deal.id, 100, `${marker}-pay-8`),
    commitAttempts,
  ]);
  const raceDeliveries = await db.select().from(deliveriesTable)
    .where(eq(deliveriesTable.dealId, raceDeal.deal.id));
  const raceLedger = await db.select().from(reservationAllocationsTable)
    .where(and(
      eq(reservationAllocationsTable.dealId, raceDeal.deal.id),
      inArray(reservationAllocationsTable.status, ["active", "finalized"]),
    ));
  if (raceDeliveries.length > 0 && raceLedger.length > 0) {
    // Payment settled before the winning commit — it must have adopted the
    // ledger VIN exactly.
    assert.equal(raceDeliveries.length, 1);
    assert.equal(raceDeliveries[0]!.vehicleId, raceLedger[0]!.vehicleId,
      "raced commit adopted the exact ledger VIN");
  } else if (raceDeliveries.length > 0) {
    // Commit legitimately won BEFORE the payment settled (not yet a paid
    // reservation at that instant). The late allocator must then have
    // skipped — no holds may exist alongside the committed allocation.
    assert.equal((await activeHolds(raceDeal.deal.id)).length, 0,
      "allocator skipped a deal that committed first");
    assert.equal(raceDeliveries.length, 1);
  } else {
    // Commit stayed blocked — holds must exist for the paid reservation.
    assert.equal((await activeHolds(raceDeal.deal.id)).length, 1);
  }

  console.log("reservation soft-lock integration passed");
} finally {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (gateIds.length) {
    await db.delete(gatesTable).where(inArray(gatesTable.id, gateIds));
  }
  if (swapLeadId != null) {
    await db.delete(leadVehicleInterestsTable).where(eq(leadVehicleInterestsTable.leadId, swapLeadId));
    await db.delete(quotesTable).where(eq(quotesTable.leadId, swapLeadId));
    await db.delete(timelineEventsTable).where(and(
      eq(timelineEventsTable.refType, "lead"),
      eq(timelineEventsTable.refId, swapLeadId),
    ));
    await db.delete(leadsTable).where(eq(leadsTable.id, swapLeadId));
  }
  if (bookingIds.length) {
    await db.delete(bookingsTable).where(inArray(bookingsTable.id, bookingIds));
  }
  if (dealIds.length) {
    await db.delete(timelineEventsTable).where(and(
      eq(timelineEventsTable.refType, "deal"),
      inArray(timelineEventsTable.refId, dealIds),
    ));
    await db.delete(reservationAllocationsTable)
      .where(inArray(reservationAllocationsTable.dealId, dealIds));
    await db.delete(deliveriesTable).where(inArray(deliveriesTable.dealId, dealIds));
  }
  if (invoiceIds.length) {
    const rows = await db.select({ id: paymentsTable.id }).from(paymentsTable)
      .where(inArray(paymentsTable.invoiceId, invoiceIds));
    if (rows.length) {
      await db.delete(receiptsTable)
        .where(inArray(receiptsTable.paymentId, rows.map((r) => r.id)));
      await db.delete(paymentsTable)
        .where(inArray(paymentsTable.id, rows.map((r) => r.id)));
    }
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
  }
  if (dealIds.length) {
    await db.delete(notificationsTable).where(and(
      eq(notificationsTable.entityType, "deal"),
      inArray(notificationsTable.entityId, dealIds),
    ));
  }
  if (dealIds.length) await db.delete(dealsTable).where(inArray(dealsTable.id, dealIds));
  if (vehicleIds.length) await db.delete(vehiclesTable).where(inArray(vehiclesTable.id, vehicleIds));
  await pool.end();
}
// The imported app's background workers keep timers alive after pool.end();
// exit explicitly once cleanup finished (failures propagate before this).
process.exit(0);
