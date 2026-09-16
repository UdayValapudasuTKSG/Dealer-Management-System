import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db, whatsappMessagesTable } from "@workspace/db";
import type { WhatsappTransport } from "./whatsapp";
import { logger } from "./logger";
import { normalizeWhatsappPhone } from "./whatsapp-phone";

// ---------------------------------------------------------------------------
// WhatsApp transcript recording — persists every inbound customer message and
// every outbound send so the lead page can show the full chat. Never throws:
// transcript logging must not break the webhook or the bot flow.
// ---------------------------------------------------------------------------

export async function recordWhatsappMessage(opts: {
  phone: string;
  direction: "in" | "out";
  body: string;
  dealerId?: number | null;
  leadId?: number | null;
  actor?: string | null;
  outboxId?: number | null;
  providerMessageId?: string | null;
  deliveryStatus?: string;
  deliveryError?: string | null;
}): Promise<typeof whatsappMessagesTable.$inferSelect | null> {
  const body = (opts.body ?? "").trim();
  if (!body) return null;
  const phone = normalizeWhatsappPhone(opts.phone);
  if (!phone) {
    logger.warn({ phone: opts.phone }, "Refusing to record invalid WhatsApp phone");
    return null;
  }
  try {
    const [row] = await db
      .insert(whatsappMessagesTable)
      .values({
        phone,
        direction: opts.direction,
        body,
        dealerId: opts.dealerId ?? null,
        leadId: opts.leadId ?? null,
        actor: opts.actor ?? null,
        outboxId: opts.outboxId ?? null,
        providerMessageId: opts.providerMessageId ?? null,
        deliveryStatus:
          opts.deliveryStatus ?? (opts.direction === "in" ? "received" : "accepted"),
        deliveryError: opts.deliveryError ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    if (opts.outboxId != null) {
      const [existing] = await db
        .select()
        .from(whatsappMessagesTable)
        .where(eq(whatsappMessagesTable.outboxId, opts.outboxId));
      return existing ?? null;
    }
    return null;
  } catch (err) {
    logger.error({ err, phone: opts.phone }, "Failed to record WhatsApp message");
    return null;
  }
}

export type WhatsappDeliveryStatus =
  | "queued"
  | "accepted"
  | "delivered"
  | "read"
  | "failed"
  | "cancelled";

const allowedDeliveryTransitions: Record<
  WhatsappDeliveryStatus,
  ReadonlySet<WhatsappDeliveryStatus>
> = {
  queued: new Set(["queued"]),
  accepted: new Set(["queued", "accepted"]),
  // A later positive provider receipt is stronger evidence than an earlier
  // failure and may recover it. The reverse transition is never allowed.
  delivered: new Set(["queued", "accepted", "failed", "delivered"]),
  read: new Set(["queued", "accepted", "failed", "delivered", "read"]),
  failed: new Set(["queued", "accepted", "failed"]),
  cancelled: new Set(["queued", "cancelled"]),
};

export function parseWhatsappDeliveryStatus(
  value: string | null | undefined,
): WhatsappDeliveryStatus {
  return value && value in allowedDeliveryTransitions
    ? (value as WhatsappDeliveryStatus)
    : "queued";
}

/** Provider receipts may advance delivery, but never regress or revive it. */
export function canApplyWhatsappDeliveryStatus(
  current: WhatsappDeliveryStatus,
  incoming: WhatsappDeliveryStatus,
): boolean {
  return allowedDeliveryTransitions[incoming].has(current);
}

export function allowedWhatsappDeliverySources(
  incoming: WhatsappDeliveryStatus,
): WhatsappDeliveryStatus[] {
  return [...allowedDeliveryTransitions[incoming]];
}

/** Update one durable transcript row from the outbox worker or provider receipt. */
export async function updateWhatsappDeliveryStatus(opts: {
  dealerId: number;
  status: WhatsappDeliveryStatus;
  outboxId?: number;
  providerMessageId?: string;
  error?: string | null;
  recordedAt?: Date;
}): Promise<void> {
  if (opts.outboxId == null && !opts.providerMessageId) return;
  const now = opts.recordedAt ?? new Date();
  await db
    .update(whatsappMessagesTable)
    .set({
      deliveryStatus: opts.status,
      deliveryError: opts.error ?? null,
      updatedAt: now,
      ...(opts.providerMessageId
        ? { providerMessageId: opts.providerMessageId }
        : {}),
      ...(opts.status === "delivered" || opts.status === "read"
        ? { deliveredAt: now }
        : {}),
      ...(opts.status === "read" ? { readAt: now } : {}),
    })
    .where(
      and(
        eq(whatsappMessagesTable.dealerId, opts.dealerId),
        inArray(
          whatsappMessagesTable.deliveryStatus,
          allowedWhatsappDeliverySources(opts.status),
        ),
        opts.outboxId != null
          ? eq(whatsappMessagesTable.outboxId, opts.outboxId)
          : eq(whatsappMessagesTable.providerMessageId, opts.providerMessageId!),
      ),
    );
}

/** Replace the queued transcript copy when an operator re-renders a legacy row. */
export async function updateWhatsappMessageBody(opts: {
  dealerId: number;
  outboxId: number;
  body: string;
}): Promise<void> {
  const body = opts.body.trim();
  if (!body) return;
  try {
    await db
      .update(whatsappMessagesTable)
      .set({ body, updatedAt: new Date() })
      .where(
        and(
          eq(whatsappMessagesTable.dealerId, opts.dealerId),
          eq(whatsappMessagesTable.outboxId, opts.outboxId),
          eq(whatsappMessagesTable.direction, "out"),
        ),
      );
  } catch (err) {
    logger.error(
      { err, dealerId: opts.dealerId, outboxId: opts.outboxId },
      "Failed to update WhatsApp retry transcript body",
    );
  }
}

/** Attach any not-yet-linked messages for this (dealer, phone) to the lead. */
export async function linkWhatsappMessagesToLead(
  phone: string,
  lead: { id: number; dealerId: number },
): Promise<void> {
  try {
    await db
      .update(whatsappMessagesTable)
      .set({ leadId: lead.id, dealerId: lead.dealerId })
      .where(
        and(
          eq(whatsappMessagesTable.phone, normalizeWhatsappPhone(phone) ?? ""),
          eq(whatsappMessagesTable.dealerId, lead.dealerId),
          isNull(whatsappMessagesTable.leadId),
        ),
      );
  } catch (err) {
    logger.error({ err, phone }, "Failed to link WhatsApp messages to lead");
  }
}

/**
 * Return the dealer-scoped customer transcript for a lead.
 *
 * Repeat customers can have several enquiries, while WhatsApp remains one
 * phone-number conversation. Include rows attached to any of those enquiries,
 * plus not-yet-linked rows, by matching the normalized phone within the same
 * dealership. Rows already attached to this lead remain visible if its phone
 * number was later corrected.
 */
export async function listWhatsappMessagesForLead(lead: {
  id: number;
  dealerId: number;
  phone?: string | null;
}) {
  const phone = normalizeWhatsappPhone(lead.phone ?? "");
  const customerScope = phone
    ? or(
        eq(whatsappMessagesTable.leadId, lead.id),
        eq(whatsappMessagesTable.phone, phone),
      )
    : eq(whatsappMessagesTable.leadId, lead.id);

  return db
    .select()
    .from(whatsappMessagesTable)
    .where(
      and(
        eq(whatsappMessagesTable.dealerId, lead.dealerId),
        customerScope,
      ),
    )
    .orderBy(whatsappMessagesTable.createdAt, whatsappMessagesTable.id);
}

/**
 * Wrap a transport so every outbound send is also written to the transcript.
 * Recording happens after a successful send only.
 * dealerId is carried so transcript rows are dealer-scoped.
 */
export function recordingTransport(
  t: WhatsappTransport,
  actor = "AURA WhatsApp Bot",
  dealerId?: number | null,
): WhatsappTransport {
  const log = (to: string, body: string) =>
    recordWhatsappMessage({
      phone: to,
      direction: "out",
      body,
      actor,
      dealerId,
      deliveryStatus: "accepted",
    });
  return {
    interactive: t.interactive,
    durable: t.durable,
    sendText: async (to, body) => {
      await t.sendText(to, body);
      await log(to, body);
    },
    sendComplianceText: async (to, body) => {
      await (t.sendComplianceText ?? t.sendText)(to, body);
      await log(to, body);
    },
    sendButtons: async (to, body, buttons) => {
      await t.sendButtons(to, body, buttons);
      await log(to, body);
    },
    sendList: async (to, opts) => {
      await t.sendList(to, opts);
      await log(to, opts.body);
    },
  };
}
