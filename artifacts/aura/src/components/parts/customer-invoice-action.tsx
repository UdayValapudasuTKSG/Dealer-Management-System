import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useMoney } from "@/lib/format";

type Preview = {
  invoice: { id: number; invoiceNumber: string } | null;
  customer?: { id: number; name: string };
  lines?: { name: string; quantity: number; unitPrice: number }[];
  subtotal?: number; shippingTotal?: number; dutiesTotal?: number;
  tax?: { taxTotal?: number; lines: { amount: number }[] }; total?: number;
  deposits?: { id: number; invoiceNumber: string; available: string }[];
  canApplyDeposit?: boolean;
  previewFingerprint?: string;
};

export function CustomerInvoiceAction({ sourceType, sourceId, internal = false }: {
  sourceType: "requisition" | "special_order"; sourceId: number; internal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [invoice, setInvoice] = useState<Preview["invoice"]>(null);
  const [documentError, setDocumentError] = useState("");
  const [depositId, setDepositId] = useState("");
  const [depositAmount, setDepositAmount] = useState("0.00");
  const money = useMoney();
  const cache = useQueryClient();
  const path = `/api/parts/billing/${sourceType}/${sourceId}`;
  const preview = useQuery({ queryKey: ["parts-customer-invoice", sourceType, sourceId], enabled: !internal,
    queryFn: () => customFetch<Preview>(path) });
  const generate = useMutation({
    mutationFn: () => customFetch<{ invoice: NonNullable<Preview["invoice"]> }>(path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previewFingerprint: preview.data?.previewFingerprint, ...(depositId ? { depositInvoiceId: Number(depositId), depositAmount } : {}) }) }),
    onSuccess: result => { setInvoice(result.invoice); void cache.invalidateQueries(); },
    onError: () => { void preview.refetch(); },
  });
  const existing = invoice ?? preview.data?.invoice;
  const email = useMutation({ mutationFn: () => customFetch<{ status: string }>(`/api/parts/customer-invoices/${existing!.id}/email`, { method: "POST" }) });
  const print = async () => {
    setDocumentError("");
    const popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    try {
      const blob = await customFetch<Blob>(`/api/parts/customer-invoices/${existing!.id}/pdf`, { responseType: "blob" });
      const url = URL.createObjectURL(blob);
      if (popup) popup.location.href = url;
      else { const link = document.createElement("a"); link.href = url; link.download = `${existing!.invoiceNumber}.pdf`; link.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { popup?.close(); setDocumentError((error as Error).message); }
  };
  if (internal) return <p className="text-xs text-muted-foreground">Internal inventory restock is not customer-billable. No customer invoice is generated.</p>;
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>{existing ? existing.invoiceNumber : sourceType === "requisition" ? "Generate Invoice" : "Invoice Customer"}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-xl">
      <DialogHeader><DialogTitle>Customer parts invoice</DialogTitle><DialogDescription>Customer, quantities and price-list prices come from the originating record. Shipping and Duties are not taxed.</DialogDescription></DialogHeader>
      {existing ? <div className="space-y-3">
        <p>Invoice <strong>{existing.invoiceNumber}</strong> already exists for this source. It cannot be invoiced again.</p>
        <div className="flex gap-2"><Button onClick={() => void print()}>Print / PDF</Button><Button variant="outline" disabled={email.isPending} onClick={() => email.mutate()}>Email invoice</Button></div>
        {email.isSuccess && <p role="status">Email status: {email.data.status}. Queued does not mean delivered.</p>}
        {(email.error || documentError) && <p role="alert">{email.error?.message || documentError}</p>}
        <a href="/finance" className="text-sm underline">View invoice and payments in Finance</a>
      </div> : preview.isPending ? <p>Loading invoice preview…</p> : preview.error ? <p role="alert" className="text-sm text-destructive">{preview.error.message}</p> : <div className="space-y-3">
        <p className="font-medium">{preview.data?.customer?.name}</p>
        <div className="max-h-64 overflow-y-auto">{preview.data?.lines?.map((line, index) => <div key={index} className="flex justify-between gap-3 border-b py-2 text-sm"><span>{line.name} × {line.quantity}</span><span>{money.gyd(line.unitPrice * line.quantity)}</span></div>)}</div>
        {[["Parts subtotal", preview.data?.subtotal], ["Shipping", preview.data?.shippingTotal], ["Duties", preview.data?.dutiesTotal], ["Tax", preview.data?.tax?.lines.reduce((sum, line) => sum + line.amount, 0)], ["Total", preview.data?.total]].map(([label, amount]) => <div key={String(label)} className="flex justify-between text-sm"><span>{label}</span><span>{money.gyd(Number(amount ?? 0))}</span></div>)}
        <p className="text-xs text-muted-foreground">For service-linked parts, current customer approval is required. Invoiced parts and charges are removed from the remaining service estimate; the remainder requires fresh approval.</p>
        {!!preview.data?.deposits?.length && <div className="space-y-2 rounded border p-3">
          <label className="text-sm">Apply an existing customer deposit
            <select aria-label="Customer deposit" className="mt-1 w-full rounded border bg-background p-2" value={depositId} disabled={!preview.data.canApplyDeposit || generate.isPending}
              onChange={event => { setDepositId(event.target.value); const deposit = preview.data?.deposits?.find(d => String(d.id) === event.target.value); setDepositAmount(Math.min(Number(deposit?.available ?? 0), preview.data?.total ?? 0).toFixed(2)); }}>
              <option value="">No deposit credit</option>
              {preview.data.deposits.map(deposit => <option key={deposit.id} value={deposit.id}>{deposit.invoiceNumber} · available {money.gyd(Number(deposit.available))}</option>)}
            </select>
          </label>
          {depositId && <label className="block text-sm">Deposit credit (GYD)<Input aria-label="Deposit credit amount" type="number" min="0.01" step="0.01" value={depositAmount} onChange={e => setDepositAmount(e.target.value)} /></label>}
          <p className="text-xs text-muted-foreground">{preview.data.canApplyDeposit ? "This is a non-cash allocation of money already received. No new receipt is created. Available deposit and invoice balance are checked atomically." : "A finance-authorized user must apply the deposited credit."}</p>
          {depositId && <p className="text-sm font-medium">Balance after deposit: {money.gyd(Math.max(0, (preview.data.total ?? 0) - Number(depositAmount)))}</p>}
        </div>}
        {generate.error && <p role="alert" className="text-sm text-destructive">{generate.error.message}</p>}
        <Button disabled={generate.isPending} onClick={() => generate.mutate()}>{generate.isPending ? "Generating…" : "Generate customer invoice"}</Button>
      </div>}
    </DialogContent></Dialog>
  </>;
}