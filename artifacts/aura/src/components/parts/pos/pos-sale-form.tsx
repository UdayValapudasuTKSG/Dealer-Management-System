import { useMemo, useState } from "react";
import { Loader2, Plus, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { useMoney } from "@/lib/format";
import { errorText, round2, usePosAction, useRequestKey, type PosState, type Tender } from "./pos-api";
import { ErrorBox, Field, TenderRows, fieldCls, tenderTotal, validTenders } from "./pos-shared";
import { PartBarcodeScanner } from "../part-barcode-scanner";
import { matchingParts } from "../barcode-match";
import { CreatePartDialog } from "../create-part-dialog";
import { useAuthz } from "@/lib/auth";
import { listParts } from "@workspace/api-client-react";

type Row = { partId: string; quantity: number };

export function PosSaleForm({ state }: { state: PosState }) {
  const { can } = useAuthz();
  const [unknownBarcode, setUnknownBarcode] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const money = useMoney();
  const { toast } = useToast();
  const act = usePosAction();
  const rk = useRequestKey();
  const [reference, setReference] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [rows, setRows] = useState<Row[]>([{ partId: "", quantity: 1 }]);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const mapped = useMemo(() => new Set(state.config.items.map((i) => i.partId)), [state.config.items]);
  const partOpts = state.parts.map((p) => ({ value: String(p.id), label: `${p.sku} — ${p.name}${mapped.has(p.id) ? "" : " (unmapped)"}` }));
  const net = rows.reduce((s, r) => s + (state.parts.find((p) => String(p.id) === r.partId)?.unitPrice ?? 0) * (r.quantity || 0), 0);
  const rate = state.config.taxRate ?? 14;
  const tax = round2(net * rate / 100);
  const total = round2(net + tax);
  const paid = tenderTotal(tenders);
  const onAccount = paid < total - 0.005;

  const submit = () => {
    setErr(null);
    const lines = rows.filter((r) => r.partId && r.quantity > 0).map((r) => ({ partId: Number(r.partId), quantity: Math.floor(r.quantity) }));
    if (!reference.trim()) return setErr("Reference is required.");
    if (!lines.length) return setErr("Add at least one part.");
    if (onAccount && !customerId) return setErr("Unpaid or partially paid sales are account sales and require a customer.");
    const input = { kind: "sale" as const, reference: reference.trim(), ...(customerId ? { customerId: Number(customerId) } : {}), ...(customerName.trim() ? { customerName: customerName.trim() } : {}), lines, tenders: validTenders(tenders) };
    act.mutate(
      { action: "submit", requestKey: rk.keyFor(input), input },
      {
        onSuccess: () => { rk.reset(); toast({ title: "Sale submitted for Finance approval" }); setReference(""); setRows([{ partId: "", quantity: 1 }]); setTenders([]); setCustomerId(""); setCustomerName(""); },
        onError: (e) => setErr(errorText(e)),
      },
    );
  };

  return (
    <div className="glass-panel rounded-2xl p-4 space-y-4">
      <PartBarcodeScanner disabled={!state.canEdit || act.isPending || lookingUp} onScan={async value => {
        setUnknownBarcode("");
        const matches = matchingParts(state.parts, value);
        if (matches.length !== 1) {
          if (matches.length) { setErr("Barcode matches multiple parts; select the correct part manually."); return; }
          setLookingUp(true);
          try {
            const catalogueMatches = matchingParts(await listParts({ search: value }), value);
            if (catalogueMatches.length) setErr("This code exists in the catalogue but is not available in this POS list. Check its active status or refresh the parts counter.");
            else { setUnknownBarcode(value); setErr("No part matches this barcode or SKU in this dealership."); }
          } catch { setErr("Could not check the catalogue. Please retry the scan."); }
          finally { setLookingUp(false); }
          return;
        }
        const id = String(matches[0].id);
        setRows(current => current.some(r => r.partId === id)
          ? current.map(r => r.partId === id ? { ...r, quantity: r.quantity + 1 } : r)
          : [...current.filter(r => r.partId), { partId: id, quantity: 1 }]);
        setErr(null);
      }} />
      {lookingUp && <p role="status" className="text-sm">Checking the parts catalogue…</p>}
      {unknownBarcode && can("parts", "create") && <div className="space-y-2 text-sm">
        <p>Add a missing part with barcode <strong>{unknownBarcode}</strong>. New parts need stock and ERP mappings before they can be posted through POS.</p>
        <CreatePartDialog key={unknownBarcode} initialBarcode={unknownBarcode} />
      </div>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} className={fieldCls} placeholder="Counter slip no." data-testid="input-sale-reference" /></Field>
        <Field label="Account customer" hint="Required when not fully paid"><SearchableSelect value={customerId} onChange={setCustomerId} options={[{ value: "", label: "Walk-in (no account)" }, ...state.customers.map((c) => ({ value: String(c.id), label: c.name }))]} placeholder="Walk-in" ariaLabel="Customer" className="rounded-xl" /></Field>
        <Field label="Name on receipt"><Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className={fieldCls} placeholder="Optional" /></Field>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => {
          const p = state.parts.find((x) => String(x.id) === r.partId);
          return (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_90px_120px_auto] items-center">
              <SearchableSelect value={r.partId} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, partId: v } : x)))} options={partOpts} placeholder="Select part…" ariaLabel={`Part line ${i + 1}`} className="rounded-xl" />
              <Input type="number" min={1} step={1} value={r.quantity} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} className={`${fieldCls} text-right`} data-testid={`input-sale-qty-${i}`} />
              <span className="text-right text-sm tabular-nums text-muted-foreground">{p ? money.gyd((p.unitPrice ?? 0) * (r.quantity || 0)) : "—"}</span>
              <Button size="icon" variant="ghost" className="h-9 w-9" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove line"><Trash2 className="h-3.5 w-3.5" /></Button>
              {p && <p className="sm:col-span-4 text-xs text-muted-foreground">{p.make || "Brand not recorded"} · Unit price {money.gyd(p.unitPrice)} · {p.quantityAvailable != null ? `Available ${p.quantityAvailable}` : `Stock on hand ${p.stock ?? "not available"}`}</p>}
            </div>
          );
        })}
        <Button size="sm" variant="outline" className="rounded-full gap-1 border-white/10" onClick={() => setRows([...rows, { partId: "", quantity: 1 }])} data-testid="button-add-line"><Plus className="h-3.5 w-3.5" /> Add part</Button>
      </div>
      <Field label="Tenders" hint="Leave empty for a full account sale."><TenderRows sources={state.config.sources} tenders={tenders} onChange={setTenders} /></Field>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-xl bg-white/[0.04] p-3 text-sm tabular-nums">
        <div><div className="text-[11px] text-muted-foreground">Net (VAT excl.)</div>{money.gyd(net)}</div>
        <div><div className="text-[11px] text-muted-foreground">VAT {rate}%{state.config.taxApproved ? "" : " (unapproved)"}</div>{money.gyd(tax)}</div>
        <div><div className="text-[11px] text-muted-foreground">Est. total</div><b>{money.gyd(total)}</b></div>
        <div><div className="text-[11px] text-muted-foreground">On account</div>{money.gyd(Math.max(0, total - paid))}</div>
      </div>
      <p className="text-[11px] text-muted-foreground">Estimate only — prices and VAT are recalculated by the server from part prices at submission.</p>
      <ErrorBox message={err} />
      <div className="flex justify-end"><Button className="rounded-full gap-2" disabled={act.isPending || !state.canEdit} onClick={submit} data-testid="button-submit-sale">{act.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Submit sale</Button></div>
    </div>
  );
}
