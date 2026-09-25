import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { customFetch, getListPurchaseOrdersQueryKey, useListPartsLocations } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { FileSpreadsheet, Download, Loader2 } from "lucide-react";

type Row = {
  rowNumber: number; supplier_code: string; part_number: string; part_name: string;
  qty: string; unit_cost: string; unknownPart: boolean;
  errors: string[]; status: "invalid" | "skipped" | "ready";
};
type Preview = { fingerprint: string; rows: Row[]; ready: number; invalid: number; skipped: number };

const header = "row_number,supplier_code,part_number,part_name,qty,unit_cost,errors";
function cell(value: string | number) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function downloadErrors(rows: Row[]) {
  const lines = rows.filter(r => r.errors.length).map(r =>
    [r.rowNumber, r.supplier_code, r.part_number, r.part_name, r.qty, r.unit_cost, r.errors.join("; ")].map(cell).join(","));
  const blob = new Blob(["\uFEFF" + header + "\r\n" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "purchase-order-import-errors.csv"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PurchaseOrderImportDialog() {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [locationId, setLocationId] = useState("");
  const [decisions, setDecisions] = useState<Record<string, "create" | "skip">>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [needsRevalidation, setNeedsRevalidation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: locations } = useListPartsLocations();

  async function submit(action: "preview" | "commit") {
    if (!file || !locationId) { setError("Choose a CSV or XLSX file and branch/location."); return; }
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("file", file); form.append("decisions", JSON.stringify(decisions));
      form.append("locationId", locationId);
      if (action === "commit") form.append("fingerprint", preview?.fingerprint ?? "");
      if (action === "preview") { setPreview(await customFetch<Preview>(`/api/purchase-orders/import/preview`, { method: "POST", body: form })); setNeedsRevalidation(false); }
      else {
        const result = await customFetch<{ purchaseOrderIds: number[] }>(`/api/purchase-orders/import/commit`, { method: "POST", body: form });
        await queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        toast({ title: "Draft purchase orders created", description: `Created ${result.purchaseOrderIds.length} supplier order(s). Review before sending.` });
        setOpen(false); setFile(null); setPreview(null); setDecisions({}); setNeedsRevalidation(false);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Import failed"); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline" size="sm"><FileSpreadsheet className="mr-2 h-4 w-4" />Import parts order</Button></DialogTrigger>
    <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Import purchase order</DialogTitle><DialogDescription>Preview is read-only. Valid rows create draft orders, grouped by supplier, only when you confirm. Supplier codes are SUP-ID; customers use CUST-ID or email/phone; RO references use RO-service-order-ID or JOB-job-card-ID.</DialogDescription></DialogHeader>
      <a className="text-sm text-primary underline" href="/api/purchase-orders/import/template" download><Download className="inline h-4 w-4 mr-1" />Download CSV template</a>
      <select aria-label="Import branch or location" value={locationId} onChange={e => { setLocationId(e.target.value); setPreview(null); }} className="w-full rounded border bg-background p-2 text-sm">
        <option value="">Select branch/location</option>
        {locations?.filter(location => location.active).map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
      </select>
      <input type="file" accept=".csv,.xlsx" aria-label="Purchase order CSV or XLSX" onChange={event => { setFile(event.target.files?.[0] ?? null); setPreview(null); setDecisions({}); setNeedsRevalidation(false); setError(""); }} />
      <Button type="button" disabled={busy || !file || !locationId} variant="outline" onClick={() => void submit("preview")}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Preview / revalidate</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {preview && <>
        {needsRevalidation && <p role="status" className="text-sm text-amber-600">Choices changed. Preview / revalidate again before confirming.</p>}
        <p className="text-sm">{preview.ready} ready · {preview.invalid} invalid · {preview.skipped} skipped. Invalid and skipped rows are not imported.</p>
        {preview.invalid > 0 && <Button type="button" variant="outline" onClick={() => downloadErrors(preview.rows)}><Download className="mr-2 h-4 w-4" />Download error CSV</Button>}
        <div className="overflow-x-auto max-h-80 overflow-y-auto border rounded"><table className="w-full text-sm"><thead><tr className="text-left"><th className="p-2">Row</th><th>Supplier</th><th>Part</th><th>Qty</th><th>Cost (GYD)</th><th>Status / errors</th><th>Unknown part</th></tr></thead><tbody>
          {preview.rows.map(row => <tr key={row.rowNumber} className="border-t"><td className="p-2">{row.rowNumber}</td><td>{row.supplier_code}</td><td>{row.part_number} {row.part_name}</td><td>{row.qty}</td><td>{row.unit_cost}</td><td className="text-xs">{row.errors.join("; ") || row.status}</td><td>{row.unknownPart && <select aria-label={`Unknown part choice for row ${row.rowNumber}`} value={decisions[row.rowNumber] ?? ""} onChange={e => { if (e.target.value) setDecisions(current => ({ ...current, [row.rowNumber]: e.target.value as "create" | "skip" })); else setDecisions(current => { const next = { ...current }; delete next[row.rowNumber]; return next; }); setNeedsRevalidation(true); }}><option value="">Choose</option><option value="create">Create part</option><option value="skip">Skip row</option></select>}</td></tr>)}
        </tbody></table></div>
        <Button type="button" disabled={busy || needsRevalidation || !preview.ready} onClick={() => void submit("commit")}>Confirm and create {preview.ready} draft line(s)</Button>
      </>}
    </DialogContent>
  </Dialog>;
}