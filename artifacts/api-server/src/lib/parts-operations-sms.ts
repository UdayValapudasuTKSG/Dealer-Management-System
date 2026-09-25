import twilio from "twilio";
import { and, eq } from "drizzle-orm";
import { db, dealerUsersTable, usersTable, dealersTable, customersTable } from "@workspace/db";
import { partsSmsReadiness } from "./parts-operations-sms-config";
export { partsSmsReadiness } from "./parts-operations-sms-config";

class PartsSmsConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "PartsSmsConfigurationError"; }
}
const setupLink = "/parts?tab=notifications";

/** Reuses installed Twilio SDK and existing account credentials. Sender routing
 * is EXPLICIT per dealer and opt-in; TWILIO_PHONE_NUMBER/WhatsApp never fallback.
 * Only an active same-dealer staff member can receive these parts alerts.
 */
export async function sendPartsAdvisorSms(dealerId: number, recipientId: number, body: string) {
  if (process.env.OUTBOX_WORKER_DISABLED === "1") throw new PartsSmsConfigurationError("Outbound delivery is disabled for this environment.");
  const readiness = partsSmsReadiness(dealerId);
  if (!readiness.ready) throw new PartsSmsConfigurationError(`${readiness.reason} Setup: ${setupLink}`);
  const [recipient] = await db.select({ phone: usersTable.phone }).from(dealerUsersTable)
    .innerJoin(usersTable, eq(usersTable.id, dealerUsersTable.userId))
    .innerJoin(dealersTable, eq(dealersTable.id, dealerUsersTable.dealerId))
    .where(and(eq(dealerUsersTable.dealerId, dealerId), eq(dealerUsersTable.userId, recipientId), eq(usersTable.status, "active"), eq(dealersTable.status, "active")));
  if (!recipient) throw new PartsSmsConfigurationError("Advisor is not an active member of this dealer. Update the special-order advisor before retrying.");
  const to = recipient.phone?.replace(/[\s()-]/g, "");
  if (!to || !/^\+[1-9]\d{7,14}$/.test(to)) throw new PartsSmsConfigurationError("Advisor SMS phone is missing or not E.164. Update the staff phone number before retrying.");
  await twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!).messages.create({ from: readiness.sender!, to, body });
}

export async function sendPartsCustomerSms(dealerId: number, customerId: number, body: string) {
  if (process.env.OUTBOX_WORKER_DISABLED === "1") throw new PartsSmsConfigurationError("Outbound delivery is disabled for this environment.");
  const readiness = partsSmsReadiness(dealerId);
  if (!readiness.ready) throw new PartsSmsConfigurationError(`${readiness.reason} Setup: ${setupLink}`);
  const [customer] = await db.select().from(customersTable).where(and(eq(customersTable.dealerId, dealerId), eq(customersTable.id, customerId)));
  const to = customer?.phone?.replace(/[\s()-]/g, "");
  if (!to || !/^\+[1-9]\d{7,14}$/.test(to)) throw new PartsSmsConfigurationError("Customer SMS phone is missing or not E.164.");
  await twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!).messages.create({ from: readiness.sender!, to, body });
}