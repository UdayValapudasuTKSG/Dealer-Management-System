import { and, eq, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  contactsTable,
  leadsTable,
  timelineEventsTable,
  type Lead,
} from "@workspace/db";
import { logger } from "./logger";

/**
 * Guarantee an account carries a primary contact.
 *
 * Every account is supposed to hold at least one primary contact (the Pre-Book
 * checklist depends on it). Backfills one from the supplied fallback details
 * when the account has no contacts at all, or promotes the oldest existing
 * contact when contacts exist but none is primary. Never throws.
 */
export async function ensurePrimaryContact(
  dealerId: number,
  accountId: number,
  fallback: {
    name: string;
    email?: string | null;
    phone?: string | null;
    title?: string | null;
  },
): Promise<void> {
  try {
    // Advisory xact lock serialises concurrent backfills for the same
    // account, so two racing callers can't both insert a primary contact.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"primary_contact:" + accountId}))`,
      );

      const contacts = await tx
        .select({ id: contactsTable.id, isPrimary: contactsTable.isPrimary })
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.accountId, accountId),
            eq(contactsTable.dealerId, dealerId),
          ),
        )
        .orderBy(contactsTable.id);

      if (contacts.some((c) => c.isPrimary)) return;

      if (contacts.length > 0) {
        // Contacts exist but none is primary — promote the oldest.
        await tx
          .update(contactsTable)
          .set({ isPrimary: true })
          .where(eq(contactsTable.id, contacts[0]!.id));
        return;
      }

      await tx.insert(contactsTable).values({
        dealerId,
        accountId,
        name: fallback.name,
        title: fallback.title ?? null,
        email: fallback.email ?? null,
        phone: fallback.phone ?? null,
        isPrimary: true,
      });
    });
  } catch (err) {
    logger.error({ err, accountId }, "ensurePrimaryContact failed");
  }
}

/**
 * Promote a lead to an account (customer).
 *
 * Finds an existing account (customer) by email (case-insensitive) or phone
 * digits, otherwise creates a new one from the lead's contact details, then
 * links the lead via customerId and drops a timeline note. Never throws —
 * account creation must not fail the flow that triggered it.
 *
 * `source` controls the tag + timeline copy: "test_drive" (booking promoted
 * the lead), "whatsapp" (WhatsApp intake created the lead) or "reservation"
 * (a vehicle reservation/Pre-Book promoted the lead).
 *
 * Returns the linked customer id (or the existing one / null on failure).
 */
export async function ensureAccountForLead(
  lead: Lead,
  source: "test_drive" | "whatsapp" | "reservation" = "test_drive",
): Promise<number | null> {
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
          accountType: lead.company ? "business" : "person",
          company: lead.company ?? null,
          tags: [
            source === "whatsapp"
              ? "whatsapp"
              : source === "reservation"
                ? "reservation"
                : "test-drive",
          ],
        })
        .returning();
      created = true;
    }
    if (!customer) return null;

    // Every account carries at least one primary contact. For a business
    // account this is the person on the lead; for a person account it mirrors
    // the person themselves.
    const [existingContact] = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(eq(contactsTable.accountId, customer.id))
      .limit(1);
    if (!existingContact) {
      await db.insert(contactsTable).values({
        dealerId: lead.dealerId,
        accountId: customer.id,
        name: lead.name,
        title: lead.title ?? null,
        email: lead.email ?? null,
        phone: lead.phone ?? null,
        isPrimary: true,
      });
    }

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
      detail:
        source === "whatsapp"
          ? created
            ? "A new account was opened automatically from the WhatsApp enquiry."
            : `Matched to existing account "${customer.name}" by contact details from the WhatsApp enquiry.`
          : created
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
