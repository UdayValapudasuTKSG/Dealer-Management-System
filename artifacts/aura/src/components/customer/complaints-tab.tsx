import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCustomerComplaints, useCreateCustomerComplaint, useUpdateCustomerComplaint, getListCustomerComplaintsQueryKey,
  useListLeadComplaints, useCreateLeadComplaint, useUpdateLeadComplaint, getListLeadComplaintsQueryKey,
} from "@workspace/api-client-react";
import type { CustomerComplaint, CustomerComplaintUpdate } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

type Props = { customerId: number; leads: { id: number }[]; leadId?: never; readOnly?: boolean } | { leadId: number; customerId?: never; leads?: never; readOnly?: boolean };
const severityOptions = ["low", "medium", "high", "critical"] as const;
const statusOptions = ["open", "in_progress", "resolved", "closed"] as const;
const label = (value: string) => value.replaceAll("_", " ");

export function ComplaintsTab(props: Props) {
  const isLead = props.leadId !== undefined;
  const customerId = props.customerId ?? 0;
  const leadId = props.leadId ?? 0;
  const qc = useQueryClient();
  const customerQuery = useListCustomerComplaints(customerId, { query: { queryKey: getListCustomerComplaintsQueryKey(customerId), enabled: !isLead } });
  const leadQuery = useListLeadComplaints(leadId, { query: { queryKey: getListLeadComplaintsQueryKey(leadId), enabled: isLead } });
  const createCustomer = useCreateCustomerComplaint();
  const createLead = useCreateLeadComplaint();
  const updateCustomer = useUpdateCustomerComplaint();
  const updateLead = useUpdateLeadComplaint();
  const query = isLead ? leadQuery : customerQuery;
  const rows = query.data ?? [];
  const saving = createCustomer.isPending || createLead.isPending;
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [severity, setSeverity] = useState<(typeof severityOptions)[number]>("medium");
  const [linkedLeadId, setLinkedLeadId] = useState("");
  const [escalated, setEscalated] = useState(true);
  const { toast } = useToast();

  function refresh(linkedId?: number | null, linkedCustomerId?: number | null) {
    if (isLead) void qc.invalidateQueries({ queryKey: getListLeadComplaintsQueryKey(leadId) });
    else void qc.invalidateQueries({ queryKey: getListCustomerComplaintsQueryKey(customerId) });
    if (linkedId && !isLead) void qc.invalidateQueries({ queryKey: getListLeadComplaintsQueryKey(linkedId) });
    if (linkedCustomerId) void qc.invalidateQueries({ queryKey: getListCustomerComplaintsQueryKey(linkedCustomerId) });
  }

  async function submit() {
    if (!title.trim() || !details.trim()) return;
    try {
      const data = { title: title.trim(), details: details.trim(), severity, escalated };
      const result = isLead
        ? await createLead.mutateAsync({ id: leadId, data })
        : await createCustomer.mutateAsync({ id: customerId, data: { ...data, ...(linkedLeadId ? { leadId: Number(linkedLeadId) } : {}) } });
      refresh(result.leadId, result.customerId);
      setTitle(""); setDetails(""); setLinkedLeadId(""); setEscalated(true);
      toast({ title: "Complaint recorded", description: result.notification === "queued" ? "Manager notification queued (not yet delivered)." : result.notification === "skipped" ? `Manager notification skipped: ${result.notificationReason}` : "Manager notification not requested." });
    } catch (e) {
      toast({ title: "Could not record complaint", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" });
    }
  }

  async function update(row: CustomerComplaint, changes: CustomerComplaintUpdate) {
    try {
      const result = isLead
        ? await updateLead.mutateAsync({ id: leadId, complaintId: row.id, data: changes })
        : await updateCustomer.mutateAsync({ id: customerId, complaintId: row.id, data: changes });
      refresh(row.leadId, row.customerId);
      toast({ title: "Complaint updated", description: result.notification === "queued" ? "Manager notification queued (not yet delivered)." : result.notification === "skipped" ? `Manager notification skipped: ${result.notificationReason}` : undefined });
    } catch (e) {
      toast({ title: "Could not update complaint", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" });
    }
  }

  return <div className="space-y-6">
    {!props.readOnly && <Card className="glass-panel"><CardContent className="p-6 space-y-4">
      <div><h2 className="text-lg font-semibold">Record a complaint</h2><p className="text-sm text-muted-foreground">Keep a record of the issue and choose whether to alert dealership management.</p></div>
      <Input aria-label="Complaint title" placeholder="Complaint title" maxLength={200} value={title} onChange={e => setTitle(e.target.value)} />
      <Textarea aria-label="Complaint details" placeholder="Describe the customer's concern" maxLength={10000} value={details} onChange={e => setDetails(e.target.value)} />
      <div className="flex flex-wrap gap-4 items-center">
        <label className="text-sm">Severity <select className="ml-2 rounded border bg-background p-2" value={severity} onChange={e => setSeverity(severityOptions.find(option => option === e.target.value) ?? "medium")}>{severityOptions.map(option => <option key={option} value={option}>{label(option)}</option>)}</select></label>
        {!isLead && props.leads.length > 0 && <label className="text-sm">Linked lead <select className="ml-2 rounded border bg-background p-2" value={linkedLeadId} onChange={e => setLinkedLeadId(e.target.value)}><option value="">None</option>{props.leads.map(lead => <option key={lead.id} value={lead.id}>Lead #{lead.id}</option>)}</select></label>}
      </div>
      <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={escalated} onChange={e => setEscalated(e.target.checked)} />Escalate to dealership manager by email</label>
      <Button onClick={submit} disabled={saving || !title.trim() || !details.trim()}>{saving ? "Saving…" : "Record complaint"}</Button>
    </CardContent></Card>}
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Complaint history</h2>
      {query.isLoading ? <p>Loading complaints…</p> : query.isError ? <p role="alert" className="text-destructive">{query.error instanceof Error ? query.error.message : "Could not load complaints"}</p> : rows.length === 0 ? <p className="text-muted-foreground">No complaints recorded.</p> : rows.map(row => <Card key={row.id} className="glass-panel"><CardContent className="p-5 space-y-3">
        <div className="flex justify-between gap-3"><div><h3 className="font-semibold">{row.title}</h3><p className="text-xs text-muted-foreground">{new Date(row.createdAt).toLocaleString()} · {row.escalated ? "Escalated" : "Not escalated"}{row.leadId ? <> · <Link href={`/leads/${row.leadId}`} className="text-primary underline">Lead #{row.leadId}</Link></> : null}</p></div></div>
        <p className="whitespace-pre-wrap text-sm">{row.details}</p>
        {!props.readOnly && <div className="flex flex-wrap gap-3 items-center">
          <label className="text-sm">Status <select className="ml-2 rounded border bg-background p-2" value={row.status} onChange={e => { const status = statusOptions.find(option => option === e.target.value); if (status) void update(row, { status }); }}>{statusOptions.map(option => <option key={option} value={option}>{label(option)}</option>)}</select></label>
          <label className="text-sm">Severity <select className="ml-2 rounded border bg-background p-2" value={row.severity} onChange={e => { const severity = severityOptions.find(option => option === e.target.value); if (severity) void update(row, { severity }); }}>{severityOptions.map(option => <option key={option} value={option}>{label(option)}</option>)}</select></label>
          {!row.escalated && <Button variant="outline" size="sm" onClick={() => void update(row, { escalated: true })}>Escalate to manager</Button>}
        </div>}
      </CardContent></Card>)}
    </div>
  </div>;
}