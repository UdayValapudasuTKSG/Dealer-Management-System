// Authorized opening stock for isolated dummy parts only. Reuses its exact voucher.
const base = "https://erpnext-jcy-qlx.m.frappe.cloud";
const company = "GT AUTOMOTIVE";
const marker = "AURA-DUMMY-PARTS-OPENING-20261020";
async function api(path, method = "GET", body) {
  const r = await fetch(`${base}/api/${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(45000),
    headers: { Authorization: `token ${process.env.ERPNEXT_SETUP_API_KEY}:${process.env.ERPNEXT_SETUP_API_SECRET}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw Error(`ERP opening stock HTTP ${r.status}: ${j.exc_type || "rejected"}`);
  return j.data ?? j.message;
}
const get = (type, name) => api(`resource/${encodeURIComponent(type)}/${encodeURIComponent(name)}`);
const list = (type, fields, filters) => api(`resource/${encodeURIComponent(type)}?${new URLSearchParams({
  fields: JSON.stringify(fields), filters: JSON.stringify(filters), limit_page_length: "100",
})}`);
const c = await get("Company", company);
if (c.abbr !== "GA" || c.default_currency !== "GYD") throw Error("Wrong test company");
const offset = "3030101 - Opening Balance Equity - To Be Reclassified - GA";
const a = await get("Account", offset);
if (a.company !== company || a.is_group || a.disabled || a.root_type !== "Equity") throw Error("Invalid opening equity");
const specs = ["BYD", "Foton", "Jetour", "BMW", "Accessories"].map((brand, i) => ({
  item_code: `AURA-POS-TEST-${brand.toUpperCase()}`, qty: 20, basic_rate: 1000 + i * 500,
  t_warehouse: `AURA Dummy Parts - ${brand} - GA`, expense_account: offset, cost_center: "Main - GA",
}));
for (const s of specs) {
  const [item, wh] = await Promise.all([get("Item", s.item_code), get("Warehouse", s.t_warehouse)]);
  if (!item.item_name.startsWith("[DUMMY TEST ONLY]") || item.valuation_method !== "Moving Average" ||
      item.has_serial_no || item.has_batch_no || !item.is_stock_item || item.disabled ||
      wh.company !== company || wh.disabled || wh.is_group) throw Error("Invalid dummy boundary");
}
const matches = await list("Stock Entry", ["name", "docstatus"], [["company", "=", company], ["remarks", "=", marker]]);
if (matches.length > 1 || matches.some(d => d.docstatus === 2)) throw Error("Opening voucher conflict; manual review needed");
let doc;
if (matches.length) {
  doc = await get("Stock Entry", matches[0].name);
} else {
  for (const s of specs) {
    const ledger = await list("Stock Ledger Entry", ["name"], [["item_code", "=", s.item_code], ["warehouse", "=", s.t_warehouse]]);
    if (ledger.length) throw Error("Existing stock history: do not duplicate opening balances");
  }
  doc = await api("resource/Stock%20Entry", "POST", {
    company, stock_entry_type: "Material Receipt", purpose: "Material Receipt",
    posting_date: "2026-10-20", posting_time: "00:00:00", set_posting_time: 1,
    remarks: marker, items: specs,
  });
}
if (doc.items.length !== specs.length || specs.some(s => !doc.items.some(l =>
  l.item_code === s.item_code && Number(l.qty) === s.qty && Number(l.basic_rate) === s.basic_rate &&
  l.t_warehouse === s.t_warehouse && l.expense_account === offset))) throw Error("Opening draft differs from authorized fixture");
if (doc.docstatus === 0) await api("method/frappe.client.submit", "POST", { doc: { ...doc, doctype: "Stock Entry" } });
doc = await get("Stock Entry", doc.name);
if (doc.docstatus !== 1) throw Error("Opening stock not submitted");
const gl = await list("GL Entry", ["account", "debit", "credit"], [["company", "=", company], ["voucher_type", "=", "Stock Entry"], ["voucher_no", "=", doc.name], ["is_cancelled", "=", 0]]);
const debit = gl.reduce((n, l) => n + Number(l.debit), 0);
const credit = gl.reduce((n, l) => n + Number(l.credit), 0);
if (debit !== 200000 || credit !== 200000) throw Error("Opening GL does not balance to expected GYD 200,000");
const bins = await list("Bin", ["item_code", "warehouse", "actual_qty", "valuation_rate"], [["warehouse", "like", "AURA Dummy Parts%"]]);
console.log(JSON.stringify({ voucher: doc.name, submitted: true, debit, credit, gl, bins }, null, 2));
