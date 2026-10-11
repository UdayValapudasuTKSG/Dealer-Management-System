/**
 * Explicitly authorised, isolated ERPNext dummy-sale verification.
 * Never changes AURA data/configuration, existing stock, defaults or queues.
 * Run with --apply to create labelled test data; retries reconcile by marker.
 */
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const BASE = "https://erpnext-jcy-qlx.m.frappe.cloud";
const COMPANY = "GT AUTOMOTIVE";
const MARK = "AURA-DUMMY-SALES-20261012";
const VIN = "AURATEST0000000001";
const dir = "generated-artifacts/erpnext-sales-fixture";
const apply = process.argv.includes("--apply");
const results = [];
async function api(path, method = "GET", body) {
  if (!process.env.ERPNEXT_SETUP_API_KEY || !process.env.ERPNEXT_SETUP_API_SECRET) throw Error("Setup credentials missing");
  const r = await fetch(`${BASE}/api/${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", Authorization: `token ${process.env.ERPNEXT_SETUP_API_KEY}:${process.env.ERPNEXT_SETUP_API_SECRET}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) {
    // Do not print server traceback or request/auth headers.
    throw Error(`${method} ${path.split("?")[0]}: HTTP ${r.status} ${j.exc_type || "API error"} ${String(j._server_messages || "").replace(/<[^>]*>/g,"").slice(0,1200)}`);
  }
  return j.data ?? j.message ?? j;
}
const get = (t,n) => api(`resource/${encodeURIComponent(t)}/${encodeURIComponent(n)}`);
const list = (t, fields, filters) => api(`resource/${encodeURIComponent(t)}?${new URLSearchParams({fields:JSON.stringify(fields),filters:JSON.stringify(filters),limit_page_length:"500"})}`);
async function saveResult(step,name) {
  results.push({step,name});
  await writeFile(`${dir}/result.json`, JSON.stringify({company:COMPANY,marker:MARK,documents:results},null,2));
  console.log(step,name);
}
async function master(type, field, value, body) {
  const found = await list(type,["name"],[[field,"=",value]]);
  if (found.length > 1) throw Error(`Ambiguous fixture ${type}`);
  const row = found[0] ?? await api(`resource/${encodeURIComponent(type)}`,"POST",body);
  await saveResult(type,row.name);
  return row.name;
}
async function voucher(type, key, data) {
  const field = type === "Journal Entry" ? "user_remark" : "remarks";
  const marker = `${MARK}:${key}`;
  const found = await list(type,["name","docstatus"],[["company","=",COMPANY],[field,"=",marker]]);
  if (found.length > 1) throw Error(`Duplicate ${key}; stop for reconciliation`);
  const row = found[0] ?? await api(`resource/${encodeURIComponent(type)}`,"POST",{company:COMPANY,...data,[field]:marker});
  let doc = await get(type,row.name);
  if (doc.docstatus === 2) throw Error(`Cancelled ${key}; never recreate automatically`);
  if (doc.docstatus === 0) {
    await api("method/frappe.client.submit","POST",{doc:{...doc,doctype:type}});
    doc = await get(type,row.name);
  }
  assert.equal(doc.docstatus,1);
  await saveResult(key,doc.name);
  return doc;
}
try {
  await mkdir(dir,{recursive:true});
  const company = await get("Company",COMPANY);
  assert.equal(company.default_currency,"GYD");
  assert.equal(company.abbr,"GA");
  assert.equal(company.enable_perpetual_inventory,1);
  const accounts = await list("Account",["name","account_number","root_type","account_type","disabled","is_group","account_currency"],[["company","=",COMPANY]]);
  const account = (code,root) => {
    const a = accounts.filter(a => a.account_number===code && !a.disabled && !a.is_group);
    assert.equal(a.length,1,`Need one enabled account ${code}`);
    assert.equal(a[0].root_type,root);
    assert.equal(a[0].account_currency,"GYD");
    return a[0].name;
  };
  const A = {
    cash: account("1010301","Asset"), bank:account("1010101","Asset"),
    deposit:account("2020101","Liability"), ar:account("1020101","Asset"),
    inventory:account("1030107","Asset"), sales:account("4010107","Income"),
    cogs:account("5010107","Expense"), vat:account("2030101","Liability"),
    opening:account("3030101","Equity"),
  };
  const total=5700000,net=5000000,tax=700000,deposit=500000,cost=3500000;
  console.log(JSON.stringify({mode:apply?"APPLY AUTHORISED FIXTURES":"DRY RUN",company:COMPANY,marker:MARK,total,net,tax,deposit,cost,accounts:A}));
  if (!apply) process.exit(0);
  const stockSettings=await get("Stock Settings","Stock Settings");
  if (!stockSettings.enable_serial_and_batch_no_for_item) {
    if (!process.argv.includes("--enable-test-vin")) throw Error("Test-site VIN support disabled; explicit --enable-test-vin required.");
    const companies=await list("Company",["name"],[]);
    assert.deepEqual(companies.map(c=>c.name),[COMPANY],"Never change a shared site's stock settings automatically");
    await writeFile(`${dir}/stock-setting-before.json`,JSON.stringify({enable_serial_and_batch_no_for_item:0}));
    await api("resource/Stock%20Settings/Stock%20Settings","PUT",{enable_serial_and_batch_no_for_item:1});
    assert.equal((await get("Stock Settings","Stock Settings")).enable_serial_and_batch_no_for_item,1);
    await saveResult("Enabled test-site VIN capability","enable_serial_and_batch_no_for_item");
  }
  const system = await api("method/frappe.client.get_single_value?doctype=System%20Settings&field=time_zone");
  const date = new Intl.DateTimeFormat("en-CA",{timeZone:String(system || "America/Guyana"),year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const cc=company.cost_center;
  assert.ok(cc,"Company cost center required");
  const warehouse=await master("Warehouse","warehouse_name",MARK,{warehouse_name:MARK,company:COMPANY,parent_warehouse:"All Warehouses - GA",is_group:0,account:A.inventory});
  const wh=await get("Warehouse",warehouse);
  assert.equal(wh.company,COMPANY); assert.equal(wh.account,A.inventory);
  const group=await master("Customer Group","customer_group_name",MARK,{customer_group_name:MARK,parent_customer_group:"All Customer Groups",is_group:0});
  const territory=await master("Territory","territory_name",MARK,{territory_name:MARK,parent_territory:"All Territories",is_group:0});
  const itemGroup=await master("Item Group","item_group_name",MARK,{item_group_name:MARK,parent_item_group:"All Item Groups",is_group:0});
  const customer=await master("Customer","customer_name",`${MARK}-CUSTOMER`,{customer_name:`${MARK}-CUSTOMER`,customer_type:"Company",customer_group:group,territory,accounts:[{company:COMPANY,account:A.ar}]});
  // The site's installed compliance extension requires a classification even
  // for dummy stock. Use its existing passenger-vehicle heading, only here.
  await get("GST HSN Code","870380");
  const item=await master("Item","item_code",MARK,{item_code:MARK,item_name:"DUMMY ONLY — BYD Dolphin Mini",item_group:itemGroup,gst_hsn_code:"870380",stock_uom:"Nos",is_stock_item:1,has_serial_no:1,valuation_method:"FIFO",item_defaults:[{company:COMPANY,default_warehouse:warehouse,income_account:A.sales,expense_account:A.cogs}]});
  const itemDoc=await get("Item",item);
  assert.equal(itemDoc.has_serial_no,1);assert.equal(itemDoc.is_stock_item,1);
  const stock=await voucher("Stock Entry","opening-stock",{stock_entry_type:"Material Receipt",purpose:"Material Receipt",posting_date:date,set_posting_time:1,items:[{item_code:item,qty:1,t_warehouse:warehouse,basic_rate:cost,expense_account:A.opening,cost_center:cc,serial_no:VIN,use_serial_batch_fields:1}]});
  const journal=(key,rows)=>voucher("Journal Entry",key,{voucher_type:"Journal Entry",posting_date:date,accounts:rows.map(r=>({cost_center:cc,...r}))});
  const entry=(account,debit,credit,party=false)=>({account,debit_in_account_currency:debit,credit_in_account_currency:credit,...(party?{party_type:"Customer",party:customer}:{})});
  const dep=await journal("advance-received",[entry(A.cash,deposit,0),entry(A.deposit,0,deposit)]);
  const banking=await journal("advance-banked",[entry(A.bank,deposit,0),entry(A.cash,0,deposit)]);
  const sale=await voucher("Sales Invoice","delivery-sale",{customer,currency:"GYD",posting_date:date,due_date:date,set_posting_time:1,debit_to:A.ar,update_stock:1,cost_center:cc,items:[{item_code:item,qty:1,rate:net,warehouse,serial_no:VIN,use_serial_batch_fields:1,income_account:A.sales,expense_account:A.cogs,cost_center:cc}],taxes:[{charge_type:"Actual",account_head:A.vat,description:"DUMMY TEST — VAT at delivery",tax_amount:tax,cost_center:cc}]});
  assert.equal(Number(sale.grand_total),total);
  const reference={reference_type:"Sales Invoice",reference_name:sale.name};
  const applied=await journal("apply-advance",[entry(A.deposit,deposit,0),{...entry(A.ar,0,deposit,true),...reference}]);
  const balance=await journal("balance-received",[entry(A.cash,total-deposit,0),{...entry(A.ar,0,total-deposit,true),...reference}]);
  const settlement=await journal("balance-banked",[entry(A.bank,total-deposit,0),entry(A.cash,0,total-deposit)]);
  const gl=await list("GL Entry",["voucher_no","account","debit","credit","is_cancelled"],[["company","=",COMPANY],["voucher_no","in",[stock.name,dep.name,banking.name,sale.name,applied.name,balance.name,settlement.name]]]);
  const active=gl.filter(r=>!r.is_cancelled);
  const sums=new Map();
  for(const r of active) sums.set(r.account,(sums.get(r.account)||0)+Number(r.debit)-Number(r.credit));
  const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<0.01,`${label}: expected ${expected}, got ${actual}`);
  for(const d of [stock,dep,banking,sale,applied,balance,settlement]) {
    const rows=active.filter(r=>r.voucher_no===d.name);assert.ok(rows.length,`Missing GL for ${d.name}`);
    near(rows.reduce((s,r)=>s+Number(r.debit)-Number(r.credit),0),0,d.name);
  }
  for(const [a,n] of [[A.deposit,0],[A.cash,0],[A.ar,0],[A.inventory,0],[A.sales,-net],[A.vat,-tax],[A.cogs,cost],[A.bank,total],[A.opening,-cost]]) near(sums.get(a)||0,n,a);
  const fresh=await get("Sales Invoice",sale.name);near(Number(fresh.outstanding_amount),0,"invoice outstanding");
  const sle=await list("Stock Ledger Entry",["actual_qty","stock_value_difference"],[["company","=",COMPANY],["item_code","=",item],["warehouse","=",warehouse],["is_cancelled","=",0]]);
  near(sle.reduce((s,r)=>s+Number(r.actual_qty),0),0,"remaining stock");
  near(sle.reduce((s,r)=>s+Number(r.stock_value_difference),0),0,"remaining inventory value");
  await writeFile(`${dir}/verified.json`,JSON.stringify({marker:MARK,company:COMPANY,verifiedAt:new Date().toISOString(),assumptions:{tax:"Dummy VAT at delivery only; illustrative 14%, not a live tax rule",opening:"Explicit sample opening equity; no actual inventory imported"},documents:results,netBalances:Object.fromEntries(sums),outstanding:Number(fresh.outstanding_amount),stockEntries:sle},null,2));
  console.log("VERIFIED: balanced GL, deposit/AR/clearing zero, one VIN received and sold, cost 3.5m, sales 5m, VAT 0.7m.");
} catch(e) {console.error(e.message);process.exitCode=1;}
