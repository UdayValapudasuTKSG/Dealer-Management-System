import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { customFetch } from "@workspace/api-client-react";

async function request(path: string, options?: RequestInit) {
  return customFetch<{ shippingTotal: number; dutiesTotal: number }>(`/api${path}`, options);
}

export function PartsEstimateCharges({ jobCardId, editable }: { jobCardId: number; editable: boolean }) {
  const queryClient = useQueryClient();
  const [shipping, setShipping] = useState("0.00");
  const [duties, setDuties] = useState("0.00");
  const [pdfError, setPdfError] = useState("");
  const query = useQuery({
    queryKey: ["parts-estimate-charges", jobCardId],
    queryFn: () => request(`/job-cards/${jobCardId}/parts-charges`),
  });
  useEffect(() => {
    if (query.data) {
      setShipping(Number(query.data.shippingTotal).toFixed(2));
      setDuties(Number(query.data.dutiesTotal).toFixed(2));
    }
  }, [query.data]);
  const save = useMutation({
    mutationFn: () => request(`/job-cards/${jobCardId}/parts-charges`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shippingAmount: shipping, dutiesAmount: duties }),
    }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const print = async () => {
    setPdfError("");
    const popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    try {
      const blob = await customFetch<Blob>(`/api/job-cards/${jobCardId}/parts-estimate.pdf`, { responseType: "blob" });
      const url = URL.createObjectURL(blob);
      if (popup) popup.location.href = url;
      else { const link = document.createElement("a"); link.href = url; link.download = `estimate-${jobCardId}.pdf`; link.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { popup?.close(); setPdfError((error as Error).message); }
  };
  return <div className="space-y-2 border-t border-border pt-3">
    <p className="text-xs text-muted-foreground">Shipping and Duties · GYD · non-taxable</p>
    {query.isPending ? <p>Loading charges…</p> : query.error ? <p role="alert">{query.error.message}</p> : <>
      <label className="flex items-center justify-between gap-3 text-sm">Shipping
        <Input aria-label="Shipping amount" className="w-32" type="number" min="0" step="0.01" value={shipping} disabled={!editable || save.isPending} onChange={e => setShipping(e.target.value)} />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm">Duties
        <Input aria-label="Duties amount" className="w-32" type="number" min="0" step="0.01" value={duties} disabled={!editable || save.isPending} onChange={e => setDuties(e.target.value)} />
      </label>
      {editable && <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save charges"}</Button>}
      <Button size="sm" variant="outline" className="ml-2" onClick={() => void print()}>Print saved estimate</Button>
      {pdfError && <p role="alert" className="text-sm text-destructive">{pdfError}</p>}
      {editable && <p className="text-xs text-muted-foreground">Changing charges supersedes prior customer approval. Send the revised estimate before invoicing. Zero charges do not print.</p>}
      {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
      {save.isSuccess && <p role="status" className="text-xs">Charges saved. Estimate total updated.</p>}
    </>}
  </div>;
}