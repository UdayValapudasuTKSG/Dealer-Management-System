import { and, eq, isNull } from "drizzle-orm";
import { db, whatsappMessagesTable } from "@workspace/db";
import type { WhatsappTransport } from "./whatsapp";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// WhatsApp transcript recording — persists every inbound customer message and
// every outbound send so the lead page can show the full chat. Never throws:
// transcript logging must not break the webhook or the bot flow.
// ---------------------------------------------------------------------------

const digits = (s: string): string => s.replace(/\D/g, "");

export async function recordWhatsappMessage(opts: {
  phone: string;
  direction: "in" | "out";
  body: string;
  dealerId?: number | null;
  leadId?: number | null;
  actor?: string | null;
}): Promise<void> {
  const body = (opts.body ?? "").trim();
  if (!body) return;
  try {
    await db.insert(whatsappMessagesTable).values({
      phone: digits(opts.phone),
      direction: opts.direction,
      body,
      dealerId: opts.dealerId ?? null,
      leadId: opts.leadId ?? null,
      actor: opts.actor ?? null,
    });
  } catch (err) {
    logger.error({ err, phone: opts.phone }, "Failed to record WhatsApp message");
  }
}

/** Attach any not-yet-linked messages for this phone to the lead. */
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
          eq(whatsappMessagesTable.phone, digits(phone)),
          isNull(whatsappMessagesTable.leadId),
        ),
      );
  } catch (err) {
    logger.error({ err, phone }, "Failed to link WhatsApp messages to lead");
  }
}

/**
 * Wrap a transport so every outbound send is also written to the transcript.
 * Recording happens after a successful send only.
 */
export function recordingTransport(
  t: WhatsappTransport,
  actor = "AURA WhatsApp Bot",
): WhatsappTransport {
  const log = (to: string, body: string) =>
    recordWhatsappMessage({ phone: to, direction: "out", body, actor });
  return {
    interactive: t.interactive,
    sendText: async (to, body) => {
      await t.sendText(to, body);
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
