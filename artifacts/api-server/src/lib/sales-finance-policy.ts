import type { SalesAccountingConfigData, SalesAccountingLine } from "@workspace/db";
import { normalizeModelKey } from "@workspace/db";

/**
 * Pure policy for operational sales finance requests. Amounts are integer
 * cents throughout. Output separates:
 *  - `lines`: exact DR/CR the posting will make (immutable once submitted)
 *  - `blockers`: fixable preconditions (mapping, validation, dependency) that
 *     prevent approval until resolved and resubmitted
 *  - `policyBlocks`: unapproved business policy (advance VAT, financier
 *     transfer, supplier party). These requests are stored as `blocked` and
 *     can never be approved by this release.
 */
export type RequestKind = "invoice" | "payment" | "expense";
export type ExpenseCategory = "registration" | "fuel" | "detailing";
export type FinancePolicyInput = {
  kind: RequestKind;
  amountCents: number;
  category?: ExpenseCategory | null;
  sourceId?: string | null;
  payerType?: "customer" | "financier" | null;
  billingTreatment?: "dealer_paid" | "customer_billed" | null;
  customerChargeCents?: number | null;
  reference: string;
};
export type FinancePolicyContext = {
  configValid: boolean;
  vehicle?: { make: string; model: string; dutyFree: boolean; vin: string | null } | null;
  dealStage?: string;
  invoice?: { kind: string; status: string; amountCents: number; taxCents: number } | null;
  invoiceOutstandingCents?: number;
  invoicePosted?: boolean;
  legacyHeld?: boolean;
};
export type FinancePolicyResult = {
  lines: SalesAccountingLine[];
  blockers: string[];
  policyBlocks: string[];
  debitCents: number;
  creditCents: number;
  chargeNetCents: number;
  chargeVatCents: number;
};

export const ADVANCE_VAT_BLOCK =
  "Advance VAT policy is pending Finance approval. Deposit/advance postings stay blocked; nothing was posted.";
export const FINANCIER_BLOCK =
  "Financier settlement against a distinct financed receivable needs an established transfer policy. This release keeps it blocked.";
export const SUPPLIER_PARTY_BLOCK =
  "Supplier-funded expenses need an actual supplier party; payable GL rows are never sent without one. Use a bank, cash or float source.";

export function splitVat(grossOrNetCents: number, ratePct: number, includesVat: boolean) {
  if (ratePct <= 0) return { net: grossOrNetCents, vat: 0 };
  if (includesVat) {
    const net = Math.round((grossOrNetCents * 100) / (100 + ratePct));
    return { net, vat: grossOrNetCents - net };
  }
  return { net: grossOrNetCents, vat: Math.round((grossOrNetCents * ratePct) / 100) };
}

export function evaluateFinanceRequest(
  config: SalesAccountingConfigData,
  input: FinancePolicyInput,
  ctx: FinancePolicyContext,
): FinancePolicyResult {
  const lines: SalesAccountingLine[] = [];
  const blockers: string[] = [];
  const policyBlocks: string[] = [];
  const account = (key: string, label: string) => {
    const v = config.accounts.find((a) => a.key === key)?.account.trim() ?? "";
    if (!v) blockers.push(`Configure the ${label} account in Finance mappings.`);
    return v;
  };
  const line = (acct: string, debitCents: number, creditCents: number, purpose: string) => {
    if (debitCents || creditCents) lines.push({ account: acct, debit: debitCents / 100, credit: creditCents / 100, purpose });
  };
  const source = input.sourceId ? config.sources.find((s) => s.id === input.sourceId) : undefined;
  let chargeNetCents = 0;
  let chargeVatCents = 0;

  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) blockers.push("Amount must be greater than zero.");
  if (!input.reference.trim()) blockers.push("Supporting reference/evidence is required.");
  if (!ctx.configValid) blockers.push("ERPNext account validation must be valid before Finance can approve postings.");
  if (ctx.legacyHeld) policyBlocks.push("A linked legacy financial record is under Finance review hold. It cannot be posted from this desk.");

  if (input.kind === "invoice") {
    const inv = ctx.invoice;
    if (!inv) blockers.push("Select the prepared AURA invoice for this deal.");
    else {
      if (inv.status === "void") blockers.push("The selected invoice is void.");
      if (inv.kind === "reservation") policyBlocks.push(ADVANCE_VAT_BLOCK);
      if (inv.amountCents !== input.amountCents) blockers.push("Amount must equal the prepared invoice total.");
      if (!ctx.vehicle?.vin) blockers.push("Assign the VIN through the existing allocation controls before invoicing.");
      if (ctx.dealStage && !["committed", "delivered"].includes(ctx.dealStage)) {
        blockers.push("The deal must be committed (existing inventory/VIN gate) before the tax invoice posts.");
      }
      const model = ctx.vehicle ? config.models.find((m) =>
        normalizeModelKey(m.make) === normalizeModelKey(ctx.vehicle!.make) &&
        normalizeModelKey(m.model) === normalizeModelKey(ctx.vehicle!.model)) : undefined;
      const income = (ctx.vehicle?.dutyFree ? model?.dutyFreeIncome : model?.income)?.trim() ?? "";
      if (!income) blockers.push(ctx.vehicle?.dutyFree
        ? "Configure this model's duty-free income account; normal income is never reused."
        : "Configure this vehicle model's income account in Finance mappings.");
      const tax = inv.taxCents;
      line(account("receivables", "customer receivables"), inv.amountCents, 0, "Customer receivable (invoice total)");
      line(income, 0, inv.amountCents - tax, "Vehicle sale income");
      if (tax > 0) line(account("vatOutput", "VAT output"), 0, tax, "VAT output on delivery invoice");
    }
  }

  if (input.kind === "payment") {
    const inv = ctx.invoice;
    if (!inv) blockers.push("Select the invoice this payment settles.");
    else {
      if (inv.kind === "reservation") policyBlocks.push(ADVANCE_VAT_BLOCK);
      if (inv.status === "void") blockers.push("The selected invoice is void.");
      if (ctx.invoiceOutstandingCents != null && input.amountCents > ctx.invoiceOutstandingCents) {
        blockers.push("Amount exceeds the invoice's outstanding balance (overpayment).");
      }
      if (inv.kind !== "reservation" && !ctx.invoicePosted) {
        blockers.push("Post the invoice through an approved invoice request before allocating payments to it.");
      }
    }
    if (input.payerType === "financier") policyBlocks.push(FINANCIER_BLOCK);
    if (!source) blockers.push("Select a configured receiving source.");
    else if (!["bank", "cash"].includes(source.kind)) blockers.push("Receipts require a bank or cash source.");
    line(source?.account ?? "", input.amountCents, 0, `Receipt into ${source?.label ?? "source"}`);
    line(account("receivables", "customer receivables"), 0, input.amountCents, "Customer receivable settled");
  }

  if (input.kind === "expense") {
    const cat = input.category;
    if (!cat || !["registration", "fuel", "detailing"].includes(cat)) blockers.push("Choose registration, fuel or detailing/PDI.");
    if (!source) blockers.push("Select a configured funding source.");
    else if (source.kind === "supplier") policyBlocks.push(SUPPLIER_PARTY_BLOCK);
    const label = cat === "detailing" ? "detailing/PDI" : cat ?? "expense";
    line(cat ? account(cat, `${label} expense`) : "", input.amountCents, 0, `${label} cost (dealer expense)`);
    line(source?.account ?? "", 0, input.amountCents, `Paid from ${source?.label ?? "source"}`);
    if (input.billingTreatment === "customer_billed") {
      const charge = input.customerChargeCents ?? 0;
      if (!Number.isSafeInteger(charge) || charge <= 0) blockers.push("Enter the separate customer charge amount.");
      const rule = config.customerCharges?.find((r) => r.category === cat);
      if (!rule?.approved || !rule.incomeAccount || rule.taxTreatment === "pending") {
        blockers.push(`Finance must approve a ${label} customer-charge income and tax mapping before billing the customer.`);
      }
      const { net, vat } = splitVat(charge, rule?.taxTreatment === "taxable" ? rule.vatRate : 0, !!rule?.amountIncludesVat);
      chargeNetCents = net;
      chargeVatCents = vat;
      line(account("receivables", "customer receivables"), net + vat, 0, "Customer charge receivable (charge invoice)");
      line(rule?.incomeAccount ?? "", 0, net, `${label} recovery income`);
      if (vat > 0) line(account("vatOutput", "VAT output"), 0, vat, "VAT output on customer charge");
    }
  }

  if (lines.some((l) => !l.account)) blockers.push("Every GL line needs a configured account.");
  const debitCents = lines.reduce((s, l) => s + Math.round(l.debit * 100), 0);
  const creditCents = lines.reduce((s, l) => s + Math.round(l.credit * 100), 0);
  if (debitCents !== creditCents) blockers.push("Debit and credit totals do not balance.");
  return {
    lines, blockers: [...new Set(blockers)], policyBlocks: [...new Set(policyBlocks)],
    debitCents, creditCents, chargeNetCents, chargeVatCents,
  };
}

export const toCents = (v: number) => Math.round(v * 100);
