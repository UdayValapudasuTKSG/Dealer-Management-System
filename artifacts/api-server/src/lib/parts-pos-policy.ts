import { z } from "zod";

export const posConfigSchema = z.object({
  enabled: z.boolean().default(false),
  taxRate: z.number().min(0).max(100),
  taxApproved: z.boolean(),
  approvalReference: z.string().trim().max(200),
  receivable: z.string().trim(),
  vat: z.string().trim(),
  overShort: z.string().trim(),
  openingOffset: z.string().trim(),
  costCenter: z.string().trim(),
  sources: z.array(z.object({
    id: z.string().trim().min(1), label: z.string().trim().min(1),
    kind: z.enum(["cash", "bank"]), account: z.string().trim().min(1),
  })).max(30),
  brands: z.array(z.object({
    brand: z.enum(["BYD", "Foton", "Jetour", "BMW", "Accessories"]),
    income: z.string().trim(), cogs: z.string().trim(), inventory: z.string().trim(),
    warehouse: z.string().trim(),
  })).max(5),
  items: z.array(z.object({
    partId: z.number().int().positive(), itemCode: z.string().trim().min(1),
  })).max(2000),
}).superRefine((v, ctx) => {
  for (const [key, ids] of [
    ["sources", v.sources.map(s => s.id)], ["brands", v.brands.map(b => b.brand)],
    ["items", v.items.map(i => String(i.partId))],
  ] as const) if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: [key], message: "Duplicate mappings are not allowed" });
  if (new Set(v.items.map(i => i.itemCode)).size !== v.items.length)
    ctx.addIssue({ code: "custom", path: ["items"], message: "An ERP stock item may map to only one AURA part" });
  if (new Set(v.sources.map(s => s.account)).size !== v.sources.length)
    ctx.addIssue({ code: "custom", path: ["sources"], message: "Each cash/bank account must have one source ID only" });
});
export type PosConfig = z.infer<typeof posConfigSchema>;
export const posInputSchema = z.object({
  kind: z.enum(["sale", "return", "payment", "shift_close"]),
  reference: z.string().trim().min(1).max(200),
  customerId: z.number().int().positive().optional(),
  customerName: z.string().trim().max(200).optional(),
  originalId: z.number().int().positive().optional(),
  goodsReceived: z.boolean().optional(),
  lines: z.array(z.object({ partId: z.number().int().positive(), quantity: z.number().int().positive().max(10000) })).max(100).optional(),
  tenders: z.array(z.object({ sourceId: z.string().min(1), amount: z.number().positive().max(1e12) })).max(20).optional(),
  sourceId: z.string().optional(),
  destinationSourceId: z.string().optional(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  openingFloat: z.number().min(0).max(1e12).optional(),
  countedCash: z.number().min(0).max(1e12).optional(),
  transferAmount: z.number().min(0).max(1e12).optional(),
});
export type PosInput = z.infer<typeof posInputSchema>;
export type PosLine = {
  partId: number; quantity: number; sku: string; name: string; brand: string;
  unitPrice: number; unitCost: number; net: number; tax: number;
  itemCode: string; income: string; cogs: string; inventory: string; warehouse: string;
};
export type PosSnapshot = {
  config: PosConfig; date: string; lines: PosLine[]; total: number;
  net: number; tax: number; cost: number; paid: number; balance: number;
  customerName: string; erpCustomer?: string; originalId?: number;
  expectedCash?: number; variance?: number; cashBasisIds?: number[];
  erpSite?: string; erpCompany?: string;
};
export function money(n: number) {
  if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw new Error("Invalid monetary amount");
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
export function tenderTotal(tenders: PosInput["tenders"]) {
  return money((tenders ?? []).reduce((n, t) => n + money(t.amount), 0));
}
export function totals(lines: PosLine[], paid: number) {
  const net = money(lines.reduce((n, l) => n + l.net, 0));
  const tax = money(lines.reduce((n, l) => n + l.tax, 0));
  const total = money(net + tax);
  if (paid > total) throw new Error("Tender exceeds the invoice total; enter the amount applied, excluding change");
  return { net, tax, total, paid, balance: money(total - paid),
    cost: money(lines.reduce((n, l) => n + money(l.quantity * l.unitCost), 0)) };
}
export function shiftAmounts(opening: number, movement: number, counted: number, transfer: number) {
  if ([opening, counted, transfer].some(n => n < 0)) throw new Error("Cash amounts cannot be negative");
  if (transfer > counted) throw new Error("Cash transfer cannot exceed counted cash");
  return { expectedCash: money(opening + movement), variance: money(counted - opening - movement) };
}
export function posGlLines(input: PosInput, s: PosSnapshot) {
  const lines: { account: string; debit: number; credit: number; purpose: string }[] = [];
  const add = (account: string, debit: number, credit: number, purpose: string) => {
    if (debit || credit) lines.push({ account, debit: money(debit), credit: money(credit), purpose });
  };
  if (input.kind === "sale" || input.kind === "return") {
    const reverse = input.kind === "return";
    add(s.config.receivable, reverse ? 0 : s.total, reverse ? s.total : 0, reverse ? "Customer credit" : "Parts invoice");
    for (const l of s.lines) {
      add(l.income, reverse ? l.net : 0, reverse ? 0 : l.net, `${l.brand} parts ${reverse ? "reversal" : "income"}`);
      const cost = money(l.unitCost * l.quantity);
      add(l.cogs, reverse ? 0 : cost, reverse ? cost : 0, `${l.brand} cost of sales`);
      add(l.inventory, reverse ? cost : 0, reverse ? 0 : cost, reverse ? "Physical stock returned" : "Stock relieved");
    }
    add(s.config.vat, reverse ? s.tax : 0, reverse ? 0 : s.tax, "VAT output");
  }
  for (const t of input.tenders ?? []) {
    const account = s.config.sources.find(v => v.id === t.sourceId)?.account ?? "Unmapped";
    const refund = input.kind === "return";
    add(account, refund ? 0 : t.amount, refund ? t.amount : 0, refund ? "Customer refund" : "Receipt");
    add(s.config.receivable, refund ? t.amount : 0, refund ? 0 : t.amount, "Customer settlement");
  }
  if (input.kind === "shift_close") {
    const cash = s.config.sources.find(v => v.id === input.sourceId)?.account ?? "Unmapped";
    const variance = s.variance ?? 0;
    add(cash, Math.max(variance,0), Math.max(-variance,0), "Actual till variance");
    add(s.config.overShort, Math.max(-variance,0), Math.max(variance,0), "Cash over / short — not a transfer");
    const transfer = input.transferAmount ?? 0;
    add(s.config.sources.find(v => v.id === input.destinationSourceId)?.account ?? "Unmapped", transfer, 0, "Cash transfer");
    add(cash, 0, transfer, "Cash transfer");
  }
  return lines;
}
export const defaultPosConfig: PosConfig = {
  enabled: false, taxRate: 14, taxApproved: false, approvalReference: "",
  receivable: "", vat: "", overShort: "", openingOffset: "", costCenter: "",
  sources: [], items: [],
  brands: ["BYD", "Foton", "Jetour", "BMW", "Accessories"].map(brand => ({
    brand: brand as PosConfig["brands"][number]["brand"], income: "", cogs: "", inventory: "", warehouse: "",
  })),
};
