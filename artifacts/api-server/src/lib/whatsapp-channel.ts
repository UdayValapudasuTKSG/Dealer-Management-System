/**
 * Per-dealer Meta WhatsApp channel resolution.
 *
 * Resolution order (for each lookup):
 *   1. DB whatsapp_channels row — enabled + has token → use it.
 *   2. Legacy env fallback — ONLY when the requested dealer AND phoneNumberId
 *      exactly match WHATSAPP_DEALER_ID / WHATSAPP_PHONE_NUMBER_ID.
 *      This keeps CAM Motors live without a DB row.
 *   3. null — unknown / disabled / unconfigured.
 *
 * Access tokens are NEVER logged or returned to clients.
 * SERVER-ONLY.
 */
import { eq } from "drizzle-orm";
import { db, whatsappChannelsTable } from "@workspace/db";
import { decryptToken } from "./whatsapp-crypto";
import { logger } from "./logger";

export type ResolvedChannel = {
  dealerId: number;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  /** Plaintext access token — never log this value. */
  accessToken: string;
};

/** Env-fallback config (legacy CAM Motors). */
function legacyEnvChannel(): ResolvedChannel | null {
  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  const dealerIdStr = process.env["WHATSAPP_DEALER_ID"];
  const wabaId = process.env["WHATSAPP_WABA_ID"] ?? "";
  const dealerId = Number(dealerIdStr);
  if (
    !accessToken ||
    !phoneNumberId ||
    !Number.isSafeInteger(dealerId) ||
    dealerId <= 0
  )
    return null;
  return {
    dealerId,
    wabaId,
    phoneNumberId,
    displayPhoneNumber: null,
    verifiedName: null,
    accessToken,
  };
}

/**
 * Look up the active channel for a dealer.
 * Returns null when the dealer has no enabled channel with a token.
 */
export async function getChannelByDealerId(
  dealerId: number,
): Promise<ResolvedChannel | null> {
  // 1. DB lookup
  const [row] = await db
    .select()
    .from(whatsappChannelsTable)
    .where(eq(whatsappChannelsTable.dealerId, dealerId));

  if (row) {
    if (!row.enabled) return null;
    if (!row.accessTokenCiphertext) return null;
    try {
      const accessToken = decryptToken(row.accessTokenCiphertext, row.dealerId);
      return {
        dealerId: row.dealerId,
        wabaId: row.wabaId,
        phoneNumberId: row.phoneNumberId,
        displayPhoneNumber: row.displayPhoneNumber ?? null,
        verifiedName: row.verifiedName ?? null,
        accessToken,
      };
    } catch (err) {
      logger.error(
        { dealerId, err: (err as Error).message },
        "whatsapp channel token decryption failed",
      );
      return null;
    }
  }

  // 2. Legacy env fallback — only for the exact matching dealer.
  const legacy = legacyEnvChannel();
  if (legacy && legacy.dealerId === dealerId) return legacy;

  return null;
}

/**
 * Look up the active channel by Meta phone_number_id (used during webhook
 * processing — the webhook carries phoneNumberId, not dealerId).
 * Returns null when unknown or disabled.
 */
export async function getChannelByPhoneNumberId(
  phoneNumberId: string,
): Promise<ResolvedChannel | null> {
  // 1. DB lookup
  const [row] = await db
    .select()
    .from(whatsappChannelsTable)
    .where(eq(whatsappChannelsTable.phoneNumberId, phoneNumberId));

  if (row) {
    if (!row.enabled) return null;
    if (!row.accessTokenCiphertext) return null;
    try {
      const accessToken = decryptToken(row.accessTokenCiphertext, row.dealerId);
      return {
        dealerId: row.dealerId,
        wabaId: row.wabaId,
        phoneNumberId: row.phoneNumberId,
        displayPhoneNumber: row.displayPhoneNumber ?? null,
        verifiedName: row.verifiedName ?? null,
        accessToken,
      };
    } catch (err) {
      logger.error(
        { phoneNumberId, err: (err as Error).message },
        "whatsapp channel token decryption failed (by phoneNumberId)",
      );
      return null;
    }
  }

  // 2. Legacy env fallback — only for the exact matching phoneNumberId.
  const legacy = legacyEnvChannel();
  if (legacy && legacy.phoneNumberId === phoneNumberId) return legacy;

  return null;
}
