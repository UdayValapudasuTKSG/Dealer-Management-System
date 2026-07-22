// L6 payment-layer demo seeder. Drives the DEV api-server through the real
// API (dev-only x-test-user-email persona header) to produce two demo deals:
//   1. CASH   — booking w/ reservation fee → deal (cash) → deposit → commit
//               → final invoice auto-generated → final invoice paid in full.
//   2. FINANCED — deal (bank_financing) → finance application → submit →
//               sync (sandbox LOS approves at DTI ≤ 45%) → commit → final
//               invoice (net of financed facility).
// Idempotent-ish: re-running creates fresh records (new bookings/deals) but
// never corrupts existing ones.

const BASE = process.env.API_BASE ?? "http://localhost:80/api";
const ADVISOR = "gm@aura-demo.com";
const FINANCE = "finance.manager@aura-demo.com";
const DEALER = 2;

async function call(
  method: string,
  path: string,
  user: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-test-user-email": user,
      "x-dealer-id": String(DEALER),
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

function fail(step: string, r: { status: number; json: any }): never {
  console.error(`✗ ${step} failed (${r.status}):`, JSON.stringify(r.json));
  process.exit(1);
}

async function main() {
  // Pick two available vehicles.
  const vehiclesRes = await call("GET", "/vehicles", ADVISOR);
  if (vehiclesRes.status !== 200) fail("list vehicles", vehiclesRes);
  const available = (vehiclesRes.json as any[]).filter(
    (v) => v.status === "available",
  );
  if (available.length < 2) {
    console.error(
      `✗ need at least 2 available vehicles on dealer ${DEALER}, found ${available.length}`,
    );
    process.exit(1);
  }
  const [cashVehicle, finVehicle] = available;
  console.log(
    `Vehicles: cash → #${cashVehicle.id} ${cashVehicle.make} ${cashVehicle.model}, financed → #${finVehicle.id} ${finVehicle.make} ${finVehicle.model}`,
  );

  // ---------- 1. CASH DEAL ----------
  console.log("\n— Cash deal —");
  const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
  const booking = await call("POST", "/bookings", ADVISOR, {
    vehicleId: cashVehicle.id,
    customerName: "Devon Ramnarine",
    bookingAmount: 500,
    amountPaid: 500,
    expiresAt,
    notes: "L6 demo — cash buyer reservation",
  });
  if (booking.status !== 201) fail("create booking", booking);
  console.log(`✓ booking #${booking.json.id} — reservation invoice issued + $500 paid`);

  const cashDeal = await call("POST", "/deals", ADVISOR, {
    vehicleId: cashVehicle.id,
    customerName: "Devon Ramnarine",
    vehiclePrice: cashVehicle.price,
    otdPrice: cashVehicle.price,
    discount: 0,
    stage: "desking",
    finalPaymentMethod: "cash",
  });
  if (cashDeal.status !== 201) fail("create cash deal", cashDeal);
  console.log(`✓ deal #${cashDeal.json.id} desked (cash)`);

  const cashCommit = await call("PATCH", `/deals/${cashDeal.json.id}`, ADVISOR, {
    depositPaid: true,
    stage: "committed",
  });
  if (cashCommit.status !== 200) fail("commit cash deal", cashCommit);
  console.log(`✓ deal #${cashDeal.json.id} committed — final invoice auto-generated`);

  // Pay the final invoice in full.
  const invoices = await call("GET", "/invoices", FINANCE);
  if (invoices.status !== 200) fail("list invoices", invoices);
  const finalInv = (invoices.json as any[]).find(
    (i) => i.dealId === cashDeal.json.id && i.kind === "final",
  );
  if (!finalInv) {
    console.error("✗ final invoice for cash deal not found");
    process.exit(1);
  }
  console.log(
    `✓ final invoice ${finalInv.invoiceNumber} — $${finalInv.amount} (${finalInv.taxLines?.length ?? 0} tax lines, rate ${finalInv.exchangeRate})`,
  );
  if (finalInv.amount > 0) {
    const pay = await call("POST", "/payments", FINANCE, {
      invoiceId: finalInv.id,
      amount: finalInv.amount,
      method: "cash",
      reference: "L6-demo-cash-settlement",
    });
    if (pay.status !== 201) fail("pay final invoice", pay);
    console.log(`✓ payment #${pay.json.id} — invoice settled, receipt issued`);
  }

  // ---------- 2. FINANCED DEAL ----------
  console.log("\n— Financed deal —");
  // Reservation booking first — the financed journey also starts with a
  // reservation fee (dual-invoice #1: kind=reservation + receipt).
  const finBooking = await call("POST", "/bookings", ADVISOR, {
    vehicleId: finVehicle.id,
    customerName: "Anika Persaud",
    bookingAmount: 500,
    amountPaid: 500,
    expiresAt,
    notes: "L6 demo — financed buyer reservation",
  });
  if (finBooking.status !== 201) fail("create financed booking", finBooking);
  console.log(
    `✓ booking #${finBooking.json.id} — reservation invoice issued + $500 paid`,
  );

  const finDeal = await call("POST", "/deals", ADVISOR, {
    vehicleId: finVehicle.id,
    customerName: "Anika Persaud",
    vehiclePrice: finVehicle.price,
    otdPrice: finVehicle.price,
    discount: 0,
    stage: "desking",
    finalPaymentMethod: "bank_financing",
  });
  if (finDeal.status !== 201) fail("create financed deal", finDeal);
  console.log(`✓ deal #${finDeal.json.id} desked (bank financing)`);

  // Prove the gate: committing before approval must 422.
  const early = await call("PATCH", `/deals/${finDeal.json.id}`, ADVISOR, {
    depositPaid: true,
    stage: "committed",
  });
  if (early.status !== 422) {
    console.error(
      `✗ financed commit gate expected 422 before approval, got ${early.status}`,
    );
    process.exit(1);
  }
  console.log("✓ financed commit correctly blocked before approval (422)");

  const otd = finDeal.json.otdPrice ?? finVehicle.price;
  const financedAmount = Math.round(otd * 0.8);
  const app = await call("POST", "/finance-applications", FINANCE, {
    dealId: finDeal.json.id,
    customerName: "Anika Persaud",
    amount: financedAmount,
    downPayment: Math.round(financedAmount * 0.2),
    termMonths: 60,
    apr: 8.5,
    employmentType: "employed",
    employerName: "GuySuCo",
    monthlyIncome: Math.max(Math.round(financedAmount / 10), 5000),
  });
  if (app.status !== 201) fail("create finance application", app);
  console.log(`✓ finance application #${app.json.id} drafted`);

  const submit = await call(
    "POST",
    `/finance-applications/${app.json.id}/submit`,
    FINANCE,
  );
  if (submit.status !== 200) fail("submit application", submit);
  // Sandbox LOS advances one stage per poll: submitted → under_review →
  // approved/declined. Sync until a decision lands (max 3 polls).
  let appStatus = "";
  for (let i = 0; i < 3; i++) {
    const sync = await call(
      "POST",
      `/finance-applications/${app.json.id}/sync`,
      FINANCE,
    );
    if (sync.status !== 200) fail("sync application", sync);
    appStatus = sync.json.status ?? sync.json.application?.status;
    if (["approved", "disbursed", "declined"].includes(appStatus)) break;
  }
  if (appStatus !== "approved" && appStatus !== "disbursed") {
    console.error(`✗ sandbox LOS did not approve (status: ${appStatus})`);
    process.exit(1);
  }
  console.log(`✓ sandbox LOS decision: ${appStatus}`);

  // Commit now that financing is approved (may already be committed if the
  // LOS effects auto-committed on disbursement).
  const dealNow = await call("GET", `/deals/${finDeal.json.id}`, ADVISOR);
  if (dealNow.json.stage !== "committed") {
    const commit = await call("PATCH", `/deals/${finDeal.json.id}`, ADVISOR, {
      depositPaid: true,
      stage: "committed",
    });
    if (commit.status !== 200) fail("commit financed deal", commit);
  }
  console.log(`✓ deal #${finDeal.json.id} committed`);

  const invoices2 = await call("GET", "/invoices", FINANCE);
  const finFinalInv = (invoices2.json as any[]).find(
    (i) => i.dealId === finDeal.json.id && i.kind === "final",
  );
  if (!finFinalInv) {
    console.error("✗ final invoice for financed deal not found");
    process.exit(1);
  }
  console.log(
    `✓ final invoice ${finFinalInv.invoiceNumber} — $${finFinalInv.amount} net of reservation + financed facility (rate ${finFinalInv.exchangeRate})`,
  );

  // Prove idempotent replay on POST /payments: same key twice → one payment.
  if (finFinalInv.amount > 0 && finFinalInv.status !== "paid") {
    const key = `l6-demo-${finDeal.json.id}-${Date.now()}`;
    const idemHeaders = { "x-idempotency-key": key };
    const body = {
      invoiceId: finFinalInv.id,
      amount: Math.min(1000, finFinalInv.amount),
      method: "cheque",
      reference: "L6-demo-financed-part-payment",
    };
    const first = await call("POST", "/payments", FINANCE, body, idemHeaders);
    if (first.status !== 201) fail("part-pay financed invoice", first);
    const replay = await call("POST", "/payments", FINANCE, body, idemHeaders);
    if (replay.status !== 201 || replay.json.id !== first.json.id) {
      console.error(
        `✗ idempotent replay expected same payment #${first.json.id}, got ${replay.status} #${replay.json?.id}`,
      );
      process.exit(1);
    }
    console.log(
      `✓ payment #${first.json.id} recorded once — idempotent replay returned the same payment`,
    );
  }

  console.log("\nL6 payment demo seeded — cash + financed deals end-to-end.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
