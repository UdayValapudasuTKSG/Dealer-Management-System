import { useEffect, useState } from "react";
import { Loader2, Plus, Save, ShieldCheck, Trash2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { StyledSelect } from "@/components/ui/styled-select";
import { SearchableSelect } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { BRANDS, errorText, usePosAction, type PosConfig, type PosState } from "./pos-api";
import { ErrorBox, Field, fieldCls } from "./pos-shared";

function normalize(c: PosConfig): PosConfig {
  return {
    ...c,
    taxRate: c.taxRate ?? 14,
    brands: BRANDS.map((b) => c.brands?.find((x) => x.brand === b) ?? { brand: b, income: "", cogs: "", inventory: "", warehouse: "" }),
    sources: c.sources ?? [],
    items: c.items ?? [],
  };
}

export function PosConfigPanel({ state }: { state: PosState }) {
  const { toast } = useToast();
  const act = usePosAction();
  const [draft, setDraft] = useState<PosConfig>(() => normalize(state.config));
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ro = !state.canApprove || act.isPending;

  useEffect(() => { if (!dirty) setDraft(normalize(state.config)); }, [state.revision, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<PosConfig>) => { setDirty(true); setDraft((d) => ({ ...d, ...patch })); };
  const run = (body: Parameters<typeof act.mutate>[0], ok: string) => {
    setErr(null);
    act.mutate(body, {
      onSuccess: () => { toast({ title: ok }); if (body.action === "save_config") setDirty(false); },
      onError: (e) => setErr(errorText(e)),
    });
  };
  const partOpts = state.parts.map((p) => ({ value: String(p.id), label: `${p.sku} — ${p.name}` }));
  const acct = (k: keyof PosConfig, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input value={String(draft[k] ?? "")} onChange={(e) => set({ [k]: e.target.value } as Partial<PosConfig>)} disabled={ro} className={fieldCls} placeholder="Full ERP account name, e.g. 1310 - Debtors - AD" data-testid={`input-config-${k}`} />
    </Field>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-muted-foreground space-y-1">
        <p><b className="text-foreground">Use full ERPNext names</b> exactly as they appear in the Chart of Accounts, Warehouse and Cost Center lists (including company suffix).</p>
        <p>VAT defaults to 14% but nothing posts until Finance marks the rate approved with a reference. Each brand's warehouse must be linked to the same inventory GL account entered on that row.</p>
        <p>Every mapped ERP item must already exist as a stock item using Moving Average valuation with its tax template set in ERP — AURA never creates items or HSN codes.</p>
        {!state.canApprove && <p className="text-amber-600 font-medium">Read-only: only Finance approvers can edit this configuration.</p>}
      </div>
      <ErrorBox message={err} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Revision {state.revision} · validation <b className="text-foreground">{state.validation.state}</b></span>
        <div className="flex-1" />
        {state.isDummy && state.canApprove && (
          <Button size="sm" variant="outline" className="rounded-full gap-1 border-white/10" disabled={act.isPending} onClick={() => run({ action: "seed" }, "Sample parts created")} data-testid="button-pos-seed">
            <Sparkles className="h-3.5 w-3.5" /> Seed sample parts
          </Button>
        )}
        <Button size="sm" variant="outline" className="rounded-full gap-1 border-white/10" disabled={act.isPending || !state.canApprove} onClick={() => run({ action: "validate" }, "Validation queued")} data-testid="button-pos-validate">
          <ShieldCheck className="h-3.5 w-3.5" /> Queue ERP validation
        </Button>
        <Button size="sm" className="rounded-full gap-1" disabled={ro || !dirty} onClick={() => run({ action: "save_config", revision: state.revision, config: draft }, "Configuration saved")} data-testid="button-pos-save">
          {act.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
        </Button>
      </div>
      {state.isDummy && <p className="text-[11px] text-muted-foreground">Seed creates labelled sample parts in AURA only — not ERP stock. Prepare ERP items and opening inventory separately before anything can post.</p>}
      {state.validation.errors.length > 0 && (
        <ul className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive list-disc pl-6 space-y-0.5">
          {state.validation.errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      <section className="glass-panel rounded-2xl p-4 space-y-3">
        <h3 className="text-sm font-semibold">General & tax</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.enabled} disabled={ro} onCheckedChange={(v) => set({ enabled: v === true })} /> POS enabled</label>
          <Field label="VAT rate %"><Input type="number" step="0.01" value={draft.taxRate} disabled={ro} onChange={(e) => set({ taxRate: Number(e.target.value), taxApproved: false })} className={fieldCls} /></Field>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.taxApproved} disabled={ro} onCheckedChange={(v) => set({ taxApproved: v === true })} /> Finance approved rate</label>
          <Field label="Approval reference"><Input value={draft.approvalReference} disabled={ro} onChange={(e) => set({ approvalReference: e.target.value })} className={fieldCls} /></Field>
          {acct("receivable", "Receivable account")}
          {acct("vat", "Output VAT account")}
          {acct("overShort", "Cash over/short account")}
          {acct("openingOffset", "Opening float offset account")}
          {acct("costCenter", "Cost center")}
        </div>
      </section>

      <section className="glass-panel rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Tender sources</h3>
          <Button size="sm" variant="outline" className="rounded-full gap-1 border-white/10" disabled={ro} onClick={() => set({ sources: [...draft.sources, { id: `src-${Date.now().toString(36)}`, label: "", kind: "cash", account: "" }] })}><Plus className="h-3.5 w-3.5" /> Add source</Button></div>
        {!draft.sources.length && <p className="text-xs text-muted-foreground">No sources yet. Add the counter cash drawer and each bank/card account.</p>}
        {draft.sources.map((s, i) => {
          const up = (p: Partial<typeof s>) => set({ sources: draft.sources.map((x, j) => (j === i ? { ...x, ...p } : x)) });
          return (
            <div key={s.id} className="grid gap-2 sm:grid-cols-[1fr_110px_2fr_auto]">
              <Input value={s.label} placeholder="Label" disabled={ro} onChange={(e) => up({ label: e.target.value })} className={fieldCls} />
              <StyledSelect value={s.kind} onValueChange={(v) => up({ kind: v as "cash" | "bank" })} options={[{ value: "cash", label: "Cash" }, { value: "bank", label: "Bank" }]} disabled={ro} className={fieldCls} />
              <Input value={s.account} placeholder="Full ERP account name" disabled={ro} onChange={(e) => up({ account: e.target.value })} className={fieldCls} />
              <Button size="icon" variant="ghost" className="h-9 w-9" disabled={ro} onClick={() => set({ sources: draft.sources.filter((_, j) => j !== i) })} aria-label="Delete source"><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          );
        })}
      </section>

      <section className="glass-panel rounded-2xl p-4 space-y-3 overflow-x-auto">
        <h3 className="text-sm font-semibold">Brand accounts</h3>
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-[11px] uppercase tracking-wider text-muted-foreground text-left"><tr><th className="py-1 w-28">Brand</th><th>Income</th><th>COGS</th><th>Inventory GL</th><th>Warehouse</th></tr></thead>
          <tbody>
            {draft.brands.map((b, i) => (
              <tr key={b.brand}>
                <td className="py-1 font-medium">{b.brand}</td>
                {(["income", "cogs", "inventory", "warehouse"] as const).map((k) => (
                  <td key={k} className="pr-2 py-1"><Input value={b[k]} disabled={ro} onChange={(e) => set({ brands: draft.brands.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)) })} className={fieldCls} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="glass-panel rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Part → ERP item mapping</h3>
          <Button size="sm" variant="outline" className="rounded-full gap-1 border-white/10" disabled={ro} onClick={() => set({ items: [...draft.items, { partId: 0, itemCode: "" }] })}><Plus className="h-3.5 w-3.5" /> Map part</Button></div>
        {!draft.items.length && <p className="text-xs text-muted-foreground">Unmapped parts cannot be sold through POS.</p>}
        {draft.items.map((it, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
            <SearchableSelect value={it.partId ? String(it.partId) : ""} onChange={(v) => set({ items: draft.items.map((x, j) => (j === i ? { ...x, partId: Number(v) } : x)) })} options={partOpts} placeholder="Select part…" ariaLabel="Part" disabled={ro} className="rounded-xl" />
            <Input value={it.itemCode} placeholder="Existing ERP item code" disabled={ro} onChange={(e) => set({ items: draft.items.map((x, j) => (j === i ? { ...x, itemCode: e.target.value } : x)) })} className={fieldCls} />
            <Button size="icon" variant="ghost" className="h-9 w-9" disabled={ro} onClick={() => set({ items: draft.items.filter((_, j) => j !== i) })} aria-label="Remove mapping"><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        ))}
      </section>
    </div>
  );
}
