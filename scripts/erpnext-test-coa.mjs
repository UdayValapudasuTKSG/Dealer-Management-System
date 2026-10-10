// Restricted to the user-confirmed ERPNext test company. Never posts journals,
// balances or transactions, never edits existing accounts, never accesses AURA DB.
import { mkdir, writeFile, readFile } from "node:fs/promises";
const base = "https://erpnext-jcy-qlx.m.frappe.cloud";
const company = "GT AUTOMOTIVE";
const output = "generated-artifacts/gt-coa";
async function api(path, method = "GET", body) {
  if (!process.env.ERPNEXT_SETUP_API_KEY || !process.env.ERPNEXT_SETUP_API_SECRET) {
    throw new Error("ERPNext setup credentials are unavailable.");
  }
  const res = await fetch(`${base}/api/${path}`, {
    method, redirect: "error",
    headers: {
      Authorization: `token ${process.env.ERPNEXT_SETUP_API_KEY}:${process.env.ERPNEXT_SETUP_API_SECRET}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (!res.ok) {
    // Frappe exceptions can contain request details. Never log raw responses.
    throw new Error(`ERPNext ${method} ${path.split("?")[0]} failed: HTTP ${res.status}, ${json.exc_type || "API rejection"}`);
  }
  return json.data ?? json.message ?? json;
}
async function list(type, fields, filters = []) {
  const rows = [];
  for (let start = 0; ; start += 200) {
    const page = await api(`resource/${encodeURIComponent(type)}?${new URLSearchParams({
      fields: JSON.stringify(fields), filters: JSON.stringify(filters),
      limit_start: String(start), limit_page_length: "200", order_by: "name asc",
    })}`);
    rows.push(...page);
    if (page.length < 200) return rows;
  }
}
async function inspect() {
  const c = await api(`resource/Company/${encodeURIComponent(company)}`);
  const accounts = await list("Account", ["name","account_name","account_number","parent_account","is_group","root_type","account_type","account_currency","disabled"], [["company","=",company]]);
  const warehouses = await list("Warehouse", ["name","warehouse_name","is_group","disabled","account"], [["company","=",company]]);
  const modes = await list("Mode of Payment", ["name","type","enabled"]);
  const defaultFields = ["name","abbr","default_currency","enable_perpetual_inventory","default_receivable_account","default_payable_account","default_cash_account","default_bank_account","default_income_account","default_expense_account","stock_received_but_not_billed","stock_adjustment_account","default_inventory_account","cost_center"];
  const report = { site: base, inspectedAt: new Date().toISOString(), company: Object.fromEntries(defaultFields.map(k => [k,c[k] ?? null])), accounts, warehouses, modes };
  if (c.default_currency !== "GYD") throw new Error("Expected company currency GYD; stop before changes.");
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/erpnext-current-accounts.json`, JSON.stringify(report,null,2));
  return report;
}
try {
  const report = await inspect();
  if (process.argv.includes("--apply")) {
    const plan = JSON.parse(await readFile(`${output}/account-setup-plan.json`, "utf8"));
    if (plan.site !== base || plan.company !== company || plan.currency !== "GYD") throw new Error("Plan target mismatch.");
    if (report.company.abbr !== "GA") throw new Error("Company abbreviation changed; review required.");
    const checks = ["name","account_name","account_number","parent_account","is_group","root_type","account_type","account_currency","disabled"];
    const pending = [];
    // Entire plan preflight, before making any write.
    for (const row of plan.create) {
      if (row.company !== company || row.is_group !== 0 || row.account_currency !== "GYD") throw new Error("Unsafe account plan.");
      const parent = report.accounts.find(a => a.name === row.parent_account);
      if (!parent || !parent.is_group || parent.disabled || parent.root_type !== row.root_type) throw new Error(`Invalid parent for ${row.account_number}`);
      const existing = report.accounts.find(a => a.account_number === row.account_number || a.account_name === row.account_name);
      if (existing && Object.entries(row).some(([k,v]) => !["doctype","company","report_type"].includes(k) && existing[k] !== v)) throw new Error(`Existing account conflict: ${row.account_number}`);
      pending.push({ row, existing });
    }
    for (const row of plan.reuse) {
      const a = report.accounts.find(a => a.name === row.existing_account);
      if (!a || a.disabled || a.is_group) throw new Error(`Invalid reuse account: ${row.source_code}`);
    }
    const journal = { site: base, company, startedAt: new Date().toISOString(), created: [], reused: plan.reuse, held: plan.hold };
    await writeFile(`${output}/erpnext-before-setup.json`, JSON.stringify(report,null,2));
    for (const { row, existing } of pending) {
      const saved = existing ?? await api("resource/Account", "POST", row);
      const verified = await api(`resource/Account/${encodeURIComponent(saved.name)}`);
      for (const [key,value] of Object.entries(row)) {
        if (!["doctype"].includes(key) && verified[key] !== value) throw new Error(`Read-back mismatch ${row.account_number}: ${key}`);
      }
      journal.created.push({ name: verified.name, account_number: row.account_number, action: existing ? "already present" : "created", verified: true });
      await writeFile(`${output}/erpnext-setup-result.json`, JSON.stringify(journal,null,2));
      console.log(`${existing ? "VERIFIED" : "CREATED"} ${verified.name}`);
    }
    const after = await inspect();
    for (const old of report.accounts) {
      const now = after.accounts.find(a => a.name === old.name);
      if (!now || checks.some(k => now[k] !== old[k])) throw new Error(`Pre-existing account changed: ${old.name}`);
    }
    if (JSON.stringify(report.company) !== JSON.stringify(after.company)) throw new Error("Company defaults changed during setup; investigate.");
    journal.finishedAt = new Date().toISOString();
    journal.existingAccountsUnchanged = true;
    journal.companyDefaultsUnchanged = true;
    journal.transactionWrites = 0;
    await writeFile(`${output}/erpnext-setup-result.json`, JSON.stringify(journal,null,2));
    console.log(JSON.stringify({createdOrVerified: journal.created.length, reused: journal.reused.length, held: journal.held.length, existingAccountsUnchanged: true, companyDefaultsUnchanged: true}));
  } else {
    console.log(JSON.stringify(report,null,2));
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
