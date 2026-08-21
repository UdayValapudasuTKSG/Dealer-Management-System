import { pool } from "@workspace/db";

// Focused regression checks for the per-dealer SMTP email system:
//   1. GM-only management — non-GM staff cannot read/write connection details
//   2. Credentials never leave the server (no password/ciphertext in any payload)
//   3. Dealer isolation — one dealer's connection is invisible to another
//   4. No global/Gmail fallback — unconfigured dealer test-send refuses
//   5. Queued email for an unconfigured dealer is TERMINALLY cancelled (no retry loop)
//   6. Template overrides: bad merge tokens rejected, valid override applied to preview,
//      other dealers keep the default copy
// Uses the dev-only x-test-user-email persona header against the local api-server.

const BASE = process.env.API_BASE ?? "http://localhost:80/api";
const GM_A = "smtp-test-gm-a@aura-test.local"; // dealer 2 GM
const GM_B = "smtp-test-gm-b@aura-test.local"; // dealer 1 GM
const STAFF_A = "smtp-test-staff-a@aura-test.local"; // dealer 2 non-GM

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail: string) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${detail}`);
    console.log(`  \u2717 ${name} — ${detail}`);
  }
}

async function call(
  method: string,
  path: string,
  user: string,
  dealerId: number,
  body?: unknown,
) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-test-user-email": user,
      "x-dealer-id": String(dealerId),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

async function seedUser(email: string, dealerId: number, roleId: number) {
  await pool.query(`DELETE FROM users WHERE lower(email) = $1`, [email]);
  const id = await pool
    .query(
      `INSERT INTO users (clerk_id, email, name, status)
       VALUES ($1, $2, 'SMTP Test User', 'active') RETURNING id`,
      [`smtp-test-${email}-${Date.now()}`, email],
    )
    .then((r) => r.rows[0].id as number);
  await pool.query(
    `INSERT INTO dealer_users (dealer_id, user_id, role_id) VALUES ($1, $2, $3)`,
    [dealerId, id, roleId],
  );
  return id;
}

async function cleanup() {
  await pool.query(
    `DELETE FROM email_template_overrides WHERE dealer_id IN (1, 2) AND template_key = 'lead_received'
       AND (subject LIKE 'SMTPTEST%' OR heading LIKE 'SMTPTEST%')`,
  );
  await pool.query(
    `DELETE FROM smtp_connections WHERE host = 'smtp.verify-test.invalid'`,
  );
  await pool.query(
    `DELETE FROM email_logs WHERE recipient = 'smtp-verify@aura-test.local'`,
  );
  await pool.query(
    `DELETE FROM users WHERE lower(email) = ANY($1)`,
    [[GM_A, GM_B, STAFF_A]],
  );
}

async function main() {
  const gmRole = await pool
    .query(`SELECT id FROM roles WHERE name = 'General Manager' LIMIT 1`)
    .then((r) => r.rows[0]?.id as number | undefined);
  const staffRole = await pool
    .query(
      `SELECT id FROM roles WHERE name <> 'General Manager' ORDER BY id LIMIT 1`,
    )
    .then((r) => r.rows[0]?.id as number | undefined);
  if (!gmRole || !staffRole) throw new Error("roles not seeded");

  await cleanup();
  await seedUser(GM_A, 2, gmRole);
  await seedUser(GM_B, 1, gmRole);
  await seedUser(STAFF_A, 2, staffRole);
  // Preserve any real dealer-1/2 connections: this suite only creates rows
  // with host smtp.verify-test.invalid and removes exactly those.
  const preexisting = await pool
    .query(`SELECT dealer_id FROM smtp_connections WHERE dealer_id IN (1,2)`)
    .then((r) => r.rows.map((x) => x.dealer_id as number));
  if (preexisting.length > 0) {
    throw new Error(
      `dealers ${preexisting.join(",")} already have SMTP rows; aborting to avoid clobbering real config`,
    );
  }

  try {
    console.log("\n1. GM-only management");
    {
      const r = await call("PUT", "/emails/connection", STAFF_A, 2, {
        host: "smtp.verify-test.invalid",
        port: 587,
        security: "starttls",
        username: "u",
        password: "p",
        fromEmail: "x@y.z",
      });
      check("non-GM PUT connection → 403", r.status === 403, `got ${r.status}`);
      const r2 = await call("DELETE", "/emails/connection", STAFF_A, 2);
      check("non-GM DELETE connection → 403", r2.status === 403, `got ${r2.status}`);
      const r3 = await call("POST", "/emails/connection/test", STAFF_A, 2);
      check("non-GM connection test → 403", r3.status === 403, `got ${r3.status}`);
      const r4 = await call("PUT", "/emails/templates/lead_received/override", STAFF_A, 2, {
        subject: "SMTPTEST nope",
      });
      check("non-GM template override → 403", r4.status === 403, `got ${r4.status}`);
    }

    console.log("\n2. Unconfigured dealer refuses to send (no global fallback)");
    {
      const r = await call("POST", "/emails/test-send", GM_A, 2, {
        to: "smtp-verify@aura-test.local",
      });
      check(
        "test-send without connection → ok:false",
        r.status === 200 && r.json?.ok === false,
        `got ${r.status} ok=${r.json?.ok}`,
      );
      const s = await call("GET", "/emails/settings", GM_A, 2);
      check(
        "settings show configured:false",
        s.json?.configured === false && s.json?.canManage === true,
        JSON.stringify(s.json),
      );
    }

    console.log("\n3. Configure connection (dealer 2)");
    {
      const r = await call("PUT", "/emails/connection", GM_A, 2, {
        host: "smtp.verify-test.invalid",
        port: 587,
        security: "starttls",
        username: "mailbox@verify-test.invalid",
        password: "super-secret-password-XYZZY",
        fromEmail: "sales@verify-test.invalid",
        fromName: "Verify Motors",
      });
      check("GM PUT connection → 200", r.status === 200, `got ${r.status}: ${r.text.slice(0, 200)}`);
      check(
        "response never echoes the password",
        !r.text.includes("XYZZY") && !r.text.toLowerCase().includes("ciphertext"),
        "password material leaked in payload",
      );
      check(
        "hasPassword true, host visible to GM",
        r.json?.hasPassword === true && r.json?.host === "smtp.verify-test.invalid",
        JSON.stringify(r.json),
      );
      const stored = await pool
        .query(`SELECT password_ciphertext FROM smtp_connections WHERE dealer_id = 2`)
        .then((x) => x.rows[0]?.password_ciphertext as string);
      check(
        "password stored encrypted (not plaintext)",
        Boolean(stored) && !stored.includes("XYZZY"),
        "ciphertext missing or contains plaintext",
      );

      // Non-GM roles either have no settings access at all (RBAC 403,
      // fail-closed) or — if a role is ever granted settings:view — must get
      // the redacted payload with no server details. Either way: no leak.
      const staff = await call("GET", "/emails/settings", STAFF_A, 2);
      const redactedOk =
        staff.status === 403 ||
        (staff.status === 200 &&
          staff.json?.canManage === false &&
          staff.json?.host === null &&
          staff.json?.username === null);
      check(
        "non-GM settings hide server details (403 or redacted)",
        redactedOk && !staff.text.includes("XYZZY"),
        `status=${staff.status} ${JSON.stringify(staff.json)}`,
      );
    }

    console.log("\n4. Dealer isolation");
    {
      const b = await call("GET", "/emails/settings", GM_B, 1);
      check(
        "dealer 1 does not see dealer 2's connection",
        b.json?.configured === false,
        JSON.stringify(b.json),
      );
      const bt = await call("POST", "/emails/test-send", GM_B, 1, {
        to: "smtp-verify@aura-test.local",
      });
      check(
        "dealer 1 test-send still refuses (no cross-dealer fallback)",
        bt.status === 200 && bt.json?.ok === false,
        `got ${bt.status} ok=${bt.json?.ok}`,
      );
    }

    console.log("\n5. Unconfigured dealer's queued email is terminally cancelled");
    {
      const enq = await call("POST", "/emails/send", GM_B, 1, {
        template: "lead_received",
        to: "smtp-verify@aura-test.local",
        data: {},
      });
      check("enqueue → 201", enq.status === 201, `got ${enq.status}`);
      const logId = enq.json?.id as number;
      // retry endpoint kicks processQueue immediately
      await call("POST", `/emails/logs/${logId}/retry`, GM_B, 1);
      let status = "";
      let lastError = "";
      let attempts = -1;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const row = await pool
          .query(`SELECT status, last_error, attempts FROM email_logs WHERE id = $1`, [logId])
          .then((r) => r.rows[0]);
        status = row?.status;
        lastError = row?.last_error ?? "";
        attempts = row?.attempts ?? -1;
        if (status === "cancelled") break;
      }
      check(
        "log terminally cancelled with skip reason",
        status === "cancelled" && lastError.length > 0,
        `status=${status} lastError=${lastError}`,
      );
      // The atomic claim increments attempts once before the skip decision;
      // terminal cancellation must stop it there (no retry loop).
      check("no retry loop (attempts ≤ 1)", attempts >= 0 && attempts <= 1, `attempts=${attempts}`);
    }

    console.log("\n6. Template overrides");
    {
      const bad = await call("PUT", "/emails/templates/lead_received/override", GM_A, 2, {
        subject: "SMTPTEST {{notAField}}",
      });
      check("unknown merge token → 400", bad.status === 400, `got ${bad.status}`);
      const ok = await call("PUT", "/emails/templates/lead_received/override", GM_A, 2, {
        subject: "SMTPTEST custom for {{name}}",
        heading: "SMTPTEST hello {{name}}",
      });
      check("valid override saved", ok.status === 200 && ok.json?.hasOverride === true, `got ${ok.status}`);
      const prev = await call("GET", "/emails/templates/lead_received/preview", GM_A, 2);
      check(
        "preview applies override with merged field",
        prev.json?.subject?.startsWith("SMTPTEST custom for ") === true &&
          !String(prev.json?.subject).includes("{{"),
        `subject=${prev.json?.subject}`,
      );
      const prevB = await call("GET", "/emails/templates/lead_received/preview", GM_B, 1);
      check(
        "other dealer keeps the default copy",
        !String(prevB.json?.subject ?? "").includes("SMTPTEST"),
        `subject=${prevB.json?.subject}`,
      );
      const reset = await call("DELETE", "/emails/templates/lead_received/override", GM_A, 2);
      check("reset override → hasOverride:false", reset.json?.hasOverride === false, JSON.stringify(reset.json));
    }

    console.log("\n7. Remove connection");
    {
      const del = await call("DELETE", "/emails/connection", GM_A, 2);
      check("GM DELETE connection → configured:false", del.status === 200 && del.json?.configured === false, `got ${del.status}`);
      const t = await call("POST", "/emails/test-send", GM_A, 2, {
        to: "smtp-verify@aura-test.local",
      });
      check("sends refuse again after removal", t.json?.ok === false, JSON.stringify(t.json));
    }
  } finally {
    await cleanup();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
