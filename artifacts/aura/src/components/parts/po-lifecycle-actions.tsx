import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const base = "/api/parts/operations/purchase-orders";
type Preview = { id: number; to: string; cc: string; subject: string; html: string; filename: string; sha256: string };
export function PoLifecycleActions({ po }: { po: { id: number; status: string; sendCount?: number; createdBy?: number | null; reviewComment?: string | null } }) {
  const { can, me } = useAuthz();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [resend, setResend] = useState(false);
  const [returning, setReturning] = useState(false);
  const [comment, setComment] = useState("");
  const [pdfLoading, setPdfLoading] = useState(false);
  const downloadSnapshot = async () => {
    if (!preview) return;
    setPdfLoading(true);
    try {
      const blob = await customFetch<Blob>(`${base}/${po.id}/snapshots/${preview.id}/pdf?v=${Date.now()}`, { responseType: "blob", cache: "no-store" });
      const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (sha256 !== preview.sha256) throw new Error("PDF snapshot integrity check failed. Reopen Preview & send.");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = preview.filename;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      toast({ title: "PDF download failed", description: error instanceof Error ? error.message : "Could not fetch the authenticated PDF snapshot", variant: "destructive" });
    } finally { setPdfLoading(false); }
  };
  const history = useQuery({ queryKey: ["po-email-history", po.id], queryFn: () => customFetch<any[]>(`${base}/${po.id}/email-history`), refetchInterval: 15000 });
  const mutation = useMutation({
    mutationFn: ({ action, body }: { action: string; body: unknown }) => customFetch<any>(`${base}/${po.id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    onSuccess: (_, variables) => { if (variables.action !== "preview") void qc.invalidateQueries(); },
    onError: error => toast({ title: "PO action failed", description: error.message, variant: "destructive" }),
  });
  const review = async (action: string) => {
    await mutation.mutateAsync({ action: "review", body: { action, ...(comment ? { comment } : {}) } });
    setReturning(false); setComment("");
  };
  const openPreview = async (isResend: boolean) => {
    setResend(isResend);
    setPreview(await mutation.mutateAsync({ action: "preview", body: { resend: isResend } }));
  };
  const send = async () => {
    if (!preview) return;
    await mutation.mutateAsync({ action: "send", body: { confirm: true, resend, snapshotId: preview.id, to: preview.to, cc: preview.cc, subject: preview.subject, html: preview.html } });
    setPreview(null);
    toast({ title: "PO email queued", description: "The PO becomes Sent only when the provider accepts it. Delivery status is shown below." });
  };
  const manager = can("parts", "approve");
  const mayReview = manager && (po.createdBy !== me?.id || can("parts", "admin"));
  return <div className="space-y-3">
    <p className="text-sm font-semibold capitalize">{po.status.replaceAll("_", " ")}</p>
    {po.reviewComment && <p className="text-sm text-muted-foreground">{po.reviewComment}</p>}
    {po.status === "draft" && can("parts", "edit") && <Button disabled={mutation.isPending} onClick={() => void review("submit").catch(() => {})}>Submit for review</Button>}
    {po.status === "pending_review" && mayReview && <><Button disabled={mutation.isPending} onClick={() => void review("approve").catch(() => {})}>Approve PO</Button><Button variant="outline" onClick={() => setReturning(true)}>Return to draft</Button></>}
    {po.status === "pending_review" && manager && !mayReview && <p className="text-xs text-muted-foreground">Another reviewer must approve your PO. Parts admin override is required for self-review.</p>}
    {po.status === "received" && manager && <Button variant="outline" disabled={mutation.isPending} onClick={() => { if (window.confirm("Close this received PO? All supplier invoices must be reconciled.")) void mutation.mutateAsync({ action: "close", body: {} }).catch(() => {}); }}>Close PO</Button>}
    {["draft", "pending_review", "approved"].includes(po.status) && manager && <Button variant="outline" disabled={mutation.isPending} onClick={() => { if (window.confirm("Cancel this purchase order?")) void review("cancel").catch(() => {}); }}>Cancel PO</Button>}
    {po.status === "approved" && manager && <Button disabled={mutation.isPending} onClick={() => void openPreview(false).catch(() => {})}>Preview & send</Button>}
    {(po.status === "sent" || ((po.sendCount ?? 0) > 0 && ["ordered", "partially_received", "received"].includes(po.status))) && manager && <Button variant="outline" disabled={mutation.isPending} onClick={() => void openPreview(true).catch(() => {})}>Preview resend</Button>}
    {history.isError && <p className="text-sm text-destructive">{history.error.message}</p>}
    {history.data?.map(log => <div key={log.id} className="rounded border p-2 text-xs"><strong>Email #{log.id}: {log.status}</strong><p>{log.to_address}</p>{log.sent_at && <p>{new Date(log.sent_at).toLocaleString()}</p>}{log.last_error && <p className="text-destructive">{log.last_error}</p>}{log.provider_message_id && <p className="break-all">Provider: {log.provider_message_id}</p>}</div>)}
    <Dialog open={returning} onOpenChange={setReturning}><DialogContent><DialogHeader><DialogTitle>Return PO to draft</DialogTitle><DialogDescription>The creator will receive your comment in their notification bell.</DialogDescription></DialogHeader><Textarea value={comment} onChange={e => setComment(e.target.value)} placeholder="Reason for returning" /><Button disabled={!comment.trim() || mutation.isPending} onClick={() => void review("return").catch(() => {})}>Return to draft</Button></DialogContent></Dialog>
    <Dialog open={!!preview} onOpenChange={open => { if (!open) setPreview(null); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{resend ? "Confirm resend" : "Preview supplier email"}</DialogTitle><DialogDescription>The exact edited content and immutable PDF below are saved for this send only.</DialogDescription></DialogHeader>
      {preview && <>{(["to", "cc", "subject"] as const).map(key => <Label key={key} className="space-y-2 capitalize">{key}<Input value={preview[key]} onChange={e => setPreview({ ...preview, [key]: e.target.value })} /></Label>)}<Label>Body HTML<Textarea rows={6} value={preview.html} onChange={e => setPreview({ ...preview, html: e.target.value })} /></Label><iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-48 w-full rounded border bg-white" /><Button variant="link" disabled={pdfLoading} onClick={() => void downloadSnapshot()}>{pdfLoading ? "Verifying PDF…" : `Attached: ${preview.filename} — download exact PDF`}</Button><p className="text-xs break-all text-muted-foreground">SHA-256: {preview.sha256}</p><Button disabled={mutation.isPending} onClick={() => void send().catch(() => {})}>{resend ? "Confirm & resend" : "Send approved PO"}</Button></>}
    </DialogContent></Dialog>
  </div>;
}