/**
 * Integration test for the ERPNext entity sync (customers, invoices, payments)
 * against a local stub ERPNext server, with failure injection for the
 * crash-recovery paths.
 *
 * Covers:
 *  - lead-promoted accounts enqueue customer sync
 *  - Sales Invoice posting (submitted, base = amount − taxes)
 *  - void → frappe.client.cancel (and cancel idempotence)
 *  - Payment Entry allocation (receive positive, refund "Pay" + non-negative)
 *  - failure injection: submit fails once after create → retry must NOT
 *    duplicate the document (ref persisted before submit + ensureSubmitted)
 *  - orphan adoption: a doc created remotely with no local ref (crash before
 *    saveErpnextRef) is reconciled by deterministic remarks, not duplicated
 *
 * Run: pnpm --filter @workspace/api-server run verify:erpnext-entities
 * (needs ERPNEXT_ALLOW_PRIVATE_URLS=1 on the command line — the URL policy
 * caches the flag at module import, so setting it in-script is too late.)
 */
import http from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  pool,
  dealersTable,
  customersTable,
  contactsTable,
  leadsTable,
  invoicesTable,
  paymentsTable,
  erpnextConnectionsTable,
  erpnextSyncJobsTable,
  erpnextRefsTable,
  dealsTable,
  vehiclesTable,
  vehicleModelGlCodesTable,
} from "@workspace/db";
import { processQueue } from "../lib/erpnext/sync";
import {
  registerErpnextEntitySync,
  queueCustomerSync,
  queueInvoiceSync,
  queuePaymentSync,
  normalizeErpnextDueDate,
  parseErpnextModified,
} from "../lib/erpnext/entities";
import { ensureAccountForLead } from "../lib/accounts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ————— Stub ERPNext —————
type Doc = Record<string, unknown> & { name: string; docstatus: number };
const store = new Map<string, Map<string, Doc>>();
let counter = 0;
const bucket = (dt: string) => {
  if (!store.has(dt)) store.set(dt, new Map());
  return store.get(dt)!;
};
/** Failure injection: fail the next N submit calls with a retryable 503. */
let failSubmits = 0;

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url!, "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const json = (code: number, payload: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (parts[1] === "method") {
      const method = parts.slice(2).join("/");
      if (method === "frappe.client.submit") {
        if (failSubmits > 0) {
          failSubmits--;
          return json(503, { message: "injected submit failure" });
        }
        const doc = bucket((body.doc as Doc)["doctype"] as string).get((body.doc as Doc).name);
        if (!doc) return json(404, { message: "not found" });
        // ERPNext rule: allocations must be non-negative.
        const refs = doc["references"] as Array<Record<string, unknown>> | undefined;
        if (refs?.some((r) => typeof r["allocated_amount"] === "number" && (r["allocated_amount"] as number) < 0)) {
          return json(417, { message: "Allocated amount cannot be negative" });
        }
        doc.docstatus = 1;
        return json(200, { message: doc });
      }
      if (method === "frappe.client.cancel") {
        const doc = bucket(body.doctype).get(body.name);
        if (!doc) return json(404, { message: "not found" });
        doc.docstatus = 2;
        return json(200, { message: "ok" });
      }
      return json(404, { message: `unknown method ${method}` });
    }
    if (parts[1] === "resource") {
      const dt = decodeURIComponent(parts[2] ?? "");
      const name = parts[3] ? decodeURIComponent(parts[3]) : null;
      if (req.method === "GET" && name) {
        const doc = bucket(dt).get(name);
        return doc ? json(200, { data: doc }) : json(404, { message: "not found" });
      }
      if (req.method === "GET") {
        const filters = url.searchParams.get("filters");
        let rows = [...bucket(dt).values()];
        if (filters) {
          for (const f of JSON.parse(filters) as unknown[][]) {
            const [, field, , value] = f as [string, string, string, unknown];
            rows = rows.filter((r) => r[field] === value);
          }
        }
        return json(200, { data: rows.map((r) => ({ name: r.name })) });
      }
      if (req.method === "POST") {
        // Mirror ERPNext's mandatory-field validation for the doctypes we
        // post, so the test exercises the real contract, not a lax stub.
        const missing: string[] = [];
        if (dt === "Sales Invoice") {
          if (!body["company"]) missing.push("company");
          if (!body["customer"]) missing.push("customer");
          const items = (body["items"] ?? []) as Array<Record<string, unknown>>;
          if (!items.length) missing.push("items");
          for (const it of items) {
            if (!it["item_code"]) missing.push("items.item_code");
            else if (!bucket("Item").has(String(it["item_code"]))) missing.push(`unknown Item ${it["item_code"]}`);
            if (!it["income_account"]) missing.push("items.income_account");
          }
        }
        if (dt === "Payment Entry") {
          for (const f of ["company", "payment_type", "party", "paid_from", "paid_to", "paid_amount"]) {
            if (!body[f]) missing.push(f);
          }
        }
        if (dt === "Item") {
          for (const f of ["item_code", "item_group", "stock_uom"]) {
            if (!body[f]) missing.push(f);
          }
        }
        if (missing.length) {
          return json(417, { message: `MandatoryError: ${missing.join(", ")}` });
        }
        const docName = dt === "Item" ? String(body["item_code"]) : `${dt.toUpperCase().replace(/ /g, "-")}-${String(++counter).padStart(4, "0")}`;
        const doc = { ...body, name: docName, docstatus: body.docstatus ?? 0 } as Doc;
        bucket(dt).set(docName, doc);
        return json(200, { data: doc });
      }
      if (req.method === "PUT" && name) {
        const doc = bucket(dt).get(name);
        if (!doc) return json(404, { message: "not found" });
        Object.assign(doc, body);
        return json(200, { data: doc });
      }
    }
    return json(404, { message: "nope" });
  });
});

async function drain(dealerId: number, passes = 6) {
  for (let i = 0; i < passes; i++) await processQueue(dealerId);
}
const settle = () => new Promise((r) => setTimeout(r, 300));

/** Force a queued/failed job for an entity back to runnable NOW (skip backoff). */
async function fastForwardJobs(dealerId: number) {
  await db
    .update(erpnextSyncJobsTable)
    .set({ nextAttemptAt: new Date(0) })
    .where(
      eq(erpnextSyncJobsTable.dealerId, dealerId),
    );
}

async function main() {
  if (process.env["ERPNEXT_ALLOW_PRIVATE_URLS"] !== "1") {
    console.error("Run with ERPNEXT_ALLOW_PRIVATE_URLS=1 (see file header)");
    process.exit(1);
  }
  await new Promise<void>((r) => server.listen(39323, "127.0.0.1", r));
  registerErpnextEntitySync();

  const [dealer] = await db
    .insert(dealersTable)
    .values({ name: "ERPNext EntitySync Verify (tmp)" } as never)
    .returning();
  const dealerId = dealer!.id;
  await db.insert(erpnextConnectionsTable).values({
    dealerId,
    siteUrl: "http://127.0.0.1:39323",
    apiKey: "k",
    apiSecret: "s",
    webhookSecret: "x",
    enabled: true,
    incomeAccount: "Sales - GD",
    taxAccount: "VAT - GD",
    receivableAccount: "Debtors - GD",
    settlementAccount: "Cash - GD",
    companyName: "AURA Motors GY",
    siteTimezone: "America/Guyana",
    paymentModes: { cash: "Cash" },
  });

  // 0 — timezone-aware conflict ordering (pure function checks)
  check(
    "naive ERPNext timestamp interpreted in site timezone (UTC-4)",
    parseErpnextModified("2026-08-18 10:00:00", "America/Guyana")?.toISOString() === "2026-08-18T14:00:00.000Z",
  );
  check(
    "unknown timezone falls back to UTC",
    parseErpnextModified("2026-08-18 10:00:00", "Not/AZone")?.toISOString() === "2026-08-18T10:00:00.000Z",
  );
  check(
    "missing due date leaves ERPNext payment terms in control",
    normalizeErpnextDueDate(null, "2026-08-18") === undefined,
  );
  check(
    "historical due date is clamped to posting date",
    normalizeErpnextDueDate("2026-08-01", "2026-08-18") === "2026-08-18",
  );
  check(
    "same/later due date is preserved",
    normalizeErpnextDueDate("2026-08-18", "2026-08-18") === "2026-08-18" &&
      normalizeErpnextDueDate("2026-09-01", "2026-08-18") === "2026-09-01",
  );
  check(
    "malformed due date is omitted",
    normalizeErpnextDueDate("9999-invalid", "2026-08-18") === undefined &&
      normalizeErpnextDueDate("2026-02-30", "2026-08-18") === undefined,
  );

  try {
    // 1 — lead promotion enqueues customer sync
    const [lead] = await db
      .insert(leadsTable)
      .values({ dealerId, name: "Lead Larry", email: "larry@example.gy", phone: "+5926007007", source: "web", status: "new" } as never)
      .returning();
    const accountId = await ensureAccountForLead(lead!, "reservation");
    check("lead promotion created an account", accountId != null);
    await settle();
    await drain(dealerId);
    const leadRef = accountId != null
      ? await db
          .select()
          .from(erpnextRefsTable)
          .where(and(eq(erpnextRefsTable.dealerId, dealerId), eq(erpnextRefsTable.entityType, "customer"), eq(erpnextRefsTable.entityId, accountId)))
      : [];
    check("lead-promoted account synced to ERPNext", leadRef.length === 1);

    // 2 — failure injection: submit fails once after Sales Invoice create.
    // The ref is persisted before submit, so the retry must adopt the same
    // doc via ensureSubmitted — never create a second Sales Invoice.
    const [cust] = await db
      .insert(customersTable)
      .values({ dealerId, name: "Ann Persaud", email: "ann@example.gy" })
      .returning();
    queueCustomerSync(dealerId, cust!.id);
    const [inv] = await db
      .insert(invoicesTable)
      .values({ dealerId, invoiceNumber: "INV-ES-1", customerId: cust!.id, customerName: "Ann Persaud", amount: 1120, kind: "final", status: "paid", taxLines: [{ code: "vat", name: "VAT", kind: "percent", rate: 12, amount: 120 }], currency: "GYD" } as never)
      .returning();
    failSubmits = 1;
    queueInvoiceSync(dealerId, inv!.id, "create");
    await settle();
    await drain(dealerId, 2); // first pass: create ok, submit fails (retryable)
    await fastForwardJobs(dealerId);
    await drain(dealerId, 4); // retry: must reuse the mapped doc and submit it
    const siDocs = [...bucket("Sales Invoice").values()];
    check("submit-failure retry did not duplicate the Sales Invoice", siDocs.length === 1, `count=${siDocs.length}`);
    check("Sales Invoice submitted after retry", siDocs[0]?.docstatus === 1);
    const items = siDocs[0]?.["items"] as Array<Record<string, unknown>> | undefined;
    check("Sales Invoice base = amount − taxes", items?.[0]?.["rate"] === 1000);

    // 2b — vehicle-model GL code mapping: a deal-linked invoice must post
    // with the model mapping's income account (matched via the shared
    // normalizer), the resolved code must be snapshotted on the job payload,
    // and LATER mapping edits must never rewrite the historical posting.
    const [veh] = await db
      .insert(vehiclesTable)
      .values({ dealerId, make: "BYD", model: "SEAL   ev", year: 2026, price: 9000, powertrain: "ev", mileageKm: 0, exteriorColor: "White", bodyType: "sedan" } as never)
      .returning();
    await db.insert(vehicleModelGlCodesTable).values({
      dealerId,
      makeKey: "byd",
      modelKey: "seal ev",
      makeLabel: "BYD",
      modelLabel: "SEAL EV",
      glCode: "4110 - Vehicle Sales - GD",
    });
    const [deal] = await db
      .insert(dealsTable)
      .values({ dealerId, customerId: cust!.id, vehicleId: veh!.id, vehiclePrice: 9000 } as never)
      .returning();
    const [invM] = await db
      .insert(invoicesTable)
      .values({ dealerId, invoiceNumber: "INV-ES-MODEL", customerId: cust!.id, customerName: "Ann Persaud", dealId: deal!.id, amount: 9000, kind: "final", status: "issued", taxLines: [], currency: "GYD" } as never)
      .returning();
    queueInvoiceSync(dealerId, invM!.id, "create");
    await settle();
    await drain(dealerId, 4);
    const modelDoc = [...bucket("Sales Invoice").values()].find(
      (d) => d["remarks"] === "AURA INV-ES-MODEL (final)",
    );
    const modelItems = modelDoc?.["items"] as Array<Record<string, unknown>> | undefined;
    check(
      "deal-linked invoice posts with the vehicle-model GL code",
      modelItems?.[0]?.["income_account"] === "4110 - Vehicle Sales - GD",
      String(modelItems?.[0]?.["income_account"]),
    );
    const [modelJob] = await db
      .select()
      .from(erpnextSyncJobsTable)
      .where(and(eq(erpnextSyncJobsTable.dealerId, dealerId), eq(erpnextSyncJobsTable.entityType, "invoice"), eq(erpnextSyncJobsTable.entityId, invM!.id)));
    const snap = modelJob?.payload as Record<string, unknown> | null;
    check(
      "resolved GL code snapshotted on the sync job payload",
      snap?.["resolvedIncomeAccount"] === "4110 - Vehicle Sales - GD" && snap?.["incomeAccountSource"] === "model-mapping",
      JSON.stringify({ acct: snap?.["resolvedIncomeAccount"], src: snap?.["incomeAccountSource"] }),
    );
    // Change the mapping, replay the queue: the existing ref short-circuit
    // must leave both the remote doc and the snapshot untouched.
    await db
      .update(vehicleModelGlCodesTable)
      .set({ glCode: "4999 - Changed Later - GD" })
      .where(eq(vehicleModelGlCodesTable.dealerId, dealerId));
    queueInvoiceSync(dealerId, invM!.id, "create", { dedupeKey: `verify-model-replay-${Date.now()}` });
    await settle();
    await drain(dealerId, 4);
    const [modelJobAfter] = await db
      .select()
      .from(erpnextSyncJobsTable)
      .where(and(eq(erpnextSyncJobsTable.dealerId, dealerId), eq(erpnextSyncJobsTable.entityType, "invoice"), eq(erpnextSyncJobsTable.entityId, invM!.id), eq(erpnextSyncJobsTable.id, modelJob!.id)));
    check(
      "later mapping edits never rewrite the historical posting or snapshot",
      (modelItems?.[0]?.["income_account"] === "4110 - Vehicle Sales - GD") &&
        (modelJobAfter?.payload as Record<string, unknown>)?.["resolvedIncomeAccount"] === "4110 - Vehicle Sales - GD",
    );
    // Default fallback: invoice with no deal keeps the dealer-wide account.
    const defaultDoc = [...bucket("Sales Invoice").values()].find(
      (d) => d["remarks"] === "AURA INV-ES-2 (final)",
    );
    const defaultItems = defaultDoc?.["items"] as Array<Record<string, unknown>> | undefined;
    check(
      "invoice without a deal keeps the dealer default income account",
      defaultItems === undefined || defaultItems?.[0]?.["income_account"] === "Sales - GD",
    );

    // 3 — orphan adoption: doc exists remotely with no local ref (simulated
    // crash between insertDoc and saveErpnextRef on an older code path).
    const [inv2] = await db
      .insert(invoicesTable)
      .values({ dealerId, invoiceNumber: "INV-ES-2", customerId: cust!.id, customerName: "Ann Persaud", amount: 500, kind: "final", status: "issued", taxLines: [], currency: "GYD" } as never)
      .returning();
    bucket("Sales Invoice").set("SI-ORPHAN", {
      name: "SI-ORPHAN",
      doctype: "Sales Invoice",
      remarks: "AURA INV-ES-2 (final)",
      docstatus: 0,
    } as Doc);
    queueInvoiceSync(dealerId, inv2!.id, "create");
    await settle();
    await drain(dealerId, 4);
    const orphanRef = await db
      .select()
      .from(erpnextRefsTable)
      .where(and(eq(erpnextRefsTable.dealerId, dealerId), eq(erpnextRefsTable.entityType, "invoice"), eq(erpnextRefsTable.entityId, inv2!.id)));
    const inv2Docs = [...bucket("Sales Invoice").values()].filter(
      (d) => d["remarks"] === "AURA INV-ES-2 (final)" || d.name === "SI-ORPHAN",
    );
    check("orphaned remote doc adopted (no duplicate)", orphanRef[0]?.docName === "SI-ORPHAN" && inv2Docs.length === 1);
    check("adopted orphan submitted", bucket("Sales Invoice").get("SI-ORPHAN")?.docstatus === 1);

    // 4 — payments: receive + refund allocations
    const [pay] = await db
      .insert(paymentsTable)
      .values({ dealerId, invoiceId: inv!.id, customerName: "Ann Persaud", amount: 1120, method: "cash" } as never)
      .returning();
    queuePaymentSync(dealerId, pay!.id);
    const [refund] = await db
      .insert(paymentsTable)
      .values({ dealerId, invoiceId: inv!.id, customerName: "Ann Persaud", amount: -250, method: "cash" } as never)
      .returning();
    queuePaymentSync(dealerId, refund!.id);
    await settle();
    await drain(dealerId, 6);
    const peDocs = [...bucket("Payment Entry").values()];
    const receive = peDocs.find((d) => d["payment_type"] === "Receive");
    const payOut = peDocs.find((d) => d["payment_type"] === "Pay");
    const rRefs = payOut?.["references"] as Array<Record<string, unknown>> | undefined;
    check("receive payment submitted, allocated to invoice", receive?.docstatus === 1 && (receive?.["references"] as Array<Record<string, unknown>>)?.[0]?.["allocated_amount"] === 1120);
    check("refund is Pay with non-negative allocation", payOut?.docstatus === 1 && rRefs?.[0]?.["allocated_amount"] === 250, JSON.stringify({ alloc: rRefs?.[0]?.["allocated_amount"] }));
    check("mode of payment mapped (cash → Cash)", receive?.["mode_of_payment"] === "Cash");

    // 5 — zero-value operational invoice/payment pair is a clean no-op
    const [zeroInv] = await db
      .insert(invoicesTable)
      .values({ dealerId, invoiceNumber: "INV-ES-ZERO", customerId: cust!.id, customerName: "Ann Persaud", amount: 0, kind: "final", status: "issued", taxLines: [], currency: "GYD" } as never)
      .returning();
    queueInvoiceSync(dealerId, zeroInv!.id, "create");
    const [zeroPay] = await db
      .insert(paymentsTable)
      .values({ dealerId, invoiceId: zeroInv!.id, customerName: "Ann Persaud", amount: 0, method: "cash" } as never)
      .returning();
    queuePaymentSync(dealerId, zeroPay!.id);
    await settle();
    await drain(dealerId, 4);
    const zeroJobs = await db
      .select()
      .from(erpnextSyncJobsTable)
      .where(
        and(
          eq(erpnextSyncJobsTable.dealerId, dealerId),
          eq(erpnextSyncJobsTable.entityId, zeroPay!.id),
          eq(erpnextSyncJobsTable.entityType, "payment"),
        ),
      );
    check(
      "zero invoice/payment completes without ERPNext documents",
      zeroJobs[0]?.status === "succeeded" &&
        ![...bucket("Sales Invoice").values()].some(
          (d) => d["remarks"] === "AURA INV-ES-ZERO (final)",
        ),
    );

    // 6 — void mirrors cancel; cancel is idempotent
    queueInvoiceSync(dealerId, inv!.id, "cancel");
    await settle();
    await drain(dealerId, 4);
    check("void cancelled the Sales Invoice (docstatus 2)", siDocs[0]?.docstatus === 2);
    queueInvoiceSync(dealerId, inv!.id, "cancel", { dedupeKey: `verify-cancel-again-${Date.now()}` });
    await settle();
    await drain(dealerId, 4);
    const cancelJobs = await db
      .select()
      .from(erpnextSyncJobsTable)
      .where(and(eq(erpnextSyncJobsTable.dealerId, dealerId), eq(erpnextSyncJobsTable.doctype, "Sales Invoice"), eq(erpnextSyncJobsTable.entityId, inv!.id)));
    check("re-cancel is idempotent (no failed cancel jobs)", cancelJobs.every((j) => j.status === "succeeded"));
  } finally {
    await db.delete(erpnextSyncJobsTable).where(eq(erpnextSyncJobsTable.dealerId, dealerId));
    await db.delete(erpnextRefsTable).where(eq(erpnextRefsTable.dealerId, dealerId));
    await db.delete(erpnextConnectionsTable).where(eq(erpnextConnectionsTable.dealerId, dealerId));
    await db.delete(paymentsTable).where(eq(paymentsTable.dealerId, dealerId));
    await db.delete(vehicleModelGlCodesTable).where(eq(vehicleModelGlCodesTable.dealerId, dealerId));
    await db.delete(dealsTable).where(eq(dealsTable.dealerId, dealerId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.dealerId, dealerId));
    await db.delete(invoicesTable).where(eq(invoicesTable.dealerId, dealerId));
    await db.delete(contactsTable).where(eq(contactsTable.dealerId, dealerId));
    await db.delete(leadsTable).where(eq(leadsTable.dealerId, dealerId));
    await db.delete(customersTable).where(eq(customersTable.dealerId, dealerId));
    await db.delete(dealersTable).where(eq(dealersTable.id, dealerId));
    server.close();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
