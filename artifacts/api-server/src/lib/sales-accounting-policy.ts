import type { SalesAccountingConfigData, SalesAccountingInput, SalesAccountingLine } from "@workspace/db";
import { normalizeModelKey } from "@workspace/db";

export const SALES_STAGES = [
  { id: "VS-01", title: "Quotation", posts: false },
  { id: "VS-02", title: "Sales order / VIN reservation", posts: false },
  { id: "VS-03", title: "Deposit / prepayment", posts: true },
  { id: "VS-04", title: "Bank-statement matching", posts: false },
  { id: "VS-05", title: "Pre-delivery costs", posts: true },
  { id: "VS-06", title: "Delivery tax invoice", posts: true },
  { id: "VS-07", title: "VIN cost of sale", posts: true },
  { id: "VS-08", title: "Apply deposit", posts: true },
  { id: "VS-09", title: "Balance collection", posts: true },
  { id: "VS-10", title: "Cancellation / refund", posts: true },
] as const;
export const ACCOUNT_ROLES = [
  { key: "deposits", label: "Customer deposits", suggestedCode: "2020101", rootType: "Liability" },
  { key: "receivables", label: "Customer receivables", suggestedCode: "1020101", rootType: "Asset" },
  { key: "financierReceivables", label: "Bank-financed receivables", suggestedCode: "1020102", rootType: "Asset" },
  { key: "vatOutput", label: "VAT output payable", suggestedCode: "2030101", rootType: "Liability" },
  { key: "registration", label: "Registration, licensing & fitness", suggestedCode: "5040101", rootType: "Expense" },
  { key: "fuel", label: "Fuel — delivery & PDI", suggestedCode: "5040102", rootType: "Expense" },
  { key: "detailing", label: "Detailing & PDI", suggestedCode: "5040104", rootType: "Expense" },
] as const;
export const EMPTY_SALES_CONFIG: SalesAccountingConfigData = { accounts: [], sources: [], models: [] };
const cents = (value: number) => Math.round(value * 100);
const money = (value: number) => cents(value) / 100;

export function buildSalesPreview(
  config: SalesAccountingConfigData, input: SalesAccountingInput,
  vehicle?: { make: string; model: string; dutyFree: boolean } | null,
) {
  const lines: SalesAccountingLine[] = [];
  const blockers: string[] = [];
  const phase = SALES_STAGES.find(s => s.id === input.stage);
  if (!phase) throw Error("Unknown accounting stage");
  const account = (key: string) => {
    const value = config.accounts.find(a => a.key === key)?.account.trim() ?? "";
    if (!value) blockers.push(`Configure ${ACCOUNT_ROLES.find(r => r.key === key)?.label ?? key}.`);
    return value;
  };
  const source = config.sources.find(s => s.id === input.sourceId);
  const sourceAccount = () => {
    if (!source?.account) blockers.push("Select a configured payment/funding source.");
    return source?.account ?? "";
  };
  const line = (acct: string, debit: number, credit: number, purpose: string) => {
    if (debit || credit) lines.push({ account: acct, debit: money(debit), credit: money(credit), purpose });
  };
  const model = vehicle ? config.models.find(m =>
    normalizeModelKey(m.make) === normalizeModelKey(vehicle.make) &&
    normalizeModelKey(m.model) === normalizeModelKey(vehicle.model)) : undefined;
  const modelAccount = (key: "income" | "dutyFreeIncome" | "inventory" | "cogs" | "discount") => {
    const value = model?.[key]?.trim() ?? "";
    if (!value) blockers.push(`Configure this vehicle model's ${key} account.`);
    return value;
  };
  if (!input.reference?.trim()) blockers.push("Enter the supporting document/reference.");
  if (phase.posts && input.amount <= 0 && input.stage !== "VS-07") blockers.push("Enter an amount greater than zero.");
  if (["VS-03", "VS-09", "VS-10"].includes(input.stage) && source && !["bank", "cash"].includes(source.kind)) {
    blockers.push("Receipts and refunds require a bank or cash source.");
  }
  switch (input.stage) {
    case "VS-03":
      line(sourceAccount(), input.amount, 0, "Deposit received");
      line(account("deposits"), 0, input.amount, "Customer deposit liability");
      break;
    case "VS-05":
      if (!["registration", "fuel", "detailing"].includes(input.expenseType ?? "")) blockers.push("Select a pre-delivery expense type.");
      line(account(input.expenseType ?? ""), input.amount, 0, "Pre-delivery expense");
      line(sourceAccount(), 0, input.amount, "Funding source / supplier payable");
      break;
    case "VS-06": {
      const discount = input.discount ?? 0;
      const vat = input.vat ?? 0;
      if (vat > input.amount) blockers.push("VAT cannot exceed the invoice total.");
      line(account("receivables"), input.amount, 0, "Gross invoice receivable");
      if (discount) line(modelAccount("discount"), discount, 0, "Vehicle discount");
      line(modelAccount(vehicle?.dutyFree ? "dutyFreeIncome" : "income"), 0, input.amount - vat + discount, "Vehicle sales before discount");
      if (vat) line(account("vatOutput"), 0, vat, "Output VAT");
      break;
    }
    case "VS-07":
      if (!input.costEvidence?.trim()) blockers.push("Provide the VIN landed-cost / ERPNext stock valuation reference.");
      if (!(input.cost && input.cost > 0)) blockers.push("Enter the verified VIN cost; do not use selling price.");
      line(modelAccount("cogs"), input.cost ?? 0, 0, "Cost of vehicles sold");
      line(modelAccount("inventory"), 0, input.cost ?? 0, "VIN inventory relieved");
      break;
    case "VS-08":
      line(account("deposits"), input.amount, 0, "Deposit applied");
      line(account("receivables"), 0, input.amount, "Customer receivable reduced");
      break;
    case "VS-09":
      if (!["customer", "financier"].includes(input.payerType ?? "")) blockers.push("Select customer or financier.");
      line(sourceAccount(), input.amount, 0, "Balance received");
      line(account(input.payerType === "financier" ? "financierReceivables" : "receivables"), 0, input.amount, "Receivable settled");
      if (input.payerType === "financier") blockers.push("Finance must verify the transfer into bank-financed receivables; this document does not define that transfer.");
      break;
    case "VS-10":
      line(account("deposits"), input.amount, 0, "Unapplied deposit refunded");
      line(sourceAccount(), 0, input.amount, "Refund payment");
      break;
  }
  const debitTotal = money(lines.reduce((sum, l) => sum + l.debit, 0));
  const creditTotal = money(lines.reduce((sum, l) => sum + l.credit, 0));
  if (cents(debitTotal) !== cents(creditTotal)) blockers.push("Debit and credit totals do not balance.");
  if (phase.posts) blockers.push("ERPNext posting is held: advance-VAT policy is pending finance approval. This is a workpaper, not a posted transaction.");
  return { lines, blockers: [...new Set(blockers)], debitTotal, creditTotal };
}
