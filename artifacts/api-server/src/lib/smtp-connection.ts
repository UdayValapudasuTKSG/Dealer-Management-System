/**
 * Per-dealer SMTP transport resolution.
 *
 * Every outbound email is sent through the OWNING dealer's configured SMTP
 * connection. There is NO shared/global fallback sender: a dealer with no
 * connection (or a disabled one, or one missing a password) sends nothing,
 * and the outbox item is terminally skipped with a clear reason.
 *
 * Transports are pooled per dealer and cached keyed by the connection row's
 * updatedAt version; any settings change closes and replaces the pool.
 *
 * SERVER-ONLY. Decrypted passwords never leave this module.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { eq } from "drizzle-orm";
import {
  db,
  dealersTable,
  smtpConnectionsTable,
  type SmtpConnection,
} from "@workspace/db";
import { decryptSmtpPassword } from "./smtp-crypto";
import { logger } from "./logger";

export type DealerSmtpUnavailableReason =
  | "not_configured"
  | "disabled"
  | "missing_password";

export type DealerSmtpResolution =
  | {
      ok: true;
      transport: Transporter;
      fromEmail: string;
      fromName: string | null;
      replyTo: string | null;
    }
  | { ok: false; reason: DealerSmtpUnavailableReason };

export function smtpSkipMessage(reason: DealerSmtpUnavailableReason): string {
  switch (reason) {
    case "disabled":
      return "skipped: email sending is paused for this dealership";
    case "missing_password":
      return "skipped: the dealership's email connection has no password saved";
    default:
      return "skipped: this dealership has not configured an email connection";
  }
}

/**
 * Map an SMTP/network error to a safe, fixed diagnostic message. Raw SMTP
 * error text (server banners, auth responses) may echo credential material —
 * especially from a hostile or misconfigured endpoint — so nothing from the
 * original message is ever returned, persisted, or logged. Only the
 * classification survives.
 */
export function sanitizeSmtpError(err: unknown): {
  code: string;
  message: string;
} {
  const e = err as {
    code?: string;
    responseCode?: number;
    errno?: string;
  } | null;
  const code = e?.code ?? e?.errno ?? "";
  const rc = e?.responseCode ?? 0;
  if (code === "EAUTH" || rc === 535 || rc === 534) {
    return {
      code: "auth_failed",
      message:
        "Authentication failed — check the username and password (many providers require an app password).",
    };
  }
  if (code === "EDNS" || code === "ENOTFOUND") {
    return {
      code: "host_not_found",
      message: "The SMTP host could not be found — check the server hostname.",
    };
  }
  if (code === "ECONNREFUSED") {
    return {
      code: "connection_refused",
      message:
        "The server refused the connection — check the port and security mode.",
    };
  }
  if (code === "ETIMEDOUT" || code === "ECONNECTION" || code === "ESOCKET") {
    return {
      code: "connection_failed",
      message:
        "Could not reach the SMTP server — check the host, port and security mode.",
    };
  }
  if (code === "EENVELOPE" || (rc >= 550 && rc <= 554)) {
    return {
      code: "rejected",
      message: "The server rejected the message envelope (sender/recipient).",
    };
  }
  if (rc >= 400 && rc < 500) {
    return {
      code: "temporarily_rejected",
      message: "The server temporarily rejected the message — try again later.",
    };
  }
  return {
    code: "send_failed",
    message: "The SMTP server reported an error while sending.",
  };
}

export async function getSmtpConnectionRow(
  dealerId: number,
): Promise<SmtpConnection | null> {
  const [row] = await db
    .select()
    .from(smtpConnectionsTable)
    .where(eq(smtpConnectionsTable.dealerId, dealerId))
    .limit(1);
  return row ?? null;
}

/**
 * Server-only credential row for explicit Gmail IMAP intake. This does not
 * discover dealers, apply fallbacks, or expose the decrypted password.
 */
export async function getDealerGmailCredentialRow(dealerId: number) {
  const [row] = await db
    .select({
      dealerId: smtpConnectionsTable.dealerId,
      dealerStatus: dealersTable.status,
      host: smtpConnectionsTable.host,
      username: smtpConnectionsTable.username,
      enabled: smtpConnectionsTable.enabled,
      passwordCiphertext: smtpConnectionsTable.passwordCiphertext,
    })
    .from(smtpConnectionsTable)
    .innerJoin(dealersTable, eq(dealersTable.id, smtpConnectionsTable.dealerId))
    .where(eq(smtpConnectionsTable.dealerId, dealerId))
    .limit(1);
  return row ?? null;
}

type CacheEntry = { version: number; transport: Transporter };
const transportCache = new Map<number, CacheEntry>();

/** Close and drop a dealer's pooled transport (after update/disable/delete). */
export function invalidateSmtpTransport(dealerId: number): void {
  const hit = transportCache.get(dealerId);
  if (hit) {
    try {
      hit.transport.close();
    } catch {
      // pool already closed
    }
    transportCache.delete(dealerId);
  }
}

/** Build (but do not cache) a transport for a connection row. */
export function buildSmtpTransport(row: SmtpConnection): Transporter {
  if (!row.passwordCiphertext) {
    throw new Error("SMTP connection has no stored password");
  }
  const pass = decryptSmtpPassword(row.passwordCiphertext, row.dealerId);
  return nodemailer.createTransport({
    host: row.host,
    port: row.port,
    // "ssl" = implicit TLS; "starttls"/"none" connect plain then upgrade
    // (nodemailer negotiates STARTTLS automatically when offered).
    secure: row.security === "ssl",
    ...(row.security === "starttls" ? { requireTLS: true } : {}),
    // Pooled connections: reuse one authenticated session for many messages
    // instead of a fresh SMTP login per email (providers throttle logins).
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
    rateDelta: 1000,
    rateLimit: 1,
    auth: { user: row.username, pass },
  });
}

/**
 * Resolve the transport + sender identity for a dealer. Never falls back to
 * another dealer or a global sender.
 */
export async function resolveDealerSmtp(
  dealerId: number,
): Promise<DealerSmtpResolution> {
  const row = await getSmtpConnectionRow(dealerId);
  if (!row) return { ok: false, reason: "not_configured" };
  if (!row.enabled) return { ok: false, reason: "disabled" };
  if (!row.passwordCiphertext) return { ok: false, reason: "missing_password" };

  const version = row.updatedAt.getTime();
  const hit = transportCache.get(dealerId);
  let transport: Transporter;
  if (hit && hit.version === version) {
    transport = hit.transport;
  } else {
    if (hit) invalidateSmtpTransport(dealerId);
    try {
      transport = buildSmtpTransport(row);
    } catch (err) {
      // Decryption failure (e.g. rotated SESSION_SECRET) — treat as missing
      // password so the item is skipped with a clear reason, never retried
      // against a broken credential. Never log the error payload verbatim
      // beyond its message (which contains no secret material).
      logger.error(
        { dealerId, err: err instanceof Error ? err.message : "unknown" },
        "failed to build dealer SMTP transport",
      );
      return { ok: false, reason: "missing_password" };
    }
    transportCache.set(dealerId, { version, transport });
  }
  return {
    ok: true,
    transport,
    fromEmail: row.fromEmail,
    fromName: row.fromName ?? null,
    replyTo: row.replyTo ?? null,
  };
}
