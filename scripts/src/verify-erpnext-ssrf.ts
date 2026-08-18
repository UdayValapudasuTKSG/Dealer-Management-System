/**
 * Targeted checks for the ERPNext foundation:
 *  1. SSRF policy — the settings endpoint must reject internal/unsafe site URLs.
 *  2. Migration-backed flows — settings GET, webhook receiver, and the sync
 *     queue must work against the migrated tables.
 *
 * Requires the API server workflow to be running (dev auth via
 * x-test-user-email). Usage: pnpm --filter @workspace/scripts run verify-erpnext-ssrf
 */
import { pool } from "@workspace/db";

const BASE = process.env["API_BASE"] ?? "http://localhost:80/api";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const pg = pool;

  const gmRes = await pg.query(
    `select u.email from users u join dealer_users du on du.user_id = u.id and du.is_general_manager limit 1`,
  );
  const gm: string = gmRes.rows[0].email;
  const authed = (path: string, init?: RequestInit) =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-test-user-email": gm,
        ...(init?.headers ?? {}),
      },
    });

  // ——— 1. SSRF rejection ———
  const badUrls = [
    ["cloud metadata", "http://169.254.169.254/latest/meta-data"],
    ["https metadata IP", "https://169.254.169.254"],
    ["localhost", "https://localhost:8443"],
    ["loopback IP", "https://127.0.0.1"],
    ["RFC1918", "https://10.0.0.5"],
    ["RFC1918 172", "https://172.16.0.1"],
    ["RFC1918 192.168", "https://192.168.1.10"],
    ["CGNAT", "https://100.64.0.1"],
    ["IPv6 loopback", "https://[::1]"],
    ["plain http", "http://example.com"],
    ["embedded creds", "https://user:pass@example.com"],
    ["internal suffix", "https://db.internal"],
  ] as const;
  for (const [label, url] of badUrls) {
    const r = await authed("/erpnext/settings", {
      method: "PUT",
      body: JSON.stringify({ siteUrl: url, apiKey: "k", apiSecret: "s" }),
    });
    check(`rejects ${label} (${url})`, r.status === 422 || r.status === 400, `status ${r.status}`);
  }
  // Nothing may have been persisted by the rejected saves.
  const persisted = await pg.query(
    `select count(*)::int as n from erpnext_connections where site_url like '%169.254%' or site_url like '%localhost%' or site_url like '%127.0.0.1%'`,
  );
  check("no unsafe URL persisted", persisted.rows[0].n === 0);

  // ——— 2. Migration-backed flows ———
  for (const t of ["erpnext_connections", "erpnext_sync_jobs", "erpnext_refs", "erpnext_webhook_events"]) {
    const r = await pg.query(`select to_regclass($1) as reg`, [t]);
    check(`table ${t} exists`, r.rows[0].reg === t);
  }

  const settings = await authed("/erpnext/settings");
  const body = (await settings.json()) as { configured: boolean };
  check("settings GET works (not-connected state)", settings.status === 200 && typeof body.configured === "boolean");

  // Accepts a valid public HTTPS host.
  const good = await authed("/erpnext/settings", {
    method: "PUT",
    body: JSON.stringify({ siteUrl: "https://demo.frappe.cloud", apiKey: "verify-key", apiSecret: "verify-secret" }),
  });
  const goodBody = (await good.json()) as { configured?: boolean; webhookSecret?: string };
  check("accepts public https host", good.status === 200 && goodBody.configured === true);

  // Webhook receiver: bad secret 403, good secret 200 + ledger row.
  const dealerRes = await pg.query(`select dealer_id, webhook_secret from erpnext_connections where site_url = 'https://demo.frappe.cloud' limit 1`);
  const { dealer_id: dealerId, webhook_secret: secret } = dealerRes.rows[0];
  const badHook = await fetch(`${BASE}/webhooks/erpnext/${dealerId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aura-webhook-secret": "wrong" },
    body: JSON.stringify({ doctype: "Customer", name: "V-1", event: "on_update" }),
  });
  check("webhook rejects bad secret", badHook.status === 403);
  const goodHook = await fetch(`${BASE}/webhooks/erpnext/${dealerId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aura-webhook-secret": secret },
    body: JSON.stringify({ doctype: "Customer", name: "V-1", event: "on_update" }),
  });
  check("webhook accepts valid secret", goodHook.status === 200);
  const evt = await pg.query(`select status from erpnext_webhook_events where dealer_id = $1 and doc_name = 'V-1' order by id desc limit 1`, [dealerId]);
  check("webhook event recorded", evt.rowCount === 1);

  // Sync queue: job listable via API.
  await pg.query(
    `insert into erpnext_sync_jobs (dealer_id, doctype, entity_type, entity_id, payload, dedupe_key) values ($1, 'Customer', 'customer', 424242, '{}', 'verify:ssrf:424242') on conflict (dedupe_key) do nothing`,
    [dealerId],
  );
  const jobs = await authed("/erpnext/sync-jobs");
  const jobList = (await jobs.json()) as { entityId: number }[];
  check("sync jobs listable", jobs.status === 200 && jobList.some((j) => j.entityId === 424242));

  // Cleanup verification artifacts.
  await pg.query(`delete from erpnext_sync_jobs where dedupe_key = 'verify:ssrf:424242'`);
  await pg.query(`delete from erpnext_webhook_events where doc_name = 'V-1'`);
  await pg.query(`delete from erpnext_connections where site_url = 'https://demo.frappe.cloud' and api_key = 'verify-key'`);
  await pg.end();

  console.log(failures === 0 ? "\nAll ERPNext foundation checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
