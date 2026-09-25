import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, getListPartsQueryKey } from "@workspace/api-client-react";
import { MapPin } from "lucide-react";
import { useAuthz } from "@/lib/auth";
import { useCreateTransfer } from "@/hooks/use-parts-operations";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";

type Location = { id: number; name: string; active: boolean };
type Bin = { id: number; locationId: number; code: string; active: boolean };
type Level = { id: number; locationId: number; binId: number | null; quantityOnHand: number; quantityReserved: number; quantityNonSellable: number; quantityAvailable: number };

export function PartStorageDialog({ part }: { part: { id: number; name: string; sku: string; stock: number } }) {
  const { activeDealer, can } = useAuthz();
  const dealerId = activeDealer?.dealerId;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const transfer = useCreateTransfer();
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [binId, setBinId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [assignOnly, setAssignOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const locations = useQuery<Location[]>({
    queryKey: ["parts-locations", dealerId],
    queryFn: () => customFetch("/api/parts/operations/locations"),
    enabled: open && !!dealerId,
    staleTime: 0,
  });
  const bins = useQuery<Bin[]>({
    queryKey: ["parts-bins", dealerId],
    queryFn: () => customFetch("/api/parts/operations/bins"),
    enabled: open && !!dealerId,
    staleTime: 0,
  });
  const levels = useQuery<Level[]>({
    queryKey: ["parts-levels", dealerId, part.id],
    queryFn: () => customFetch(`/api/parts/operations/levels?partId=${part.id}`),
    enabled: open && !!dealerId,
    staleTime: 0,
  });
  useEffect(() => {
    setSourceId("");
    setLocationId("");
    setBinId("");
    setQuantity("");
    setAssignOnly(false);
  }, [open, dealerId, part.id]);

  const activeLocations = locations.data?.filter(item => item.active) ?? [];
  const activeBins = bins.data?.filter(item => item.active && item.locationId === Number(locationId)) ?? [];
  const source = levels.data?.find(item => String(item.id) === sourceId);
  const available = source ? Math.max(0, source.quantityAvailable) : 0;
  const positiveLevels = levels.data?.filter(item => item.quantityOnHand > 0) ?? [];
  const needsTransfer = !assignOnly && (positiveLevels.length > 0 || (levels.data?.length === 0 && part.stock > 0));
  const destinationValid = activeBins.some(bin => String(bin.id) === binId);
  const amount = Number(quantity);
  const sameStorage = source?.locationId === Number(locationId) && source?.binId === Number(binId);
  const ready = destinationValid && (!needsTransfer || (source && !sameStorage && Number.isSafeInteger(amount) && amount > 0 && amount <= available));

  const save = async () => {
    if (!ready || !dealerId) return;
    setSaving(true);
    try {
      if (needsTransfer) {
        if (!source) throw new Error("Select a source with available stock.");
        await transfer.mutateAsync({
          partId: part.id, locationId: source.locationId, binId: source.binId,
          toLocationId: Number(locationId), toBinId: Number(binId),
          quantity: amount, referenceId: `part-storage:${part.id}`,
          idempotencyKey: crypto.randomUUID(),
        });
      } else {
        await customFetch(`/api/parts/operations/parts/${part.id}/storage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locationId: Number(locationId), binId: Number(binId) }),
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["parts-levels"] }),
        queryClient.invalidateQueries({ queryKey: ["parts-ledger"] }),
        queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() }),
      ]);
      toast({ title: needsTransfer ? "Stock relocated" : "Storage bin assigned" });
      setOpen(false);
    } catch (error) {
      toast({ title: "Storage change failed", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
      await levels.refetch();
    } finally {
      setSaving(false);
    }
  };
  const initialize = async () => {
    setSaving(true);
    try {
      await customFetch(`/api/parts/operations/parts/${part.id}/initialize-storage`, { method: "POST" });
      await Promise.all([
        levels.refetch(),
        queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: ["parts-ledger"] }),
      ]);
      toast({ title: "Legacy stock initialized", description: "Choose its source location to move available units." });
    } catch (error) {
      toast({ title: "Could not initialize stock", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (!can("parts", "edit")) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground" aria-label={`Assign or move ${part.name} to a bin`} title="Assign / move storage">
          <MapPin className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign / move storage</DialogTitle>
          <DialogDescription>{part.name} · {part.sku}. Select a bin for zero stock, or move available stock from its current location.</DialogDescription>
        </DialogHeader>
        {locations.isError || bins.isError || levels.isError ? (
          <p className="text-sm text-destructive">Could not load inventory storage. Please retry.</p>
        ) : locations.isLoading || bins.isLoading || levels.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading stock and bins…</p>
        ) : (
          <div className="space-y-4 text-sm">
            {!activeLocations.length && <p>No active locations. Create a location in Locations &amp; Bins first.</p>}
            {!!activeLocations.length && !bins.data?.some(bin => bin.active && activeLocations.some(l => l.id === bin.locationId)) && <p>No active bins. Add a bin under an active location in Locations &amp; Bins first.</p>}
            <div>
              <p className="font-medium mb-1">Current locations</p>
              {levels.data?.length ? levels.data.map(level => (
                <div key={level.id} className="py-1 text-muted-foreground">
                  {locations.data?.find(l => l.id === level.locationId)?.name ?? `Location #${level.locationId}`} / {bins.data?.find(b => b.id === level.binId)?.code ?? "Unbinned"}: {level.quantityOnHand} on hand · {level.quantityReserved} reserved · {level.quantityNonSellable} non-sellable · {level.quantityAvailable} available
                </div>
              )) : <p className="text-muted-foreground">{part.stock > 0 ? `${part.stock} legacy units (default location; initialize before relocating)` : "No stock or storage assignment yet."}</p>}
            </div>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={assignOnly} onChange={e => setAssignOnly(e.target.checked)} />
              <span>Assign this bin for future stock only (leave all current stock and reservations where they are)</span>
            </label>
            {needsTransfer && (
              <>
                <label className="block">Source
                  <select className="w-full mt-1 rounded-md border bg-background p-2" value={sourceId} onChange={e => { setSourceId(e.target.value); setQuantity(""); }}>
                    <option value="">Select stock location</option>
                    {positiveLevels.map(level => <option key={level.id} value={level.id}>
                      {locations.data?.find(l => l.id === level.locationId)?.name ?? `Location #${level.locationId}`} / {bins.data?.find(b => b.id === level.binId)?.code ?? "Unbinned"} ({level.quantityAvailable} available)
                    </option>)}
                  </select>
                </label>
                {part.stock > 0 && !levels.data?.length && <div className="space-y-2">
                  <p className="text-amber-500">Initialize legacy stock at the default location before selecting a source. This records the existing balance; it does not add stock.</p>
                  <Button variant="outline" type="button" disabled={saving} onClick={initialize}>Initialize existing stock</Button>
                </div>}
              </>
            )}
            <label className="block">Destination location
              <select className="w-full mt-1 rounded-md border bg-background p-2" value={locationId} onChange={e => { setLocationId(e.target.value); setBinId(""); }}>
                <option value="">Select location</option>
                {activeLocations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
              </select>
            </label>
            <label className="block">Destination bin
              <select className="w-full mt-1 rounded-md border bg-background p-2" value={binId} onChange={e => setBinId(e.target.value)}>
                <option value="">Select bin</option>
                {activeBins.map(bin => <option key={bin.id} value={bin.id}>{bin.code}</option>)}
              </select>
            </label>
            {locationId && !activeBins.length && <p className="text-amber-500">Add an active bin to this location in Locations &amp; Bins first.</p>}
            {needsTransfer && <label className="block">Quantity to move (available: {available})
              <Input type="number" min={1} max={available} step={1} value={quantity} onChange={e => setQuantity(e.target.value)} className="mt-1" />
            </label>}
            {sameStorage && needsTransfer && <p className="text-amber-500">Choose a different destination.</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={!ready || saving || locations.isLoading || bins.isLoading || levels.isLoading || locations.isError || bins.isError || levels.isError}>{saving ? "Saving…" : needsTransfer ? "Move stock" : "Assign bin"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}