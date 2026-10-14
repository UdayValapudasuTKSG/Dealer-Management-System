import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { formatGuyanaDateTime } from "@/lib/format";
import { downloadPartsReport } from "./parts-analysis-export";
import { useListPagination } from "./list-pagination";

type Issue = {
  id: number; issuedAt: string; sku: string; part: string; quantity: number;
  issuedTo: string; customer: string; jobCardId: number | null; technician: string;
  issuedBy: string; location: string;
};
export function IssuanceReport() {
  const [search, setSearch] = useState("");
  const [downloading, setDownloading] = useState(false);
  const { toast } = useToast();
  const report = useQuery({
    queryKey: ["parts-issuance"],
    queryFn: () => customFetch<{ rows: Issue[] }>("/api/parts/operations/issuance"),
  });
  const filtered = (report.data?.rows ?? []).filter(r =>
    [r.sku, r.part, r.customer, r.technician, r.issuedTo, r.issuedBy].join(" ").toLowerCase().includes(search.toLowerCase()));
  const paging = useListPagination(filtered, search);
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-3 items-center">
      <h3 className="text-lg font-semibold">Parts issuance</h3>
      <Input aria-label="Search parts issuance" className="max-w-md" placeholder="Search part, customer or technician…" value={search} onChange={e => setSearch(e.target.value)} />
      <Button variant="outline" onClick={() => report.refetch()}>Refresh</Button>
      <Button disabled={downloading || report.isError || report.isLoading} onClick={async () => {
        setDownloading(true);
        try { await downloadPartsReport("/api/parts/operations/issuance", "parts-issuance", "csv"); }
        catch (e) { toast({ title: "Export failed", description: e instanceof Error ? e.message : "Please retry.", variant: "destructive" }); }
        finally { setDownloading(false); }
      }}>{downloading ? "Exporting…" : "Export all CSV"}</Button>
    </div>
    <p className="text-sm text-muted-foreground">Physical stock issues only; reservations are excluded. Technician shows the current job-card assignment, not necessarily who issued the part. Missing historical attribution is marked “Not recorded”.</p>
    {report.isError ? <p role="alert">Unable to load issuance records. Please retry.</p> : report.isLoading ? <p>Loading issues…</p> :
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm"><thead><tr>{["Issued at", "Part number", "Part", "Quantity", "Issued to", "Customer", "Job card", "Technician", "Issued by", "Location"].map(c => <th key={c} className="p-3 text-left whitespace-nowrap">{c}</th>)}</tr></thead>
          <tbody>{paging.items.map(r => <tr key={r.id} className="border-t">{[formatGuyanaDateTime(r.issuedAt), r.sku, r.part, r.quantity, r.issuedTo, r.customer, r.jobCardId ? `JC #${r.jobCardId}` : "—", r.technician, r.issuedBy, r.location].map((v, i) => <td key={i} className="p-3">{v}</td>)}</tr>)}
            {!filtered.length && <tr><td colSpan={10} className="p-6 text-center">No issuance records found.</td></tr>}</tbody>
        </table>
      </div>}
    {paging.controls}
  </div>;
}
