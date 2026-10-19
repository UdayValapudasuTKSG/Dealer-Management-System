import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { StyledSelect } from "@/components/ui/styled-select";
import { useToast } from "@/hooks/use-toast";
import { useMoney } from "@/lib/format";
import { errorText, round2, usePosAction, useRequestKey, type PosState, type Tender } from "./pos-api";
import { ErrorBox, Field, TenderRows, fieldCls, tenderTotal, validTenders } from "./pos-shared";

export function PosReturnForm({ state }: { state: PosState }) {
  const money = useMoney();
  const { toast } = useToast();
  const act = usePosAction();
  const rk = useRequestKey();
  const [originalId, setOriginalId] = useState("");
  const [reference, setReference] = useState("");
  const [qty, setQty] = useState<Record<number, number>>({});
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [received, setReceived] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const originals = state.requests.filter((r) => r.kind === "sale" && r.status === "posted" && (r.returnableLines ?? []).some((l) => l.quantity > 0));
  const orig = originals.find((r) => String(r.id) === originalId);
  const remaining = (partId: number) => orig?.returnableLines?.find((l) => l.partId === partId)?.quantity ?? 0;
  const rate = state.config.taxRate ?? 14;
  const gross = round2((orig?.snapshot?.lines ?? []).reduce((s, l) => s + (qty[l.partId] ?? 0) * l.unitPrice, 0) * (1 + rate / 100));
  const available = orig?.availableBalance ?? 0;
  const received$ = orig?.receivedBalance ?? 0;
  const requiredRefund = round2(Math.max(0, gross - available));
  const refund = tenderTotal(tenders);

  const submit = () => {
    setErr(null);
    if (!orig) return setErr("Select a posted sale.");
    const lines = Object.entries(qty).filter(([, q]) => q > 0).map(([partId, quantity]) => ({ partId: Number(partId), quantity: Math.floor(quantity) }));
    if (!reference.trim() || !lines.length) return setErr("Reference and at least one return quantity are required.");
    if (!received) return setErr("Confirm the goods were physically received and are sellable.");
    const input = { kind: "return" as const, reference: reference.trim(), originalId: orig.id, goodsReceived: true as const, lines, tenders: validTenders(tenders) };
    act.mutate(
      { action: "submit", requestKey: rk.keyFor(input), input },
      { onSuccess: () => { rk.reset(); toast({ title: "Return submitted for approval" }); setQty({}); setTenders([]); setReference(""); setReceived(false); }, onError: (e) => setErr(errorText(e)) },
    );
  };

  return (
    <div className="glass-panel rounded-2xl p-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Original posted sale"><StyledSelect value={originalId} onValueChange={(v) => { setOriginalId(v); setQty({}); setTenders([]); }} options={originals.map((r) => ({ value: String(r.id), label: `#${r.id} · ${r.input.reference} · ${r.snapshot?.customerName || "Walk-in"}` }))} placeholder={originals.length ? "Select sale" : "No returnable sales"} className={fieldCls} /></Field>
        <Field label="Reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} className={fieldCls} data-testid="input-return-reference" /></Field>
      </div>
      {orig?.snapshot && (
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase text-muted-foreground text-left"><tr><th>Part</th><th className="text-right">Sold</th><th className="text-right">Returnable</th><th className="text-right">Unit (excl.)</th><th className="text-right w-24">Return</th></tr></thead>
          <tbody>{orig.snapshot.lines.map((l) => {
            const max = remaining(l.partId);
            return (
              <tr key={l.partId} className="border-t border-white/5"><td className="py-1">{l.sku} — {l.name}</td><td className="text-right">{l.quantity}</td><td className="text-right">{max}</td><td className="text-right">{money.gyd(l.unitPrice)}</td>
                <td className="text-right"><Input type="number" min={0} max={max} disabled={max <= 0} value={qty[l.partId] ?? ""} onChange={(e) => setQty({ ...qty, [l.partId]: Math.max(0, Math.min(max, Number(e.target.value))) })} className={`${fieldCls} text-right`} /></td></tr>
            );
          })}</tbody>
        </table>
      )}
      {orig && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-xl bg-white/[0.04] p-3 text-sm tabular-nums">
          <div><div className="text-[11px] text-muted-foreground">Est. return gross</div>{money.gyd(gross)}</div>
          <div><div className="text-[11px] text-muted-foreground">Open balance credited</div>{money.gyd(Math.min(gross, available))}</div>
          <div><div className="text-[11px] text-muted-foreground">Required refund</div><b>{money.gyd(requiredRefund)}</b></div>
          <div><div className="text-[11px] text-muted-foreground">Received to date</div>{money.gyd(received$)}</div>
        </div>
      )}
      <Field label="Refund tenders" hint={orig ? `Refund tenders should total ${money.gyd(requiredRefund)} (entered ${money.gyd(refund)}). Server validates the exact amount.` : undefined}>
        <TenderRows sources={state.config.sources} tenders={tenders} onChange={setTenders} />
      </Field>
      <label className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm"><Checkbox checked={received} onCheckedChange={(v) => setReceived(v === true)} data-testid="checkbox-goods-received" /> Goods physically received back and in sellable condition.</label>
      <ErrorBox message={err} />
      <div className="flex justify-end"><Button className="rounded-full gap-2" disabled={act.isPending || !state.canEdit} onClick={submit} data-testid="button-submit-return">{act.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Submit return</Button></div>
    </div>
  );
}
