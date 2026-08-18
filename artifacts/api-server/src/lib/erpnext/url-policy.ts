import dns from "node:dns/promises";
import net from "node:net";

// ---------------------------------------------------------------------------
// SSRF policy for the ERPNext site URL. The GM-supplied URL is fetched
// server-side WITH the stored API token attached, so it must never be
// allowed to point at internal services (loopback, RFC1918, link-local /
// cloud metadata, CGNAT, ULA). Enforced at save time AND immediately before
// every fetch (re-resolving DNS so a later rebind is also caught), with
// redirects disabled at the fetch layer.
// ---------------------------------------------------------------------------

/** Dev/test escape hatch only — lets local stub servers be used. */
const ALLOW_PRIVATE =
  process.env.NODE_ENV !== "production" &&
  process.env["ERPNEXT_ALLOW_PRIVATE_URLS"] === "1";

export class ErpnextUrlPolicyError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = "ErpnextUrlPolicyError";
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable → fail closed
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 100 && b! >= 64 && b! <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 192 && b === 0) || // 192.0.0/24 + 192.0.2/24 doc
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved
  );
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return (
    lower === "::" ||
    lower === "::1" || // loopback
    lower.startsWith("fc") || // fc00::/7 ULA
    lower.startsWith("fd") ||
    lower.startsWith("fe8") || // fe80::/10 link-local
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("ff") // multicast
  );
}

/**
 * Validate an ERPNext site URL: HTTPS only, a real public hostname, and
 * every DNS answer must be a public address. Throws ErpnextUrlPolicyError.
 */
export async function assertSafeErpnextUrl(siteUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    throw new ErpnextUrlPolicyError("Site URL is not a valid URL");
  }
  if (url.protocol !== "https:" && !(ALLOW_PRIVATE && url.protocol === "http:")) {
    throw new ErpnextUrlPolicyError("Site URL must use https://");
  }
  if (url.username || url.password) {
    throw new ErpnextUrlPolicyError("Site URL must not embed credentials");
  }
  if (ALLOW_PRIVATE) return;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new ErpnextUrlPolicyError(
        "Site URL must point at a public ERPNext host, not an internal address",
      );
    }
    return;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new ErpnextUrlPolicyError(
      "Site URL must point at a public ERPNext host, not an internal address",
    );
  }
  let records: { address: string }[];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new ErpnextUrlPolicyError(
      `Could not resolve ${host} — check the site URL`,
    );
  }
  if (records.length === 0 || records.some((r) => isPrivateIp(r.address))) {
    throw new ErpnextUrlPolicyError(
      "Site URL must point at a public ERPNext host, not an internal address",
    );
  }
}
