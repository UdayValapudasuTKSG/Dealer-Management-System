import React, { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateJobCard,
  useToggleJobCardTimer,
  useReopenJobCard,
  useListJobCardParts,
  useAddJobCardPart,
  useCreateJobCardInvoice,
  useListJobCardCreditNotes,
  useCreateJobCardCreditNote,
  useListJobCardTechnicianNotes,
  useCreateJobCardTechnicianNote,
  useApproveJobCardRollover,
  useDecideJobCardSurcharge,
  useListParts,
  useListServiceTechnicians,
  useClaimServiceOrder,
  useCreateJobCardPartRequisition,
  useListJobCardPartRequisitions,
  getListJobCardsQueryKey,
  getListJobCardPartsQueryKey,
  getListPartsQueryKey,
  getListJobCardCreditNotesQueryKey,
  getListJobCardTechnicianNotesQueryKey,
  getListJobCardPartRequisitionsQueryKey,
  type JobCard,
  type PartRequisitionInput,
  type PartRequisitionLineInputSource,
  PartRequisitionStatus,
} from "@workspace/api-client-react";
import { formatGuyanaDate, useMoney, formatDealerDateShort, formatDealerDayTime } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { cn } from "@/lib/utils";
import { 
  AlertTriangle, Play, Pause, RotateCcw, 
  CheckCircle2, Circle, Clock, Phone, 
  Package, Pencil, History, Send, MessageSquareWarning,
  Plus, X, Search, FileText, FileDown, Wrench, Calendar, DollarSign
} from "lucide-react";
import { useAuthz } from "@/lib/auth";

/* --- HELPERS --- */
export function useIsServiceApprover() {
  const { me } = useAuthz();
  const role = me?.roleName ?? "";
  return /service manager|general manager|leadership|management|owner.?admin|admin/i.test(role);
}

function formatWorkedSeconds(totalSeconds: number): string {
  if (!totalSeconds || totalSeconds < 0) return "0m";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatWorkDuration(start: Date, end: Date): string {
  const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const JOB_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  on_hold: "On Hold",
  completed: "Completed",
  closed: "Closed",
  cancelled: "Cancelled",
};

/* --- SUBCOMPONENTS --- */
function TimerReadout({ card }: { card: JobCard }) {
  const running = card.status === "in_progress" && !!card.timerStartedAt;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [running]);
  const seconds =
    (card.timerSeconds ?? 0) +
    (running && card.timerStartedAt
      ? Math.max(0, Math.round((Date.now() - new Date(card.timerStartedAt).getTime()) / 1000))
      : 0);
  if (seconds <= 0 && !running) return null;
  return (
    <span className={cn("font-medium", running ? "text-primary" : "text-foreground")}>
      · {formatWorkedSeconds(seconds)} worked{running ? " (running)" : card.status === "in_progress" ? " (paused)" : ""}
    </span>
  );
}

function ClaimJobCardAction({ card }: { card: JobCard }) {
  const claim = useClaimServiceOrder();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleClaim = async () => {
    try {
      await claim.mutateAsync({ id: card.serviceOrderId, data: {} });
      queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
      toast({ title: "Job claimed", description: "You are now assigned to this job." });
    } catch (e: any) {
      toast({ title: "Could not claim", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Button
      size="sm"
      disabled={claim.isPending}
      onClick={handleClaim}
      className="rounded-full bg-primary/10 text-primary hover:bg-primary/20 border-none h-8 text-xs font-semibold px-4"
    >
      Claim Job
    </Button>
  );
}

function AssignJobCardDialog({ card }: { card: JobCard }) {
  const { data: technicians } = useListServiceTechnicians();
  const claim = useClaimServiceOrder();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleAssign = async (userId: number) => {
    try {
      await claim.mutateAsync({ id: card.serviceOrderId, data: { technicianUserId: userId } });
      queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
      toast({ title: "Technician assigned" });
    } catch (e: any) {
      toast({ title: "Could not assign", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Select value={card.technicianUserId?.toString() ?? ""} onValueChange={(val) => handleAssign(parseInt(val, 10))}>
      <SelectTrigger className="h-8 text-xs bg-white/[0.03] border-white/10 rounded-full w-[160px]">
        <SelectValue placeholder="Assign Tech..." />
      </SelectTrigger>
      <SelectContent>
        {technicians?.map(t => (
          <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SurchargeSection({ card, onChanged }: { card: JobCard; onChanged: () => void }) {
  const { toast } = useToast();
  const money = useMoney();
  const decide = useDecideJobCardSurcharge();

  const act = async (action: "apply" | "waive") => {
    try {
      await decide.mutateAsync({ id: card.id, data: { action } });
      onChanged();
      toast({ title: action === "apply" ? "Surcharge applied" : "Surcharge waived" });
    } catch (e: any) {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/10 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold tracking-widest text-primary uppercase flex items-center gap-1.5 mb-0.5">
            <AlertTriangle className="w-3.5 h-3.5" /> Late-service surcharge
          </div>
          <div className="text-sm text-muted-foreground">
            {card.surchargeOverKm != null && card.surchargeOverKm > 0 && (
              <>Arrived {card.surchargeOverKm.toLocaleString()} km past interval · </>
            )}
            {money.gyd(card.surchargeAmount ?? 0)}
            {card.surchargeDecidedBy && card.surchargeDecidedAt && (
              <>
                {" "}· {card.surchargeStatus === "applied" ? "Applied" : "Waived"} by{" "}
                {card.surchargeDecidedBy} on {formatDealerDateShort(card.surchargeDecidedAt)}
              </>
            )}
          </div>
        </div>
        {card.surchargeStatus === "suggested" ? (
          <div className="flex gap-2 shrink-0">
            <Button size="sm" onClick={() => act("apply")} className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs">Apply</Button>
            <Button size="sm" variant="outline" onClick={() => act("waive")} className="rounded-full border-white/20 text-muted-foreground hover:text-white text-xs">Waive</Button>
          </div>
        ) : (
          <Badge variant="secondary" className="bg-primary/10 text-primary border-none text-[10px] uppercase font-bold">
            {card.surchargeStatus}
          </Badge>
        )}
      </div>
    </div>
  );
}

function RolloverSection({ card, onChanged }: { card: JobCard; onChanged: () => void }) {
  const { toast } = useToast();
  const approve = useApproveJobCardRollover();
  const isApprover = useIsServiceApprover();

  const handleApprove = async () => {
    try {
      await approve.mutateAsync({ id: card.id, data: { as: isApprover ? "manager" : "technician" } });
      onChanged();
      toast({ title: "Rollover approved" });
    } catch (e: any) {
      toast({ title: "Approval failed", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="rounded-xl bg-primary/5 border border-primary/20 p-3 flex items-center justify-between gap-3">
      <div>
        <div className="text-xs font-semibold tracking-widest text-primary uppercase flex items-center gap-1.5 mb-0.5">
          <History className="w-3.5 h-3.5" /> Rollover Requested
        </div>
        <div className="text-sm text-muted-foreground">
          Technician requested to roll this job over to {card.rolloverToDate ? formatGuyanaDate(card.rolloverToDate) : "tomorrow"}.
        </div>
      </div>
      {isApprover ? (
        <Button size="sm" onClick={handleApprove} disabled={approve.isPending} className="rounded-full bg-primary text-white text-xs">
          Approve Rollover
        </Button>
      ) : (
        <Badge variant="secondary" className="bg-primary/10 text-primary border-none">Pending Approval</Badge>
      )}
    </div>
  );
}

/* --- REQUISITION FORM --- */
function PartRequisitionForm({ cardId, serviceOrderId, onSuccess }: { cardId: number, serviceOrderId: number, onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const [urgency, setUrgency] = useState<"routine"|"urgent"|"vehicle_down">("routine");
  const [needBy, setNeedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<any[]>([{ id: 1, source: "INTERNAL", partId: "", quantity: 1 }]);
  const create = useCreateJobCardPartRequisition();
  
  const { data: parts } = useListParts();

  const addLine = () => setLines([...lines, { id: Date.now(), source: "INTERNAL", partId: "", quantity: 1 }]);
  const removeLine = (id: number) => setLines(lines.filter(l => l.id !== id));
  const updateLine = (id: number, key: string, value: any) => {
    setLines(lines.map(l => l.id === id ? { ...l, [key]: value } : l));
  };

  const handleSubmit = async () => {
    try {
      const validLines = lines.filter(l => {
        if (l.source === "INTERNAL") return l.partId && l.quantity > 0;
        return l.description && l.quantity > 0;
      }).map(l => {
        if (l.source === "INTERNAL") {
          return { source: "INTERNAL" as const, partId: parseInt(l.partId), quantity: parseInt(l.quantity) };
        }
        return {
          source: "EXTERNAL" as const,
          description: l.description,
          supplier: l.supplier || undefined,
          quantity: parseInt(l.quantity),
          unitCost: l.unitCost ? parseFloat(l.unitCost) : undefined,
          unitPrice: l.unitPrice ? parseFloat(l.unitPrice) : undefined
        };
      });

      if (!validLines.length) {
        toast({ title: "Validation error", description: "Add at least one valid line.", variant: "destructive" });
        return;
      }

      await create.mutateAsync({
        id: cardId,
        data: {
          serviceOrderId,
          urgency,
          needBy: needBy || undefined,
          notes: notes || undefined,
          lines: validLines
        }
      });
      
      toast({ title: "Requisition submitted successfully" });
      setOpen(false);
      setLines([{ id: Date.now(), source: "INTERNAL", partId: "", quantity: 1 }]);
      setNotes("");
      onSuccess();
    } catch (e: any) {
      toast({ title: "Submission failed", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-primary/10 text-primary hover:bg-primary/20">
          <Plus className="w-4 h-4 mr-1.5" /> Request Parts
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl glass-panel border-none p-0 overflow-hidden bg-background">
        <DialogHeader className="p-6 pb-4 border-b border-white/10 bg-white/[0.02]">
          <DialogTitle>Request Parts</DialogTitle>
        </DialogHeader>
        <div className="p-6 max-h-[70vh] overflow-y-auto space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Urgency</label>
              <Select value={urgency} onValueChange={(v: any) => setUrgency(v)}>
                <SelectTrigger className="bg-white/[0.03] border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="routine">Routine</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="vehicle_down">Vehicle Down (VOR)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Need By (Optional)</label>
              <Input type="date" value={needBy} onChange={e => setNeedBy(e.target.value)} className="bg-white/[0.03] border-white/10" />
            </div>
          </div>
          
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Lines</label>
            {lines.map((l, i) => (
              <div key={l.id} className="p-4 bg-white/[0.02] border border-white/10 rounded-xl space-y-3 relative">
                {lines.length > 1 && (
                  <button onClick={() => removeLine(l.id)} className="absolute top-3 right-3 text-muted-foreground hover:text-red-400">
                    <X className="w-4 h-4" />
                  </button>
                )}
                <div className="flex gap-3 items-center">
                  <Select value={l.source} onValueChange={v => updateLine(l.id, "source", v)}>
                    <SelectTrigger className="w-[120px] bg-white/[0.03] border-white/10"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="INTERNAL">Internal</SelectItem>
                      <SelectItem value="EXTERNAL">External</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input type="number" min={1} placeholder="Qty" value={l.quantity} onChange={e => updateLine(l.id, "quantity", e.target.value)} className="w-[80px] bg-white/[0.03] border-white/10" />
                </div>
                
                {l.source === "INTERNAL" ? (
                  <Select value={l.partId} onValueChange={v => updateLine(l.id, "partId", v)}>
                    <SelectTrigger className="bg-white/[0.03] border-white/10">
                      <SelectValue placeholder="Search inventory..." />
                    </SelectTrigger>
                    <SelectContent>
                      {parts?.map(p => (
                        <SelectItem key={p.id} value={p.id.toString()}>
                          {p.sku} — {p.name} ({p.stock} in stock)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="space-y-3">
                    <Input placeholder="Part description / Part Number" value={l.description || ""} onChange={e => updateLine(l.id, "description", e.target.value)} className="bg-white/[0.03] border-white/10" />
                    <Input placeholder="Supplier (Optional)" value={l.supplier || ""} onChange={e => updateLine(l.id, "supplier", e.target.value)} className="bg-white/[0.03] border-white/10" />
                    <div className="grid grid-cols-2 gap-3">
                      <Input type="number" placeholder="Est. Unit Cost" value={l.unitCost || ""} onChange={e => updateLine(l.id, "unitCost", e.target.value)} className="bg-white/[0.03] border-white/10" />
                      <Input type="number" placeholder="Est. Unit Price" value={l.unitPrice || ""} onChange={e => updateLine(l.id, "unitPrice", e.target.value)} className="bg-white/[0.03] border-white/10" />
                    </div>
                  </div>
                )}
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addLine} className="w-full border-dashed border-white/20 text-muted-foreground">
              <Plus className="w-4 h-4 mr-2" /> Add Line
            </Button>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Notes / Reason</label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} className="bg-white/[0.03] border-white/10" placeholder="Optional context..." />
          </div>
        </div>
        <DialogFooter className="p-6 pt-4 border-t border-white/10 bg-white/[0.02]">
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={create.isPending} className="bg-primary text-white">
            Submit Requisition
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --- MAIN COMPONENT --- */
export function JobCardPanel({ card, technicianView = false }: { card: JobCard; technicianView?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateJobCard();
  const timer = useToggleJobCardTimer();
  const reopen = useReopenJobCard();
  const { me } = useAuthz();
  
  const { data: lines } = useListJobCardParts(card.id);
  const { data: requisitions } = useListJobCardPartRequisitions(card.id);
  const technicianNotesQuery = useListJobCardTechnicianNotes(card.id);
  const createTechnicianNote = useCreateJobCardTechnicianNote();
  
  const [activeTab, setActiveTab] = useState<"work"|"parts"|"notes"|"costs">("work");
  const [noteDraft, setNoteDraft] = useState("");
  const [analysisDraft, setAnalysisDraft] = useState("");
  const [performedDraft, setPerformedDraft] = useState("");
  const [completeOpen, setCompleteOpen] = useState(false);

  const money = useMoney();
  const isApprover = useIsServiceApprover();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListJobCardPartsQueryKey(card.id) });
    queryClient.invalidateQueries({ queryKey: getListJobCardPartRequisitionsQueryKey(card.id) });
  };

  const setStatus = async (status: JobCard["status"]) => {
    if (status === "completed" && (!card.serviceAnalysis?.trim() || !card.workPerformed?.trim())) {
      setAnalysisDraft(card.serviceAnalysis ?? "");
      setPerformedDraft(card.workPerformed ?? "");
      setCompleteOpen(true);
      return;
    }
    await update.mutateAsync({ id: card.id, data: { status } });
    invalidate();
    toast({ title: "Job card updated", description: `Status → ${JOB_STATUS_LABEL[status]}.` });
  };

  const submitCompletion = async () => {
    try {
      await update.mutateAsync({
        id: card.id,
        data: { status: "completed", serviceAnalysis: analysisDraft.trim(), workPerformed: performedDraft.trim() },
      });
      setCompleteOpen(false);
      invalidate();
      toast({ title: "Job card completed" });
    } catch (err: any) {
      toast({ title: "Could not complete", description: err.message, variant: "destructive" });
    }
  };

  const partsTotal = lines?.reduce((s, l) => s + l.unitPrice * l.quantity * (l.kind === "return" ? -1 : 1), 0) ?? 0;
  const laborTotal = card.laborHours * card.laborRate;

  // Header Actions
  const renderPrimaryAction = () => {
    if (card.status === "open") return <Button size="sm" onClick={() => setStatus("in_progress")} className="bg-primary/20 text-primary hover:bg-primary/30 h-8">Start Work</Button>;
    if (card.status === "in_progress") {
      const running = !!card.timerStartedAt;
      return (
        <div className="flex items-center gap-2">
          <Button size="icon" variant="outline" className={cn("h-8 w-8 rounded-full border-white/10", running ? "bg-amber-500/20 text-amber-500" : "bg-emerald-500/20 text-emerald-500")} onClick={() => { timer.mutate({ id: card.id, data: { action: running ? "pause" : "resume" } }); invalidate(); }}>
            {running ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 pl-0.5" />}
          </Button>
          <Button size="sm" onClick={() => setStatus("completed")} className="bg-primary/20 text-primary hover:bg-primary/30 h-8">Complete Job</Button>
        </div>
      );
    }
    if (card.status === "completed") return <Button size="sm" variant="outline" className="border-white/10 h-8" onClick={() => { reopen.mutate({ id: card.id, data: {} }); invalidate(); }}><RotateCcw className="w-4 h-4 mr-2" />Reopen</Button>;
    return null;
  };

  const pendingReqs = (requisitions || []).filter(r => r.status === "submitted" || r.status === "approved" || r.status === "ordered" || r.status === "partially_fulfilled").length;

  return (
    <Card className="glass-panel border-none rounded-2xl overflow-hidden flex flex-col h-full bg-[#12141A]">
      {/* HEADER */}
      <div className="p-5 border-b border-white/10 bg-white/[0.02] flex flex-col gap-4">
        <div className="flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-bold text-lg leading-none">JC-{card.id}</h3>
              <Badge variant="outline" className="bg-white/[0.05] border-none text-[10px] tracking-widest uppercase text-muted-foreground">{JOB_STATUS_LABEL[card.status]}</Badge>
              {pendingReqs > 0 && (
                <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-none text-[10px] tracking-widest uppercase">
                  {pendingReqs} Req Pending
                </Badge>
              )}
            </div>
            <div className="text-sm font-medium text-white/90">{card.title}</div>
            <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
              <span>SO-{card.serviceOrderId}</span>
              <span className="text-white/20">•</span>
              <span>{card.payType}</span>
              {card.technicianUserId ? (
                <>
                  <span className="text-white/20">•</span>
                  <span className="text-primary">{card.technicianName}</span>
                </>
              ) : (
                <>
                  <span className="text-white/20">•</span>
                  <span className="text-muted-foreground">Unassigned</span>
                </>
              )}
            </div>
          </div>
          <div className="flex gap-2 items-center">
            {(!card.technicianUserId && isApprover) ? <AssignJobCardDialog card={card} /> : null}
            {(!card.technicianUserId && !isApprover) ? <ClaimJobCardAction card={card} /> : null}
            {renderPrimaryAction()}
          </div>
        </div>
        
        {/* TIME CONTEXT */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground bg-black/20 rounded-lg p-2.5">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            <TimerReadout card={card} />
            {card.startedAt && !card.timerStartedAt && <span>{formatWorkedSeconds(card.timerSeconds || 0)} worked</span>}
            {!card.startedAt && <span>Not started</span>}
          </div>
          <div className="w-px h-3 bg-white/10" />
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5" /> {card.laborHours}h scheduled
          </div>
        </div>
      </div>

      {/* TABS */}
      <div className="flex border-b border-white/10 px-2 overflow-x-auto no-scrollbar w-full">
        {[
          { id: "work", label: "Work & Diagnosis", icon: Wrench },
          { id: "parts", label: "Parts & Requisitions", icon: Package, badge: pendingReqs },
          { id: "notes", label: "Timeline & Notes", icon: History },
          { id: "costs", label: "Costs", icon: DollarSign },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id as any)}
            className={cn(
              "flex items-center shrink-0 gap-2 px-4 py-3 text-xs font-semibold tracking-wide uppercase transition-colors whitespace-nowrap border-b-2",
              activeTab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-white"
            )}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
            {(t.badge ?? 0) > 0 && (
              <span className="bg-primary/20 text-primary px-1.5 py-0.5 rounded text-[10px] ml-1">{t.badge}</span>
            )}
          </button>
        ))}
      </div>

      {/* CONTENT */}
      <CardContent className="p-0 flex-1 overflow-y-auto bg-black/10">
        
        {/* WORK TAB */}
        {activeTab === "work" && (
          <div className="p-5 space-y-6">
            {card.surchargeStatus && card.surchargeStatus !== "waived" && (
              <SurchargeSection card={card} onChanged={invalidate} />
            )}
            {card.rolloverStatus === "pending" && (
              <RolloverSection card={card} onChanged={invalidate} />
            )}
            
            <div className="space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Checklist</h4>
              {card.checklist.length > 0 ? (
                <div className="space-y-1.5">
                  {card.checklist.map((item, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        const next = card.checklist.map((c, i) => (i === idx ? { ...c, done: !c.done } : c));
                        update.mutate({ id: card.id, data: { checklist: next } }, { onSuccess: invalidate });
                      }}
                      className="flex items-start gap-3 text-sm w-full text-left group p-2 rounded-lg hover:bg-white/[0.03] transition-colors"
                    >
                      {item.done ? (
                        <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      ) : (
                        <Circle className="w-4 h-4 text-muted-foreground shrink-0 group-hover:text-primary transition-colors mt-0.5" />
                      )}
                      <span className={cn(item.done && "line-through text-muted-foreground")}>{item.label}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No checklist items.</p>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground flex justify-between">
                  Service Analysis
                  {card.status === "in_progress" && (
                     <button onClick={() => setCompleteOpen(true)} className="text-primary hover:underline">Edit</button>
                  )}
                </h4>
                <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 text-sm min-h-[100px] whitespace-pre-wrap">
                  {card.serviceAnalysis || <span className="text-muted-foreground italic">Not provided yet.</span>}
                </div>
              </div>
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground flex justify-between">
                  Work Performed
                  {card.status === "in_progress" && (
                     <button onClick={() => setCompleteOpen(true)} className="text-primary hover:underline">Edit</button>
                  )}
                </h4>
                <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 text-sm min-h-[100px] whitespace-pre-wrap">
                  {card.workPerformed || <span className="text-muted-foreground italic">Not provided yet.</span>}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PARTS & REQUISITIONS TAB */}
        {activeTab === "parts" && (
          <div className="p-5 space-y-6">
            <div className="flex justify-between items-center">
              <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Requisitions</h4>
              <PartRequisitionForm cardId={card.id} serviceOrderId={card.serviceOrderId} onSuccess={invalidate} />
            </div>
            
            {(!requisitions || requisitions.length === 0) ? (
              <div className="text-center p-8 bg-white/[0.02] rounded-xl border border-white/5">
                <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-50" />
                <p className="text-sm text-muted-foreground">No parts requested for this job.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {requisitions.map(req => (
                  <div key={req.id} className="bg-white/[0.02] border border-white/10 rounded-xl p-4 flex flex-col gap-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="text-sm font-bold flex items-center gap-2">
                          REQ-{req.id}
                          {req.urgency === "vehicle_down" && (
                            <Badge variant="destructive" className="bg-red-500/20 text-red-400 border-none text-[8px] uppercase font-bold tracking-widest px-1 py-0 h-4">VOR</Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">Requested by {req.requesterName}</div>
                      </div>
                      <Badge variant="secondary" className="bg-white/[0.05] border-none text-[10px] tracking-widest uppercase">
                        {req.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="pt-6 border-t border-white/10">
              <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Issued Parts</h4>
              {lines?.length ? (
                <div className="space-y-2">
                  {lines.map(l => (
                    <div key={l.id} className="flex justify-between items-center p-3 bg-white/[0.02] rounded-lg border border-white/5 text-sm">
                      <span className={cn(l.kind === "return" && "line-through text-muted-foreground")}>
                        {l.quantity}x {l.partName} {l.kind === "return" && "(returned)"}
                      </span>
                      <span className="text-muted-foreground">{money.gyd(l.unitPrice * l.quantity)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No parts issued yet.</p>
              )}
            </div>
          </div>
        )}

        {/* NOTES TAB */}
        {activeTab === "notes" && (
          <div className="p-5 flex flex-col h-full">
            <div className="flex-1 space-y-4 overflow-y-auto mb-4">
              {technicianNotesQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : technicianNotesQuery.data?.length ? (
                technicianNotesQuery.data.map(n => (
                  <div key={n.id} className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs font-bold text-primary">{n.authorName}</span>
                      <span className="text-xs text-muted-foreground">{formatDealerDateShort(n.createdAt)}</span>
                    </div>
                    <p className="text-sm">{n.body}</p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No notes.</p>
              )}
            </div>
            
            <div className="flex gap-2 pt-4 border-t border-white/10">
              <Input 
                placeholder="Add a note..." 
                value={noteDraft} 
                onChange={e => setNoteDraft(e.target.value)} 
                className="bg-white/[0.03] border-white/10"
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey && noteDraft.trim()) {
                    e.preventDefault();
                    createTechnicianNote.mutate({ id: card.id, data: { body: noteDraft.trim() } }, { onSuccess: () => { setNoteDraft(""); invalidate(); } });
                  }
                }}
              />
              <Button 
                size="icon" 
                disabled={!noteDraft.trim() || createTechnicianNote.isPending}
                onClick={() => createTechnicianNote.mutate({ id: card.id, data: { body: noteDraft.trim() } }, { onSuccess: () => { setNoteDraft(""); invalidate(); } })}
                className="bg-primary/20 text-primary hover:bg-primary/30 shrink-0"
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}

        {/* COSTS TAB */}
        {activeTab === "costs" && (
          <div className="p-5 space-y-6">
             <div className="bg-white/[0.02] border border-white/10 rounded-xl p-5">
               <div className="flex justify-between items-center py-2 border-b border-white/5">
                 <span className="text-sm text-muted-foreground">Parts Total</span>
                 <span className="text-sm font-medium">{money.gyd(partsTotal)}</span>
               </div>
               <div className="flex justify-between items-center py-2 border-b border-white/5">
                 <span className="text-sm text-muted-foreground">Labour Total ({card.laborHours}h)</span>
                 <span className="text-sm font-medium">{money.gyd(laborTotal)}</span>
               </div>
               {card.surchargeStatus === "applied" && (
                 <div className="flex justify-between items-center py-2 border-b border-white/5 text-amber-500">
                   <span className="text-sm">Late Surcharge</span>
                   <span className="text-sm font-medium">{money.gyd(card.surchargeAmount ?? 0)}</span>
                 </div>
               )}
               <div className="flex justify-between items-center pt-4 mt-2">
                 <span className="font-bold">Total Estimate</span>
                 <span className="font-bold text-primary">{money.gyd(partsTotal + laborTotal + (card.surchargeStatus === "applied" ? (card.surchargeAmount ?? 0) : 0))}</span>
               </div>
             </div>
          </div>
        )}
      </CardContent>

      <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
        <DialogContent className="glass-panel border-none">
          <DialogHeader>
            <DialogTitle>Complete Job</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Service Analysis</label>
              <Textarea value={analysisDraft} onChange={e => setAnalysisDraft(e.target.value)} placeholder="Condition found..." className="bg-white/[0.03] border-white/10 h-24" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Work Performed</label>
              <Textarea value={performedDraft} onChange={e => setPerformedDraft(e.target.value)} placeholder="Work done..." className="bg-white/[0.03] border-white/10 h-24" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCompleteOpen(false)}>Cancel</Button>
            <Button onClick={submitCompletion} disabled={!analysisDraft.trim() || !performedDraft.trim() || update.isPending} className="bg-primary text-white">Save & Complete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
