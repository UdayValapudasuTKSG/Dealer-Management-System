import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListLeads, useListLeadAdvisors, useAssignLead, getListLeadsQueryKey, getListLeadAdvisorsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { isCallCentreRole } from "@/lib/pipeline-phase-filter";

export function BulkCallCentreReassign() {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string[]>([]);
  const [progress, setProgress] = useState("");
  const client = useQueryClient();
  // Fetch without pipeline date/search filters: reassignment covers the full queue.
  const leads = useListLeads(undefined, { query: { queryKey: getListLeadsQueryKey(), enabled: open, refetchOnMount: "always" } });
  const staff = useListLeadAdvisors({ callCentre: true }, { query: {
    queryKey: getListLeadAdvisorsQueryKey({ callCentre: true }), enabled: open,
  } });
  const assign = useAssignLead();
  const pending = (leads.data ?? []).filter(l =>
    (l.callCentreStatus === "pending" || l.callCentreStatus === "follow_up") &&
    !l.callCentreTransferredAt && l.ownerUserId === l.callCentreRepId &&
    !["lost", "converted"].includes(l.status));
  const sources = [...new Map(pending.filter(l => l.callCentreRepId != null)
    .map(l => [l.callCentreRepId!, l.assignedTo || `User #${l.callCentreRepId}`])).entries()];
  const selected = pending.filter(l => l.callCentreRepId === Number(source));
  const eligible = selected.filter(l => ["new", "contacted"].includes(l.phase));
  const targets = (staff.data ?? []).filter(s => isCallCentreRole(s.roleName) && s.id !== Number(source));
  const ready = !leads.isFetching && !staff.isFetching && !leads.isError && !staff.isError &&
    eligible.length > 0 && targets.some(s => s.id === Number(target));
  const selectClass = "w-full rounded-md border bg-background p-2 text-sm";
  async function move() {
    if (!ready || running) return;
    const snapshot = [...eligible];
    setRunning(true);
    setResult([]);
    let moved = 0;
    const failures: string[] = [];
    try {
      for (const [index, lead] of snapshot.entries()) {
        setProgress(`Processing ${index + 1} of ${snapshot.length}`);
        try {
          await assign.mutateAsync({ id: lead.id, data: {
            userId: Number(target), expectedCallCentreRepId: Number(source),
          } });
          moved++;
        } catch (error) {
          const e = error as { data?: { error?: string }; message?: string };
          failures.push(`Lead #${lead.id}: ${e.data?.error || e.message || "Reassignment failed"}`);
        }
      }
      setResult([`${moved} of ${snapshot.length} leads reassigned. ${failures.length} failed.`, ...failures]);
    } finally {
      await client.invalidateQueries();
      setRunning(false);
      setConfirmed(false);
      setProgress("");
    }
  }
  return <>
    <Button variant="outline" onClick={() => { setOpen(true); setResult([]); setConfirmed(false); }} data-testid="bulk-call-centre-reassign">
      Reassign call-centre leads
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!running) setOpen(value); }}>
      <DialogContent onInteractOutside={e => { if (running) e.preventDefault(); }} className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bulk call-centre reassignment</DialogTitle>
          <DialogDescription>Move pending and follow-up leads in this dealership, including their open call-centre tasks. Sales-transferred and closed leads stay unchanged. Pipeline search and date filters do not apply.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cc-source">Current representative</Label>
          <select id="cc-source" className={selectClass} value={source} disabled={running}
            onChange={e => { setSource(e.target.value); setTarget(""); setConfirmed(false); setResult([]); }}>
            <option value="">Choose current representative</option>
            {sources.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <Label htmlFor="cc-target">Move to</Label>
          <select id="cc-target" className={selectClass} value={target} disabled={running}
            onChange={e => { setTarget(e.target.value); setConfirmed(false); }}>
            <option value="">Choose active call-centre representative</option>
            {targets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {(leads.isFetching || staff.isFetching) && <p role="status">Loading current assignments…</p>}
        {(leads.isError || staff.isError) && <p role="alert">Could not load assignments. Close and reopen to retry.</p>}
        {source && <p>{eligible.length} leads eligible. {selected.length - eligible.length} excluded because they have progressed beyond new/contacted.</p>}
        {confirmed && <p role="alert">Confirm moving {eligible.length} leads to {targets.find(s => s.id === Number(target))?.name}? Each change is recorded in lead history. Keep this page open until processing finishes.</p>}
        <Button disabled={!ready || running} onClick={() => confirmed ? void move() : setConfirmed(true)}>
          {running ? progress : confirmed ? `Confirm reassignment of ${eligible.length} leads` : "Review reassignment"}
        </Button>
        <div aria-live="polite" className="space-y-1 text-sm">
          {result.map((line, i) => <p key={i}>{line}</p>)}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
