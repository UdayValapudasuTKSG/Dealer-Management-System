import { useState, type FormEvent } from "react";
import { AlertTriangle, Check, CheckCircle2, FileSpreadsheet, Loader2, X } from "lucide-react";
import { useListPurchaseOrders, type PurchaseOrder } from "@workspace/api-client-react";
import { useMoney } from "@/lib/format";
import { useAuthz } from "@/lib/auth";
import { useGetReconciliationQueue, useResolveReconciliation, useSubmitReconciliation } from "@/hooks/use-parts-operations";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type QueueStatus = "flagged" | "matched" | "resolved";
type ReconciliationItem = {
  id: number; purchaseOrderId: number; purchaseOrderLineId: number; invoiceNumber: string;
  invoiceQuantity: number | null; invoiceUnitCost: number | null; receivedQuantity: number;
  orderedQuantity?: number; orderedUnitCost?: number; tolerancePercent: number;
  status: string; flags?: { quantityMismatch?: boolean; priceMismatch?: boolean; priceVariancePercent?: number; partiallyReceived?: boolean } | null;
};

function errorText(error: unknown) { return error instanceof Error ? error.message : "The request could not be completed."; }

export function ReconciliationTab() {
  const [status, setStatus] = useState<QueueStatus | "all">("flagged");
  const { can } = useAuthz();
  const canEdit = can("parts", "edit");
  const canApprove = can("parts", "approve");
  const queue = useGetReconciliationQueue(status === "all" ? undefined : status);

  if (queue.isLoading) return <div className="h-64 rounded-3xl bg-white/[0.05] animate-pulse" />;
  if (queue.error) return <div className="rounded-2xl border border-destructive/30 p-6 text-destructive" role="alert">Unable to load reconciliation records: {errorText(queue.error)}</div>;
  const items = (queue.data ?? []) as ReconciliationItem[];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="text-lg font-bold tracking-tight">Invoice Reconciliation</h2><p className="mt-1 text-sm text-muted-foreground">Match vendor invoices to purchase order receipts.</p></div>
        {canEdit && <SubmitInvoiceDialog />}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="reconciliation-status">Show</Label>
        <Select value={status} onValueChange={(value) => setStatus(value as QueueStatus | "all")}>
          <SelectTrigger id="reconciliation-status" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="flagged">Flagged</SelectItem><SelectItem value="matched">Matched</SelectItem><SelectItem value="resolved">Resolved</SelectItem><SelectItem value="all">All records</SelectItem></SelectContent>
        </Select>
      </div>
      {!items.length ? <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20"><CheckCircle2 className="h-8 w-8 text-muted-foreground" /><p className="text-muted-foreground">{status === "flagged" ? "No flagged discrepancies." : "No reconciliation records found."}</p></div> :
        <div className="space-y-4">{items.map((item) => <ReconciliationCard key={item.id} item={item} canApprove={canApprove} />)}</div>}
    </div>
  );
}

function SubmitInvoiceDialog() {
  const [open, setOpen] = useState(false);
  const [poId, setPoId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [tolerance, setTolerance] = useState("");
  const [selected, setSelected] = useState<Record<number, { quantity: string; unitCost: string }>>({});
  const { data: orders, isLoading, error } = useListPurchaseOrders();
  const submit = useSubmitReconciliation();
  const { toast } = useToast();
  const order = (orders ?? []).find((candidate) => String(candidate.id) === poId) as PurchaseOrder | undefined;
  const lines = order?.lines ?? [];
  const setLine = (id: number, field: "quantity" | "unitCost", value: string) =>
    setSelected((current) => ({ ...current, [id]: { quantity: current[id]?.quantity ?? "", unitCost: current[id]?.unitCost ?? "", [field]: value } }));
  const reset = () => { setPoId(""); setInvoiceNumber(""); setTolerance(""); setSelected({}); };
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const invoiceLines = lines.filter((line) => selected[line.id]).map((line) => ({ purchaseOrderLineId: line.id, quantity: Number(selected[line.id].quantity), unitCost: Number(selected[line.id].unitCost) }));
    if (!poId || !invoiceNumber.trim() || !invoiceLines.length || invoiceLines.some((line) => !Number.isFinite(line.quantity) || line.quantity < 0 || !Number.isFinite(line.unitCost) || line.unitCost < 0)) {
      toast({ title: "Complete invoice details", description: "Choose a purchase order, invoice number, and at least one valid line.", variant: "destructive" }); return;
    }
    try {
      await submit.mutateAsync({ purchaseOrderId: Number(poId), invoiceNumber: invoiceNumber.trim(), ...(tolerance === "" ? {} : { tolerancePercent: Number(tolerance) }), lines: invoiceLines });
      toast({ title: "Invoice submitted", description: "The invoice was compared with received quantities and PO costs." }); reset(); setOpen(false);
    } catch (error) { toast({ title: "Invoice submission failed", description: errorText(error), variant: "destructive" }); }
  };
  return <><Button type="button" onClick={() => setOpen(true)} className="gap-2 rounded-full"><FileSpreadsheet className="h-4 w-4" /> Enter Invoice</Button>
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); setOpen(next); }}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-3xl"><DialogHeader><DialogTitle>Enter vendor invoice</DialogTitle><DialogDescription>Select the exact PO lines on this invoice and enter billed quantities and unit costs.</DialogDescription></DialogHeader>
        {error && <p className="text-sm text-destructive" role="alert">Unable to load purchase orders: {errorText(error)}</p>}
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3"><div className="space-y-1 sm:col-span-2"><Label htmlFor="recon-po">Purchase order</Label><Select value={poId} onValueChange={(value) => { setPoId(value); setSelected({}); }} disabled={isLoading}><SelectTrigger id="recon-po"><SelectValue placeholder={isLoading ? "Loading purchase orders…" : "Select a purchase order"} /></SelectTrigger><SelectContent>{(orders ?? []).map((po) => <SelectItem key={po.id} value={String(po.id)}>PO #{po.id}{po.reference ? ` · ${po.reference}` : ""} · {po.lines.length} lines</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1"><Label htmlFor="recon-invoice">Invoice number</Label><Input id="recon-invoice" value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} /></div>
          </div>
          <div className="space-y-1"><Label htmlFor="recon-tolerance">Tolerance % (optional)</Label><Input id="recon-tolerance" type="number" min="0" max="100" step="0.01" value={tolerance} onChange={(event) => setTolerance(event.target.value)} placeholder="Use policy default" /></div>
          {poId && !lines.length && <p className="text-sm text-muted-foreground">This purchase order has no lines available for invoicing.</p>}
          {lines.length > 0 && <div className="space-y-2"><p className="text-sm font-medium">Invoice lines</p><div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-[650px] text-sm"><thead><tr className="border-b text-left text-muted-foreground"><th className="p-2">Include</th><th className="p-2">Part</th><th className="p-2">Ordered / received</th><th className="p-2">Invoice qty</th><th className="p-2">Invoice unit cost</th></tr></thead><tbody>{lines.map((line) => { const checked = !!selected[line.id]; return <tr key={line.id} className="border-b last:border-0"><td className="p-2"><Checkbox checked={checked} onCheckedChange={(value) => setSelected((current) => { if (value) return { ...current, [line.id]: { quantity: String(line.qtyReceived), unitCost: String(line.unitCost) } }; const next = { ...current }; delete next[line.id]; return next; })} aria-label={`Include ${line.partName}`} /></td><td className="p-2">{line.partName}<div className="text-xs text-muted-foreground">Line #{line.id}</div></td><td className="p-2">{line.quantity} / {line.qtyReceived}<div className="text-xs text-muted-foreground">{line.unitCost.toFixed(2)} ordered cost</div></td><td className="p-2"><Input type="number" min="0" step="0.001" disabled={!checked} value={selected[line.id]?.quantity ?? ""} onChange={(event) => setLine(line.id, "quantity", event.target.value)} aria-label={`${line.partName} invoice quantity`} /></td><td className="p-2"><Input type="number" min="0" step="0.01" disabled={!checked} value={selected[line.id]?.unitCost ?? ""} onChange={(event) => setLine(line.id, "unitCost", event.target.value)} aria-label={`${line.partName} invoice unit cost`} /></td></tr>; })}</tbody></table></div></div>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={submit.isPending || isLoading}>{submit.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Run match</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog></>;
}

function ReconciliationCard({ item, canApprove }: { item: ReconciliationItem; canApprove: boolean }) {
  const money = useMoney(); const resolve = useResolveReconciliation(); const { toast } = useToast();
  const [dialog, setDialog] = useState<"accept" | "dispute" | "adjust" | null>(null); const [reason, setReason] = useState(""); const [quantity, setQuantity] = useState(String(item.invoiceQuantity ?? "")); const [unitCost, setUnitCost] = useState(String(item.invoiceUnitCost ?? ""));
  const flagged = !!item.flags?.quantityMismatch || !!item.flags?.priceMismatch;
  const submit = async () => {
    if (!reason.trim()) return;
    try { await resolve.mutateAsync({ id: item.id, data: { action: dialog, reason: reason.trim(), ...(dialog === "adjust" ? { quantity: Number(quantity), unitCost: Number(unitCost) } : {}) } }); toast({ title: `Reconciliation ${dialog}` }); setDialog(null); setReason(""); }
    catch (error) { toast({ title: "Resolution failed", description: errorText(error), variant: "destructive" }); }
  };
  return <Card className={cn("overflow-hidden rounded-2xl border", flagged ? "border-amber-500/20" : "border-border")}><CardContent className="p-0"><div className="grid gap-0 md:grid-cols-12"><div className="space-y-4 p-5 md:col-span-8"><div className="flex justify-between gap-3"><div><Badge variant="outline">PO #{item.purchaseOrderId} · Invoice {item.invoiceNumber}</Badge><div className="mt-2 font-semibold">PO line #{item.purchaseOrderLineId}</div><div className="text-xs text-muted-foreground">Record #{item.id}</div></div><Badge variant={flagged ? "destructive" : "secondary"}>{item.status}</Badge></div><div className="grid grid-cols-2 gap-4 rounded-xl bg-black/10 p-4"><div><div className="text-xs uppercase text-muted-foreground">PO / received</div><p className="mt-1">{item.orderedQuantity ?? "—"} / {item.receivedQuantity}</p><p className="text-sm text-muted-foreground">{item.orderedUnitCost == null ? "—" : money.gyd(item.orderedUnitCost)} ordered cost</p></div><div><div className="text-xs uppercase text-muted-foreground">Invoice</div><p className={cn("mt-1", item.flags?.quantityMismatch && "font-bold text-destructive")}>{item.invoiceQuantity ?? "—"}</p><p className={cn("text-sm", item.flags?.priceMismatch && "font-bold text-destructive")}>{item.invoiceUnitCost == null ? "—" : money.gyd(item.invoiceUnitCost)}</p></div></div><div className="flex flex-wrap gap-2 text-xs text-muted-foreground">{item.flags?.quantityMismatch && <Badge variant="outline">Quantity variance</Badge>}{item.flags?.priceMismatch && <Badge variant="outline">Price variance</Badge>}{item.flags?.partiallyReceived && <Badge variant="outline">Partially received</Badge>}{item.flags?.priceVariancePercent != null && <span>Price variance {item.flags.priceVariancePercent.toFixed(2)}%</span>}</div></div><div className="flex flex-col justify-center gap-2 border-t bg-black/[0.02] p-5 md:col-span-4 md:border-l md:border-t-0">{canApprove && item.status !== "resolved" && <><Button variant="outline" onClick={() => setDialog("accept")} disabled={resolve.isPending}><Check className="h-4 w-4" /> Accept</Button><Button variant="outline" onClick={() => setDialog("dispute")} disabled={resolve.isPending}><X className="h-4 w-4" /> Dispute</Button><Button variant="outline" onClick={() => setDialog("adjust")} disabled={resolve.isPending}><AlertTriangle className="h-4 w-4" /> Adjust ledger</Button></>}</div></div></CardContent>
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}><DialogContent><DialogHeader><DialogTitle>{dialog === "adjust" ? "Adjust invoice ledger" : dialog === "accept" ? "Accept invoice variance" : "Dispute invoice variance"}</DialogTitle><DialogDescription>Provide an explicit reason for this audit action.</DialogDescription></DialogHeader>{dialog === "adjust" && <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor={`adjust-qty-${item.id}`}>Adjusted quantity</Label><Input id={`adjust-qty-${item.id}`} type="number" min="0" step="0.001" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></div><div><Label htmlFor={`adjust-cost-${item.id}`}>Adjusted unit cost</Label><Input id={`adjust-cost-${item.id}`} type="number" min="0" step="0.01" value={unitCost} onChange={(event) => setUnitCost(event.target.value)} /></div></div>}<div><Label htmlFor={`reason-${item.id}`}>Reason</Label><Input id={`reason-${item.id}`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain the decision" /></div><DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button onClick={submit} disabled={!reason.trim() || resolve.isPending}>Confirm</Button></DialogFooter></DialogContent></Dialog>
  </Card>;
}