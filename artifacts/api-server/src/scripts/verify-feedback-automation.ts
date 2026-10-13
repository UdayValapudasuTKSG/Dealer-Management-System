import assert from "node:assert/strict";
if (process.env.NODE_ENV === "production") throw Error("Development only");
const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!url || !["helium", "localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Refusing non-local database");
process.env.OUTBOX_WORKER_DISABLED = "1";
const { db, pool, dealersTable, customersTable, serviceOrdersTable, deliveriesTable,
  feedbackAutomationTable: rules, feedbackFormsTable: forms, feedbackInvitationsTable: invitations } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { processFeedbackEvent } = await import("../lib/feedback-automation");
let dealerId: number | undefined;
try {
  // Provisioning dealer is invisible to the running production-style sweep.
  const [dealer] = await db.insert(dealersTable).values({ name: "UAT Automatic Survey", status: "provisioning" }).returning();
  dealerId = dealer!.id;
  const [customer] = await db.insert(customersTable).values({ dealerId, name: "Survey Fixture", email: "survey@example.invalid", phone: "+5926000000" }).returning();
  const [form] = await db.insert(forms).values({ dealerId, name: "Fixture Survey", status: "published",
    questions: [{ id: "rating", type: "star_rating", label: "Rating", required: true, maxStars: 5 }] }).returning();
  const completed = new Date("2026-10-13T12:00:00Z");
  const [rule] = await db.insert(rules).values({ dealerId, kind: "service", formId: form!.id, enabled: true,
    delayDays: 2, channels: ["email", "whatsapp"], startsAt: new Date("2026-10-01T00:00:00Z") }).returning();
  const [order] = await db.insert(serviceOrdersTable).values({ dealerId, customerId: customer!.id,
    vehicleInfo: "Fixture EV", scheduledDate: "2026-10-13", status: "closed", closedAt: completed }).returning();
  let emails = 0, messages = 0;
  const senders = { email: async () => ({ id: ++emails }), whatsapp: async () => ({ id: ++messages }) };
  await processFeedbackEvent(rule!, order!.id, new Date("2026-10-15T11:59:59Z"), senders);
  assert.equal(emails, 0, "not early");
  await Promise.all([1, 2].map(() => processFeedbackEvent(rule!, order!.id, new Date("2026-10-15T12:00:00Z"), senders)));
  assert.equal(emails, 1, "concurrent sweeps dedupe email");
  assert.equal(messages, 1, "concurrent sweeps dedupe WhatsApp");
  const [inv] = await db.select().from(invitations).where(eq(invitations.dealerId, dealerId));
  assert.equal(inv!.formId, form!.id);
  assert.equal(inv!.automationState, "queued");
  assert.equal(inv!.serviceOrderId, order!.id);
  const [salesRule] = await db.insert(rules).values({ dealerId, kind: "sales", formId: form!.id, enabled: true,
    delayDays: 2, channels: ["email"], startsAt: new Date("2026-10-01T00:00:00Z") }).returning();
  const [delivery] = await db.insert(deliveriesTable).values({ dealerId, customerId: customer!.id, customerName: "Survey Fixture",
    dealId: -1, vehicleId: -1, status: "completed", deliveredAt: completed }).returning();
  await processFeedbackEvent(salesRule!, delivery!.id, new Date("2026-10-15T12:00:00Z"), senders);
  assert.equal(emails, 2, "delivery event queues selected survey");
  if (process.env.REPLIT_DEV_DOMAIN) {
    const invites = await db.select().from(invitations).where(eq(invitations.dealerId, dealerId));
    for (const invitation of invites) {
      const endpoint = `https://${process.env.REPLIT_DEV_DOMAIN}/api/feedback/${invitation.token}`;
      const response = await fetch(endpoint);
      assert.equal(response.status, 200, `${invitation.automationKind} public form opens`);
      assert.equal((await response.json()).formName, form!.name);
      if (invitation.deliveryId != null) {
        const submitted = await fetch(`${endpoint}/submit`, { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: [{ questionId: "rating", rating: 5 }] }) });
        assert.equal(submitted.status, 200, "delivery survey accepts customer response");
        assert.equal((await submitted.json()).state, "submitted");
      }
    }
    console.log("PASS: both public survey links open; delivery response is persisted.");
  }
  await db.update(rules).set({ enabled: false }).where(eq(rules.dealerId, dealerId));
  await processFeedbackEvent(rule!, order!.id, new Date("2026-10-20T12:00:00Z"), senders);
  assert.equal(emails, 2, "disabled rule never sends");
  console.log("PASS: due time, both event types, chosen form, concurrent dedupe, both channels, disabled rule; fake transport only.");
} finally {
  if (dealerId) {
    await db.delete(invitations).where(eq(invitations.dealerId, dealerId));
    await db.delete(rules).where(eq(rules.dealerId, dealerId));
    await db.delete(forms).where(eq(forms.dealerId, dealerId));
    await db.delete(deliveriesTable).where(eq(deliveriesTable.dealerId, dealerId));
    await db.delete(serviceOrdersTable).where(eq(serviceOrdersTable.dealerId, dealerId));
    await db.delete(customersTable).where(eq(customersTable.dealerId, dealerId));
    await db.delete(dealersTable).where(eq(dealersTable.id, dealerId));
  }
  await pool.end();
}
