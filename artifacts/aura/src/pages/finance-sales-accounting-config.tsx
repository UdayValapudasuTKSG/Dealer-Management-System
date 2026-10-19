import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSalesAccountingConfig,
  useSaveSalesAccountingConfig,
  useValidateSalesAccountingConfig,
  getGetSalesAccountingConfigQueryKey,
  type GetSalesAccountingConfig200,
  type SalesAccountingConfigInput,
  type SalesAccountingConfigInputSourcesItem,
  type SalesAccountingConfigInputModelsItem,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2, Plus, Trash2, ShieldCheck, Save, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { formatGuyanaDateTime } from "@/lib/format";
import { PreparationBanner, Unavailable, apiErrorMessage, fieldCls } from "@/components/sales-accounting/shared";

type Form = Omit<SalesAccountingConfigInput, "revision">;
const MODEL_FIELDS = ["income", "dutyFreeIncome", "inventory", "cogs", "discount"] as const;
const MODEL_LABEL: Record<string, string> = { income: "Income", dutyFreeIncome: "Duty-free income (if applicable)", inventory: "Inventory", cogs: "COGS", discount: "Discount" };

function fromConfig(c: GetSalesAccountingConfig200): Form {
  const acc = new Map(c.accounts.map((a) => [a.key, a.account]));
  return {
    customerCharges: (["registration", "fuel", "detailing"] as const).map(category =>
      c.customerCharges?.find(r => r.category === category) ?? {
        category, incomeAccount: "", taxTreatment: "pending" as const, vatRate: 0,
        amountIncludesVat: false, approved: false, approvalReference: "",
      }),
    accounts: c.accountRoles.map((r) => ({ key: r.key, account: acc.get(r.key) ?? "" })),
    sources: c.sources.map((s) => ({ ...s })),
    models: c.models.map((m) => ({ ...m })),
  };
}

export default function FinanceSalesAccountingConfig() {
  const { can, activeDealer } = useAuthz();
  if (!can("finance", "view")) {
    return <Page className="pt-10"><Unavailable title="Finance view required" body="Your role cannot read sales accounting mappings." /></Page>;
  }
  return <ConfigWorkspace key={activeDealer?.dealerId ?? 0} />;
}

function ConfigWorkspace() {
  const { can } = useAuthz();
  const canEdit = can("finance", "edit");
  const qc = useQueryClient();
  const { toast } = useToast();
  const [polling, setPolling] = useState(false);
  const config = useGetSalesAccountingConfig({
    query: { queryKey: getGetSalesAccountingConfigQueryKey(), refetchInterval: polling ? 2500 : 10000 },
  });
  const state = config.data?.validation.state;
  useEffect(() => setPolling(state === "queued" || state === "running"), [state]);

  const [form, setForm] = useState<Form | null>(null);
  const [baseRev, setBaseRev] = useState<number | null>(null);
  const initRev = useRef<number | null>(null);
  useEffect(() => {
    if (config.data && initRev.current === null) {
      initRev.current = config.data.revision;
      setBaseRev(config.data.revision);
      setForm(fromConfig(config.data));
    }
  }, [config.data]);

  const reload = () => {
    if (!config.data) return;
    initRev.current = config.data.revision;
    setBaseRev(config.data.revision);
    setForm(fromConfig(config.data));
  };

  const save = useSaveSalesAccountingConfig();
  const validate = useValidateSalesAccountingConfig();
  const editable = canEdit && !!config.data?.eligible;
  const stale = config.data && baseRev !== null && config.data.revision !== baseRev;

  const doSave = () => {
    if (!form || baseRev === null) return;
    save.mutate({ data: { ...form, revision: baseRev } }, {
      onSuccess: (c) => {
        qc.setQueryData(getGetSalesAccountingConfigQueryKey(), c);
        void qc.invalidateQueries({ predicate: q => q.queryKey.some(k => typeof k === "string" && k.includes("/sales-accounting/deals")) });
        initRev.current = c.revision; setBaseRev(c.revision); setForm(fromConfig(c));
        toast({ title: `Mappings saved · revision ${c.revision}`, description: "Run ERP validation to verify account names." });
      },
      onError: (err) => {
        qc.invalidateQueries({ queryKey: getGetSalesAccountingConfigQueryKey() });
        toast({ title: "Could not save mappings", description: apiErrorMessage(err), variant: "destructive" });
      },
    });
  };
  const doValidate = () =>
    validate.mutate(undefined, {
      onSuccess: (c) => {
        qc.setQueryData(getGetSalesAccountingConfigQueryKey(), c);
        setPolling(true);
        toast({ title: "Validation queued", description: "ERPNext is read-only. Unique account numbers will be saved as exact names in AURA; reload the latest revision when validation finishes." });
      },
      onError: (err) => toast({ title: "Could not queue validation", description: apiErrorMessage(err), variant: "destructive" }),
    });

  const setSrc = (i: number, p: Partial<SalesAccountingConfigInputSourcesItem>) =>
    setForm((f) => f && { ...f, sources: f.sources.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const setModel = (i: number, p: Partial<SalesAccountingConfigInputModelsItem>) =>
    setForm((f) => f && { ...f, models: f.models.map((m, j) => (j === i ? { ...m, ...p } : m)) });

  const hero = (
    <PageHero eyebrow="Finance Desk · Pilot" title="Sales Accounting Mappings"
      subtitle="Per-workpaper GL, funding-source and model map. Separate from the legacy Vehicle Model GL Codes page."
      className="pb-3"
      action={<Link href="/finance/sales-accounting" data-testid="link-back-workpapers"><Button variant="outline" className="rounded-full h-9 gap-1.5 text-sm"><ArrowLeft className="h-4 w-4" /> Workpapers</Button></Link>} />
  );

  if (config.isLoading || (config.data && !form)) return <>{hero}<Page className="pt-0 space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-28 rounded-2xl bg-white/[0.05] animate-pulse" />)}</Page></>;
  if (config.isError || !config.data || !form) {
    return <>{hero}<Page className="pt-0"><div className="glass-panel rounded-2xl p-6 text-center space-y-3"><p className="text-sm text-red-400">{apiErrorMessage(config.error)}</p><Button size="sm" variant="outline" className="rounded-full" onClick={() => config.refetch()}>Retry</Button></div></Page></>;
  }
  const c = config.data;
  const roleOf = new Map(c.accountRoles.map((r) => [r.key, r]));
  const v = c.validation;
  const vTone = v.state === "valid" ? "text-emerald-400" : v.state === "invalid" || v.state === "failed" ? "text-red-400" : "text-amber-400";

  return (
    <>
      {hero}
      <Page className="pt-0 space-y-4 pb-28">
        <PreparationBanner />
        {!c.eligible && <Unavailable title="Read-only — not available" body="Select an available dealership to edit its own account mappings." />}
        {!canEdit && c.eligible && <p className="text-xs text-muted-foreground">View-only: finance:edit is required to change mappings or run validation.</p>}

        <section className="glass-panel rounded-2xl p-5 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">ERP validation</div>
              <div className={`flex items-center gap-2 font-semibold ${vTone}`} data-testid="status-validation">
                {polling && <Loader2 className="h-4 w-4 animate-spin" />}{v.state}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {v.company ? `Company: ${v.company}` : "Company not resolved"}{v.checkedAt && ` · checked ${formatGuyanaDateTime(v.checkedAt)}`} · rev {c.revision} · VAT policy {c.vatPolicy === "final_invoice_14" ? "14% at final invoice; deposits held as liabilities" : "pending"}
              </div>
            </div>
            <Button data-testid="button-validate" variant="outline" className="rounded-full gap-1.5" disabled={!editable || validate.isPending || polling} onClick={doValidate}>
              {validate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Queue validation
            </Button>
          </div>
          {v.errors.length > 0 && <ul className="space-y-0.5 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3 text-xs text-red-400">{v.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        </section>

        <section className="glass-panel rounded-2xl p-5 space-y-3">
          <h2 className="font-semibold tracking-tight">Control accounts</h2>
          <p className="text-xs text-muted-foreground">Enter an exact ERPNext Account name or account number. Validation resolves a unique number within the connected company and saves its full name in AURA. Suggested codes must still exist in your chart. Use Load latest after validation changes the revision.</p>
          <div className="grid gap-3 md:grid-cols-2">
            {form.accounts.map((a, i) => {
              const r = roleOf.get(a.key);
              return (
                <label key={a.key} className="block space-y-1">
                  <span className="flex justify-between text-[11px]"><span className="font-medium">{r?.label ?? a.key}</span><span className="font-mono text-muted-foreground">ref {r?.suggestedCode} · {r?.rootType}</span></span>
                  <input data-testid={`input-account-${a.key}`} className={`${fieldCls} font-mono`} disabled={!editable} value={a.account}
                    onChange={(e) => setForm((f) => f && { ...f, accounts: f.accounts.map((x, j) => (j === i ? { ...x, account: e.target.value } : x)) })} />
                </label>
              );
            })}
          </div>
        </section>

        <section className="glass-panel rounded-2xl p-5 space-y-3">
          <h2 className="font-semibold">Customer-billed expense rules</h2>
          <p className="text-xs text-muted-foreground">Dealer-paid is the default. Configure customer charges separately for each category. Approval requires Finance approve permission; saving changes resets ERP validation and existing workpapers must be reviewed again. This does not enable posting.</p>
          {form.customerCharges?.map((rule, i) => {
            const change = (patch: Partial<typeof rule>) => setForm(f => f && ({ ...f,
              customerCharges: f.customerCharges?.map((r, j) => j === i ? { ...r, ...patch, approved: false } : r),
            }));
            return <div key={rule.category} className="rounded-xl border p-3 space-y-2">
              <h3 className="text-sm font-medium">{rule.category === "detailing" ? "Detailing & PDI" : rule.category === "fuel" ? "Fuel" : "Registration"}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs">Customer-charge income account<input className={fieldCls} value={rule.incomeAccount} disabled={!editable} onChange={e => change({ incomeAccount: e.target.value })} placeholder="Exact ERPNext account name" /></label>
                <label className="text-xs">VAT treatment<select className={fieldCls} value={rule.taxTreatment} disabled={!editable} onChange={e => change({ taxTreatment: e.target.value as typeof rule.taxTreatment, vatRate: 0 })}>
                  <option value="pending">Not approved / pending</option><option value="taxable">Taxable</option><option value="exempt">Exempt</option><option value="zero_rated">Zero-rated</option>
                </select></label>
                <label className="text-xs">VAT rate (%)<input className={fieldCls} type="number" min="0" max="100" value={rule.vatRate} disabled={!editable || rule.taxTreatment !== "taxable"} onChange={e => change({ vatRate: Number(e.target.value) })} /></label>
                <label className="text-xs">Finance approval reference<input className={fieldCls} value={rule.approvalReference} disabled={!editable} onChange={e => change({ approvalReference: e.target.value })} /></label>
              </div>
              <label className="flex gap-2 text-xs"><input type="checkbox" checked={rule.amountIncludesVat} disabled={!editable} onChange={e => change({ amountIncludesVat: e.target.checked })} />Entered customer amount includes VAT</label>
              <label className="flex gap-2 text-xs"><input type="checkbox" checked={rule.approved} disabled={!editable || !can("finance", "approve")} onChange={e => setForm(f => f && ({ ...f, customerCharges: f.customerCharges?.map((r, j) => i === j ? { ...r, approved: e.target.checked } : r) }))} />Finance-approved rule (saved with Save mappings)</label>
            </div>;
          })}
        </section>

        <section className="glass-panel rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold tracking-tight">Funding sources</h2>
            <Button data-testid="button-add-source" size="sm" variant="outline" className="rounded-full gap-1" disabled={!editable}
              onClick={() => setForm((f) => f && { ...f, sources: [...f.sources, { id: `src-${f.sources.length + 1}`, label: "", kind: "bank", account: "" }] })}><Plus className="h-3.5 w-3.5" /> Source</Button>
          </div>
          {form.sources.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">No funding sources yet — add the bank, cash, float or supplier accounts used to fund sales.</p>}
          {form.sources.map((s, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 md:grid-cols-[140px_1fr_120px_1.4fr_auto]">
              <input data-testid={`input-source-id-${i}`} className={`${fieldCls} font-mono`} placeholder="id" disabled={!editable} value={s.id} onChange={(e) => setSrc(i, { id: e.target.value })} />
              <input data-testid={`input-source-label-${i}`} className={fieldCls} placeholder="Label" disabled={!editable} value={s.label} onChange={(e) => setSrc(i, { label: e.target.value })} />
              <select data-testid={`select-source-kind-${i}`} className={fieldCls} disabled={!editable} value={s.kind} onChange={(e) => setSrc(i, { kind: e.target.value as SalesAccountingConfigInputSourcesItem["kind"] })}>
                {["bank", "cash", "float", "supplier"].map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <input data-testid={`input-source-account-${i}`} className={`${fieldCls} font-mono`} placeholder="ERPNext account" disabled={!editable} value={s.account} onChange={(e) => setSrc(i, { account: e.target.value })} />
              <Button data-testid={`button-remove-source-${i}`} size="icon" variant="ghost" disabled={!editable} onClick={() => setForm((f) => f && { ...f, sources: f.sources.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </section>

        <section className="glass-panel rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold tracking-tight">Model accounts</h2>
            <Button data-testid="button-add-model" size="sm" variant="outline" className="rounded-full gap-1" disabled={!editable}
              onClick={() => setForm((f) => f && { ...f, models: [...f.models, { make: "", model: "", income: "", dutyFreeIncome: "", inventory: "", cogs: "", discount: "" }] })}><Plus className="h-3.5 w-3.5" /> Model</Button>
          </div>
          <p className="text-xs text-muted-foreground">Map each make and model to its actual sales, inventory, COGS and discount accounts. Leave duty-free income blank only when not applicable; duty-free sales remain blocked until mapped. Never substitute another model's ledger.</p>
          {form.models.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">No model rows. Legacy codes on the Vehicle Model GL page are not copied or changed.</p>}
          {form.models.map((m, i) => (
            <div key={i} className="rounded-xl border border-white/10 p-3 space-y-2">
              <div className="flex gap-2">
                <input data-testid={`input-model-make-${i}`} className={fieldCls} placeholder="Make" disabled={!editable} value={m.make} onChange={(e) => setModel(i, { make: e.target.value })} />
                <input data-testid={`input-model-model-${i}`} className={fieldCls} placeholder="Model" disabled={!editable} value={m.model} onChange={(e) => setModel(i, { model: e.target.value })} />
                <Button data-testid={`button-remove-model-${i}`} size="icon" variant="ghost" disabled={!editable} onClick={() => setForm((f) => f && { ...f, models: f.models.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {MODEL_FIELDS.map((k) => (
                  <label key={k} className="block space-y-0.5">
                    <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{MODEL_LABEL[k]}</span>
                    <input data-testid={`input-model-${k}-${i}`} className={`${fieldCls} font-mono text-xs`} disabled={!editable} value={m[k]} onChange={(e) => setModel(i, { [k]: e.target.value })} />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </section>
      </Page>

      {editable && (
        <div className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-background/90 px-4 py-2 shadow-xl backdrop-blur">
          {stale ? <span className="text-xs text-amber-400">Server has revision {c.revision}; you are editing {baseRev}.</span> : <span className="text-xs text-muted-foreground">Editing revision {baseRev}</span>}
          {stale && <Button data-testid="button-reload-config" size="sm" variant="outline" className="rounded-full gap-1" onClick={reload}><RotateCcw className="h-3.5 w-3.5" /> Load latest</Button>}
          <Button data-testid="button-save-config" size="sm" className="rounded-full gap-1.5" disabled={save.isPending} onClick={doSave}>
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save mappings
          </Button>
        </div>
      )}
    </>
  );
}
