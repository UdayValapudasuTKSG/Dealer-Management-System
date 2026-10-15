import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSalesFinanceDesk,
  useCreateSalesFinanceRequest,
  useDecideSalesFinanceRequest,
  useRetrySalesFinanceRequest,
  useGetSalesAccountingConfig,
  getGetSalesFinanceDeskQueryKey,
  getListSalesFinanceRequestsQueryKey,
  type SalesFinanceDesk,
  type SalesFinanceRequest,
  type SalesFinanceRequestInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Banknote, Check, ChevronDown, FileText, History, Loader2, Plus, ReceiptText, RotateCcw, ShieldAlert, Wrench, X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useMoney, formatGuyanaDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fieldCls } from "./shared";

/** Server error -> message. Never rewrites the server's explanation. */
export function deskError(err: unknown): string {
  const e = err as { message?: string; data?: { error?: string; unmet?: string[] } };
  return e?.data?.unmet?.join(" ") ?? e?.data?.error ?? e?.message ?? "Request failed";
}

/** Window event other surfaces dispatch to open a compose dialog on the desk. */
export const SALES_FINANCE_COMPOSE_EVENT = "aura:sales-finance-compose";

export const STATUS_META: Record<string, { label: string; cls: string; hint: string }> = {
  pending: { label: "Awaiting Finance approval", cls: "bg-amber-500/12 text-amber-400 border-amber-500/30", hint: "No local or ERPNext effect yet." },
  approved: { label: "Approved · queued for ERPNext", cls: "bg-sky-500/12 text-sky-400 border-sky-500/30", hint: "Durable posting job waiting for the ERPNext worker. Paused connections keep it queued." },
  posting: { label: "Posting to ERPNext", cls: "bg-sky-500/12 text-sky-300 border-sky-500/30", hint: "Worker is reconciling deterministic keys and submitting." },
  posted: { label: "Posted to ERPNext", cls: "bg-emerald-500/12 text-emerald-400 border-emerald-500/30", hint: "Confirmed remote success." },
  rejected: { label: "Rejected · no effect", cls: "bg-white/5 text-muted-foreground border-white/15", hint: "Nothing was recorded or posted." },
  failed: { label: "Posting failed · retry available", cls: "bg-red-500/12 text-red-400 border-red-500/30", hint: "Retry reuses the same remote keys, so no duplicates are created." },
  blocked: { label: "Blocked by pending policy", cls: "bg-red-500/10 text-red-300 border-red-500/25", hint: "Cannot be approved in this release." },
};

export function RequestStatusChip({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { label: status, cls: "bg-white/5 text-muted-foreground border-white/10", hint: "" };
  return (
    <span title={m.hint} data-testid={`status-request-${status}`} className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest", m.cls)}>
      {m.label}
    </span>
  );
}

const KIND_META = {
  invoice: { label: "Invoice", icon: FileText },
  payment: { label: "Payment", icon: Banknote },
  expense: { label: "Expense", icon: Wrench },
} as const;
const CATEGORY_LABEL: Record<string, string> = { registration: "Registration", fuel: "Fuel", detailing: "Detailing / PDI" };
const METHOD_LABEL: Record<string, string> = { cash: "Cash", bank_transfer: "Bank transfer", cheque: "Cheque", card: "Card", mobile_money: "Mobile money" };

export function SalesFinanceDeskPanel({ dealId, canEdit, canApprove, meId }: { dealId: number; canEdit: boolean; canApprove: boolean; meId?: number }) {
  const money = useMoney();
  const desk = useGetSalesFinanceDesk(dealId, {
    query: { queryKey: getGetSalesFinanceDeskQueryKey(dealId), refetchInterval: 15_000, refetchOnWindowFocus: true, staleTime: 5_000 },
  });
  const [compose, setCompose] = useState<null | "invoice" | "payment" | "expense">(null);
  const [filter, setFilter] = useState<"all" | "open" | "done">("all");
  useEffect(() => {
    const onCompose = (e: Event) => {
      const d = (e as CustomEvent<{ dealId: number; kind: "invoice" | "payment" | "expense" }>).detail;
      if (d?.dealId === dealId && canEdit) setCompose(d.kind);
    };
    window.addEventListener(SALES_FINANCE_COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(SALES_FINANCE_COMPOSE_EVENT, onCompose);
  }, [dealId, canEdit]);

  if (desk.isLoading) {
    return <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-2xl bg-white/[0.05] animate-pulse" />)}</div>;
  }
  if (desk.isError || !desk.data) {
    return (
      <div className="glass-panel rounded-2xl p-6 text-center space-y-3">
        <p className="text-sm text-red-400">{deskError(desk.error)}</p>
        <Button size="sm" variant="outline" className="rounded-full gap-1.5" onClick={() => desk.refetch()} data-testid="button-desk-retry"><RotateCcw className="h-3.5 w-3.5" /> Retry</Button>
      </div>
    );
  }
  const d = desk.data;
  const t = d.totals;
  const c = (n: number) => money.gyd(n / 100);
  const reqs = d.requests.filter((r) => filter === "all" ? true : filter === "open" ? ["pending", "approved", "posting", "failed"].includes(r.status) : ["posted", "rejected", "blocked"].includes(r.status));

  return (
    <div className="space-y-4" data-testid="sales-finance-desk">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="Invoiced (local records)" value={c(t.invoicedCents)} />
        <Tile label="Paid (recorded receipts)" value={c(t.paidCents)} />
        <Tile label="Outstanding" value={c(t.outstandingCents)} strong />
        <Tile label="Posted expenses" value={c(t.postedExpenseCents)} />
      </div>
      {(t.pendingInvoiceCents + t.pendingPaymentCents + t.pendingExpenseCents) > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-dashed border-amber-500/30 bg-amber-500/[0.04] px-4 py-2.5 text-xs" data-testid="pending-totals">
          <span className="font-semibold uppercase tracking-widest text-[10px] text-amber-400">Not yet in balances</span>
          {t.pendingInvoiceCents > 0 && <span>Invoices awaiting posting <b className="font-mono">{c(t.pendingInvoiceCents)}</b></span>}
          {t.pendingPaymentCents > 0 && <span>Payments awaiting approval <b className="font-mono">{c(t.pendingPaymentCents)}</b></span>}
          {t.pendingExpenseCents > 0 && <span>Expenses awaiting approval <b className="font-mono">{c(t.pendingExpenseCents)}</b></span>}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-full border border-white/10 p-0.5 text-xs">
          {(["all", "open", "done"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} data-testid={`filter-${f}`}
              className={cn("rounded-full px-3 py-1 transition-colors", filter === f ? "bg-primary text-white" : "text-muted-foreground hover:text-foreground")}>
              {f === "all" ? `All ${d.requests.length}` : f === "open" ? "In progress" : "Closed"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(KIND_META) as (keyof typeof KIND_META)[]).map((k) => {
            const Icon = KIND_META[k].icon;
            return (
              <Button key={k} size="sm" variant="outline" disabled={!canEdit || !d.deal.enrolled} onClick={() => setCompose(k)}
                className="h-8 rounded-full gap-1.5 text-xs" data-testid={`button-new-${k}`}>
                <Plus className="h-3 w-3" /><Icon className="h-3.5 w-3.5" /> {KIND_META[k].label}
              </Button>
            );
          })}
        </div>
      </div>
      {!canEdit && <p className="text-[11px] text-muted-foreground">Submitting requests requires finance:edit. Approving requires finance:approve and a different user.</p>}

      {reqs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/15 px-6 py-10 text-center">
          <ReceiptText className="mx-auto mb-2 h-7 w-7 text-primary/60" />
          <p className="text-sm font-medium">No {filter === "all" ? "" : filter === "open" ? "open " : "closed "}finance requests</p>
          <p className="mt-1 text-xs text-muted-foreground">Each invoice, receipt, and registration / fuel / PDI cost is its own request. Finance approves it before anything is recorded or posted.</p>
        </div>
      ) : (
        <ol className="space-y-2.5">
          {reqs.map((r) => <RequestCard key={r.id} r={r} dealId={dealId} canApprove={canApprove} meId={meId} />)}
        </ol>
      )}

      {compose && <ComposeDialog kind={compose} desk={d} dealId={dealId} onClose={() => setCompose(null)} />}
    </div>
  );
}

function Tile({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-2xl border px-4 py-3", strong ? "border-primary/30 bg-primary/[0.06]" : "border-white/10 bg-foreground/[0.03]")}>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-base font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function useInvalidate(dealId: number) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: getGetSalesFinanceDeskQueryKey(dealId) });
    qc.invalidateQueries({ queryKey: getListSalesFinanceRequestsQueryKey() });
    qc.invalidateQueries({ queryKey: ["/api/invoices"] });
    qc.invalidateQueries({ queryKey: ["/api/outstanding-balances"] });
  };
}

function RequestCard({ r, dealId, canApprove, meId }: { r: SalesFinanceRequest; dealId: number; canApprove: boolean; meId?: number }) {
  const money = useMoney();
  const { toast } = useToast();
  const invalidate = useInvalidate(dealId);
  const decide = useDecideSalesFinanceRequest();
  const retry = useRetrySalesFinanceRequest();
  const [open, setOpen] = useState(r.status === "pending" || r.status === "failed");
  const [rejecting, setRejecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const own = meId != null && r.requestedBy === meId;
  const Icon = KIND_META[r.kind]?.icon ?? FileText;
  const c = (n: number) => money.gyd(n / 100);
  const run = (decision: "approve" | "reject") =>
    decide.mutate({ requestId: r.id, data: { decision, ...(decision === "reject" ? { reason } : {}) } }, {
      onSuccess: () => {
        setRejecting(false); setConfirming(false); setReason(""); invalidate();
        toast({ title: decision === "approve" ? `Request #${r.id} approved` : `Request #${r.id} rejected`,
          description: decision === "approve" ? "Posting is queued. Status changes to Posted only after ERPNext confirms." : "No financial effect was recorded." });
      },
      onError: (e) => { setConfirming(false); invalidate(); toast({ title: "Decision refused", description: deskError(e), variant: "destructive" }); },
    });

  const title = r.kind === "expense" ? `${CATEGORY_LABEL[r.category ?? ""] ?? "Expense"} cost` : r.kind === "invoice" ? `Invoice ${r.invoiceNumber ?? `#${r.invoiceId}`}` : `Payment on ${r.invoiceNumber ?? `#${r.invoiceId}`}`;
  const debit = r.lines.reduce((s, l) => s + l.debit, 0);
  const credit = r.lines.reduce((s, l) => s + l.credit, 0);

  return (
    <li className={cn("overflow-hidden rounded-2xl border bg-foreground/[0.02]", r.status === "pending" ? "border-amber-500/25" : r.status === "failed" ? "border-red-500/30" : "border-white/10")} data-testid={`request-${r.id}`}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03]">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">#{r.id}</span>
            <span className="truncate text-sm font-semibold tracking-tight">{title}</span>
            <RequestStatusChip status={r.status} />
            {r.stale && <span className="rounded-full border border-amber-500/30 px-2 py-0.5 text-[10px] uppercase tracking-widest text-amber-400">Mappings changed · resubmit</span>}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {r.date} · requested by {r.requestedByName ?? `user #${r.requestedBy}`}
            {r.sourceLabel && <> · {r.sourceLabel}</>}
            {r.paymentMethod && <> · {METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}</>}
            {r.payerType && <> · payer {r.payerType}</>}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-semibold">{c(r.amountCents)}</div>
          {r.customerChargeCents != null && <div className="text-[10px] text-muted-foreground">charge {c(r.customerChargeCents)}</div>}
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-white/10 px-4 py-3">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs md:grid-cols-4">
            <Fact k="Reference" v={r.reference} mono />
            <Fact k="Evidence" v={r.evidence ?? "None attached"} />
            <Fact k="Funding / receiving source" v={r.sourceLabel ? `${r.sourceLabel} (${r.sourceKind})` : "Not applicable"} />
            <Fact k="Billing" v={r.billingTreatment === "customer_billed" ? `Customer billed: ${c(r.customerChargeCents ?? 0)} via charge invoice` : r.billingTreatment === "dealer_paid" ? "Dealer paid" : "Not applicable"} />
            {r.legacyPaymentId && <Fact k="Reconciles receipt" v={`Existing receipt #${r.legacyPaymentId} (no second receipt)`} />}
            <Fact k="Config revision" v={`r${r.configRevision}`} mono />
            {r.reviewedByName && <Fact k={r.status === "rejected" ? "Rejected by" : "Approved by"} v={`${r.reviewedByName}${r.reviewedAt ? ` · ${formatGuyanaDateTime(r.reviewedAt)}` : ""}`} />}
            {r.erpDocName && <Fact k="ERPNext document" v={`${r.erpDoctype ?? ""} ${r.erpDocName}`} mono />}
            {r.erpRemoteKey && <Fact k="Remote key" v={r.erpRemoteKey} mono />}
          </dl>

          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-xs">
              <thead className="bg-white/[0.03] text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr><th className="px-3 py-2 text-left font-medium">Account</th><th className="px-3 py-2 text-left font-medium">Purpose</th><th className="px-3 py-2 text-right font-medium">Debit</th><th className="px-3 py-2 text-right font-medium">Credit</th></tr>
              </thead>
              <tbody>
                {r.lines.map((l, i) => (
                  <tr key={i} className="border-t border-white/5">
                    <td className="px-3 py-1.5 font-mono">{l.account || <span className="text-red-400">unmapped</span>}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{l.purpose}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{l.debit ? money.gyd(l.debit) : ""}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{l.credit ? money.gyd(l.credit) : ""}</td>
                  </tr>
                ))}
                <tr className="border-t border-white/10 font-semibold"><td className="px-3 py-1.5" colSpan={2}>Totals {Math.round(debit * 100) === Math.round(credit * 100) ? "· balanced" : "· UNBALANCED"}</td><td className="px-3 py-1.5 text-right font-mono">{money.gyd(debit)}</td><td className="px-3 py-1.5 text-right font-mono">{money.gyd(credit)}</td></tr>
              </tbody>
            </table>
          </div>

          {r.blockers.length > 0 && r.status !== "posted" && (
            <ul className="space-y-1 rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3 text-xs text-red-300">
              {r.blockers.map((b) => <li key={b} className="flex gap-2"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{b}</li>)}
            </ul>
          )}
          {r.rejectionReason && <p className="rounded-xl border border-white/10 p-3 text-xs"><b>Rejection reason:</b> {r.rejectionReason}</p>}
          {r.lastError && r.status === "failed" && <p className="rounded-xl border border-red-500/25 bg-red-500/[0.05] p-3 text-xs text-red-300"><b>ERPNext error:</b> {r.lastError}</p>}

          <div className="flex flex-wrap items-center gap-2">
            {canApprove && ["pending", "blocked"].includes(r.status) && !own && (
              <>
                {r.status === "pending" && (
                  <Button size="sm" className="h-8 rounded-full gap-1.5 text-xs" disabled={decide.isPending} onClick={() => setConfirming(true)} data-testid={`button-approve-${r.id}`}>
                    <Check className="h-3.5 w-3.5" /> Approve and post
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8 rounded-full gap-1.5 text-xs" disabled={decide.isPending} onClick={() => setRejecting(true)} data-testid={`button-reject-${r.id}`}>
                  <X className="h-3.5 w-3.5" /> Reject
                </Button>
              </>
            )}
            {canApprove && r.status === "failed" && (
              <Button size="sm" variant="outline" className="h-8 rounded-full gap-1.5 text-xs" disabled={retry.isPending}
                onClick={() => retry.mutate({ requestId: r.id }, {
                  onSuccess: () => { invalidate(); toast({ title: `Posting re-queued for #${r.id}` }); },
                  onError: (e) => toast({ title: "Retry refused", description: deskError(e), variant: "destructive" }),
                })} data-testid={`button-retry-${r.id}`}>
                {retry.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Retry posting
              </Button>
            )}
            {own && ["pending", "blocked"].includes(r.status) && <span className="text-[11px] text-muted-foreground">You submitted this request; a different Finance approver must decide it.</span>}
            {!canApprove && r.status === "pending" && <span className="text-[11px] text-muted-foreground">Awaiting a user with finance:approve.</span>}
          </div>

          {r.audit.length > 0 && (
            <details className="group text-xs">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground hover:text-foreground"><History className="h-3.5 w-3.5" /> Audit trail ({r.audit.length})</summary>
              <ol className="mt-2 space-y-1.5 border-l border-white/10 pl-4">
                {r.audit.map((a) => (
                  <li key={a.id}><span className="font-mono text-[10px] text-muted-foreground">{formatGuyanaDateTime(a.at)}</span> · <b className="font-medium">{a.actorName}</b> · {a.summary}</li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}

      <Dialog open={confirming} onOpenChange={(o) => !decide.isPending && setConfirming(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Approve request #{r.id}?</DialogTitle>
            <DialogDescription>
              The server re-checks mappings, balances and policy, then claims this request and queues one durable ERPNext posting of exactly the lines shown ({money.gyd(debit)} DR / {money.gyd(credit)} CR).
              {r.kind === "payment" && " The receipt is recorded against the invoice through the existing payment guards."}
              {" "}Status shows Posted only after ERPNext confirms.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={decide.isPending}>Cancel</Button>
            <Button onClick={() => run("approve")} disabled={decide.isPending} data-testid={`button-confirm-approve-${r.id}`}>
              {decide.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={rejecting} onOpenChange={(o) => !decide.isPending && setRejecting(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject request #{r.id}</DialogTitle>
            <DialogDescription>Rejection records nothing locally or in ERPNext. The requester sees your reason.</DialogDescription>
          </DialogHeader>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" className="min-h-[90px]" data-testid="input-reject-reason" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(false)} disabled={decide.isPending}>Cancel</Button>
            <Button variant="destructive" onClick={() => run("reject")} disabled={!reason.trim() || decide.isPending} data-testid={`button-confirm-reject-${r.id}`}>
              {decide.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function Fact({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{k}</dt>
      <dd className={cn("truncate", mono && "font-mono")} title={v}>{v}</dd>
    </div>
  );
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function ComposeDialog({ kind, desk, dealId, onClose }: { kind: "invoice" | "payment" | "expense"; desk: SalesFinanceDesk; dealId: number; onClose: () => void }) {
  const { toast } = useToast();
  const money = useMoney();
  const config = useGetSalesAccountingConfig();
  const invalidate = useInvalidate(dealId);
  const create = useCreateSalesFinanceRequest();
  const [f, setF] = useState({
    date: todayIso(), amount: "", invoiceId: "", legacyPaymentId: "", category: "registration", paymentMethod: "bank_transfer",
    sourceId: "", payerType: "customer", reference: "", evidence: "", billingTreatment: "dealer_paid", customerCharge: "",
  });
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const sources = useMemo(() => (config.data?.sources ?? []).filter((s) => kind === "payment" ? ["bank", "cash"].includes(s.kind) : true), [config.data, kind]);
  const invoices = desk.invoices.filter((i) => kind === "invoice" ? !i.erpPosted : true);
  const legacy = desk.payments.filter((p) => String(p.invoiceId) === f.invoiceId);
  const chargeRule = config.data?.customerCharges?.find((r) => r.category === f.category);
  const pickInvoice = (v: string) => {
    const inv = desk.invoices.find((i) => String(i.id) === v);
    setF((p) => ({ ...p, invoiceId: v, legacyPaymentId: "", amount: kind === "invoice" && inv ? (inv.amountCents / 100).toFixed(2) : kind === "payment" && inv ? ((inv.amountCents - inv.paidCents) / 100).toFixed(2) : p.amount }));
  };
  const submit = () => {
    const body: SalesFinanceRequestInput = { kind, date: f.date, amount: f.amount.trim(), reference: f.reference.trim(), ...(f.evidence.trim() ? { evidence: f.evidence.trim() } : {}) };
    if (kind !== "expense" && f.invoiceId) body.invoiceId = Number(f.invoiceId);
    if (kind === "payment") {
      body.paymentMethod = f.paymentMethod as SalesFinanceRequestInput["paymentMethod"];
      body.payerType = f.payerType as SalesFinanceRequestInput["payerType"];
      if (f.sourceId) body.sourceId = f.sourceId;
      if (f.legacyPaymentId) body.legacyPaymentId = Number(f.legacyPaymentId);
    }
    if (kind === "expense") {
      body.category = f.category as SalesFinanceRequestInput["category"];
      body.billingTreatment = f.billingTreatment as SalesFinanceRequestInput["billingTreatment"];
      if (f.sourceId) body.sourceId = f.sourceId;
      if (f.billingTreatment === "customer_billed") body.customerCharge = f.customerCharge.trim();
    }
    create.mutate({ dealId, data: body }, {
      onSuccess: (res) => {
        invalidate();
        const latest = res.requests[0];
        toast({ title: latest?.status === "blocked" ? "Submitted · blocked by pending policy" : "Submitted for Finance approval",
          description: latest?.status === "blocked" ? latest.blockers[0] : "Nothing is recorded or posted until a different Finance approver approves it." });
        onClose();
      },
      onError: (e) => toast({ title: "Request refused", description: deskError(e), variant: "destructive" }),
    });
  };
  const amountOk = /^\d{1,12}(\.\d{1,2})?$/.test(f.amount.trim()) && Number(f.amount) > 0;
  const valid = amountOk && !!f.reference.trim() && !!f.date &&
    (kind === "expense" ? !!f.sourceId && (f.billingTreatment === "dealer_paid" || /^\d{1,12}(\.\d{1,2})?$/.test(f.customerCharge.trim())) : !!f.invoiceId) &&
    (kind !== "payment" || !!f.sourceId);

  return (
    <Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New {KIND_META[kind].label.toLowerCase()} request · deal #{dealId}</DialogTitle>
          <DialogDescription>
            {kind === "invoice" && "Requests posting of a prepared AURA invoice. Reservation/deposit invoices stay blocked while advance VAT is pending."}
            {kind === "payment" && "Submitting does not mark the invoice paid. After approval, the receipt is recorded once through the existing guards and posted as a Payment Entry."}
            {kind === "expense" && "An independent registration, fuel or PDI cost. Customer billing creates a separate charge invoice only after approval."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {kind !== "expense" && (
            <Field label="Invoice" full>
              <select className={fieldCls} value={f.invoiceId} onChange={(e) => pickInvoice(e.target.value)} data-testid="select-invoice">
                <option value="">Select invoice</option>
                {invoices.map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber} · {i.kind} · {money.gyd(i.amountCents / 100)} · paid {money.gyd(i.paidCents / 100)}{i.erpPosted ? " · in ERPNext" : ""}</option>)}
              </select>
              {invoices.length === 0 && <p className="mt-1 text-[11px] text-muted-foreground">No eligible invoices on this deal. Prepare the final invoice through the existing deal flow first.</p>}
            </Field>
          )}
          {kind === "expense" && (
            <Field label="Category">
              <select className={fieldCls} value={f.category} onChange={(e) => set("category")(e.target.value)} data-testid="select-category">
                {Object.entries(CATEGORY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
          )}
          <Field label="Date"><input type="date" className={fieldCls} value={f.date} onChange={(e) => set("date")(e.target.value)} data-testid="input-date" /></Field>
          <Field label={kind === "expense" ? "Cost amount (GYD)" : "Amount (GYD)"}>
            <input inputMode="decimal" className={cn(fieldCls, "font-mono")} value={f.amount} onChange={(e) => set("amount")(e.target.value)} placeholder="0.00" readOnly={kind === "invoice"} data-testid="input-amount" />
          </Field>
          {kind === "payment" && (
            <>
              <Field label="Payer">
                <select className={fieldCls} value={f.payerType} onChange={(e) => set("payerType")(e.target.value)} data-testid="select-payer">
                  <option value="customer">Customer</option>
                  <option value="financier">Financier (blocked: transfer policy pending)</option>
                </select>
              </Field>
              <Field label="Method">
                <select className={fieldCls} value={f.paymentMethod} onChange={(e) => set("paymentMethod")(e.target.value)} data-testid="select-method">
                  {Object.entries(METHOD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
            </>
          )}
          {kind !== "invoice" && (
            <Field label={kind === "payment" ? "Receiving source" : "Funding source"} full={kind === "expense"}>
              <select className={fieldCls} value={f.sourceId} onChange={(e) => set("sourceId")(e.target.value)} data-testid="select-source">
                <option value="">Select configured source</option>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.label} · {s.kind}{s.kind === "supplier" ? " (blocked: no supplier party)" : ""}</option>)}
              </select>
              {config.isSuccess && sources.length === 0 && <p className="mt-1 text-[11px] text-amber-400">No configured sources. Finance must add them in mappings.</p>}
            </Field>
          )}
          {kind === "payment" && legacy.length > 0 && (
            <Field label="Reconcile an existing receipt (optional)" full>
              <select className={fieldCls} value={f.legacyPaymentId} onChange={(e) => {
                const p = legacy.find((x) => String(x.id) === e.target.value);
                setF((s) => ({ ...s, legacyPaymentId: e.target.value, amount: p ? (p.amountCents / 100).toFixed(2) : s.amount }));
              }} data-testid="select-legacy-payment">
                <option value="">New receipt</option>
                {legacy.map((p) => <option key={p.id} value={p.id}>Receipt #{p.id} · {money.gyd(p.amountCents / 100)} · {p.reference || p.method}</option>)}
              </select>
            </Field>
          )}
          {kind === "expense" && (
            <>
              <Field label="Who bears it">
                <select className={fieldCls} value={f.billingTreatment} onChange={(e) => set("billingTreatment")(e.target.value)} data-testid="select-billing">
                  <option value="dealer_paid">Dealer paid</option>
                  <option value="customer_billed">Bill the customer separately</option>
                </select>
              </Field>
              {f.billingTreatment === "customer_billed" ? (
                <Field label="Customer charge (GYD)">
                  <input inputMode="decimal" className={cn(fieldCls, "font-mono")} value={f.customerCharge} onChange={(e) => set("customerCharge")(e.target.value)} placeholder="0.00" data-testid="input-charge" />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {chargeRule?.approved ? `${chargeRule.taxTreatment}${chargeRule.taxTreatment === "taxable" ? ` ${chargeRule.vatRate}% ${chargeRule.amountIncludesVat ? "incl." : "excl."}` : ""} · ${chargeRule.incomeAccount}` : "No approved charge mapping for this category: approval will be refused."}
                  </p>
                </Field>
              ) : <div />}
            </>
          )}
          <Field label="Reference" full><input className={fieldCls} value={f.reference} onChange={(e) => set("reference")(e.target.value)} placeholder="Receipt no., bank ref, supplier invoice" data-testid="input-reference" /></Field>
          <Field label="Evidence" full><input className={fieldCls} value={f.evidence} onChange={(e) => set("evidence")(e.target.value)} placeholder="Document link or description of the attached evidence" data-testid="input-evidence" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || create.isPending} data-testid="button-submit-request">
            {create.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label className={cn("block", full && "col-span-2")}>
      <span className="mb-1 block text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
