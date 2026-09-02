import React, { useState } from "react";
import {
  useListCollisionCommunications,
  useGenerateCollisionCommunicationDraft,
  useEditCollisionCommunicationDraft,
  useSendCollisionCommunicationDraft,
  type CollisionCommunication,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Bot, Mail, MessageSquare, Plus, Send, Edit, Loader2 } from "lucide-react";
import { formatGuyanaDateTime } from "@/lib/format";

export function CollisionCommunicationsCard({ claimId }: { claimId: number }) {
  const { data: comms, isLoading } = useListCollisionCommunications(claimId);
  
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-border/40 pb-2">
         <div className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Communications Studio</div>
         <GenerateDialog claimId={claimId} />
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground text-center py-4 border border-dashed border-border/40 rounded-lg">Loading...</div>
      ) : comms?.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-4 border border-dashed border-border/40 rounded-lg">
          No communications sent or drafted.
        </div>
      ) : (
        <div className="space-y-3">
          {comms?.map((c) => (
            <CommunicationRow key={c.id} claimId={claimId} comm={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function GenerateDialog({ claimId }: { claimId: number }) {
  const [open, setOpen] = useState(false);
  const [audience, setAudience] = useState("customer");
  const [purpose, setPurpose] = useState("delay_update");
  const [instruction, setInstruction] = useState("");
  
  const generate = useGenerateCollisionCommunicationDraft();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleGenerate = async () => {
    try {
      await generate.mutateAsync({
        id: claimId,
        data: {
          audience,
          purpose,
          instruction: instruction || undefined,
          idempotencyKey: crypto.randomUUID(),
        } as any
      });
      toast({ title: "Draft generated" });
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["listCollisionCommunications"] } as any);
    } catch (e: any) {
      toast({ title: "Generation failed", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 shadow-sm">
          <Bot className="w-3.5 h-3.5 mr-1" /> New AI Draft
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Generate Communication</DialogTitle></DialogHeader>
        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Audience</label>
              <Select value={audience} onValueChange={setAudience}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="customer">Customer</SelectItem>
                  <SelectItem value="insurer">Insurer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Purpose</label>
              <Select value={purpose} onValueChange={setPurpose}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="claim_received">Claim Received</SelectItem>
                  <SelectItem value="missing_documents">Missing Documents</SelectItem>
                  <SelectItem value="estimate_submitted">Estimate Submitted</SelectItem>
                  <SelectItem value="delay_update">Delay Update</SelectItem>
                  <SelectItem value="payment_request">Payment Request</SelectItem>
                  <SelectItem value="ready_for_collection">Ready for Collection</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Extra Instructions</label>
            <Textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="e.g. Tell them the parts are stuck in customs..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={generate.isPending} onClick={handleGenerate}>
            {generate.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Generate Draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CommunicationRow({ claimId, comm }: { claimId: number, comm: CollisionCommunication }) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const [subject, setSubject] = useState(comm.subject);
  const [body, setBody] = useState(comm.body);
  const [recipient, setRecipient] = useState(comm.recipient);

  const edit = useEditCollisionCommunicationDraft();
  const send = useSendCollisionCommunicationDraft();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleEdit = async () => {
    try {
      await edit.mutateAsync({
        id: claimId,
        communicationId: comm.id,
        data: { subject, body, recipient }
      });
      toast({ title: "Draft updated" });
      setEditOpen(false);
      qc.invalidateQueries({ queryKey: ["listCollisionCommunications"] } as any);
    } catch (e: any) {
      toast({ title: "Edit failed", description: e.message, variant: "destructive" });
    }
  };

  const handleSend = async () => {
    try {
      await send.mutateAsync({ 
        id: claimId, 
        communicationId: comm.id, 
        data: { confirm: true, idempotencyKey: crypto.randomUUID() } 
      });
      toast({ title: "Communication sent" });
      setReviewOpen(false);
      qc.invalidateQueries({ queryKey: ["listCollisionCommunications"] } as any);
    } catch (e: any) {
      toast({ title: "Send failed", description: e.message, variant: "destructive" });
    }
  };

  const isDraft = comm.status === "draft";

  return (
    <div className="p-3 rounded-lg border border-border/60 bg-muted/5 flex flex-col gap-2">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="space-y-1">
          <div className="font-medium text-sm flex items-center gap-2">
             <span className="capitalize">{comm.audience}</span>
             {comm.generatedByAgent && <span className="text-[10px] uppercase font-bold text-indigo-500 bg-indigo-500/10 px-1.5 py-0.5 rounded flex items-center gap-1"><Bot className="w-3 h-3" /> AI Draft</span>}
             <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${isDraft ? 'text-amber-500 bg-amber-500/10' : 'text-emerald-500 bg-emerald-500/10'}`}>
               {comm.status}
             </span>
          </div>
          <div className="text-xs text-muted-foreground">{comm.recipient} · {formatGuyanaDateTime(comm.createdAt)}</div>
        </div>
        {isDraft && (
          <div className="flex items-center gap-2 shrink-0">
             <Button size="sm" variant="outline" className="h-7 text-xs border-dashed" onClick={() => setEditOpen(true)}>
               <Edit className="w-3 h-3 mr-1" /> Edit
             </Button>
             <Button size="sm" className="h-7 text-xs bg-primary text-white" onClick={() => setReviewOpen(true)}>
               Review & Send
             </Button>
          </div>
        )}
      </div>

      <div className="mt-2 text-sm">
         <div className="font-medium text-foreground/80 mb-1">{comm.subject}</div>
         <div className="text-muted-foreground whitespace-pre-wrap text-xs line-clamp-2">{comm.body}</div>
      </div>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Edit Draft</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4">
             <div className="space-y-2">
               <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Recipient</label>
               <Input value={recipient} onChange={e => setRecipient(e.target.value)} />
             </div>
             <div className="space-y-2">
               <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Subject</label>
               <Input value={subject} onChange={e => setSubject(e.target.value)} />
             </div>
             <div className="space-y-2">
               <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Body</label>
               <Textarea value={body} onChange={e => setBody(e.target.value)} className="h-64 resize-none" />
             </div>
          </div>
          <DialogFooter>
             <Button variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
             <Button disabled={edit.isPending} onClick={handleEdit}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Review Dialog */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>Review & Send</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4 bg-muted/10 p-4 rounded border border-border/40 text-sm">
             <div className="grid grid-cols-[80px_1fr] gap-2">
               <div className="text-muted-foreground text-right font-medium">To:</div>
               <div>{comm.recipient}</div>
               <div className="text-muted-foreground text-right font-medium">Subject:</div>
               <div className="font-semibold">{comm.subject}</div>
             </div>
             <div className="border-t border-border/40 pt-4 mt-2 whitespace-pre-wrap text-foreground/80">
               {comm.body}
             </div>
          </div>
          <DialogFooter>
             <Button variant="ghost" onClick={() => setReviewOpen(false)}>Cancel</Button>
             <Button disabled={send.isPending} onClick={handleSend} className="bg-primary text-white">
               {send.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
               Send Now
             </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
