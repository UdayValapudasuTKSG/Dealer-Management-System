import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSaveSalesAccountingEntry,
  getGetSalesAccountingWorkflowQueryKey,
  getListSalesAccountingDealsQueryKey,
  type GetSalesAccountingWorkflow200,
  type GetSalesAccountingWorkflow200EntriesItem,
  type SalesAccountingEntryInput,
  type SalesAccountingEntryInputStage,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { dealerDayKey } from "@/lib/format";
import { AMOUNT_STAGES, SOURCE_STAGES, apiErrorMessage, fieldCls } from "./shared";

type Draft = Record<string, string>;

function toDraft(stage: string, e?: GetSalesAccountingWorkflow200EntriesItem): Draft {
  const i = e?.input;
  const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  return {
    date: i?.date ?? dealerDayKey(),
    amount: s(i?.amount),
    sourceId: s(i?.sourceId),
    expenseType: s(i?.expenseType),
    billingTreatment: i?.billingTreatment ?? "dealer_paid",
    customerChargeAmount: s(i?.customerChargeAmount),
    payerType: s(i?.payerType),
    reference: s(i?.reference),
    notes: s(i?.notes),
    invoiceId: s(i?.invoiceId),
    paymentId: s(i?.paymentId),
    discount: s(i?.discount),
    vat: s(i?.vat),
    cost: s(i?.cost),
    costEvidence: s(i?.costEvidence),
    stage,
  };
}

function L({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1 block">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

export function EntryForm({
  workflow,
  stage,
  entry,
  canEdit,
}: {
  workflow: GetSalesAccountingWorkflow200;
  stage: string;
  entry?: GetSalesAccountingWorkflow200EntriesItem;
  canEdit: boolean;
}) {
  const dealId = workflow.deal.id;
  const [d, setD] = useState<Draft>(() => toDraft(stage, entry));
  const set = (k: string, v: string) => setD((p) => ({ ...p, [k]: v }));
  const qc = useQueryClient();
  const { toast } = useToast();
  const save = useSaveSalesAccountingEntry();

  const has = (list: string[]) => list.includes(stage);
  const disabled = !canEdit || save.isPending;
  const chargeRule = workflow.config.customerCharges?.find(r => r.category === d.expenseType);

  const submit = () => {
    const data: SalesAccountingEntryInput = {
      stage: stage as SalesAccountingEntryInputStage,
      date: d.date,
      amount: has(AMOUNT_STAGES) ? Number(d.amount || 0) : 0,
      revision: entry?.revision ?? 0,
      reference: d.reference || undefined,
      notes: d.notes || undefined,
    };
    if (has(SOURCE_STAGES)) data.sourceId = d.sourceId || undefined;
    if (stage === "VS-05") {
      data.expenseType = d.expenseType || undefined;
      data.billingTreatment = d.billingTreatment === "customer_billed" ? "customer_billed" : "dealer_paid";
      if (data.billingTreatment === "customer_billed") data.customerChargeAmount = num(d.customerChargeAmount);
    }
    if (stage === "VS-06") {
      data.invoiceId = num(d.invoiceId);
      data.discount = num(d.discount);
      data.vat = num(d.vat);
    }
    if (stage === "VS-07") {
      data.cost = num(d.cost);
      data.costEvidence = d.costEvidence || undefined;
    }
    if (stage === "VS-08") {
      data.invoiceId = num(d.invoiceId);
      data.paymentId = num(d.paymentId);
    }
    if (stage === "VS-09") data.payerType = d.payerType || undefined;
    if (["VS-03", "VS-04", "VS-09", "VS-10"].includes(stage)) data.paymentId = num(d.paymentId);
    save.mutate(
      { dealId, data },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetSalesAccountingWorkflowQueryKey(dealId) });
          qc.invalidateQueries({ queryKey: getListSalesAccountingDealsQueryKey() });
          toast({ title: `${stage} workpaper saved`, description: "Draft only — nothing was posted." });
        },
        onError: (err) => {
          qc.invalidateQueries({ queryKey: getGetSalesAccountingWorkflowQueryKey(dealId) });
          toast({ title: "Could not save workpaper", description: apiErrorMessage(err), variant: "destructive" });
        },
      },
    );
  };

  const input = (k: string, type = "text", ph = "") => (
    <input data-testid={`input-${k}`} type={type} value={d[k]} placeholder={ph} disabled={disabled}
      onChange={(e) => set(k, e.target.value)} className={fieldCls} />
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <L label="Date (dealer time)">{input("date", "date")}</L>
        {has(AMOUNT_STAGES) && <L label="Amount (GYD)">{input("amount", "number", "0.00")}</L>}
        {has(SOURCE_STAGES) && (
          <L label="Funding source">
            <select data-testid="select-source" value={d.sourceId} disabled={disabled} onChange={(e) => set("sourceId", e.target.value)} className={fieldCls}>
              <option value="">Select source…</option>
              {workflow.config.sources.map((s) => (
                <option key={s.id} value={s.id}>{s.label} · {s.kind}</option>
              ))}
            </select>
          </L>
        )}
        {stage === "VS-05" && (
          <L label="Expense type">
            <select data-testid="select-expense" value={d.expenseType} disabled={disabled} onChange={(e) => set("expenseType", e.target.value)} className={fieldCls}>
              <option value="">Select…</option>
              <option value="registration">Registration</option>
              <option value="fuel">Fuel</option>
              <option value="detailing">Detailing</option>
            </select>
          </L>
        )}
        {stage === "VS-05" && <>
          <L label="Who bears this expense?"><select className={fieldCls} value={d.billingTreatment} disabled={disabled} onChange={e => set("billingTreatment", e.target.value)}>
            <option value="dealer_paid">Dealer-paid — no customer charge</option>
            <option value="customer_billed">Request separate customer charge</option>
          </select></L>
          {d.billingTreatment === "customer_billed" && <>
            <L label="Customer charge (GYD)">{input("customerChargeAmount", "number", "0.00")}</L>
            <p className="text-xs sm:col-span-2">
              {chargeRule?.approved
                ? `Category rule: ${chargeRule.taxTreatment === "taxable" ? `${chargeRule.vatRate}% VAT` : chargeRule.taxTreatment === "zero_rated" ? "Zero-rated" : "Exempt"} · Amount ${chargeRule.amountIncludesVat ? "includes" : "excludes"} VAT.`
                : "Blocked: Finance has not approved this category's customer-charge rule."}
            </p>
            <p className="text-xs text-muted-foreground sm:col-span-2">The cost above remains a dealer expense. This separate customer charge requires an approved category rule and validated GL mappings. VAT-inclusive/exclusive treatment follows that rule. Saving never changes the customer's invoice or balance.</p>
          </>}
        </>}
        {stage === "VS-09" && (
          <L label="Payer">
            <select data-testid="select-payer" value={d.payerType} disabled={disabled} onChange={(e) => set("payerType", e.target.value)} className={fieldCls}>
              <option value="">Select…</option>
              <option value="customer">Customer</option>
              <option value="financier">Financier</option>
            </select>
          </L>
        )}
        {(stage === "VS-06" || stage === "VS-08") && <L label="Existing invoice ID">{input("invoiceId", "number", "From Finance › Invoices")}</L>}
        {["VS-03", "VS-04", "VS-08", "VS-09", "VS-10"].includes(stage) && <L label="Existing payment ID">{input("paymentId", "number", "From Finance › Payments")}</L>}
        {stage === "VS-06" && <L label="Discount">{input("discount", "number")}</L>}
        {stage === "VS-06" && <L label="VAT">{input("vat", "number")}</L>}
        {stage === "VS-07" && <L label="Verified VIN cost">{input("cost", "number")}</L>}
        {stage === "VS-07" && <L label="Cost evidence">{input("costEvidence", "text", "Landed-cost sheet ref")}</L>}
        <L label="Reference">{input("reference", "text", "Doc / transfer ref")}</L>
      </div>
      <L label="Notes">
        <textarea data-testid="input-notes" value={d.notes} disabled={disabled} onChange={(e) => set("notes", e.target.value)}
          className={`${fieldCls} h-20 py-2`} />
      </L>
      {(stage === "VS-06" || stage === "VS-08") && (
        <p className="text-[11px] text-muted-foreground">Reference IDs must already exist in Finance › Invoices & Payments. This workpaper never creates them.</p>
      )}
      {stage === "VS-10" && (
        <p className="text-[11px] text-amber-400">VS-10 is the cancellation / refund alternative to completing the sale — use it instead of VS-08/VS-09.</p>
      )}
      <div className="flex justify-end">
        <Button data-testid="button-save-entry" size="sm" className="rounded-full" disabled={disabled} onClick={submit}>
          {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {entry ? `Save revision ${entry.revision}` : "Save draft workpaper"}
        </Button>
      </div>
    </div>
  );
}
