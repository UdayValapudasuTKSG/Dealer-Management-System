import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import type { PosSource, Tender } from "./pos-api";

export const fieldCls = "h-9 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div role="alert" data-testid="text-pos-error" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{message}</div>;
}

export function TenderRows({ sources, tenders, onChange, disabled }: { sources: PosSource[]; tenders: Tender[]; onChange: (t: Tender[]) => void; disabled?: boolean }) {
  const opts = sources.map((s) => ({ value: s.id, label: `${s.label} (${s.kind})` }));
  return (
    <div className="space-y-2">
      {tenders.map((t, i) => (
        <div key={i} className="flex gap-2">
          <StyledSelect value={t.sourceId} onValueChange={(v) => onChange(tenders.map((x, j) => (j === i ? { ...x, sourceId: v } : x)))} options={opts} placeholder="Tender source" className={`${fieldCls} flex-1`} disabled={disabled} />
          <Input type="number" min={0} step="0.01" value={t.amount || ""} onChange={(e) => onChange(tenders.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)))} className={`${fieldCls} w-32 text-right`} placeholder="Amount" data-testid={`input-tender-${i}`} disabled={disabled} />
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9" onClick={() => onChange(tenders.filter((_, j) => j !== i))} aria-label="Remove tender" disabled={disabled}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="rounded-full gap-1 border-white/10" onClick={() => onChange([...tenders, { sourceId: sources[0]?.id ?? "", amount: 0 }])} disabled={disabled || !sources.length} data-testid="button-add-tender">
        <Plus className="h-3.5 w-3.5" /> Add tender
      </Button>
    </div>
  );
}

export const tenderTotal = (t: Tender[]) => t.reduce((s, x) => s + (Number.isFinite(x.amount) ? x.amount : 0), 0);
export const validTenders = (t: Tender[]) => t.filter((x) => x.sourceId && x.amount > 0);
