// Master data only: no inventory balances, invoices, journals, or tax approvals.
import { readFile, writeFile } from "node:fs/promises";
const base = "https://erpnext-jcy-qlx.m.frappe.cloud";
const company = "GT AUTOMOTIVE";
const report = JSON.parse(await readFile("generated-artifacts/gt-coa/erpnext-current-accounts.json", "utf8"));
async function api(path, method = "GET", body) {
  if (!process.env.ERPNEXT_SETUP_API_KEY || !process.env.ERPNEXT_SETUP_API_SECRET) throw Error("Missing setup credentials");
  const response = await fetch(`${base}/api/resource/${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { Authorization: `token ${process.env.ERPNEXT_SETUP_API_KEY}:${process.env.ERPNEXT_SETUP_API_SECRET}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw Error(`ERPNext master data request failed: HTTP ${response.status}`);
  return (await response.json()).data;
}
const c = await api(`Company/${encodeURIComponent(company)}`);
if (c.abbr !== "GA" || c.default_currency !== "GYD" || report.site !== base) throw Error("Target mismatch");
const brands = ["BYD", "Foton", "Jetour", "BMW", "Accessories"];
const get = code => {
  const a = report.accounts.find(a => a.account_number === code);
  if (!a || a.disabled || a.is_group || a.account_currency !== "GYD") throw Error(`Invalid account ${code}`);
  return a.name;
};
const rows = [];
for (const [index, brand] of brands.entries()) {
  const suffix = String(index + 1);
  const inventory = get(`103070${suffix}`);
  const live = await api(`Account/${encodeURIComponent(inventory)}`);
  if (live.company !== company || live.root_type !== "Asset" || live.account_type !== "Stock" || live.is_group || live.disabled) throw Error("Invalid inventory account");
  const label = `AURA Dummy Parts - ${brand}`;
  const name = `${label} - GA`;
  const matches = await api("Warehouse?" + new URLSearchParams({
    filters: JSON.stringify([["name", "=", name]]), fields: JSON.stringify(["name"]), limit_page_length: "2",
  }));
  if (!matches.length) {
    await api("Warehouse", "POST", { warehouse_name: label, company, parent_warehouse: "All Warehouses - GA", is_group: 0, account: inventory });
  }
  const wh = await api(`Warehouse/${encodeURIComponent(name)}`);
  if (wh.company !== company || wh.account !== inventory || wh.is_group || wh.disabled) throw Error(`Warehouse mismatch: ${name}`);
  rows.push({ brand, income: get(`402010${suffix}`), cogs: get(`502010${suffix}`), inventory, warehouse: wh.name });
}
const center = await api("Cost%20Center/Main%20-%20GA");
if (center.company !== company || center.is_group || center.disabled) throw Error("Invalid cost center");
const result = {
  company, site: base, checkedAt: new Date().toISOString(),
  general: { receivable: get("1020101"), vat: get("2030101"), overShort: get("6060112"), openingOffset: get("3030101"), costCenter: center.name },
  sources: [
    { label: "Counter cash", kind: "cash", account: get("1010201") },
    { label: "Demerara Bank", kind: "bank", account: get("1010101") },
    { label: "Card clearing", kind: "card", account: get("1010303") },
  ],
  brands: rows,
};
await writeFile("generated-artifacts/gt-coa/parts-pos-mappings.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
