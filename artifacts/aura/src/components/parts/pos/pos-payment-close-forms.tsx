import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { useToast } from "@/hooks/use-toast";
import { useMoney } from "@/lib/format";
import { errorText, today, usePosAction, useRequestKey, type PosState, type Tender } from "./pos-api";
import { ErrorBox, Field, TenderRows, fieldCls, tenderTotal, validTenders } from "./pos-shared";

export function PosPaymentForm({ state }: { state: PosState }) {
  const money = useMoney();
  const { toast } = useToast();
  const act = usePosAction();
  const rk = useRequestKey();
  const [originalId, setOriginalId] = useState("");
  const [reference, setReference] = useState("");
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const open = state.requests.filter((r) => r.kind === "sale" && r.status === "posted" && (r.availableBalance ?? 0) > 0.005);
  const orig = open.find((r) => String(r.id) === originalId);

  const submit = () => {
    setErr(null);
    const t = validTenders(tenders);
    if (!orig || !reference.trim() || !t.length) return setErr("Select an open account sale, reference and at least one tender.");
    if (tenderTotal(t) > (orig.availableBalance ?? 0) + 0.005) return setErr("Payment exceeds the outstanding balance.");
    const input = { kind: "payment" as const, originalId: orig.id, reference: reference.trim(), tenders: t };
    act.mutate({ action: "submit", requestKey: rk.keyFor(input), input },
      { onSuccess: () => { rk.reset(); toast({ title: "Payment submitted" }); setTenders([]); setReference(""); }, onError: (e) => setErr(errorText(e)) });
  };
  return (
    <div className="glass-panel rounded-2xl p-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Account sale"><StyledSelect value={originalId} onValueChange={setOriginalId} options={open.map((r) => ({ value: String(r.id), label: `#${r.id} · ${r.snapshot?.customerName} · available ${money.gyd(r.availableBalance ?? 0)}` }))} placeholder={open.length ? "Select" : "No open balances"} className={fieldCls} /></Field>
        <Field label="Reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} className={fieldCls} data-testid="input-payment-reference" /></Field>
      </div>
      <Field label="Tenders"><TenderRows sources={state.config.sources} tenders={tenders} onChange={setTenders} /></Field>
      <ErrorBox message={err} />
      <div className="flex justify-end"><Button className="rounded-full gap-2" disabled={act.isPending || !state.canEdit} onClick={submit} data-testid="button-submit-payment">{act.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Submit payment</Button></div>
    </div>
  );
}

export function PosShiftCloseForm({ state }: { state: PosState }) {
  const { toast } = useToast();
  const act = usePosAction();
  const rk = useRequestKey();
  const cash = state.config.sources.filter((s) => s.kind === "cash");
  const [f, setF] = useState({ reference: "", sourceId: "", destinationSourceId: "", businessDate: today(), openingFloat: 0, countedCash: 0, transferAmount: 0 });
  const [err, setErr] = useState<string | null>(null);
  const up = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const dup = state.requests.some((r) => r.kind === "shift_close" && r.status !== "rejected" && r.input.kind === "shift_close" && r.input.sourceId === f.sourceId && r.input.businessDate === f.businessDate);
  const amountError = [f.openingFloat, f.countedCash, f.transferAmount].some(n => !Number.isFinite(n) || n < 0)
    ? "Opening float, counted cash and transfer must be zero or greater."
    : f.transferAmount > f.countedCash ? "Transfer cannot exceed counted cash." : null;

  const submit = () => {
    setErr(null);
    if (amountError) return setErr(amountError);
    if (!f.reference.trim() || !f.sourceId || (f.transferAmount > 0 && !f.destinationSourceId)) return setErr("Reference and cash drawer are required; select a destination when transferring cash.");
    if (f.transferAmount > 0 && f.sourceId === f.destinationSourceId) return setErr("Destination must differ from the drawer.");
    if (dup) return setErr("This drawer already has a close for that business date.");
    const input = { kind: "shift_close" as const, ...f, reference: f.reference.trim() };
    act.mutate({ action: "submit", requestKey: rk.keyFor(input), input },
      { onSuccess: () => { rk.reset(); toast({ title: "Shift close submitted" }); up({ reference: "" }); }, onError: (e) => setErr(errorText(e)) });
  };
  const num = (k: "openingFloat" | "countedCash" | "transferAmount") => <Input type="number" step="0.01" min={0} value={f[k]} onChange={(e) => up({ [k]: Number(e.target.value) })} className={`${fieldCls} text-right`} data-testid={`input-close-${k}`} />;
  return (
    <div className="glass-panel rounded-2xl p-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Reference"><Input value={f.reference} onChange={(e) => up({ reference: e.target.value })} className={fieldCls} /></Field>
        <Field label="Cash drawer"><StyledSelect value={f.sourceId} onValueChange={(v) => up({ sourceId: v })} options={cash.map((s) => ({ value: s.id, label: s.label }))} placeholder="Select" className={fieldCls} /></Field>
        <Field label="Transfer to"><StyledSelect value={f.destinationSourceId} onValueChange={(v) => up({ destinationSourceId: v })} options={state.config.sources.filter((s) => s.id !== f.sourceId).map((s) => ({ value: s.id, label: s.label }))} placeholder="Select" className={fieldCls} /></Field>
        <Field label="Business date"><Input type="date" value={f.businessDate} onChange={(e) => up({ businessDate: e.target.value })} className={fieldCls} /></Field>
        <Field label="Opening float">{num("openingFloat")}</Field>
        <Field label="Counted cash">{num("countedCash")}</Field>
        <Field label="Transfer amount" hint="Banked separately from any variance">{num("transferAmount")}</Field>
      </div>
      <p className="text-[11px] text-muted-foreground">Expected cash and over/short variance are computed by the server from posted cash movements. One close per drawer per day.</p>
      <ErrorBox message={amountError ?? err ?? (dup ? "A close already exists for this drawer and date." : null)} />
      <div className="flex justify-end"><Button className="rounded-full gap-2" disabled={act.isPending || !state.canEdit || dup || !!amountError} onClick={submit} data-testid="button-submit-close">{act.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Submit close</Button></div>
    </div>
  );
}
