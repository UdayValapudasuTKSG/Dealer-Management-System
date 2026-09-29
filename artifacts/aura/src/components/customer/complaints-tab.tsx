import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

type Complaint = {
  id: number; title: string; details: string; severity: string; status: string;
  escalated: boolean; leadId: number | null; createdAt: string;
};
type Result = Complaint & { notification: "queued" | "skipped" | "not_requested"; notificationReason: string | null };
const apiBase = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
const severityOptions = ["low", "medium", "high", "critical"];
const statusOptions = ["open", "in_progress", "resolved", "closed"];
const label = (value: string) => value.replaceAll("_", " ");

export function ComplaintsTab({ customerId, leads }: { customerId: number; leads: { id: number }[] }) {
  const [rows, setRows] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [leadId, setLeadId] = useState("");
  const [escalated, setEscalated] = useState(true);
  const { toast } = useToast();
  const url = `${apiBase()}/customers/${customerId}/complaints`;

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    fetch(url, { credentials: "include" }).then(async r => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not load complaints");
      return r.json() as Promise<Complaint[]>;
    }).then(data => { if (mounted) { setRows(data); setError(""); } })
      .catch(e => { if (mounted) setError(e.message); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [url]);

  async function submit() {
    if (!title.trim() || !details.trim()) return;
    setSaving(true);
    try {
      const response = await fetch(url, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), details: details.trim(), severity, escalated, ...(leadId ? { leadId: Number(leadId) } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save complaint");
      const result = data as Result;
      setRows(previous => [result, ...previous]);
      setTitle(""); setDetails(""); setLeadId(""); setEscalated(true);
      toast({ title: "Complaint recorded", description: result.notification === "queued" ? "Manager notification queued (not yet delivered)." : result.notification === "skipped" ? `Manager notification skipped: ${result.notificationReason}` : "Manager notification not requested." });
    } catch (e) {
      toast({ title: "Could not record complaint", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function update(row: Complaint, changes: Record<string, string | boolean>) {
    try {
      const response = await fetch(`${url}/${row.id}`, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not update complaint");
      const result = data as Result;
      setRows(previous => previous.map(item => item.id === row.id ? result : item));
      toast({ title: "Complaint updated", description: result.notification === "queued" ? "Manager notification queued (not yet delivered)." : result.notification === "skipped" ? `Manager notification skipped: ${result.notificationReason}` : undefined });
    } catch (e) {
      toast({ title: "Could not update complaint", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" });
    }
  }

  return <div className="space-y-6">
    <Card className="glass-panel"><CardContent className="p-6 space-y-4">
      <div><h2 className="text-lg font-semibold">Record a complaint</h2><p className="text-sm text-muted-foreground">Keep a record of the issue and choose whether to alert dealership management.</p></div>
      <Input aria-label="Complaint title" placeholder="Complaint title" maxLength={200} value={title} onChange={e => setTitle(e.target.value)} />
      <Textarea aria-label="Complaint details" placeholder="Describe the customer's concern" maxLength={10000} value={details} onChange={e => setDetails(e.target.value)} />
      <div className="flex flex-wrap gap-4 items-center">
        <label className="text-sm">Severity <select className="ml-2 rounded border bg-background p-2" value={severity} onChange={e => setSeverity(e.target.value)}>{severityOptions.map(option => <option key={option} value={option}>{label(option)}</option>)}</select></label>
        {leads.length > 0 && <label className="text-sm">Linked lead <select className="ml-2 rounded border bg-background p-2" value={leadId} onChange={e => setLeadId(e.target.value)}><option value="">None</option>{leads.map(lead => <option key={lead.id} value={lead.id}>Lead #{lead.id}</option>)}</select></label>}
      </div>
      <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={escalated} onChange={e => setEscalated(e.target.checked)} />Escalate to dealership manager by email</label>
      <Button onClick={submit} disabled={saving || !title.trim() || !details.trim()}>{saving ? "Saving…" : "Record complaint"}</Button>
    </CardContent></Card>
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Complaint history</h2>
      {loading ? <p>Loading complaints…</p> : error ? <p role="alert" className="text-destructive">{error}</p> : rows.length === 0 ? <p className="text-muted-foreground">No complaints recorded.</p> : rows.map(row => <Card key={row.id} className="glass-panel"><CardContent className="p-5 space-y-3">
        <div className="flex justify-between gap-3"><div><h3 className="font-semibold">{row.title}</h3><p className="text-xs text-muted-foreground">{new Date(row.createdAt).toLocaleString()} · {row.escalated ? "Escalated" : "Not escalated"}{row.leadId ? <> · <Link href={`/leads/${row.leadId}`} className="text-primary underline">Lead #{row.leadId}</Link></> : null}</p></div></div>
        <p className="whitespace-pre-wrap text-sm">{row.details}</p>
        <div className="flex flex-wrap gap-3 items-center">
          <label className="text-sm">Status <select className="ml-2 rounded border bg-background p-2" value={row.status} onChange={e => void update(row, { status: e.target.value })}>{statusOptions.map(option => <option key={option} value={option}>{label(option)}</option>)}</select></label>
          <label className="text-sm">Severity <select className="ml-2 rounded border bg-background p-2" value={row.severity} onChange={e => void update(row, { severity: e.target.value })}>{severityOptions.map(option => <option key={option} value={option}>{label(option)}</option>)}</select></label>
          {!row.escalated && <Button variant="outline" size="sm" onClick={() => void update(row, { escalated: true })}>Escalate to manager</Button>}
        </div>
      </CardContent></Card>)}
    </div>
  </div>;
}