/**
 * Per-dealer Meta Lead Ads credential resolution.
 *
 * Resolution order (per lookup):
 *   1. meta_connections row for the dealer (tokens decrypted on demand).
 *   2. Global env fallback: META_APP_SECRET / META_PAGE_ACCESS_TOKEN /
 *      META_VERIFY_TOKEN (platform-level app config).
 *
 * Credentials are NEVER logged or returned to clients.
 * SERVER-ONLY.
 */
import { eq } from "drizzle-orm";
import { db, metaConnectionsTable, type MetaConnection } from "@workspace/db";
import { decryptMetaSecret } from "./meta-crypto";
import { logger } from "./logger";

export async function getMetaConnectionRow(
  dealerId: number,
): Promise<MetaConnection | null> {
  const [row] = await db
    .select()
    .from(metaConnectionsTable)
    .where(eq(metaConnectionsTable.dealerId, dealerId));
  return row ?? null;
}

function tryDecrypt(
  wire: string | null,
  dealerId: number,
  label: string,
): string | null {
  if (!wire) return null;
  try {
    return decryptMetaSecret(wire, dealerId);
  } catch (err) {
    logger.error({ err, dealerId, label }, "Failed to decrypt Meta credential");
    return null;
  }
}

/** Page access token for a dealer: stored value first, then env fallback. */
export async function resolveMetaPageToken(
  dealerId: number,
): Promise<string | null> {
  const row = await getMetaConnectionRow(dealerId);
  const stored = tryDecrypt(
    row?.pageAccessTokenCiphertext ?? null,
    dealerId,
    "page_access_token",
  );
  return stored ?? process.env["META_PAGE_ACCESS_TOKEN"] ?? null;
}

/** App secret for a dealer: stored value first, then env fallback. */
export async function resolveMetaAppSecret(
  dealerId: number,
): Promise<string | null> {
  const row = await getMetaConnectionRow(dealerId);
  const stored = tryDecrypt(
    row?.appSecretCiphertext ?? null,
    dealerId,
    "app_secret",
  );
  return stored ?? process.env["META_APP_SECRET"] ?? null;
}

/**
 * All app secrets that may legitimately sign an incoming webhook: every
 * dealer's stored secret plus the global env secret. The webhook has no
 * dealer context until the payload is parsed, so signature verification
 * tries each candidate (the set is tiny — one per configured dealer).
 */
export async function allMetaAppSecrets(): Promise<string[]> {
  const rows = await db.select().from(metaConnectionsTable);
  const secrets = new Set<string>();
  for (const row of rows) {
    const s = tryDecrypt(row.appSecretCiphertext, row.dealerId, "app_secret");
    if (s) secrets.add(s);
  }
  const env = process.env["META_APP_SECRET"];
  if (env) secrets.add(env);
  return [...secrets];
}

/** All acceptable webhook verify tokens (dealer rows + env). */
export async function allMetaVerifyTokens(): Promise<string[]> {
  const rows = await db.select().from(metaConnectionsTable);
  const tokens = new Set<string>();
  for (const row of rows) {
    if (row.verifyToken) tokens.add(row.verifyToken);
  }
  const env = process.env["META_VERIFY_TOKEN"];
  if (env) tokens.add(env);
  return [...tokens];
}
