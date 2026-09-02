import React, { useState } from "react";
import {
  useRequestCollisionChecklistItem,
  useVerifyCollisionChecklistItem,
  useWaiveCollisionChecklistItem,
  useLinkCollisionChecklistDocument,
  type CollisionChecklistItem,
  type CollisionChecklistSummary,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { CheckCircle2, CircleDashed, Link as LinkIcon, AlertTriangle, MessageSquare, Plus, FileText, Loader2, Upload } from "lucide-react";
import { formatGuyanaDateTime } from "@/lib/format";

export function CollisionChecklistPanel({ claimId, checklist, summary }: { claimId: number, checklist: CollisionChecklistItem[], summary: CollisionChecklistSummary }) {
  // Group by audience
  const groups = {
    customer: checklist.filter(c => c.audience === "customer"),
    insurer: checklist.filter(c => c.audience === "insurer"),
    workshop: checklist.filter(c => c.audience === "workshop"),
  };

  const progress = summary.total > 0 ? ((summary.verified + summary.waived) / summary.total) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Summary Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 bg-muted/10 border border-border/40 rounded-xl">
        <div>
          <div className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1">Claim Readiness</div>
          <div className="flex items-center gap-2">
            <div className="w-full max-w-[200px] h-2 bg-background rounded-full overflow-hidden border border-border/40">
              <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-sm font-medium">{summary.verified + summary.waived} / {summary.total}</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-1.5"><CircleDashed className="w-4 h-4 text-amber-500" /> {summary.missing} missing</div>
          <div className="flex items-center gap-1.5"><MessageSquare className="w-4 h-4 text-sky-500" /> {summary.requested} requested</div>
          <div className="flex items-center gap-1.5"><Upload className="w-4 h-4 text-emerald-500" /> {summary.uploaded} uploaded</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <ChecklistGroup claimId={claimId} title="Customer Documents" items={groups.customer} />
        <ChecklistGroup claimId={claimId} title="Insurer Documents" items={groups.insurer} />
        <ChecklistGroup claimId={claimId} title="Internal Checks" items={groups.workshop} />
      </div>
    </div>
  );
}

function ChecklistGroup({ claimId, title, items }: { claimId: number, title: string, items: CollisionChecklistItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold border-b border-border/40 pb-2">{title}</h4>
      <div className="space-y-2">
        {items.map(item => (
          <ChecklistItemRow key={item.id} claimId={claimId} item={item} />
        ))}
      </div>
    </div>
  );
}

function ChecklistItemRow({ claimId, item }: { claimId: number, item: CollisionChecklistItem }) {
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  
  const { toast } = useToast();
  const qc = useQueryClient();
  const verify = useVerifyCollisionChecklistItem();
  
  const handleVerify = async () => {
    try {
      await verify.mutateAsync({ id: claimId, itemId: item.id });
      toast({ title: "Item verified" });
      qc.invalidateQueries({ queryKey: ["getCollisionClaim", claimId] } as any); // using generic invalidation if keys missing
    } catch (e: any) {
      toast({ title: "Verification failed", description: e.message, variant: "destructive" });
    }
  };

  const statusColors = {
    missing: "border-amber-500/30 text-amber-600 bg-amber-500/10",
    requested: "border-sky-500/30 text-sky-600 bg-sky-500/10",
    uploaded: "border-emerald-500/50 text-emerald-600 bg-emerald-500/20 shadow-sm",
    verified: "border-foreground/20 text-foreground bg-muted/40",
    waived: "border-border/40 text-muted-foreground bg-background",
  };

  return (
    <div className="p-3 rounded-lg border border-border/60 bg-muted/5 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium leading-tight">
          {item.label}
          {item.requiredForStatus && (
            <span className="block text-[10px] uppercase text-red-500 font-bold mt-0.5">
              Blocks {item.requiredForStatus}
            </span>
          )}
        </div>
        <Badge variant="outline" className={`text-[10px] py-0 px-1.5 uppercase font-bold shrink-0 ${statusColors[item.status]}`}>
          {item.status}
        </Badge>
      </div>

      <div className="text-xs text-muted-foreground leading-snug">
        {item.description}
      </div>

      {item.status === "uploaded" && (
        <div className="mt-1 flex items-center justify-between p-2 rounded-md border border-emerald-500/30 bg-emerald-500/5">
          <div className="text-xs text-emerald-600 flex items-center gap-1 font-medium">
            <FileText className="w-3.5 h-3.5" /> Awaiting Verification
          </div>
          <Button size="sm" onClick={handleVerify} disabled={verify.isPending} className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white">
            {verify.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
            Verify
          </Button>
        </div>
      )}

      {(item.status === "missing" || item.status === "requested") && (
        <div className="flex items-center gap-2 mt-1">
          {item.audience !== "workshop" && (
            <Button size="sm" variant="outline" onClick={() => setRequestOpen(true)} className="h-7 text-xs flex-1 border-dashed">
              Request
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setLinkOpen(true)} className="h-7 text-xs flex-1 border-dashed">
            Link Doc
          </Button>
          <Button size="sm" variant="outline" onClick={() => setWaiveOpen(true)} className="h-7 text-xs border-dashed text-red-500 hover:text-red-600 hover:bg-red-500/10">
            Waive
          </Button>
        </div>
      )}

      {item.status === "waived" && (
        <div className="text-xs text-muted-foreground bg-background p-2 rounded border border-border/40 mt-1 italic">
          Waived: {item.waiverReason}
        </div>
      )}

      <WaiveDialog claimId={claimId} itemId={item.id} open={waiveOpen} onOpenChange={setWaiveOpen} label={item.label} />
      <RequestDialog claimId={claimId} itemId={item.id} open={requestOpen} onOpenChange={setRequestOpen} label={item.label} />
      <LinkDialog claimId={claimId} itemId={item.id} open={linkOpen} onOpenChange={setLinkOpen} label={item.label} />
    </div>
  );
}

function WaiveDialog({ claimId, itemId, open, onOpenChange, label }: any) {
  const [reason, setReason] = useState("");
  const waive = useWaiveCollisionChecklistItem();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handle = async () => {
    try {
      await waive.mutateAsync({ id: claimId, itemId, data: { reason } });
      toast({ title: "Checklist item waived" });
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["getCollisionClaim", claimId] } as any);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Waive Requirement</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="p-3 bg-red-500/10 text-red-600 rounded-md border border-red-500/20 text-sm flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <p>Waiving "{label}" allows the claim to advance without this document. A manager's reason is permanently recorded.</p>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Reason for waiver</label>
            <Textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is this document no longer required?" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={!reason.trim() || waive.isPending} onClick={handle}>Waive Item</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestDialog({ claimId, itemId, open, onOpenChange, label }: any) {
  const [note, setNote] = useState("");
  const req = useRequestCollisionChecklistItem();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handle = async () => {
    try {
      await req.mutateAsync({ id: claimId, itemId, data: { note: note || undefined } });
      toast({ title: "Item requested" });
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["getCollisionClaim", claimId] } as any);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request Document</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">This moves the status of "{label}" to Requested and adds an optional note for the Customer Portal.</p>
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Optional Note</label>
            <Textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Please upload the updated form..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={req.isPending} onClick={handle}>Request Item</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkDialog({ claimId, itemId, open, onOpenChange, label }: any) {
  const [docId, setDocId] = useState("");
  const link = useLinkCollisionChecklistDocument();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handle = async () => {
    try {
      await link.mutateAsync({ id: claimId, itemId, data: { documentId: Number(docId) } });
      toast({ title: "Document linked and item verified" });
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["getCollisionClaim", claimId] } as any);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link Existing Document</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">If the document was uploaded separately, link it to "{label}" to verify this checklist item.</p>
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Document ID</label>
            <Input type="number" value={docId} onChange={e => setDocId(e.target.value)} placeholder="e.g. 1024" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!docId || link.isPending} onClick={handle}>Link Document</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
