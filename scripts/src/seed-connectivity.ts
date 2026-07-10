import { eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  customersTable,
  leadsTable,
  dealsTable,
  appraisalsTable,
  financeApplicationsTable,
  serviceOrdersTable,
  vehiclesTable,
  timelineEventsTable,
  gatesTable,
  insertCustomerSchema,
  insertTimelineEventSchema,
  insertGateSchema,
  type GateEvidenceItem,
} from "@workspace/db";

const GYD = 209; // approx GY$ per US$ for dual-currency evidence
const g = (usd: number) =>
  `G$${Math.round(usd * GYD).toLocaleString("en-US")}`;
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const dual = (n: number) => `${usd(n)} (${g(n)})`;

// Validate a seed row against the drizzle-zod insert schema (which now enforces
// the same enum values the API uses). A bad value fails loudly here at seed
// time instead of silently 500-ing a list endpoint at request time.
function validate<T>(
  schema: { parse: (input: unknown) => T },
  label: string,
  row: unknown,
): T {
  try {
    return schema.parse(row);
  } catch (err) {
    console.error(`Invalid seed row for ${label}:`, JSON.stringify(row));
    throw err;
  }
}

async function ensureCustomer(
  name: string,
  fields: Partial<typeof customersTable.$inferInsert>,
): Promise<number> {
  const row = { name, ...fields };
  validate(insertCustomerSchema, `customer "${name}"`, row);
  const [existing] = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.name, name));
  if (existing) {
    await db
      .update(customersTable)
      .set(fields)
      .where(eq(customersTable.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(customersTable)
    .values(row)
    .returning();
  return created.id;
}

async function main() {
  console.log("Resetting connective tables (timeline_events, gates)...");
  await db.delete(timelineEventsTable);
  await db.delete(gatesTable);

  console.log("Ensuring customers exist for every named person...");
  const james = await ensureCustomer("James Whitfield", {
    email: "james.whitfield@example.com",
    phone: "+592 611 0142",
    location: "Georgetown",
    loyaltyTier: "gold",
    lifetimeValue: 58600,
    vehiclesOwned: 1,
  });
  const nadia = await ensureCustomer("Nadia Haddad", {
    email: "nadia.haddad@example.com",
    phone: "+592 622 0187",
    location: "Georgetown",
    loyaltyTier: "new",
    lifetimeValue: 0,
    vehiclesOwned: 0,
  });
  const grace = await ensureCustomer("Grace Liu", {
    email: "grace.liu@example.com",
    phone: "+592 633 0219",
    location: "Georgetown",
    loyaltyTier: "gold",
    lifetimeValue: 4200,
    vehiclesOwned: 0,
  });
  const owen = await ensureCustomer("Owen Park", {
    email: "owen.park@example.com",
    phone: "+592 644 0255",
    location: "Georgetown",
    loyaltyTier: "new",
    lifetimeValue: 0,
    vehiclesOwned: 0,
  });

  // Existing customers keyed by name -> id
  const idByName = new Map<string, number>();
  for (const c of await db.select().from(customersTable)) {
    idByName.set(c.name, c.id);
  }
  const amara = idByName.get("Amara Okafor")!;
  const daniel = idByName.get("Daniel Reyes")!;
  const priya = idByName.get("Priya Nair")!;
  const marcus = idByName.get("Marcus Feld")!;
  const sofia = idByName.get("Sofia Bennett")!;

  console.log("Backfilling customer_id across every domain (one identity)...");
  const linkByName = async (
    table:
      | typeof dealsTable
      | typeof appraisalsTable
      | typeof financeApplicationsTable
      | typeof serviceOrdersTable,
    name: string,
    id: number,
  ) => {
    await db
      .update(table)
      .set({ customerId: id })
      .where(eq(table.customerName, name));
  };

  // Leads use a `name` column
  await db
    .update(leadsTable)
    .set({ customerId: marcus })
    .where(eq(leadsTable.name, "Marcus Feld"));
  await db
    .update(leadsTable)
    .set({ customerId: grace })
    .where(eq(leadsTable.name, "Grace Liu"));
  await db
    .update(leadsTable)
    .set({ customerId: james })
    .where(eq(leadsTable.name, "James Whitfield"));
  await db
    .update(leadsTable)
    .set({ customerId: nadia })
    .where(eq(leadsTable.name, "Nadia Haddad"));
  await db
    .update(leadsTable)
    .set({ customerId: owen })
    .where(eq(leadsTable.name, "Owen Park"));

  await linkByName(dealsTable, "James Whitfield", james);
  await linkByName(dealsTable, "Nadia Haddad", nadia);

  await linkByName(appraisalsTable, "James Whitfield", james);
  await linkByName(appraisalsTable, "Nadia Haddad", nadia);
  await linkByName(appraisalsTable, "Owen Park", owen);

  await linkByName(financeApplicationsTable, "James Whitfield", james);
  await linkByName(financeApplicationsTable, "Amara Okafor", amara);
  await linkByName(financeApplicationsTable, "Nadia Haddad", nadia);
  await linkByName(financeApplicationsTable, "Marcus Feld", marcus);

  await linkByName(serviceOrdersTable, "Grace Liu", grace);

  // Capital-order gate proposes ordering the Jeep allocation, so it must read
  // as available stock, not already inbound.
  await db
    .update(vehiclesTable)
    .set({ status: "available" })
    .where(eq(vehiclesTable.id, 8));

  // Grace's lapsed reservation holds the Ioniq 5; the refund-release gate
  // returns this VIN to available stock when a manager signs off.
  await db
    .update(vehiclesTable)
    .set({ status: "reserved" })
    .where(eq(vehiclesTable.id, 6));

  console.log("Writing connected timeline receipts...");
  const base = Date.now();
  let seq = 0;
  const at = (minsAgo: number) => new Date(base - minsAgo * 60_000);
  const events: (typeof timelineEventsTable.$inferInsert)[] = [];
  const add = (
    customerId: number,
    domain: string,
    kind: string,
    title: string,
    detail: string,
    opts: {
      actor?: string;
      isAgent?: boolean;
      cause?: string;
      refType?: string;
      refId?: number;
      minsAgo?: number;
    } = {},
  ) => {
    events.push({
      customerId,
      domain,
      kind,
      title,
      detail,
      actor: opts.actor ?? "Concierge",
      isAgent: opts.isAgent ?? true,
      cause: opts.cause ?? null,
      refType: opts.refType ?? null,
      refId: opts.refId ?? null,
      createdAt: at(opts.minsAgo ?? 5000 - seq++ * 37),
    });
  };

  // James Whitfield — full connected journey lead -> appraisal -> deal -> finance -> delivered
  add(james, "leads", "captured", "James arrived from the web showroom", "Configured a Ford F-150 and asked about trading in his current truck.", { refType: "lead", refId: 5, minsAgo: 8600 });
  add(james, "appraisals", "valued", "Trade-in appraised and accepted", `2019 Ford F-150 valued at ${dual(18500)}; offer accepted and applied to the deal.`, { cause: "James arrived from the web showroom", refType: "appraisal", refId: 1, minsAgo: 8200 });
  add(james, "deals", "structured", "Deal structured on the F-150", `Trade equity of ${usd(18500)} rolled in; out-the-door set to ${dual(58600)}.`, { cause: "Trade-in appraised and accepted", refType: "deal", refId: 2, minsAgo: 8000 });
  add(james, "finance", "funded", "Financing funded", `Lender funded ${dual(58600)} at 5.9% APR; contract released to delivery.`, { cause: "Deal structured on the F-150", refType: "finance", refId: 1, minsAgo: 7600 });
  add(james, "deals", "delivered", "F-150 delivered", "Keys handed over; registration pack completed and the customer file moved to ownership.", { cause: "Financing funded", refType: "deal", refId: 2, actor: "Delivery Team", isAgent: false, minsAgo: 7200 });

  // Amara Okafor — committed Tesla with approved finance and active service
  add(amara, "deals", "reserved", "Amara reserved a Model Y", `Reservation deposit paid; out-the-door set to ${dual(55890)}.`, { refType: "deal", refId: 3, minsAgo: 4200 });
  add(amara, "finance", "approved", "Financing approved", `Lender approved ${dual(55890)} at 4.4% APR; awaiting delivery scheduling.`, { cause: "Amara reserved a Model Y", refType: "finance", refId: 2, minsAgo: 3900 });
  add(amara, "service", "booked", "First service pre-booked", "Complimentary 1,500 km inspection scheduled alongside delivery prep.", { cause: "Financing approved", refType: "service", refId: 1, minsAgo: 3600 });

  // Marcus Feld — negotiation with a below-floor gate raised
  add(marcus, "leads", "engaged", "Marcus re-engaged on the Taycan", "Returned after a test drive and asked for a sharper number to match a competitor quote.", { refType: "lead", refId: 1, minsAgo: 900 });
  add(marcus, "deals", "negotiation", "Deal moved to negotiation", `Advisor built a Taycan offer; requested discount pushes below the pricing floor.`, { cause: "Marcus re-engaged on the Taycan", refType: "deal", refId: 1, minsAgo: 700 });
  add(marcus, "finance", "submitted", "Finance application submitted", `Application for ${dual(124300)} sent to lenders pending final price.`, { cause: "Deal moved to negotiation", refType: "finance", refId: 4, minsAgo: 500 });
  add(marcus, "gate", "gate_below_floor_price", "Pricing decision needed", "Below-floor discount requires a manager decision before the number can go live.", { cause: "Deal moved to negotiation", refType: "deal", refId: 1, actor: "System", isAgent: false, minsAgo: 300 });

  // Nadia Haddad — finance stage with a credit decline gate
  add(nadia, "leads", "engaged", "Nadia engaged on the BMW i4", "Asked to trade an Audi A4 and finance the balance.", { refType: "lead", refId: 6, minsAgo: 2600 });
  add(nadia, "appraisals", "valued", "Audi A4 appraised", `Trade valued at ${dual(26800)}; awaiting final offer acceptance.`, { cause: "Nadia engaged on the BMW i4", refType: "appraisal", refId: 2, minsAgo: 2300 });
  add(nadia, "deals", "finance", "Deal advanced to financing", `i4 structured with ${usd(12000)} trade equity; out-the-door ${dual(56990)}.`, { cause: "Audi A4 appraised", refType: "deal", refId: 5, minsAgo: 2000 });
  add(nadia, "finance", "under_review", "Lender flagged the application", "Debt-to-income ratio triggered a manual review; a credit decision is required.", { cause: "Deal advanced to financing", refType: "finance", refId: 3, minsAgo: 1500 });
  add(nadia, "gate", "gate_credit_decline", "Credit decision needed", "Lender recommends decline; a manager must confirm or re-route to restructured terms.", { cause: "Lender flagged the application", refType: "finance", refId: 3, actor: "System", isAgent: false, minsAgo: 1200 });

  // Daniel Reyes — appraisal + desking + service
  add(daniel, "appraisals", "requested", "Daniel requested a trade appraisal", "Honda CR-V submitted for valuation to offset a RAV4 purchase.", { refType: "appraisal", refId: 3, minsAgo: 3300 });
  add(daniel, "deals", "desking", "RAV4 deal opened", `Working numbers with ${usd(9000)} projected trade equity; out-the-door ${dual(33990)}.`, { cause: "Daniel requested a trade appraisal", refType: "deal", refId: 4, minsAgo: 3000 });
  add(daniel, "service", "scheduled", "Service visit scheduled", "Booked a maintenance visit on his current BYD Seal.", { refType: "service", refId: 2, minsAgo: 2800 });

  // Sofia Bennett — delivered with a service approval pending
  add(sofia, "deals", "delivered", "Sofia took delivery of an F-150", `Out-the-door ${dual(72400)}; file moved to ownership.`, { refType: "deal", refId: 6, minsAgo: 5200 });
  add(sofia, "service", "awaiting_approval", "Service estimate awaiting approval", "Diagnostic complete; repair estimate sent to the customer for sign-off.", { cause: "Sofia took delivery of an F-150", refType: "service", refId: 3, minsAgo: 600 });

  // Priya Nair — service only
  add(priya, "service", "scheduled", "Priya scheduled an Ioniq 5 service", "Routine maintenance booked with a loaner requested.", { refType: "service", refId: 5, minsAgo: 4000 });

  // Grace Liu — reservation lapsed, refund pending
  add(grace, "leads", "qualified", "Grace reserved an Ioniq 5", "Placed a hold with a deposit while arranging financing.", { refType: "lead", refId: 2, minsAgo: 6000 });
  add(grace, "service", "completed", "RAV4 service completed", "Prior service visit closed out and invoiced.", { refType: "service", refId: 4, minsAgo: 5000 });
  add(grace, "gate", "gate_refund_release", "Deposit refund needed", "Reservation lapsed; a manager must authorize the deposit release.", { refType: "reservation", refId: 2, actor: "System", isAgent: false, minsAgo: 400 });

  // Owen Park — early funnel appraisal
  add(owen, "leads", "qualified", "Owen is comparing a RAV4", "Qualified lead evaluating a hybrid RAV4 with a trade.", { refType: "lead", refId: 7, minsAgo: 3500 });
  add(owen, "appraisals", "requested", "Mazda 3 submitted for appraisal", `Trade submitted; preliminary value ${dual(6200)} pending inspection.`, { cause: "Owen is comparing a RAV4", refType: "appraisal", refId: 4, minsAgo: 3200 });

  events.forEach((e, i) =>
    validate(insertTimelineEventSchema, `timeline event #${i} (${e.title})`, e),
  );
  await db.insert(timelineEventsTable).values(events);
  console.log(`Inserted ${events.length} timeline events.`);

  console.log("Creating human decision gates (never-list)...");
  const gates: (typeof gatesTable.$inferInsert)[] = [];
  const ev = (label: string, value: string): GateEvidenceItem => ({
    label,
    value,
  });

  gates.push({
    type: "below_floor_price",
    status: "pending",
    priority: "high",
    customerId: marcus,
    customerName: "Marcus Feld",
    refType: "deal",
    refId: 1,
    title: "Below-floor discount on the Porsche Taycan",
    summary:
      "Marcus is requesting a discount that takes the Taycan under its pricing floor to match a verified competitor quote.",
    recommendation:
      "Approve to a $6,500 discount — it holds margin above the floor and matches a documented competitor offer for a repeat buyer.",
    amount: 6500,
    floorAmount: 113400,
    evidence: [
      ev("Requested discount", dual(6500)),
      ev("Pricing floor", dual(113400)),
      ev("Proposed out-the-door", dual(115900)),
      ev("Margin after discount", "4.2%"),
      ev("Competitor quote", `${usd(114200)} (verified)`),
      ev("Customer signal", "Repeat buyer, 2 prior deliveries"),
    ],
  });

  gates.push({
    type: "credit_decline",
    status: "pending",
    priority: "high",
    customerId: nadia,
    customerName: "Nadia Haddad",
    refType: "finance",
    refId: 3,
    title: "Credit decision on Nadia Haddad's BMW i4",
    summary:
      "The primary lender recommends declining the application on debt-to-income. A manager must confirm the decline or re-route to restructured terms.",
    recommendation:
      "Re-route to restructured terms — an alternate lender pre-approves $48,000 and a co-signer path keeps the delivery on track.",
    amount: 56990,
    evidence: [
      ev("Requested amount", dual(56990)),
      ev("Lender decision", "Declined — DTI 47%"),
      ev("Credit tier", "612 (subprime)"),
      ev("Trade equity down", dual(12000)),
      ev("Alternate lender", `Republic Bank @ 8.9%, approved ${usd(48000)}`),
      ev("Restructure option", "72-month term with co-signer"),
    ],
  });

  gates.push({
    type: "capital_order",
    status: "pending",
    priority: "normal",
    customerId: null,
    customerName: null,
    refType: "vehicle",
    refId: 8,
    title: "Capital order: 3-unit Jeep Wrangler allocation",
    summary:
      "Demand is outpacing stock on the Wrangler. Committing dealership capital to an inbound allocation requires manager approval.",
    recommendation:
      "Approve the allocation — the active pipeline supports a 38-day turn at target margin.",
    amount: 156900,
    evidence: [
      ev("Capital required", dual(156900)),
      ev("Allocation", "3x Jeep Wrangler"),
      ev("Unit cost (CIF)", dual(52300)),
      ev("GRA import duty (45%)", dual(23535)),
      ev("Open demand", "4 active leads, 2 test drives booked"),
      ev("Est. inventory turn", "38 days"),
      ev("Margin at retail", "14.6%"),
    ],
  });

  gates.push({
    type: "gra_filing",
    status: "pending",
    priority: "normal",
    customerId: james,
    customerName: "James Whitfield",
    refType: "deal",
    refId: 2,
    title: "GRA duty filing for the imported F-150",
    summary:
      "The imported unit is cleared by the broker but the GRA declaration must be filed before registration can proceed.",
    recommendation:
      "File the IM4 declaration — the duty pack is complete and clearance is already confirmed.",
    amount: 24300,
    evidence: [
      ev("Filing type", "IM4 declaration"),
      ev("Customs value (CIF)", dual(54000)),
      ev("GRA duty + taxes", dual(24300)),
      ev("Broker status", "Cleared"),
      ev("Registration", "Pending filing"),
    ],
  });

  gates.push({
    type: "refund_release",
    status: "pending",
    priority: "low",
    customerId: grace,
    customerName: "Grace Liu",
    refType: "vehicle",
    refId: 6,
    title: "Release lapsed reservation deposit",
    summary:
      "Grace's Ioniq 5 reservation has expired. Releasing the held deposit and returning the VIN to stock needs manager sign-off.",
    recommendation:
      "Release the deposit and return the VIN to available inventory — the reservation window has closed.",
    amount: 2500,
    evidence: [
      ev("Deposit held", dual(2500)),
      ev("Reservation age", "14 days (expired)"),
      ev("Reason", "Customer deferred purchase"),
      ev("VIN status", "Returns to available stock"),
      ev("Refund method", "Original card"),
    ],
  });

  gates.forEach((gate, i) =>
    validate(insertGateSchema, `gate #${i} (${gate.title})`, gate),
  );
  await db.insert(gatesTable).values(gates);
  console.log(`Inserted ${gates.length} gates.`);

  // Keep customers.vehicles_owned consistent with delivered deals.
  await db.execute(sql`
    UPDATE customers c SET vehicles_owned = sub.cnt
    FROM (
      SELECT customer_id, COUNT(*) AS cnt FROM deals
      WHERE stage = 'delivered' AND customer_id IS NOT NULL
      GROUP BY customer_id
    ) sub
    WHERE c.id = sub.customer_id
  `);

  console.log("Connectivity seed complete.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
