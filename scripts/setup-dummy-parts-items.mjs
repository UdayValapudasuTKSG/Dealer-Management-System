// Authorized dummy master-data setup only. Never creates stock or accounting entries.
const base = "https://erpnext-jcy-qlx.m.frappe.cloud";
const company = "GT AUTOMOTIVE";
async function api(type, name, body) {
  if (!process.env.ERPNEXT_SETUP_API_KEY || !process.env.ERPNEXT_SETUP_API_SECRET) throw Error("Missing setup credentials");
  const r = await fetch(`${base}/api/resource/${encodeURIComponent(type)}${name ? "/" + encodeURIComponent(name) : ""}`, {
    method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { Authorization: `token ${process.env.ERPNEXT_SETUP_API_KEY}:${process.env.ERPNEXT_SETUP_API_SECRET}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  if (r.status === 404 && !body) return null;
  if (!r.ok) {
    // Only allowlisted validation descriptions; never dump raw ERP responses.
    const text = JSON.stringify(json);
    const reason = /HSN/i.test(text) ? "HSN classification required or invalid"
      : /mandatory/i.test(text) ? "Mandatory ERP field missing" : "ERP rejected request";
    throw Error(`${type}: HTTP ${r.status} ${json.exc_type || ""} — ${reason}`);
  }
  return json.data;
}
const c = await api("Company", company);
if (!c || c.abbr !== "GA" || c.default_currency !== "GYD") throw Error("Test company mismatch");
const group = "AURA Dummy Parts";
const specs = ["BYD", "Foton", "Jetour", "BMW", "Accessories"].map((brand, i) => ({
  brand, code: `AURA-POS-TEST-${brand.toUpperCase()}`,
  product: i === 4 ? "vulcanised rubber floor mat" : "vehicle electric horn",
  hsn: i === 4 ? "40169100" : "85123010",
  warehouse: `AURA Dummy Parts - ${brand} - GA`,
  income: `${4020101 + i} - ${i === 4 ? "Accessories & Fit-out Sales" : "Parts Sales - " + brand} - GA`,
  expense: `${5020101 + i} - ${i === 4 ? "COS - Accessories & Fit-outs" : "COS Parts - " + brand} - GA`,
}));
for (const s of specs) {
  const hsn = await api("GST HSN Code", s.hsn);
  const expectedDescription = s.brand === "Accessories" ? /floor.*cover|mats/i : /horns/i;
  if (!hsn || !expectedDescription.test(hsn.description || "")) throw Error("Test product classification does not match ERP catalogue");
  const wh = await api("Warehouse", s.warehouse);
  if (!wh || wh.company !== company || wh.disabled || wh.is_group) throw Error("Invalid warehouse");
  for (const [name, root] of [[s.income, "Income"], [s.expense, "Expense"]]) {
    const a = await api("Account", name);
    if (!a || a.company !== company || a.root_type !== root || a.disabled || a.is_group) throw Error("Invalid account");
  }
}
let g = await api("Item Group", group);
if (!g) g = await api("Item Group", null, { item_group_name: group, parent_item_group: "All Item Groups", is_group: 0 });
if (g.is_group) throw Error("Expected leaf item group");
for (const s of specs) {
  let item = await api("Item", s.code);
  const created = !item;
  if (!item) item = await api("Item", null, {
    item_code: s.code, item_name: `[DUMMY TEST ONLY] ${s.brand} ${s.product}`,
    description: `Fictional ${s.product} for isolated CAM Motors Dummy POS testing. Brand is a test accounting bucket, not verified vehicle fitment. HSN is for this test product only, not approved for live inventory. No opening stock.`,
    gst_hsn_code: s.hsn,
    item_group: group, stock_uom: "Nos", is_stock_item: 1, has_serial_no: 0, has_batch_no: 0,
    valuation_method: "Moving Average", disabled: 0,
    item_defaults: [{ company, default_warehouse: s.warehouse, income_account: s.income, expense_account: s.expense }],
  });
  const verified = await api("Item", s.code);
  if (!verified || !verified.is_stock_item || verified.disabled || verified.has_serial_no || verified.has_batch_no ||
      verified.valuation_method !== "Moving Average" || verified.gst_hsn_code !== s.hsn ||
      !verified.item_defaults?.some(d => d.company === company && d.default_warehouse === s.warehouse &&
        d.income_account === s.income && d.expense_account === s.expense)) throw Error(`Incompatible existing item: ${s.code}`);
  console.log(JSON.stringify({ code: s.code, name: verified.item_name, hsn: verified.gst_hsn_code, created, verified: true }));
}
