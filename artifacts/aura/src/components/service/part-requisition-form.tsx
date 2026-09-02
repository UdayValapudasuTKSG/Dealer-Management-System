import React, { useState } from "react";
import { useCreateJobCardPartRequisition, useListParts } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Plus, X } from "lucide-react";

export function PartRequisitionForm({ cardId, serviceOrderId, onSuccess }: { cardId: number, serviceOrderId: number, onSuccess: () => void }) {
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
        <Button size="sm" variant="outline" className="rounded-full border-white/15 gap-1.5 text-xs">
          <Plus className="w-3.5 h-3.5" /> Request Parts
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
                <SelectTrigger className="bg-white/[0.03] border-white/10"><SelectValue placeholder="Select" /></SelectTrigger>
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
                    <SelectTrigger className="w-[120px] bg-white/[0.03] border-white/10"><SelectValue placeholder="Source" /></SelectTrigger>
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
