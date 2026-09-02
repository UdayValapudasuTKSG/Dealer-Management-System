import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPartRequisitions,
  useGetPartRequisition,
  useDecidePartRequisition,
  useMarkPartRequisitionOrdered,
  useFulfillPartRequisition,
  useListParts,
  getListPartRequisitionsQueryKey,
  getGetPartRequisitionQueryKey,
  type PartRequisition,
  type PartRequisitionDetail,
} from "@workspace/api-client-react";
import { formatGuyanaDate, useMoney } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Search, Loader2, FileText, CheckCircle, XCircle, ShoppingCart, Truck, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const URGENCY_LABELS: Record<string, string> = {
  routine: "Routine",
  urgent: "Urgent",
  vehicle_down: "Vehicle Down (VOR)",
};

const STATUS_LABELS: Record<string, string> = {
  submitted: "Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
  ordered: "Ordered",
  partially_fulfilled: "Partially Fulfilled",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
};

export function RequisitionsWorkspace() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [urgencyFilter, setUrgencyFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  
  const { data, isLoading } = useListPartRequisitions({
    status: statusFilter !== "all" ? (statusFilter as any) : undefined,
    urgency: urgencyFilter !== "all" ? (urgencyFilter as any) : undefined,
  });

  const filtered = (data || []).filter((req) => {
    if (!search) return true;
    const lower = search.toLowerCase();
    return (
      req.id.toString().includes(lower) ||
      (req.requesterName || "").toLowerCase().includes(lower) ||
      req.serviceOrderId.toString().includes(lower) ||
      req.jobCardId.toString().includes(lower)
    );
  });

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
            <SelectItem value="ordered">Ordered</SelectItem>
            <SelectItem value="partially_fulfilled">Partially Fulfilled</SelectItem>
            <SelectItem value="fulfilled">Fulfilled</SelectItem>
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
          {filtered.map(req => (
            <RequisitionCard key={req.id} req={req} />
          ))}
        </div>
      )}
    </div>
  );
}

function RequisitionCard({ req }: { req: PartRequisition }) {
  const [open, setOpen] = useState(false);
  const isPending = req.status === "submitted";
  const isVOR = req.urgency === "vehicle_down";

  return (
    <>
      <Card className="glass-panel border-none rounded-2xl cursor-pointer hover:bg-white/[0.06] transition-colors" onClick={() => setOpen(true)}>
        <CardContent className="p-4 space-y-3">
          <div className="flex justify-between items-start">
            <div>
              <h4 className="font-bold text-sm">REQ-{req.id}</h4>
              <p className="text-xs text-muted-foreground">Job Card #{req.jobCardId} · SO #{req.serviceOrderId}</p>
            </div>
            <Badge variant="secondary" className={cn(
              "px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border-none",
              isPending ? "bg-amber-500/20 text-amber-300" :
              req.status === "fulfilled" ? "bg-emerald-500/20 text-emerald-300" :
              "bg-white/[0.05] text-foreground"
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
      <DialogContent className="max-w-3xl glass-panel border-none p-0 overflow-hidden bg-background">
        <DialogHeader className="p-6 pb-4 border-b border-white/10 bg-white/[0.02]">
          <DialogTitle className="flex items-center gap-3">
            REQ-{reqId}
            {data && (
              <Badge variant="secondary" className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border-none bg-white/[0.05]">
                {STATUS_LABELS[data.status]}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>
        
        <div className="p-6 max-h-[70vh] overflow-y-auto space-y-6">
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
  const order = useMarkPartRequisitionOrdered();
  const fulfill = useFulfillPartRequisition();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListPartRequisitionsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPartRequisitionQueryKey(req.id) });
  };

  const handleDecision = async (action: 'approve' | 'reject') => {
    try {
      await decide.mutateAsync({ id: req.id, data: { action } });
      toast({ title: `Requisition ${action}d` });
      invalidate();
      onActionComplete();
    } catch (e: any) {
      toast({ title: "Decision failed", description: e.message, variant: "destructive" });
    }
  };

  const handleOrder = async () => {
    try {
      await order.mutateAsync({ id: req.id, data: {} });
      toast({ title: "Marked as ordered" });
      invalidate();
    } catch (e: any) {
      toast({ title: "Action failed", description: e.message, variant: "destructive" });
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
    } catch (e: any) {
      const msg = e.response?.data?.error || e.message;
      toast({ title: "Fulfillment failed", description: msg, variant: "destructive" });
    }
  };

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
          <div className="text-sm font-medium">JC #{req.jobCardId}</div>
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
            const canFulfill = ["approved", "ordered", "partially_fulfilled"].includes(req.status) && unfulfilled > 0;
            const part = isInternal && line.partId ? parts?.find(p => p.id === line.partId) : null;
            
            return (
              <div key={line.id} className="bg-white/[0.02] border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex justify-between items-start gap-4">
                  <div>
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
                    {line.supplierSnapshot && <div className="text-xs text-muted-foreground">Supplier: {line.supplierSnapshot}</div>}
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium">{line.quantity} requested</div>
                    <div className="text-xs text-muted-foreground">{line.fulfilledQuantity} fulfilled</div>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="text-muted-foreground">Procurement:</span> {money.gyd(line.unitCost)} 
                    {line.taxCost > 0 && <span className="text-muted-foreground ml-1">(+{money.gyd(line.taxCost)} tax)</span>}
                  </div>
                  <div className="text-right">
                    <span className="text-muted-foreground">Customer Charge:</span> {money.gyd(line.unitPrice)}
                    {!isInternal && line.unitPrice > 0 && (
                      <span className="text-emerald-400 ml-2">
                        Margin: {Math.round(((line.unitPrice - line.unitCost - line.taxCost - line.freightCost) / line.unitPrice) * 100)}%
                      </span>
                    )}
                  </div>
                </div>
                
                {canFulfill && (
                  <div className="flex items-center gap-3 pt-3 mt-3 border-t border-white/5">
                    <span className="text-xs text-muted-foreground">Fulfill qty:</span>
                    <Input 
                      type="number" 
                      min={0} 
                      max={unfulfilled}
                      value={fulfillmentLines[line.id] ?? 0}
                      onChange={e => setFulfillmentLines(prev => ({...prev, [line.id]: parseInt(e.target.value) || 0}))}
                      className="w-20 h-8 text-sm"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      
      {/* Actions */}
      <div className="flex justify-end gap-3 pt-4 border-t border-white/10">
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
        
        {req.status === "approved" && (
          <Button onClick={handleOrder} disabled={order.isPending} className="bg-primary hover:bg-primary/90">
            <ShoppingCart className="w-4 h-4 mr-2" /> Mark Ordered
          </Button>
        )}
        
        {["approved", "ordered", "partially_fulfilled"].includes(req.status) && Object.values(fulfillmentLines).some(q => q > 0) && (
          <Button onClick={handleFulfill} disabled={fulfill.isPending} className="bg-amber-500 hover:bg-amber-600 text-white">
            <Truck className="w-4 h-4 mr-2" /> Record Fulfillment
          </Button>
        )}
      </div>
    </div>
  );
}