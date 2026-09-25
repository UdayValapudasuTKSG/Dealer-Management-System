import React, { useState, useMemo } from "react";
import { useListPagination } from "./list-pagination";
import { CustomerInvoiceAction } from "./customer-invoice-action";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPartRequisitions,
  useGetPartRequisition,
  useDecidePartRequisition,
  useFulfillPartRequisition,
  useConvertPartRequisitionToPurchaseOrders,
  useCancelPartRequisition,
  useListParts,
  useListSuppliers,
  useCreateInventoryPartRequisition,
  getListPartRequisitionsQueryKey,
  getGetPartRequisitionQueryKey,
  getListPurchaseOrdersQueryKey,
  type PartRequisition,
  type PartRequisitionDetail,
  type PartRequisitionStatus,
  type PartRequisitionUrgency,
} from "@workspace/api-client-react";
import { formatGuyanaDate, useMoney } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/create-record-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Search, Loader2, FileText, CheckCircle, XCircle, ShoppingCart, Truck, Ban, Link as LinkIcon, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";

const URGENCY_LABELS: Record<string, string> = {
  routine: "Routine",
  urgent: "Urgent",
  vehicle_down: "Vehicle Down (VOR)",
};

const STATUS_LABELS: Record<string, string> = {
  submitted: "Pending Approval",
  approved: "Approved",
  partially_ordered: "Partially Ordered",
  rejected: "Rejected",
  ordered: "Ordered",
  partially_fulfilled: "Partially Fulfilled",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
};

const getBadgeClass = (status: string) => {
  switch (status) {
    case "submitted": return "bg-amber-500/20 text-amber-300";
    case "approved": return "bg-emerald-500/20 text-emerald-300";
    case "partially_ordered": return "bg-blue-500/20 text-blue-300";
    case "ordered": return "bg-indigo-500/20 text-indigo-300";
    case "partially_fulfilled": return "bg-teal-500/20 text-teal-300";
    case "fulfilled": return "bg-green-500/20 text-green-300";
    case "rejected":
    case "cancelled": return "bg-red-500/20 text-red-400";
    default: return "bg-white/[0.05] text-foreground";
  }
};

export function RequisitionsWorkspace() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [urgencyFilter, setUrgencyFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data, isLoading } = useListPartRequisitions({
    status: statusFilter !== "all" ? (statusFilter as PartRequisitionStatus) : undefined,
    urgency: urgencyFilter !== "all" ? (urgencyFilter as PartRequisitionUrgency) : undefined,
  });

  const filtered = (data || []).filter((req) => {
    if (!search) return true;
    const lower = search.toLowerCase();
    return (
      req.id.toString().includes(lower) ||
      (req.requesterName || "").toLowerCase().includes(lower) ||
      req.serviceOrderId?.toString().includes(lower) ||
      req.jobCardId?.toString().includes(lower) ||
      (req.jobCardId == null && "inventory restock".includes(lower))
    );
  });
  const paging = useListPagination(filtered, `${statusFilter}:${urgencyFilter}:${search}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search req ID, requester, or job..."
            className="pl-9 rounded-full bg-white/[0.03] border-white/10"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-48 rounded-full border-white/10 bg-white/[0.03]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="submitted">Pending Approval</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="partially_ordered">Partially Ordered</SelectItem>
            <SelectItem value="ordered">Ordered</SelectItem>
            <SelectItem value="partially_fulfilled">Partially Fulfilled</SelectItem>
            <SelectItem value="fulfilled">Fulfilled</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Select value={urgencyFilter} onValueChange={setUrgencyFilter}>
          <SelectTrigger className="w-full sm:w-48 rounded-full border-white/10 bg-white/[0.03]">
            <SelectValue placeholder="All priorities" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            <SelectItem value="routine">Routine</SelectItem>
            <SelectItem value="urgent">Urgent</SelectItem>
            <SelectItem value="vehicle_down">Vehicle Down (VOR)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {paging.controls}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-[104px] rounded-2xl bg-white/[0.03] border border-white/5 animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-16 bg-white/[0.02] rounded-3xl border border-white/5 border-dashed">
          <FileText className="w-12 h-12 text-muted-foreground mb-4 opacity-50 stroke-[1]" />
          <h3 className="text-lg font-medium">No requisitions found</h3>
          <p className="text-sm text-muted-foreground mt-1 text-center max-w-md">Try adjusting your filters or search terms.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {paging.items.map(req => (
            <RequisitionCard key={req.id} req={req} />
          ))}
        </div>
      )}
    </div>
  );
}

export function CreateInventoryRequisitionButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2"
      >
        <Plus className="w-5 h-5" />
        New Restock Requisition
      </Button>
      <CreateInventoryRequisitionDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function CreateInventoryRequisitionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const create = useCreateInventoryPartRequisition();
  const { data: parts } = useListParts();
  const [urgency, setUrgency] = useState<PartRequisitionUrgency>("routine");
  const [needBy, setNeedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Array<{ partId: string; quantity: number }>>([
    { partId: "", quantity: 1 },
  ]);

  const reset = () => {
    setUrgency("routine");
    setNeedBy("");
    setNotes("");
    setLines([{ partId: "", quantity: 1 }]);
  };

  const submit = async () => {
    const validLines = lines
      .filter((line) => line.partId && line.quantity > 0)
      .map((line) => ({ partId: Number(line.partId), quantity: line.quantity }));
    if (validLines.length === 0 || validLines.length !== lines.length) {
      toast({
        title: "Complete every requested part",
        description: "Select a part and enter a quantity of at least one for each line.",
        variant: "destructive",
      });
      return;
    }
    if (new Set(validLines.map((line) => line.partId)).size !== validLines.length) {
      toast({
        title: "Duplicate part selected",
        description: "Combine duplicate parts into one requested quantity.",
        variant: "destructive",
      });
      return;
    }
    try {
      await create.mutateAsync({
        data: {
          urgency,
          lines: validLines,
          ...(needBy ? { needBy } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
      await queryClient.invalidateQueries({ queryKey: getListPartRequisitionsQueryKey() });
      toast({
        title: "Restock requisition submitted",
        description: "It is now ready for approval and supplier sourcing.",
      });
      reset();
      onOpenChange(false);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error || (e as Error).message;
      toast({ title: "Could not submit requisition", description: msg, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !create.isPending) reset(); onOpenChange(next); }}>
      <DialogContent className="max-w-2xl glass-panel border-none">
        <DialogHeader>
          <DialogTitle>New Inventory Restock Requisition</DialogTitle>
          <DialogDescription>
            Request inventory replenishment without linking it to a customer or job card.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 py-2">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Priority</label>
              <Select value={urgency} onValueChange={(value) => setUrgency(value as PartRequisitionUrgency)}>
                <SelectTrigger className="border-white/10 bg-white/[0.03]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="routine">Routine</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="vehicle_down">Vehicle Down (VOR)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Need by</label>
              <Input type="date" value={needBy} onChange={(event) => setNeedBy(event.target.value)} className="border-white/10 bg-white/[0.03]" />
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Parts to replenish</label>
              <Button variant="outline" size="sm" onClick={() => setLines((current) => [...current, { partId: "", quantity: 1 }])}>
                <Plus className="w-4 h-4 mr-1" /> Add part
              </Button>
            </div>
            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-[1fr_110px_40px] gap-3 items-center">
                <SearchableSelect
                  value={line.partId}
                  onChange={(value) => setLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, partId: value } : item))}
                  options={parts?.filter((part) => part.status === "active").map((part) => ({ value: String(part.id), label: `${part.sku} — ${part.name} (${part.stock} on hand)` })) ?? []}
                  placeholder="Select inventory part"
                  ariaLabel={`Inventory part ${index + 1}`}
                />
                <Input type="number" min={1} value={line.quantity} onChange={(event) => setLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: Number(event.target.value) } : item))} className="border-white/10 bg-white/[0.03]" />
                <Button variant="ghost" size="icon" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label="Remove part">
                  <Trash2 className="w-4 h-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes</label>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Supplier preference, pack size, or replenishment context…" className="border-white/10 bg-white/[0.03] min-h-24" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Submit Requisition
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequisitionCard({ req }: { req: PartRequisition }) {
  const [open, setOpen] = useState(false);
  const isVOR = req.urgency === "vehicle_down";

  return (
    <>
      <Card className="glass-panel border-none rounded-2xl cursor-pointer hover:bg-white/[0.06] transition-colors" onClick={() => setOpen(true)}>
        <CardContent className="p-4 space-y-3">
          <div className="flex justify-between items-start">
            <div>
              <h4 className="font-bold text-sm">REQ-{req.id}</h4>
              <p className="text-xs text-muted-foreground">
                {req.jobCardId == null ? "Inventory restock" : `Job Card #${req.jobCardId} · SO #${req.serviceOrderId}`}
              </p>
            </div>
            <Badge variant="secondary" className={cn(
              "px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border-none",
              getBadgeClass(req.status)
            )}>
              {STATUS_LABELS[req.status] || req.status}
            </Badge>
          </div>

          <div className="flex justify-between items-end">
            <div className="text-xs text-muted-foreground">
              <span className="block">By: {req.requesterName}</span>
              {req.needBy && <span className="block">Need by: {formatGuyanaDate(req.needBy)}</span>}
            </div>
            {isVOR && (
              <Badge variant="destructive" className="bg-red-500/20 text-red-400 border-none text-[10px] uppercase font-bold tracking-widest">
                VOR
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <RequisitionDialog open={open} onOpenChange={setOpen} reqId={req.id} />
    </>
  );
}

function RequisitionDialog({ open, onOpenChange, reqId }: { open: boolean, onOpenChange: (open: boolean) => void, reqId: number }) {
  const { data, isLoading } = useGetPartRequisition(reqId, { query: { enabled: open, queryKey: getGetPartRequisitionQueryKey(reqId) } });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl glass-panel border-none p-0 overflow-hidden bg-background">
        <DialogHeader className="p-6 pb-4 border-b border-white/10 bg-white/[0.02]">
          <DialogTitle className="flex items-center gap-3">
            REQ-{reqId}
            {data && (
              <Badge variant="secondary" className={cn(
                "px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border-none",
                getBadgeClass(data.status)
              )}>
                {STATUS_LABELS[data.status]}
              </Badge>
            )}
          </DialogTitle>
          {data && <CustomerInvoiceAction sourceType="requisition" sourceId={reqId} internal={!data.jobCardId || !data.serviceOrderId} />}
        </DialogHeader>

        <div className="p-6 max-h-[75vh] overflow-y-auto space-y-6">
          {isLoading || !data ? (
             <div className="space-y-6">
               <div className="h-20 bg-white/[0.03] border border-white/5 rounded-xl animate-pulse" />
               <div className="space-y-3">
                 <div className="h-6 w-32 bg-white/[0.03] rounded animate-pulse" />
                 <div className="h-32 bg-white/[0.03] border border-white/5 rounded-xl animate-pulse" />
               </div>
             </div>
          ) : (
             <RequisitionDetailContent req={data} onActionComplete={() => onOpenChange(false)} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RequisitionDetailContent({ req, onActionComplete }: { req: PartRequisitionDetail, onActionComplete: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const money = useMoney();
  const { data: parts } = useListParts();

  const decide = useDecidePartRequisition();
  const fulfill = useFulfillPartRequisition();

  const [sourcePOModalOpen, setSourcePOModalOpen] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListPartRequisitionsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPartRequisitionQueryKey(req.id) });
    queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
  };

  const handleDecision = async (action: 'approve' | 'reject') => {
    try {
      await decide.mutateAsync({ id: req.id, data: { action } });
      toast({ title: `Requisition ${action}d` });
      invalidate();
      onActionComplete();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error || (e as Error).message;
      toast({ title: "Decision failed", description: msg, variant: "destructive" });
    }
  };

  const [fulfillmentLines, setFulfillmentLines] = useState<Record<number, number>>({});
  const handleFulfill = async () => {
    const linesToFulfill = Object.entries(fulfillmentLines)
      .filter(([_, qty]) => qty > 0)
      .map(([id, qty]) => ({ lineId: parseInt(id), quantity: qty }));

    if (!linesToFulfill.length) {
      toast({ title: "No quantities selected", variant: "destructive" });
      return;
    }

    try {
      await fulfill.mutateAsync({
        id: req.id,
        data: { idempotencyKey: `ful-${Date.now()}`, lines: linesToFulfill }
      });
      toast({ title: "Fulfillment recorded" });
      setFulfillmentLines({});
      invalidate();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error || (e as Error).message;
      toast({ title: "Fulfillment failed", description: msg, variant: "destructive" });
    }
  };

  const canCancel = ["submitted", "approved", "partially_ordered", "ordered"].includes(req.status);
  const canSourcePO = ["approved", "partially_ordered"].includes(req.status) && req.lines.some(l => (l.outstandingQuantity ?? 0) > 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 bg-white/[0.03] p-4 rounded-xl border border-white/5">
        <div>
          <div className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground mb-1">Requester</div>
          <div className="text-sm font-medium">{req.requesterName}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground mb-1">Urgency</div>
          <div className="text-sm font-medium">{URGENCY_LABELS[req.urgency] || req.urgency}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground mb-1">Context</div>
           <div className="text-sm font-medium">{req.jobCardId == null ? "Inventory restock" : `JC #${req.jobCardId}`}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground mb-1">Need By</div>
          <div className="text-sm font-medium">{req.needBy ? formatGuyanaDate(req.needBy) : 'N/A'}</div>
        </div>
      </div>

      {req.notes && (
        <div>
          <h4 className="text-sm font-semibold mb-2">Notes</h4>
          <p className="text-sm text-muted-foreground bg-white/[0.02] p-3 rounded-lg border border-white/5">{req.notes}</p>
        </div>
      )}

      <div>
        <h4 className="text-sm font-semibold mb-3">Lines</h4>
        <div className="space-y-3">
          {req.lines.map(line => {
            const isInternal = line.source === "INTERNAL";
            const unfulfilled = line.quantity - line.fulfilledQuantity;
            const canFulfill = req.jobCardId != null && ["approved", "partially_ordered", "ordered", "partially_fulfilled"].includes(req.status) && unfulfilled > 0;
            const part = isInternal && line.partId ? parts?.find(p => p.id === line.partId) : null;

            return (
              <div key={line.id} className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                <div className="flex justify-between items-start gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className={cn(
                        "text-[10px] uppercase font-bold tracking-widest px-1.5 py-0 border-none",
                        isInternal ? "bg-blue-500/10 text-blue-400" : "bg-purple-500/10 text-purple-400"
                      )}>
                        {line.source}
                      </Badge>
                      <span className="text-sm font-semibold">{line.descriptionSnapshot}</span>
                    </div>
                    {line.skuSnapshot && <div className="text-xs text-muted-foreground">SKU: {line.skuSnapshot}</div>}
                    {part && (
                      <div className="text-xs text-blue-400 font-medium mt-0.5">Current Stock: {part.stock}</div>
                    )}
                    {line.supplierSnapshot && <div className="text-xs text-muted-foreground">Supplier (Snapshot): {line.supplierSnapshot}</div>}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-sm font-medium">{line.quantity} requested</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-xs mt-4 pt-4 border-t border-white/5">
                  <div className="space-y-1">
                    <div className="text-muted-foreground uppercase text-[10px] tracking-widest font-bold">Ordered</div>
                    <div className="text-sm font-medium">{line.orderedQuantity ?? 0}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-muted-foreground uppercase text-[10px] tracking-widest font-bold">Received</div>
                    <div className="text-sm font-medium">{line.receivedQuantity ?? 0}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-muted-foreground uppercase text-[10px] tracking-widest font-bold">Outstanding</div>
                    <div className="text-sm font-medium text-amber-400">{line.outstandingQuantity ?? 0}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-muted-foreground uppercase text-[10px] tracking-widest font-bold">{req.jobCardId == null ? "Received" : "Consumed"}</div>
                    <div className="text-sm font-medium text-emerald-400">{line.fulfilledQuantity} / {line.quantity}</div>
                  </div>
                </div>

                {line.purchaseOrderLinks && line.purchaseOrderLinks.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-white/5 space-y-2">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Purchase Orders</div>
                    {line.purchaseOrderLinks.map(link => (
                      <div key={`${link.purchaseOrderId}-${link.purchaseOrderLineId}`} className="flex justify-between items-center text-xs bg-white/[0.03] p-2.5 rounded-lg border border-white/5">
                        <Link href="/parts?tab=orders" className="flex items-center gap-1.5 text-primary hover:text-primary/80 transition-colors font-medium">
                          <LinkIcon className="w-3.5 h-3.5" /> PO-{link.purchaseOrderId}
                        </Link>
                        <span className="text-muted-foreground">
                          Ord: <span className="text-foreground">{link.quantityOrdered}</span> · Rcvd: <span className="text-foreground">{link.quantityReceived}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {canFulfill && (
                  <div className="flex items-center justify-between gap-3 pt-3 mt-4 border-t border-white/5">
                    <span className="text-xs font-medium text-muted-foreground">Issue to Job Card (Fulfill):</span>
                    <Input
                      type="number"
                      min={0}
                      max={unfulfilled}
                      value={fulfillmentLines[line.id] ?? 0}
                      onChange={e => setFulfillmentLines(prev => ({...prev, [line.id]: parseInt(e.target.value) || 0}))}
                      className="w-24 h-8 text-sm bg-white/[0.03] border-white/10"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-between items-center gap-3 pt-4 border-t border-white/10">
        <div>
          {canCancel && (
            <Button variant="ghost" className="text-red-400 hover:text-red-300 hover:bg-red-500/10" onClick={() => setCancelModalOpen(true)}>
              <Ban className="w-4 h-4 mr-2" /> Cancel Requisition
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          {req.status === "submitted" && (
            <>
              <Button variant="outline" className="border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={() => handleDecision('reject')} disabled={decide.isPending}>
                <XCircle className="w-4 h-4 mr-2" /> Reject
              </Button>
              <Button className="bg-emerald-500 hover:bg-emerald-600 text-white" onClick={() => handleDecision('approve')} disabled={decide.isPending}>
                <CheckCircle className="w-4 h-4 mr-2" /> Approve
              </Button>
            </>
          )}

          {canSourcePO && (
            <Button onClick={() => setSourcePOModalOpen(true)} className="bg-primary hover:bg-primary/90">
              <ShoppingCart className="w-4 h-4 mr-2" /> Source & Create PO
            </Button>
          )}

          {req.jobCardId != null && ["approved", "partially_ordered", "ordered", "partially_fulfilled"].includes(req.status) && Object.values(fulfillmentLines).some(q => q > 0) && (
            <Button onClick={handleFulfill} disabled={fulfill.isPending} className="bg-amber-500 hover:bg-amber-600 text-white">
              <Truck className="w-4 h-4 mr-2" /> Record Consumption
            </Button>
          )}
        </div>
      </div>

      <SourceAndCreatePODialog
        req={req}
        open={sourcePOModalOpen}
        onOpenChange={setSourcePOModalOpen}
        onSuccess={invalidate}
      />
      <CancelRequisitionDialog
        req={req}
        open={cancelModalOpen}
        onOpenChange={setCancelModalOpen}
        onSuccess={() => { invalidate(); onActionComplete(); }}
      />
    </div>
  );
}

function SourceAndCreatePODialog({
  req,
  open,
  onOpenChange,
  onSuccess
}: {
  req: PartRequisitionDetail,
  open: boolean,
  onOpenChange: (open: boolean) => void,
  onSuccess: () => void
}) {
  const { toast } = useToast();
  const convert = useConvertPartRequisitionToPurchaseOrders();
  const { data: suppliers } = useListSuppliers();

  // Stable idempotency key per mount
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [open]);

  // State: mapping of lineId -> { supplierId: string, quantity: number, unitCost: string }
  const [selections, setSelections] = useState<Record<number, { supplierId: string, quantity: number, unitCost: string }>>({});

  // Initialize selections
  React.useEffect(() => {
    if (open && req) {
      const init: Record<number, { supplierId: string, quantity: number, unitCost: string }> = {};
      req.lines.forEach(line => {
        if ((line.outstandingQuantity ?? 0) > 0) {
          init[line.id] = { supplierId: "", quantity: line.outstandingQuantity ?? 0, unitCost: line.unitCost > 0 ? String(line.unitCost) : "" };
        }
      });
      setSelections(init);
    }
  }, [open, req]);

  const handleSubmit = async () => {
    const lines = Object.entries(selections)
      .filter(([_, s]) => s.supplierId && s.quantity > 0)
      .map(([id, s]) => ({
        lineId: Number(id),
        supplierId: Number(s.supplierId),
        quantity: s.quantity,
        unitCost: s.unitCost ? Number(s.unitCost) : undefined
      }));

    if (lines.length === 0) {
      toast({ title: "No lines selected", description: "Select a supplier and quantity for at least one line.", variant: "destructive" });
      return;
    }

    try {
      await convert.mutateAsync({
        id: req.id,
        data: {
          idempotencyKey,
          lines
        }
      });
      toast({ title: "Purchase Orders Created", description: "Draft POs have been prepared." });
      onSuccess();
      onOpenChange(false);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error || (e as Error).message;
      toast({ title: "Sourcing failed", description: msg, variant: "destructive" });
    }
  };

  const outstandingLines = req.lines.filter(l => (l.outstandingQuantity ?? 0) > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl glass-panel border-none">
        <DialogHeader>
          <DialogTitle>Source & Create PO</DialogTitle>
          <DialogDescription>
            Select suppliers to fulfill the outstanding quantities. This will create or append to Draft purchase orders.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2 py-2">
          {outstandingLines.map(line => {
            const sel = selections[line.id] || { supplierId: "", quantity: 0, unitCost: "" };
            const isInternal = line.source === "INTERNAL";
            return (
              <div key={line.id} className="grid grid-cols-12 gap-4 items-center bg-white/[0.02] border border-white/5 p-4 rounded-xl">
                <div className="col-span-5 flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={cn(
                      "text-[10px] uppercase font-bold tracking-widest px-1.5 py-0 border-none",
                      isInternal ? "bg-blue-500/10 text-blue-400" : "bg-purple-500/10 text-purple-400"
                    )}>
                      {line.source}
                    </Badge>
                    <span className="text-sm font-semibold truncate" title={line.descriptionSnapshot}>{line.descriptionSnapshot}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Outstanding: <span className="text-foreground font-medium">{line.outstandingQuantity}</span>
                  </div>
                </div>

                <div className="col-span-3">
                  <Select value={sel.supplierId} onValueChange={v => setSelections(prev => ({ ...prev, [line.id]: { ...prev[line.id], supplierId: v } }))}>
                    <SelectTrigger className="h-9 text-xs border-white/10 bg-white/[0.03]">
                      <SelectValue placeholder="Select supplier..." />
                    </SelectTrigger>
                    <SelectContent>
                      {suppliers?.map(s => (
                        <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="col-span-2">
                  <Input
                    type="number"
                    min={0}
                    max={line.outstandingQuantity}
                    className="h-9 text-xs border-white/10 bg-white/[0.03]"
                    placeholder="Qty"
                    value={sel.quantity || ""}
                    onChange={e => setSelections(prev => ({ ...prev, [line.id]: { ...prev[line.id], quantity: Number(e.target.value) } }))}
                  />
                </div>

                <div className="col-span-2">
                  <Input
                    type="number"
                    min={0}
                    className="h-9 text-xs border-white/10 bg-white/[0.03]"
                    placeholder="Cost (Opt)"
                    value={sel.unitCost}
                    onChange={e => setSelections(prev => ({ ...prev, [line.id]: { ...prev[line.id], unitCost: e.target.value } }))}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-white/10">Cancel</Button>
          <Button onClick={handleSubmit} disabled={convert.isPending} className="bg-primary hover:bg-primary/90">
            {convert.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Create POs
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelRequisitionDialog({
  req,
  open,
  onOpenChange,
  onSuccess
}: {
  req: PartRequisitionDetail,
  open: boolean,
  onOpenChange: (open: boolean) => void,
  onSuccess: () => void
}) {
  const { toast } = useToast();
  const cancel = useCancelPartRequisition();
  const [reason, setReason] = useState("");

  const handleSubmit = async () => {
    if (!reason.trim()) {
      toast({ title: "Reason required", description: "You must provide a cancellation reason.", variant: "destructive" });
      return;
    }
    try {
      await cancel.mutateAsync({
        id: req.id,
        data: { reason: reason.trim() }
      });
      toast({ title: "Requisition Cancelled" });
      setReason("");
      onSuccess();
      onOpenChange(false);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error || (e as Error).message;
      toast({ title: "Cancellation failed", description: msg, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md glass-panel border-none">
        <DialogHeader>
          <DialogTitle className="text-red-400 flex items-center gap-2"><Ban className="w-5 h-5"/> Cancel Requisition</DialogTitle>
          <DialogDescription>
            This action will cancel the requisition. Any unfulfilled lines will be released. You must provide a reason.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <Input
            placeholder="Cancellation reason..."
            value={reason}
            onChange={e => setReason(e.target.value)}
            className="bg-white/[0.03] border-white/10 h-10"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="hover:bg-white/[0.05]">Keep Requisition</Button>
          <Button variant="destructive" onClick={handleSubmit} disabled={cancel.isPending || !reason.trim()} className="bg-red-500/20 text-red-400 hover:bg-red-500/30">
            {cancel.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Confirm Cancellation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
