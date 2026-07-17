import { and, eq, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  leadsTable,
  timelineEventsTable,
  type Lead,
} from "@workspace/db";
import { logger } from "./logger";

/**
 * Test-drive booked → the lead becomes an account.
 *
 * Finds an existing account (customer) by email (case-insensitive) or phone
 * digits, otherwise creates a new one from the lead's contact details, then
 * links the lead via customerId and drops a timeline note. Never throws —
 * account creation must not fail the booking that triggered it.
 *
 * Returns the linked customer id (or the existing one / null on failure).
 */
export async function ensureAccountForLead(lead: Lead): Promise<number | null> {
  if (lead.customerId) return lead.customerId;

  try {
    const email = lead.email?.trim().toLowerCase() || null;
    const phoneDigits = lead.phone?.replace(/\D+/g, "") || null;

    let customer: typeof customersTable.$inferSelect | undefined;
    if (email) {
      [customer] = await db
        .select()
        .from(customersTable)
        .where(
          and(
            eq(customersTable.dealerId, lead.dealerId),
            sql`lower(${customersTable.email}) = ${email}`,
          ),
        )
        .limit(1);
    }
    if (!customer && phoneDigits) {
      [customer] = await db
        .select()
        .from(customersTable)
        .where(
          and(
            eq(customersTable.dealerId, lead.dealerId),
            sql`regexp_replace(coalesce(${customersTable.phone}, ''), '\\D', '', 'g') = ${phoneDigits}`,
          ),
        )
        .limit(1);
    }

    let created = false;
    if (!customer) {
      [customer] = await db
        .insert(customersTable)
        .values({
          dealerId: lead.dealerId,
          name: lead.name,
          email: lead.email ?? null,
          phone: lead.phone ?? null,
          location: lead.preferredBranch ?? null,
          tags: ["test-drive"],
        })
        .returning();
      created = true;
    }
    if (!customer) return null;

    await db
      .update(leadsTable)
      .set({ customerId: customer.id })
      .where(eq(leadsTable.id, lead.id));

    await db.insert(timelineEventsTable).values({
      dealerId: lead.dealerId,
      customerId: customer.id,
      domain: "leads",
      kind: created ? "account_created" : "account_linked",
      title: created
        ? `${lead.name} became an account`
        : `Lead linked to existing account`,
      detail: created
        ? "A new account was opened automatically when the test drive was booked."
        : `Matched to existing account "${customer.name}" by contact details when the test drive was booked.`,
      actor: "AURA",
      isAgent: true,
      refType: "customer",
      refId: customer.id,
    });

    return customer.id;
  } catch (err) {
    logger.error({ err, leadId: lead.id }, "ensureAccountForLead failed");
    return lead.customerId ?? null;
  }
}
