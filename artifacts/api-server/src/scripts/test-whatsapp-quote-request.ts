import assert from "node:assert/strict";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "@workspace/db";
import { confirmedQuoteReply, QUOTE_REPLIES, quoteEmailReply, requestWhatsappQuote } from "../lib/whatsapp-quote-request";

// Isolated fixtures only: no real database connection, LLM, SMTP or outbox worker.
const fixtureLead = {
  id: 17, dealerId: 7, name: "Fixture", phone: "+5926001234", email: "fixture@example.test",
  phase: "qualified", emailOptOut: false, deletedAt: null, interestedVehicleId: 27,
  interestedModelText: null, ownerUserId: null, customerId: null,
};
const fixtures: Record<string, Record<string, unknown>[]> = {};
const dialect = new PgDialect();
function builder(tableName = "", inserting = false) {
  let condition: SQL | undefined;
  let values: Record<string, unknown> = {};
  const chain = {
    from(table: Parameters<typeof getTableName>[0]) { tableName = getTableName(table); return chain; },
    where(value: SQL) { condition = value; return chain; },
    orderBy() { return chain; }, limit() { return chain; }, returning() { return chain; },
    values(value: Record<string, unknown>) { values = value; return chain; },
    then(resolve: (rows: Record<string, unknown>[]) => unknown, reject: (err: unknown) => unknown) {
      try {
        if (inserting) {
          const row = { id: 100, status: "open", ...values };
          (fixtures[tableName] ??= []).push(row);
          return resolve([row]);
        }
        const query = condition && dialect.sqlToQuery(condition);
        const matches = query ? [...query.sql.matchAll(/"[^"]+"\."([^"]+)" = \$(\d+)/g)] : [];
        return resolve((fixtures[tableName] ?? []).filter(row => matches.every(m => {
          const key = m[1]!.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
          return row[key] === query!.params[Number(m[2]) - 1];
        })));
      } catch (err) { return reject(err); }
    },
  };
  return chain;
}
const original = { select: db.select, insert: db.insert, transaction: db.transaction, execute: db.execute };
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("NETWORK FORBIDDEN"); };
Object.assign(db, {
  select: () => builder(),
  insert: (table: Parameters<typeof getTableName>[0]) => builder(getTableName(table), true),
  transaction: async (fn: (tx: typeof db) => unknown) => fn(db),
  execute: async () => [],
});
type Services = NonNullable<Parameters<typeof requestWhatsappQuote>[3]>;
let status = "queued", sender = true, generated = 0, enqueued = 0, noQuote = false, crash = false;
let key: string | null | undefined;
const services: Services = {
  preflight: async () => sender ? { ok: true, fromEmail: "sender@example.test" } :
    { ok: false, code: "sender_disabled", message: "Disabled" },
  generate: async (lead, opts) => {
    generated++;
    assert.equal(lead.dealerId, 7);
    assert.equal(opts.trigger, "whatsapp_request");
    assert.equal(opts.overrides, undefined);
    if (crash) throw new Error("fixture generation failure");
    return noQuote ? null : { id: 37, total: 5700000 } as Awaited<ReturnType<Services["generate"]>>;
  },
  payload: async () => ({ customerName: "Fixture", total: "5700000" }),
  enqueue: async (opts) => {
    enqueued++;
    assert.equal(opts.dealerId, 7);
    assert.equal(opts.to, fixtureLead.email);
    assert.equal(opts.template, "vehicle_quote");
    assert.equal(opts.data?.quoteId, "37");
    key = opts.dedupeKey;
    return { status, recipient: fixtureLead.email } as Awaited<ReturnType<Services["enqueue"]>>;
  },
};
function reset() {
  fixtures.leads = [{ ...fixtureLead }];
  fixtures.vehicles = [{ id: 27, dealerId: 7, make: "BYD", model: "Yuan Pro", year: 2026, price: 5700000 }];
  fixtures.quotes = [];
  fixtures.lead_vehicle_interests = [];
  fixtures.tasks = [];
  fixtures.timeline_events = [];
  status = "queued"; sender = true; generated = 0; enqueued = 0; noQuote = false; crash = false;
}
const request = () => requestWhatsappQuote(7, 17, "5926001234", services);
try {
  reset();
  assert.equal(await request(), QUOTE_REPLIES.queued);
  assert.equal(key, "lead:17:quote:37:email:v1");
  assert.equal(await request(), QUOTE_REPLIES.queued);
  assert.equal(key, "lead:17:quote:37:email:v1", "retries must share the canonical dedupe key");
  status = "sent";
  assert.equal(await request(), QUOTE_REPLIES.sent);
  for (const blocked of ["failed", "cancelled", "unknown"]) {
    reset(); status = blocked;
    assert.equal(await request(), QUOTE_REPLIES.handoff);
    assert.equal(await request(), QUOTE_REPLIES.handoff);
    assert.equal(fixtures.tasks.length, 1, "blocked retries reuse the open task");
    assert.equal(fixtures.timeline_events.length, 1);
  }
  reset();
  assert.equal(await requestWhatsappQuote(8, 17, "5926001234", services), QUOTE_REPLIES.missing);
  assert.equal(await requestWhatsappQuote(7, 17, "5926999999", services), QUOTE_REPLIES.missing);
  assert.equal(enqueued, 0);
  fixtures.leads[0]!.email = null;
  assert.equal(await request(), QUOTE_REPLIES.email);
  assert.equal(generated, 0);
  for (const field of ["emailOptOut", "deletedAt", "interestedModelText"]) {
    reset(); fixtures.leads[0]![field] = field === "emailOptOut" ? true : "needs review";
    assert.equal(await request(), QUOTE_REPLIES.handoff);
    assert.equal(generated, 0);
  }
  for (const approval of ["discountStatus", "dutyFreeStatus"]) {
    reset(); fixtures.quotes = [{ dealerId: 7, leadId: 17, [approval]: "pending" }];
    assert.equal(await request(), QUOTE_REPLIES.handoff);
    assert.equal(generated, 0);
  }
  reset(); fixtures.lead_vehicle_interests = [{ dealerId: 7, leadId: 17, make: "Toyota", model: "Other" }];
  assert.equal(await request(), QUOTE_REPLIES.handoff);
  assert.equal(generated, 0);
  reset(); sender = false;
  assert.equal(await request(), QUOTE_REPLIES.handoff);
  assert.equal(enqueued, 0);
  reset(); noQuote = true;
  assert.equal(await request(), QUOTE_REPLIES.handoff);
  reset(); crash = true;
  assert.equal(await request(), QUOTE_REPLIES.handoff);
  assert.equal(quoteEmailReply("sending"), QUOTE_REPLIES.queued);
  assert.equal(quoteEmailReply("failed"), null);
  for (const text of [
    "The team will email your quote shortly.",
    "I've sent your quote. Anything else?",
    "Your quotation is queued.",
    "I will send a detailed estimate soon.",
  ]) assert.match(confirmedQuoteReply(text), /^Would you like/);
  assert.equal(confirmedQuoteReply("I've sent it!", QUOTE_REPLIES.queued), QUOTE_REPLIES.queued);
  assert.equal(confirmedQuoteReply("Would you like a quote?"), "Would you like a quote?");
  console.log("PASS: WhatsApp quote workflow, tenant/phone boundaries, approvals, dedupe keys, fallback tasks and truthful replies (no sends).");
} finally {
  Object.assign(db, original);
  globalThis.fetch = originalFetch;
}