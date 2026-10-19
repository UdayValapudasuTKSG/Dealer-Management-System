import { useState } from "react";
import { Check, Printer, RotateCw, X, Landmark, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { formatGuyanaDate, useMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { STATUS_TONE, errorText, usePosAction, type PosRequest, type PosState } from "./pos-api";
import { printReceipt } from "./pos-receipt";
import { GlTable } from "./pos-gl-table";

function Row({ r, state }: { r: PosRequest; state: PosState }) {
  const money = useMoney();
  const { toast } = useToast();
  const { activeDealer } = useAuthz();
  const act = usePosAction();
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const own = r.createdBy === state.userId;
  const canDecide = state.canApprove && !own && r.status === "pending";
  const go = (action: "approve" | "reject" | "retry" | "reconcile") => {
    setErr(null);
    if ((action === "reject" || action === "reconcile") && !note.trim()) return setErr(action === "reconcile" ? "Enter the bank statement reference." : "Enter a rejection reason.");
    act.mutate({ action, requestId: r.id, note: note.trim() }, { onSuccess: () => { toast({ title: `Request ${action}d` }); setNote(""); }, onError: (e) => setErr(errorText(e)) });
  };
  const needsNote = canDecide || (r.status === "failed" && state.canApprove) || (r.status === "posted" && state.canApprove && !r.reconciliationReference);
  return (
    <div className="border-b border-white/5 px-4 py-3 space-y-2" data-testid={`row-pos-${r.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono text-xs text-muted-foreground">#{r.id}</span>
        <span className="capitalize font-medium">{r.kind.replace("_", " ")}</span>
        <span className="text-muted-foreground">{r.input.reference}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest", STATUS_TONE[r.status] ?? "bg-white/10")}>{r.status}</span>
        {r.snapshot?.customerName && <span className="text-xs text-muted-foreground">{r.snapshot.customerName}</span>}
        <div className="flex-1" />
        {r.snapshot && <span className="tabular-nums font-semibold">{money.gyd(r.snapshot.total)}</span>}
        <span className="text-xs text-muted-foreground">{formatGuyanaDate(r.createdAt)}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
        {r.snapshot && r.kind !== "shift_close" && <span>{r.snapshot.lines.length} lines · VAT {money.gyd(r.snapshot.tax)} · paid {money.gyd(r.snapshot.paid)} · balance {money.gyd(r.snapshot.balance)}</span>}
        {r.snapshot?.expectedCash !== undefined && <span>Expected {money.gyd(r.snapshot.expectedCash)} · variance {money.gyd(r.snapshot.variance ?? 0)}</span>}
        {r.erpDocuments.map((d) => <span key={d.name} className="font-mono">{d.doctype} {d.name}</span>)}
        {r.reconciliationReference && <span>Reconciled: {r.reconciliationReference}</span>}
        {r.decisionNote && <span>Note: {r.decisionNote}</span>}
        {own && r.status === "pending" && <span className="text-amber-600">Awaiting a different Finance approver</span>}
      </div>
      {r.snapshot?.glLines?.length ? <GlTable lines={r.snapshot.glLines} /> : null}
      {r.error && <p role="alert" className="text-xs text-destructive">{r.error}</p>}
      {err && <p role="alert" className="text-xs text-destructive">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {needsNote && <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={r.status === "posted" ? "Bank statement reference" : "Note"} className="h-8 max-w-xs rounded-xl text-xs" data-testid={`input-note-${r.id}`} />}
        {canDecide && <Button size="sm" className="h-8 rounded-full gap-1" disabled={act.isPending} onClick={() => go("approve")} data-testid={`button-approve-${r.id}`}><Check className="h-3.5 w-3.5" />Approve</Button>}
        {canDecide && <Button size="sm" variant="outline" className="h-8 rounded-full gap-1 border-white/10" disabled={act.isPending} onClick={() => go("reject")} data-testid={`button-reject-${r.id}`}><X className="h-3.5 w-3.5" />Reject</Button>}
        {r.status === "failed" && state.canApprove && <Button size="sm" variant="outline" className="h-8 rounded-full gap-1 border-white/10" disabled={act.isPending} onClick={() => go("retry")}><RotateCw className="h-3.5 w-3.5" />Retry</Button>}
        {r.status === "posted" && state.canApprove && !r.reconciliationReference && <Button size="sm" variant="outline" className="h-8 rounded-full gap-1 border-white/10" disabled={act.isPending} onClick={() => go("reconcile")} title="Records bank statement match only — no GL entry"><Landmark className="h-3.5 w-3.5" />Reconcile</Button>}
        {r.kind !== "shift_close" && <Button size="sm" variant="ghost" className="h-8 rounded-full gap-1" onClick={() => { if (!printReceipt(r, state, activeDealer?.dealerName ?? "AURA")) toast({ title: "Popup blocked", description: "Allow popups to print receipts.", variant: "destructive" }); }} data-testid={`button-print-${r.id}`}><Printer className="h-3.5 w-3.5" />Receipt</Button>}
      </div>
    </div>
  );
}

export function PosRequestsList({ state }: { state: PosState }) {
  const [filter, setFilter] = useState("all");
  const list = state.requests.filter((r) => filter === "all" || r.status === filter);
  const filters = ["all", "pending", "failed", "posted", "rejected"];
  return (
    <div className="glass-panel rounded-2xl overflow-hidden">
      <div className="flex flex-wrap gap-1 border-b border-white/10 p-2">
        {filters.map((f) => <button key={f} onClick={() => setFilter(f)} className={cn("rounded-full px-3 py-1 text-xs capitalize", filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-white/[0.05]")}>{f}{f !== "all" && ` (${state.requests.filter((r) => r.status === f).length})`}</button>)}
      </div>
      {!list.length ? (
        <div className="py-12 flex flex-col items-center gap-2 text-muted-foreground"><Receipt className="h-7 w-7" /><p className="text-sm">No counter requests here yet.</p></div>
      ) : list.map((r) => <Row key={r.id} r={r} state={state} />)}
    </div>
  );
}
