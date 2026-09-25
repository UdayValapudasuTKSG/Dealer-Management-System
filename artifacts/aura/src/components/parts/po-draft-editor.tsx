import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch, useListParts, useListSuppliers, useListPartsLocations } from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { SearchableSelect } from "@/components/create-record-dialog";
type Line = { id?: number; partId: number; partName: string; quantity: number; unitCost: number; isSpecialOrder: boolean; customerId: number | null; jobCardId: number | null; requisitionLineId: number | null };
export function PoDraftEditor({ po }: { po?: any }) {
  const { can } = useAuthz();
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplier] = useState("");
  const [locationId, setLocation] = useState("");
  const [expectedDate, setExpected] = useState(po?.expectedDate ?? "");
  const [notes, setNotes] = useState(po?.notes ?? "");
  const [partToAdd, setPartToAdd] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const parts = useListParts();
  const suppliers = useListSuppliers();
  const locations = useListPartsLocations();
  const qc = useQueryClient();
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: () => customFetch(`/api/parts/operations/purchase-orders${po ? `/${po.id}/draft` : ""}`, { method: po ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(po ? { expectedDate: expectedDate || null, notes, lines: lines.map(({ partId, partName, ...line }) => line) } : { supplierId: supplierId ? Number(supplierId) : undefined, locationId: Number(locationId), expectedDate: expectedDate || undefined, notes, lines: lines.map(({ id, partName, ...line }) => line) }) }),
    onSuccess: () => { setOpen(false); void qc.invalidateQueries(); toast({ title: po ? "Draft updated" : "Draft PO created" }); },
    onError: error => toast({ title: "Could not save draft", description: error.message, variant: "destructive" }),
  });
  if (!can("parts", "edit") || (po && po.status !== "draft")) return null;
  const update = (i: number, change: Partial<Line>) => setLines(current => current.map((line, n) => n === i ? { ...line, ...change } : line));
  return <><Button variant="outline" onClick={() => { setPartToAdd(""); setLines(po?.lines.map((l: any) => ({ id: l.id, partId: l.partId, partName: l.partName, quantity: l.quantity, unitCost: l.unitCost, isSpecialOrder: l.isSpecialOrder ?? po.source === "special_order", customerId: l.customerId ?? null, jobCardId: l.jobCardId ?? null, requisitionLineId: l.requisitionLineId ?? null })) ?? []); setOpen(true); }}>{po ? "Edit draft / special-order links" : "Create purchase order"}</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90vh] overflow-auto sm:max-w-4xl"><DialogHeader><DialogTitle>{po ? `Edit PO #${po.id}` : "Create purchase order"}</DialogTitle><DialogDescription>Save as Draft, then submit for independent manager review. Customer and job links are validated within this dealership.</DialogDescription></DialogHeader>
    {!po && <div className="grid gap-3 sm:grid-cols-2"><Label>Supplier<select className="block w-full rounded border bg-background p-2" value={supplierId} onChange={e => setSupplier(e.target.value)}><option value="">Select supplier</option>{suppliers.data?.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></Label><Label>Receiving branch<select className="block w-full rounded border bg-background p-2" value={locationId} onChange={e => setLocation(e.target.value)}><option value="">Select location</option>{locations.data?.map(l => <option value={l.id} key={l.id}>{l.name}</option>)}</select></Label></div>}
    <Label>Expected date<Input type="date" value={expectedDate} onChange={e => setExpected(e.target.value)} /></Label><Label>Notes<Input value={notes} onChange={e => setNotes(e.target.value)} /></Label>
    {!po && <div className="space-y-2"><Label>Add a part</Label><SearchableSelect value={partToAdd} onChange={value => {
      setPartToAdd(value);
      const p = parts.data?.find(p => p.id === Number(value));
      if (p) setLines(current => [...current, { partId: p.id, partName: p.name, quantity: 1, unitCost: p.unitCost, isSpecialOrder: false, customerId: null, jobCardId: null, requisitionLineId: null }]);
    }} options={parts.data?.map(p => ({ value: String(p.id), label: `${p.sku} — ${p.name}` })) ?? []} placeholder="Search part number or name…" ariaLabel="Add a part" disabled={parts.isLoading || parts.isError} /></div>}
    {lines.map((line, i) => <div key={i} className="space-y-3 rounded border p-3"><strong>{line.partName}</strong><div className="grid grid-cols-2 gap-3"><Label>Qty ordered<Input type="number" min={1} step={1} value={line.quantity} onChange={e => update(i, { quantity: Number(e.target.value) })} /></Label><Label>Unit cost (GYD)<Input type="number" min={0} step="0.01" value={line.unitCost} onChange={e => update(i, { unitCost: Number(e.target.value) })} /></Label></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={line.isSpecialOrder} onChange={e => update(i, { isSpecialOrder: e.target.checked })} />Special order — notify on receipt</label>{line.isSpecialOrder && <div className="grid gap-3 sm:grid-cols-3">{(["customerId", "jobCardId", "requisitionLineId"] as const).map(key => <Label key={key}>{({ customerId: "Customer ID", jobCardId: "Repair/job card ID", requisitionLineId: "Requisition line ID" })[key]}<Input type="number" min={1} placeholder="Optional" value={line[key] ?? ""} onChange={e => update(i, { [key]: e.target.value ? Number(e.target.value) : null })} /></Label>)}</div>}{!po && <Button variant="ghost" onClick={() => setLines(lines.filter((_, n) => n !== i))}>Remove</Button>}</div>)}
    <Button disabled={save.isPending || !lines.length || (!po && !locationId)} onClick={() => save.mutate()}>Save draft</Button>
  </DialogContent></Dialog></>;
}