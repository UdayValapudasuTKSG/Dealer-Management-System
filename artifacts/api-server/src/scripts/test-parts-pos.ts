/** Dev-only, mocked ERP financial flow. No live ERP or communications. */
export {};
if (process.env.NODE_ENV !== "development") throw new Error("Development only");
const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!url || !["helium", "localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Unapproved database host");
for (const raw of [process.env.PROD_DATABASE_URL, process.env.EXTERNAL_DATABASE_URL]) {
  if (raw && new URL(raw).host + new URL(raw).pathname === new URL(url).host + new URL(url).pathname)
    throw new Error("Refusing production");
}
process.env.OUTBOX_WORKER_DISABLED = "1";
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { db, pool, dealersTable, partsTable, partsPosSettingsTable, partsPosRequestsTable, erpnextConnectionsTable,
  erpnextRefsTable, customersTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { buildPosSnapshot, posLock } = await import("../lib/parts-pos");
const { defaultPosConfig } = await import("../lib/parts-pos-policy");
const { ErpnextClient } = await import("../lib/erpnext/client");
const { postPartsPosRequest } = await import("../lib/erpnext/parts-pos");
type Input = import("../lib/parts-pos-policy").PosInput;
type Snapshot = import("../lib/parts-pos-policy").PosSnapshot;
type Job = import("@workspace/db").ErpnextSyncJob;
let dealerId = 0;
const docs = new Map<string, Record<string, any>>();
let insertCount = 0, failNextJournal = false;
const originalMethods = { get: ErpnextClient.prototype.getDoc, list: ErpnextClient.prototype.listDocs,
  insert: ErpnextClient.prototype.insertDoc, submit: ErpnextClient.prototype.submitDoc };
const config = structuredClone(defaultPosConfig);
config.enabled = true; config.taxApproved = true; config.approvalReference = "Synthetic test only";
config.receivable = "AR"; config.vat = "VAT"; config.overShort = "Variance";
config.openingOffset = "Opening"; config.costCenter = "Test Center";
config.sources = [{id:"cash",label:"Cash",kind:"cash",account:"Cash"},{id:"bank",label:"Bank",kind:"bank",account:"Bank"}];
config.brands = config.brands.map(b => ({ ...b,income:`${b.brand} Income`,cogs:`${b.brand} COGS`,inventory:`${b.brand} Stock`,warehouse:`${b.brand} Warehouse` }));
// Runtime fake lives only in this isolated process. Every network method used
// by the tested worker is replaced; no actual host/token is used.
ErpnextClient.prototype.getDoc = (async (type: string, name: string) => {
  if (type === "Company") return { default_currency:"GYD" };
  if (type === "Account") return { name,company:"POS TEST",root_type:
    name==="VAT"?"Liability":name==="Opening"?"Equity":name==="Variance"||name.endsWith("COGS")?"Expense":name.endsWith("Income")?"Income":"Asset",
    account_type:name==="AR"?"Receivable":name==="Cash"?"Cash":name==="Bank"?"Bank":name.endsWith("Stock")?"Stock":"",
    account_currency:"GYD",is_group:0,disabled:0 };
  if (type === "Warehouse") return {company:"POS TEST",account:name.replace("Warehouse","Stock"),is_group:0,disabled:0};
  if (type === "Cost Center") return {company:"POS TEST",is_group:0,disabled:0};
  if (type === "Item") return {is_stock_item:1,disabled:0,has_serial_no:0,has_batch_no:0,valuation_method:"Moving Average"};
  if (type === "Customer") return {name,disabled:0};
  const found = docs.get(`${type}:${name}`);
  if (!found) throw new Error("Mock document not found");
  return structuredClone(found);
}) as typeof ErpnextClient.prototype.getDoc;
ErpnextClient.prototype.listDocs = (async (type: string, options: any) => {
  if (type === "Bin") return [{actual_qty:20,valuation_rate:1000}];
  return [...docs.values()].filter(d => d.doctype===type && (options?.filters ?? []).every((filter: any[]) => {
    const [field,op,value] = filter.length===4 ? filter.slice(1) : filter;
    return op==="!=" ? d[field]!==value : d[field]===value;
  }));
}) as typeof ErpnextClient.prototype.listDocs;
ErpnextClient.prototype.insertDoc = (async (type: string, data: any) => {
  const name = `TEST-${++insertCount}`;
  const doc = {...structuredClone(data), name,doctype:type};
  if (type === "Sales Invoice") doc.grand_total = data.items.reduce((n:number,l:any)=>n+l.qty*l.rate,0)
    + data.taxes.reduce((n:number,l:any)=>n+l.tax_amount,0);
  docs.set(`${type}:${name}`,doc); return doc;
}) as typeof ErpnextClient.prototype.insertDoc;
ErpnextClient.prototype.submitDoc = async (type: string, name: string) => {
  if (type==="Journal Entry" && failNextJournal) { failNextJournal=false; throw new Error("Simulated transient failure after invoice"); }
  docs.get(`${type}:${name}`)!.docstatus=1;
};
try {
  const [dealer] = await db.insert(dealersTable).values({name:"DEV POS Mock Fixture",status:"active",createdBy:"parts-pos-test"}).returning();
  dealerId=dealer.id;
  await db.insert(erpnextConnectionsTable).values({dealerId,siteUrl:"https://pos-test.invalid",apiKey:"mock",apiSecret:"mock",
    webhookSecret:"mock",companyName:"POS TEST",enabled:true});
  const [part] = await db.insert(partsTable).values({dealerId,sku:"MOCK-POS",name:"Mock BYD part",make:"BYD",unitPrice:2000,unitCost:1000,stock:20}).returning();
  config.items=[{partId:part.id,itemCode:"MOCK-ERP-ITEM"}];
  await db.insert(partsPosSettingsTable).values({dealerId,config,revision:1,updatedBy:1,validation:{state:"valid",errors:[]}});
  const [customer] = await db.insert(customersTable).values({dealerId,name:"Mock account customer"}).returning();
  await db.insert(erpnextRefsTable).values({dealerId,entityType:"customer",entityId:customer.id,doctype:"Customer",docName:"Mock Customer"});
  async function request(input: Input) {
    return db.transaction(async tx => {
      await posLock(tx,dealerId);
      const snapshot=await buildPosSnapshot(tx,dealerId,input,config);
      const [r]=await tx.insert(partsPosRequestsTable).values({dealerId,kind:input.kind,input,snapshot,revision:1,
        requestKey:crypto.randomUUID(),createdBy:1,decidedBy:2,status:"approved"}).returning();
      return r;
    });
  }
  const post=async(id:number)=>postPartsPosRequest({dealerId,entityId:id} as Job);
  const stock=async()=>Number((await db.select().from(partsTable).where(eq(partsTable.id,part.id)))[0].stock);
  const sale=await request({kind:"sale",reference:"split tender",lines:[{partId:part.id,quantity:2}],
    tenders:[{sourceId:"cash",amount:2000},{sourceId:"bank",amount:2560}]});
  assert.equal(stock instanceof Function,true);
  assert.equal((sale.snapshot as unknown as Snapshot).total,4560);
  failNextJournal=true;
  await assert.rejects(()=>post(sale.id),/Simulated/);
  assert.equal(await stock(),20,"local stock not consumed on partial remote failure");
  assert.equal([...docs.values()].filter(d=>d.doctype==="Sales Invoice").length,1);
  await post(sale.id);
  assert.equal(await stock(),18);
  const count=insertCount;
  await post(sale.id);
  assert.equal(insertCount,count,"posted retry does not create remote documents");
  assert.equal([...docs.values()].filter(d=>d.doctype==="Sales Invoice").length,1,"adopts existing invoice");
  assert.equal([...docs.values()].filter(d=>d.doctype==="Journal Entry").length,2,"adopts failed tender draft");
  assert.equal(await stock(),18,"posted retry does not consume stock again");
  const returned=await request({kind:"return",reference:"one unit back",originalId:sale.id,goodsReceived:true,
    lines:[{partId:part.id,quantity:1}],tenders:[{sourceId:"bank",amount:2280}]});
  await post(returned.id);
  assert.equal(await stock(),19,"partial return restores one item");
  await assert.rejects(()=>request({kind:"return",reference:"too many",originalId:sale.id,goodsReceived:true,
    lines:[{partId:part.id,quantity:2}],tenders:[]}),/exceeds/);
  const credit=await request({kind:"sale",reference:"credit sale",customerId:customer.id,lines:[{partId:part.id,quantity:1}],tenders:[]});
  await post(credit.id);
  const payment=await request({kind:"payment",reference:"account receipt",originalId:credit.id,tenders:[{sourceId:"bank",amount:2280}]});
  await assert.rejects(()=>request({kind:"return",reference:"unsettled",originalId:credit.id,goodsReceived:true,
    lines:[{partId:part.id,quantity:1}],tenders:[{sourceId:"bank",amount:2280}]}),/Finish/);
  await post(payment.id);
  await assert.rejects(()=>request({kind:"payment",reference:"overpayment",originalId:credit.id,tenders:[{sourceId:"bank",amount:1}]}),/cannot exceed/);
  const paidCreditReturn=await request({kind:"return",reference:"credit now paid return",originalId:credit.id,goodsReceived:true,
    lines:[{partId:part.id,quantity:1}],tenders:[{sourceId:"bank",amount:2280}]});
  await post(paidCreditReturn.id);
  assert.equal(await stock(),19,"paid account return restores stock");
  const day=(sale.snapshot as unknown as Snapshot).date;
  const close=await request({kind:"shift_close",reference:"Z report",sourceId:"cash",destinationSourceId:"bank",
    businessDate:day,openingFloat:100,countedCash:2080,transferAmount:2000});
  assert.equal(close.snapshot.variance,-20);
  const before=insertCount;
  await post(close.id);
  assert.equal(insertCount-before,2,"variance and transfer use separate journals");
  await assert.rejects(()=>request({kind:"shift_close",reference:"duplicate close",sourceId:"cash",businessDate:day,openingFloat:0,countedCash:0}),/already/);
  await assert.rejects(()=>request({kind:"sale",reference:"late cash",lines:[{partId:part.id,quantity:1}],tenders:[{sourceId:"cash",amount:2280}]}),/closing/);
  await assert.rejects(()=>db.transaction(tx=>buildPosSnapshot(tx,dealerId+999999,{kind:"payment",reference:"cross dealer",originalId:sale.id,tenders:[]},config)),/Connect|posted sale/);
  const invoiceDocs=[...docs.values()].filter(d=>d.doctype==="Sales Invoice");
  assert(invoiceDocs.every(d=>d.update_stock===1));
  assert(![...docs.values()].some(d=>d.doctype==="Stock Entry"),"no second ERP stock deduction");
  console.log("PASS: split tender, transient recovery, idempotent retry, partial return, paid credit return, overpayment, return limits, stock-once, shift separation, closed-day and tenant guards.");
} finally {
  ErpnextClient.prototype.getDoc=originalMethods.get; ErpnextClient.prototype.listDocs=originalMethods.list;
  ErpnextClient.prototype.insertDoc=originalMethods.insert; ErpnextClient.prototype.submitDoc=originalMethods.submit;
  if (dealerId) {
    // Exact isolated fixture scope; children first, no shared record mutation.
    for (const table of ["inventory_cost_consumptions","inventory_cost_layers","inventory_transactions","inventory_levels","inventory_bins",
      "inventory_locations","parts_pos_requests","parts_pos_settings","erpnext_refs","erpnext_connections","parts","customers","dealers"]) {
      await pool.query(`delete from ${table} where ${table==="dealers"?"id":"dealer_id"}=$1`,[dealerId]);
    }
  }
  await pool.end();
}
