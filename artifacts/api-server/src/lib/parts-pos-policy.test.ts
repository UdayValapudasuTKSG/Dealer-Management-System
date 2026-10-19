import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPosConfig, posConfigSchema, posInputSchema, totals, shiftAmounts, posGlLines, type PosLine, type PosSnapshot } from "./parts-pos-policy";

const line: PosLine = { partId: 1, quantity: 2, sku: "TEST", name: "Test", brand: "BYD", unitPrice: 100, unitCost: 60,
  net: 200, tax: 28, itemCode: "ITEM", income: "Income", cogs: "COGS", inventory: "Stock", warehouse: "Warehouse" };
const config = { ...defaultPosConfig, receivable: "AR", vat: "VAT", overShort: "Variance", sources: [
  { id: "cash", label: "Cash", kind: "cash" as const, account: "Cash" },
  { id: "bank", label: "Bank", kind: "bank" as const, account: "Bank" },
] };
const snapshot: PosSnapshot = { config, date: "2026-10-19", lines: [line], ...totals([line], 100), customerName: "Test" };
test("gross sale includes VAT and retains partial account balance", () => {
  assert.deepEqual(totals([line],100), {net:200,tax:28,total:228,paid:100,balance:128,cost:120});
  assert.throws(() => totals([line],229), /exceeds/);
});
test("cash transfer is separate from actual shortage", () => {
  assert.deepEqual(shiftAmounts(100,500,580,400), {expectedCash:600,variance:-20});
  const gl = posGlLines({kind:"shift_close",reference:"Z",sourceId:"cash",destinationSourceId:"bank",transferAmount:400},
    {...snapshot,variance:-20});
  assert.deepEqual(gl, [
    {account:"Cash",debit:0,credit:20,purpose:"Actual till variance"},
    {account:"Variance",debit:20,credit:0,purpose:"Cash over / short — not a transfer"},
    {account:"Bank",debit:400,credit:0,purpose:"Cash transfer"},
    {account:"Cash",debit:0,credit:400,purpose:"Cash transfer"},
  ]);
  assert.throws(() => shiftAmounts(0,0,10,11), /exceed/);
});
test("sale and refund GLs balance and inventory reverses at cost", () => {
  for (const kind of ["sale","return"] as const) {
    const gl = posGlLines({kind,reference:"test",tenders:[{sourceId:"cash",amount:100}]},snapshot);
    assert.equal(gl.reduce((n,l)=>n+l.debit-l.credit,0),0);
    const stock = gl.find(l=>l.account==="Stock")!;
    assert.equal(kind==="sale"?stock.credit:stock.debit,120);
  }
});
test("duplicate source accounts and item aliases are rejected", () => {
  assert.equal(posConfigSchema.safeParse({...config,sources:[...config.sources,{...config.sources[0],id:"cash2"}]}).success,false);
  assert.equal(posConfigSchema.safeParse({...config,items:[{partId:1,itemCode:"same"},{partId:2,itemCode:"same"}]}).success,false);
});
test("quantity and money must be bounded and positive", () => {
  assert.equal(posInputSchema.safeParse({kind:"sale",reference:"x",lines:[{partId:1,quantity:0}]}).success,false);
  assert.equal(posInputSchema.safeParse({kind:"payment",reference:"x",tenders:[{sourceId:"cash",amount:-1}]}).success,false);
});
