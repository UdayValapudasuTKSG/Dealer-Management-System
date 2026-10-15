// Explicit, resumable master-data operation. Never posts transactions or resumes sync.
import pg from "../lib/db/node_modules/pg/lib/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import { normalizeModelKey } from "../lib/db/src/schema/vehicleModelGlCodes.ts";
import { fileURLToPath } from "node:url";

const apply = process.argv.includes("--apply");
const base = "https://erpnext-jcy-qlx.m.frappe.cloud";
const company = "GT AUTOMOTIVE";
const output = fileURLToPath(new URL("../generated-artifacts/dummy-model-accounts", import.meta.url));
if (!process.env.PROD_DATABASE_URL || !process.env.ERPNEXT_SETUP_API_KEY || !process.env.ERPNEXT_SETUP_API_SECRET) throw Error("Required secrets missing");
const pool = new pg.Pool({ connectionString: process.env.PROD_DATABASE_URL, connectionTimeoutMillis: 10000 });
async function api(path, method = "GET", body) {
  const r = await fetch(`${base}/api/resource/${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { Authorization: `token ${process.env.ERPNEXT_SETUP_API_KEY}:${process.env.ERPNEXT_SETUP_API_SECRET}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw Error(`ERP master-data request failed: HTTP ${r.status}`);
  return (await r.json()).data;
}
async function accounts() {
  const result = [];
  for (let offset = 0; ; offset += 200) {
    const page = await api("Account?" + new URLSearchParams({
      fields: JSON.stringify(["name", "account_name", "account_number", "company", "root_type", "account_type", "account_currency", "disabled", "is_group", "parent_account"]),
      filters: JSON.stringify([["company", "=", company]]), limit_start: String(offset), limit_page_length: "200", order_by: "name asc",
    }));
    result.push(...page);
    if (page.length < 200) return result;
  }
}
function assertAccount(a, root, group = 0) {
  if (!a || a.company !== company || a.root_type !== root || Number(a.is_group) !== group || a.disabled || a.account_currency !== "GYD") throw Error("Invalid account boundary or classification");
}
const client = await pool.connect();
try {
  const context = async () => (await client.query(`SELECT d.name,c.site_url,c.company_name,c.enabled
    FROM dealers d JOIN erpnext_connections c ON c.dealer_id=d.id WHERE d.id=2`)).rows[0];
  const initialContext = await context();
  const guard = c => {
    if (!c || c.name !== "CAM Motors Dummy" || c.site_url.replace(/\/+$/, "") !== base || c.company_name !== company || c.enabled !== initialContext.enabled) throw Error("Dummy target or connection state changed");
  };
  guard(await context());
  const settings = (await client.query("SELECT config,revision,vat_policy FROM sales_accounting_settings WHERE dealer_id=2")).rows[0];
  if (!settings) throw Error("Missing sales configuration");
  const rawModels = (await client.query("SELECT DISTINCT make,model FROM vehicles WHERE dealer_id=2 ORDER BY make,model")).rows;
  const models = [...new Map(rawModels.map(m => [`${normalizeModelKey(m.make)}|${normalizeModelKey(m.model)}`, m])).values()];
  if (models.length !== 27) throw Error("Inventory changed: expected 27 separate models");
  const existingMappings = (await client.query("SELECT * FROM vehicle_model_gl_codes WHERE dealer_id=2")).rows;
  const live = await accounts();
  const byCode = new Map(live.map(a => [a.account_number, a]));
  const proposed = [];
  function ensure(code, label, parentCode, root, type = "", group = 0) {
    const parent = byCode.get(parentCode);
    assertAccount(parent, root, 1);
    let a = byCode.get(code);
    if (a) {
      assertAccount(a, root, group);
      if (a.account_name !== label || a.parent_account !== parent.name || (type && a.account_type !== type)) throw Error(`Account code conflict: ${code}`);
    } else {
      a = { name: `${code} - ${label} - GA`, account_number: code, account_name: label, parent_account: parent.name,
        company, root_type: root, report_type: root === "Asset" ? "Balance Sheet" : "Profit and Loss",
        account_currency: "GYD", account_type: type, is_group: group, disabled: 0 };
      proposed.push(a);
      byCode.set(code, a);
    }
    return a.name;
  }
  ensure("1031100", "Vehicles - CAM Dummy Additional Models", "1030000", "Asset", "Stock", 1);
  ensure("4010800", "Vehicle Sales - CAM Dummy Additional Models", "4010000", "Income", "", 1);
  ensure("5010700", "Vehicle Costs - CAM Dummy Additional Models", "5010000", "Expense", "", 1);
  // Explicit cross-reference to inspected leaves; never derive COGS/stock from sales codes.
  const reuse = {
    "byd|seal": ["4010102","1030102","5010102","4010901",""],
    "foton|foton tunland g7": ["4010401","1030401","5010401","4010903","4010704"],
    "foton|foton tunland v9": ["4010404","1030404","5010404","4010903",""],
    "jetour|dashing": ["4010504","1030504","5010504","4010904",""],
    "jetour|t1": ["4010501","1030501","5010501","4010904",""],
    "jetour|t2": ["4010502","1030502","5010502","4010904","4010706"],
    "jetour|x70 plus(x70p)": ["4010503","1030503","5010503","4010904",""],
  };
  const mapped = models.map((m, i) => {
    const key = `${normalizeModelKey(m.make)}|${normalizeModelKey(m.model)}`;
    const codes = reuse[key];
    let income, inventory, cogs, discount, dutyFreeIncome = "";
    if (codes) {
      [income,inventory,cogs,discount,dutyFreeIncome] = codes.map((c,j) => {
        if (!c) return "";
        const a = byCode.get(c); assertAccount(a, ["Income","Asset","Expense","Income","Income"][j]); return a.name;
      });
    } else {
      const label = `${m.make} / ${m.model}`;
      income = ensure(String(4010801+i), `Sales - ${label}`, "4010800", "Income");
      inventory = ensure(String(1031101+i), label, "1031100", "Asset", "Stock");
      cogs = ensure(String(5010701+i), `COS - ${label}`, "5010700", "Expense", "Cost of Goods Sold");
      discount = ensure(String(4010910+i), `Discounts - ${label}`, "4010900", "Income");
    }
    const old = existingMappings.find(a => a.make_key === normalizeModelKey(m.make) && a.model_key === normalizeModelKey(m.model));
    if (old && old.gl_code !== income && old.gl_code !== byCode.get(reuse[key]?.[0])?.account_number) throw Error("Existing model mapping needs review before replacement");
    return { ...m, income, inventory, cogs, discount, dutyFreeIncome };
  });
  const config = structuredClone(settings.config);
  config.models = mapped;
  // Resolve the already configured control/source codes, without changing their meaning.
  for (const a of [...config.accounts, ...config.sources]) {
    const doc = byCode.get(a.account) ?? live.find(d => d.name === a.account);
    if (!doc || doc.disabled || doc.is_group || doc.company !== company) throw Error("Unresolved existing control/source account");
    a.account = doc.name;
  }
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/plan.json`, JSON.stringify({ company, dealer: 2, before: settings, mapped, create: proposed }, null, 2));
  console.log(JSON.stringify({ mode: apply ? "apply" : "preview", models: mapped.length, newAccounts: proposed.length, reusedModels: models.length - mapped.filter(m => m.income.includes("40108")).length }));
  if (apply) {
    const created = [];
    for (const a of proposed) {
      const saved = await api("Account", "POST", { doctype: "Account", ...a });
      if (saved.name !== a.name) throw Error("Unexpected ERP account name; inspect saved account before resuming");
      created.push(saved.name);
      await writeFile(`${output}/created.json`, JSON.stringify(created,null,2));
    }
    const verified = await accounts();
    for (const m of mapped) for (const [key,root] of [["income","Income"],["inventory","Asset"],["cogs","Expense"],["discount","Income"],["dutyFreeIncome","Income"]]) {
      if (m[key]) assertAccount(verified.find(a => a.name === m[key]), root);
    }
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='30s'");
    await client.query("SELECT pg_advisory_xact_lock(76042,2)");
    await client.query("SELECT id FROM erpnext_connections WHERE dealer_id=2 FOR UPDATE");
    guard(await context());
    const current = (await client.query("SELECT revision FROM sales_accounting_settings WHERE dealer_id=2 FOR UPDATE")).rows[0];
    if (current.revision !== settings.revision) throw Error("Settings changed concurrently; ERP master accounts retained, mappings not overwritten");
    // Older production installations may not yet have the composite index.
    // Serialize this short master-data write without changing production schema.
    await client.query("LOCK TABLE vehicle_model_gl_codes IN SHARE ROW EXCLUSIVE MODE");
    const currentMappings = (await client.query("SELECT * FROM vehicle_model_gl_codes WHERE dealer_id=2")).rows;
    if (JSON.stringify(currentMappings) !== JSON.stringify(existingMappings)) throw Error("Model mappings changed concurrently");
    for (const m of mapped) {
      const keys = [normalizeModelKey(m.make),normalizeModelKey(m.model),m.make,m.model,m.income];
      const updated = await client.query(`UPDATE vehicle_model_gl_codes SET make_label=$3,model_label=$4,gl_code=$5,account_name=$5,
        erpnext_status='verified',erpnext_checked_at=now(),updated_at=now(),updated_by='approved-dummy-master-setup'
        WHERE dealer_id=2 AND make_key=$1 AND model_key=$2 RETURNING id`, keys);
      if (updated.rowCount > 1) throw Error("Duplicate existing model mappings");
      if (!updated.rowCount) await client.query(`INSERT INTO vehicle_model_gl_codes
        (dealer_id,make_key,model_key,make_label,model_label,gl_code,account_name,erpnext_status,erpnext_checked_at,updated_by)
        VALUES (2,$1,$2,$3,$4,$5,$5,'verified',now(),'approved-dummy-master-setup')`, keys);
    }
    await client.query(`UPDATE sales_accounting_settings SET config=$1::jsonb,revision=revision+1,updated_at=now(),
      validation=$2::jsonb WHERE dealer_id=2`, [JSON.stringify(config), JSON.stringify({state:"unchecked",errors:[]})]);
    await client.query(`INSERT INTO audit_logs (dealer_id,action,module,entity_type,entity_id,summary,details)
      VALUES (2,'update','finance','sales_accounting_settings','2',$1,$2::jsonb)`,
    ["User-approved master account setup for all 27 dummy vehicle models", JSON.stringify({before:settings.config,after:config,created,previousMappings:existingMappings,transactionWrites:0,connectionStateUnchanged:true})]);
    await client.query("COMMIT");
    const check = (await client.query("SELECT jsonb_array_length(config->'models') AS models,vat_policy FROM sales_accounting_settings WHERE dealer_id=2")).rows[0];
    guard(await context());
    console.log(JSON.stringify({updated:true,...check,created:created.length,connectionStateUnchanged:true,transactionWrites:0}));
  }
} catch (e) {
  await client.query("ROLLBACK").catch(()=>{});
  if (e.code && /^[A-Z0-9]{5}$/.test(e.code)) console.error(JSON.stringify({databaseErrorCode:e.code, column:e.column, constraint:e.constraint, table:e.table}));
  console.error(e.message?.startsWith("ERP") || /conflict|changed|boundary|mapping|Inventory|Missing|Required|Unexpected|Unresolved|Invalid/.test(e.message) ? e.message : "Master-data operation failed; inspect safely without logging credentials.");
  process.exitCode=1;
} finally { client.release(); await pool.end(); }
