import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, erpnextConnectionsTable, type ErpnextConnection } from "@workspace/db";
import { ErpnextClient, ErpnextError } from "./client";
import { assertSafeErpnextUrl } from "./url-policy";

// ---------------------------------------------------------------------------
// Per-dealer ERPNext connection settings. Credentials live server-side only;
// the client sees a masked API key and never sees the API secret.
// ---------------------------------------------------------------------------

export async function getErpnextConnection(
  dealerId: number,
): Promise<ErpnextConnection | null> {
  const [row] = await db
    .select()
    .from(erpnextConnectionsTable)
    .where(eq(erpnextConnectionsTable.dealerId, dealerId));
  return row ?? null;
}

export function newWebhookSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

/** Show only the first 4 characters of the API key. */
export function maskApiKey(key: string): string {
  return key.length <= 4 ? "••••" : `${key.slice(0, 4)}${"•".repeat(8)}`;
}

export async function upsertErpnextConnection(
  dealerId: number,
  input: {
    siteUrl?: string;
    apiKey?: string;
    apiSecret?: string;
    enabled?: boolean;
    defaultWarehouse?: string | null;
    incomeAccount?: string | null;
    taxAccount?: string | null;
    paymentModes?: Record<string, string> | null;
    receivableAccount?: string | null;
    settlementAccount?: string | null;
  },
): Promise<ErpnextConnection> {
  // SSRF policy: only public HTTPS ERPNext hosts may be stored. (Throws a
  // 422 ErpnextUrlPolicyError; the route surfaces its statusCode.)
  if (input.siteUrl !== undefined) await assertSafeErpnextUrl(input.siteUrl);
  const existing = await getErpnextConnection(dealerId);
  if (!existing) {
    if (!input.siteUrl || !input.apiKey || !input.apiSecret) {
      throw Object.assign(
        new Error("siteUrl, apiKey and apiSecret are required for a first-time connection"),
        { statusCode: 400 },
      );
    }
    const [created] = await db
      .insert(erpnextConnectionsTable)
      .values({
        dealerId,
        siteUrl: input.siteUrl.trim().replace(/\/+$/, ""),
        apiKey: input.apiKey.trim(),
        apiSecret: input.apiSecret.trim(),
        webhookSecret: newWebhookSecret(),
        enabled: input.enabled ?? true,
        defaultWarehouse: input.defaultWarehouse?.trim() || null,
        incomeAccount: input.incomeAccount?.trim() || null,
        taxAccount: input.taxAccount?.trim() || null,
        paymentModes: input.paymentModes ?? null,
        receivableAccount: input.receivableAccount?.trim() || null,
        settlementAccount: input.settlementAccount?.trim() || null,
      })
      .returning();
    return created!;
  }
  const [updated] = await db
    .update(erpnextConnectionsTable)
    .set({
      ...(input.siteUrl !== undefined
        ? { siteUrl: input.siteUrl.trim().replace(/\/+$/, "") }
        : {}),
      ...(input.apiKey ? { apiKey: input.apiKey.trim() } : {}),
      ...(input.apiSecret ? { apiSecret: input.apiSecret.trim() } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.defaultWarehouse !== undefined
        ? { defaultWarehouse: input.defaultWarehouse?.trim() || null }
        : {}),
      ...(input.incomeAccount !== undefined
        ? { incomeAccount: input.incomeAccount?.trim() || null }
        : {}),
      ...(input.taxAccount !== undefined
        ? { taxAccount: input.taxAccount?.trim() || null }
        : {}),
      ...(input.paymentModes !== undefined
        ? { paymentModes: input.paymentModes }
        : {}),
      ...(input.receivableAccount !== undefined
        ? { receivableAccount: input.receivableAccount?.trim() || null }
        : {}),
      ...(input.settlementAccount !== undefined
        ? { settlementAccount: input.settlementAccount?.trim() || null }
        : {}),
      // Credentials changed → previous health result is stale.
      ...(input.siteUrl !== undefined || input.apiKey || input.apiSecret
        ? { lastStatus: null, lastError: null, companyName: null, erpnextVersion: null }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(erpnextConnectionsTable.dealerId, dealerId))
    .returning();
  return updated!;
}

export async function rotateWebhookSecret(dealerId: number): Promise<string> {
  const secret = newWebhookSecret();
  const [updated] = await db
    .update(erpnextConnectionsTable)
    .set({ webhookSecret: secret, updatedAt: new Date() })
    .where(eq(erpnextConnectionsTable.dealerId, dealerId))
    .returning({ id: erpnextConnectionsTable.id });
  if (!updated) {
    throw Object.assign(new Error("ERPNext is not configured yet"), {
      statusCode: 404,
    });
  }
  return secret;
}

export function clientFor(conn: ErpnextConnection): ErpnextClient {
  return new ErpnextClient({
    siteUrl: conn.siteUrl,
    apiKey: conn.apiKey,
    apiSecret: conn.apiSecret,
  });
}

/** Run a live credential check and persist the result on the connection. */
export async function testErpnextConnection(dealerId: number): Promise<{
  ok: boolean;
  companyName: string | null;
  version: string | null;
  user: string | null;
  error: string | null;
}> {
  const conn = await getErpnextConnection(dealerId);
  if (!conn) {
    return {
      ok: false,
      companyName: null,
      version: null,
      user: null,
      error: "ERPNext is not configured yet",
    };
  }
  try {
    const client = clientFor(conn);
    const result = await client.testConnection();
    // Best-effort: capture the site timezone so inbound webhook timestamps
    // (naive, site-local) can be ordered correctly against AURA edits.
    let siteTimezone: string | null = conn.siteTimezone;
    try {
      const sys = await client.getDoc<{ time_zone?: string }>(
        "System Settings",
        "System Settings",
      );
      if (sys.time_zone) siteTimezone = sys.time_zone;
    } catch {
      // Not fatal — keep whatever we knew; UTC fallback applies inbound.
    }
    await db
      .update(erpnextConnectionsTable)
      .set({
        lastStatus: "connected",
        lastError: null,
        lastCheckedAt: new Date(),
        // Keep an explicitly-chosen company (e.g. UAT → demo company) as long
        // as it still exists on the site; only fall back to discovery.
        companyName:
          conn.companyName && result.companyNames.includes(conn.companyName)
            ? conn.companyName
            : result.companyName,
        erpnextVersion: result.version,
        siteTimezone,
        updatedAt: new Date(),
      })
      .where(eq(erpnextConnectionsTable.dealerId, dealerId));
    return {
      ok: true,
      companyName: result.companyName,
      version: result.version,
      user: result.user,
      error: null,
    };
  } catch (err) {
    const message =
      err instanceof ErpnextError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await db
      .update(erpnextConnectionsTable)
      .set({
        lastStatus: "error",
        lastError: message.slice(0, 500),
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(erpnextConnectionsTable.dealerId, dealerId));
    return { ok: false, companyName: null, version: null, user: null, error: message };
  }
}
