import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  dealersTable,
  amberConnectionsTable,
  isEntitlementEnabled,
  type AmberConnection,
} from "@workspace/db";
import { encryptAmberSecret } from "./crypto";
import {
  resolveAmberProvider,
  AMBER_CONTRACT_PENDING_MESSAGE,
} from "./provider";
import { decryptAmberSecret } from "./crypto";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Per-dealer Amber Connect connection settings. Credentials live server-side
// only (AES-256-GCM ciphertext); the client sees a 4-char hint at most.
// ---------------------------------------------------------------------------

export async function getAmberConnection(
  dealerId: number,
): Promise<AmberConnection | null> {
  const [row] = await db
    .select()
    .from(amberConnectionsTable)
    .where(eq(amberConnectionsTable.dealerId, dealerId));
  return row ?? null;
}

/** True when the dealer's Amber Connect ENTITLEMENT is on (default OFF). */
export async function amberEntitled(dealerId: number): Promise<boolean> {
  const [dealer] = await db
    .select({
      status: dealersTable.status,
      entitlements: dealersTable.entitlements,
    })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  if (!dealer) return false;
  if (dealer.status !== "active") return false;
  return isEntitlementEnabled(dealer.entitlements, "amber_connect");
}

export function newAmberWebhookSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

export async function upsertAmberConnection(
  dealerId: number,
  input: {
    apiBaseUrl?: string | null;
    apiKey?: string;
    enabled?: boolean;
  },
): Promise<AmberConnection> {
  if (input.apiBaseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(input.apiBaseUrl.trim());
    } catch {
      throw Object.assign(new Error("apiBaseUrl must be a valid URL"), {
        statusCode: 400,
      });
    }
    if (parsed.protocol !== "https:") {
      throw Object.assign(new Error("apiBaseUrl must use HTTPS"), {
        statusCode: 400,
      });
    }
  }
  const existing = await getAmberConnection(dealerId);
  const credentialChanged = input.apiKey !== undefined || input.apiBaseUrl !== undefined;
  const apiKeyFields = input.apiKey
    ? {
        apiKeyCiphertext: encryptAmberSecret(input.apiKey.trim(), dealerId),
        apiKeyHint: input.apiKey.trim().slice(0, 4),
      }
    : {};
  if (!existing) {
    const [created] = await db
      .insert(amberConnectionsTable)
      .values({
        dealerId,
        enabled: input.enabled ?? false,
        apiBaseUrl: input.apiBaseUrl?.trim().replace(/\/+$/, "") || null,
        webhookSecret: newAmberWebhookSecret(),
        ...apiKeyFields,
      })
      .returning();
    return created!;
  }
  const [updated] = await db
    .update(amberConnectionsTable)
    .set({
      ...(input.apiBaseUrl !== undefined
        ? { apiBaseUrl: input.apiBaseUrl?.trim().replace(/\/+$/, "") || null }
        : {}),
      ...apiKeyFields,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      // Credentials changed → previous health result is stale.
      ...(credentialChanged ? { lastStatus: null, lastError: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(amberConnectionsTable.dealerId, dealerId))
    .returning();
  return updated!;
}

export async function rotateAmberWebhookSecret(
  dealerId: number,
): Promise<string> {
  const secret = newAmberWebhookSecret();
  const [updated] = await db
    .update(amberConnectionsTable)
    .set({ webhookSecret: secret, updatedAt: new Date() })
    .where(eq(amberConnectionsTable.dealerId, dealerId))
    .returning({ id: amberConnectionsTable.id });
  if (!updated) {
    throw Object.assign(new Error("Amber connection is not configured"), {
      statusCode: 404,
    });
  }
  return secret;
}

/**
 * Test the stored connection. While the partner contract is pending (no
 * registered adapter) this reports pending_contract WITHOUT fabricating any
 * outbound Amber request.
 */
export async function testAmberConnection(dealerId: number): Promise<{
  ok: boolean;
  status: "connected" | "error" | "pending_contract";
  detail: string;
}> {
  const conn = await getAmberConnection(dealerId);
  if (!conn) {
    throw Object.assign(new Error("Amber connection is not configured"), {
      statusCode: 404,
    });
  }
  const provider = resolveAmberProvider(conn);
  let status: "connected" | "error" | "pending_contract";
  let detail: string;
  if (!provider) {
    status = "pending_contract";
    detail = AMBER_CONTRACT_PENDING_MESSAGE;
  } else {
    try {
      const apiKey = decryptAmberSecret(conn.apiKeyCiphertext!, dealerId);
      const result = await provider.test(conn, apiKey);
      status = result.ok ? "connected" : "error";
      detail = result.detail;
    } catch (err) {
      status = "error";
      // Sanitized: never expose raw provider/crypto error text verbatim.
      detail = "Connection test failed — check the stored credentials.";
      logger.warn({ err, dealerId }, "Amber connection test failed");
    }
  }
  await db
    .update(amberConnectionsTable)
    .set({
      lastStatus: status,
      lastError: status === "error" ? detail : null,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(amberConnectionsTable.dealerId, dealerId));
  return { ok: status === "connected", status, detail };
}
