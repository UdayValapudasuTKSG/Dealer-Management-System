import { useState } from "react";
import { formatGuyanaDate, useMoney } from "@/lib/format";
import { useGetInventoryLedger, useGetInventoryHolds, useExpireHolds, useReleaseHold, useCreateHold, useConsumeHold, useCreateIssue, useCreateAdjustment, useCreateTransfer, useGetLocations, useGetBins, useGetInventoryLevels, useCreateOtcInvoice } from "@/hooks/use-parts-operations";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Clock, History, AlertTriangle, ArrowRightLeft, PackageMinus, PackagePlus, CheckCircle2, RotateCcw, Box, Loader2, Calendar, Plus, Receipt, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { useListParts } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { PartBarcodeScanner } from "./part-barcode-scanner";
import { useAuthz } from "@/lib/auth";

type PartOption = { id: number; sku: string; name: string; barcode?: string | null };
type LocationOption = { id: number; name: string; active?: boolean };
type BinOption = { id: number; locationId: number; code: string; active?: boolean };
type InventoryLevel = {
  id: number;
  partId: number;
  locationId: number;
  binId?: number | null;
  quantityOnHand: number;
  quantityReserved: number;
  quantityNonSellable: number;
  quantityAvailable: number;
};

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "The stock operation could not be completed.";
}

function resolveScannedPart(parts: PartOption[], value: string) {
  const normalized = value.trim().toLocaleLowerCase();
  return parts.find(
    (part) =>
      part.sku.toLocaleLowerCase() === normalized ||
      part.barcode?.toLocaleLowerCase() === normalized,
  );
}

export function LedgerTab() {
  const { data: ledger, isLoading, isError } = useGetInventoryLedger({ limit: 100 });
  const money = useMoney();
  const { can } = useAuthz();
  const canEdit = can("parts", "edit");
  const canApprove = can("parts", "approve");
  const partsQuery = useListParts();
  const locationsQuery = useGetLocations();
  const binsQuery = useGetBins();
  const parts = (partsQuery.data ?? []) as PartOption[];
  const locations = (locationsQuery.data ?? []) as LocationOption[];
  const bins = (binsQuery.data ?? []) as BinOption[];

  if (isLoading) {
    return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  }

  if (isError) {
    return <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">Could not load inventory transactions. Try again.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="text-lg font-bold tracking-tight">Recent Transactions</h2>
        <div className="flex flex-wrap gap-2">
          {canEdit && <OTCInvoiceDialog />}
          {canEdit && <TransactionDialog type="issue" />}
          {canEdit && <TransactionDialog type="transfer" />}
          {canApprove && <TransactionDialog type="adjustment" />}
        </div>
      </div>
      <InventoryDrilldown />
      {!ledger?.length ? (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-12 flex flex-col items-center gap-3">
          <History className="w-8 h-8 text-muted-foreground" />
          <p className="text-muted-foreground">No transactions found. Use an action above to record the first movement.</p>
        </div>
      ) : <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 font-semibold">Date</th>
              <th className="px-4 py-3 font-semibold">Type</th>
              <th className="px-4 py-3 font-semibold">Part</th>
              <th className="px-4 py-3 font-semibold">Location</th>
              <th className="px-4 py-3 font-semibold text-right">Qty</th>
              <th className="px-4 py-3 font-semibold text-right hidden sm:table-cell">Value</th>
              <th className="px-4 py-3 font-semibold text-right">Ref</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((tx) => {
              const isPositive = tx.quantityDelta > 0;
              const isNegative = tx.quantityDelta < 0;
              const part = parts.find((item) => item.id === tx.partId);
              const location = locations.find((item) => item.id === tx.locationId);
              const bin = bins.find((item) => item.id === tx.binId);
              
              let TypeIcon = Box;
              if (tx.type === 'receipt') TypeIcon = PackagePlus;
              if (tx.type === 'issue') TypeIcon = PackageMinus;
              if (tx.type === 'transfer') TypeIcon = ArrowRightLeft;
              if (tx.type === 'adjustment') TypeIcon = AlertTriangle;
              if (tx.type === 'return') TypeIcon = RotateCcw;

              return (
                <tr key={tx.id} className="border-b border-white/5 hover:bg-foreground/[0.03] transition-colors">
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                    {formatGuyanaDate(tx.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <TypeIcon className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="capitalize">{tx.type}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-medium">{part ? `${part.sku} — ${part.name}` : `Part #${tx.partId}`}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {location?.name ?? `Location #${tx.locationId}`}{tx.binId ? ` / ${bin?.code ?? `Bin #${tx.binId}`}` : ""}
                  </td>
                  <td className={cn(
                    "px-4 py-3 text-right font-semibold tabular-nums",
                    isPositive && "text-emerald-400",
                    isNegative && "text-rose-400"
                  )}>
                    {isPositive ? '+' : ''}{tx.quantityDelta}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums hidden sm:table-cell text-muted-foreground">
                    {money.gyd(tx.valueDelta || 0)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Badge variant="outline" className="font-mono text-[10px] bg-white/[0.02]">
                      {tx.referenceType} {tx.referenceId}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>}
    </div>
  );
}

export function HoldsTab() {
  const { data: holds, isLoading, isError } = useGetInventoryHolds({ status: "active" });
  const expire = useExpireHolds();
  const release = useReleaseHold();
  const consume = useConsumeHold();
  const { can } = useAuthz();
  const canEdit = can("parts", "edit");
  const { toast } = useToast();
  const partsQuery = useListParts();
  const locationsQuery = useGetLocations();
  const binsQuery = useGetBins();
  const parts = (partsQuery.data ?? []) as PartOption[];
  const locations = (locationsQuery.data ?? []) as LocationOption[];
  const bins = (binsQuery.data ?? []) as BinOption[];
  
  if (isLoading) {
    return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  }

  if (isError) {
    return <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">Could not load inventory holds. Try again.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold tracking-tight">Active Holds</h2>
        <div className="flex gap-2">
          {canEdit && <CreateHoldDialog />}
          {canEdit && <Button
            variant="outline"
            size="sm"
            className="rounded-full gap-2 border-white/10"
            onClick={() => expire.mutate(undefined, {
              onError: (error) => toast({ title: "Could not expire holds", description: errorMessage(error), variant: "destructive" }),
            })}
            disabled={expire.isPending || !holds?.length}
          >
            {expire.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
            Expire Old
          </Button>}
        </div>
      </div>

      {!holds?.length ? (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3">
          <CheckCircle2 className="w-8 h-8 text-muted-foreground" />
          <p className="text-muted-foreground">No active inventory holds.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {holds.map(hold => {
            const isAtRisk = hold.backorderRisk;
            const expiresSoon = new Date(hold.expiresAt).getTime() - Date.now() < 86400000;
            const part = parts.find((item) => item.id === hold.partId);
            const location = locations.find((item) => item.id === hold.locationId);
            const bin = bins.find((item) => item.id === hold.binId);
            
            return (
              <Card key={hold.id} className="glass-panel border-none rounded-2xl relative overflow-hidden">
                {isAtRisk && <div className="absolute top-0 inset-x-0 h-1 bg-destructive" />}
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-1.5">
                        <Box className="w-3 h-3" />
                         {part ? `${part.sku} — ${part.name}` : `Part #${hold.partId}`}
                      </div>
                      <div className="font-medium mt-1 uppercase text-xs">
                        {hold.referenceType} {hold.referenceId}
                      </div>
                       <div className="mt-1 text-xs text-muted-foreground normal-case">
                         {location?.name ?? `Location #${hold.locationId}`}{hold.binId ? ` / ${bin?.code ?? `Bin #${hold.binId}`}` : ""}
                       </div>
                    </div>
                    <Badge variant={isAtRisk ? "destructive" : "secondary"} className="text-[10px] font-bold tracking-widest uppercase">
                      Qty {hold.quantity}
                    </Badge>
                  </div>
                  
                  <div className="flex items-center justify-between pt-2 border-t border-white/5">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {hold.expiresAt ? (
                        <>
                          <Calendar className={cn("w-3.5 h-3.5", expiresSoon && "text-amber-400")} />
                          <span className={cn(expiresSoon && "text-amber-400")}>
                            Exp {new Date(hold.expiresAt).toLocaleDateString()}
                          </span>
                        </>
                      ) : (
                        <span>No expiry</span>
                      )}
                    </div>
                    {canEdit && <div className="flex gap-1">
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-7 text-xs px-2 hover:bg-white/5 hover:text-emerald-400 transition-colors"
                        onClick={() => consume.mutate(hold.id, {
                          onError: (error) => toast({ title: "Could not consume hold", description: errorMessage(error), variant: "destructive" }),
                        })}
                        disabled={consume.isPending || release.isPending}
                      >
                        Consume
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-7 text-xs px-2 hover:bg-white/5 hover:text-destructive transition-colors"
                        onClick={() => release.mutate(hold.id, {
                          onError: (error) => toast({ title: "Could not release hold", description: errorMessage(error), variant: "destructive" }),
                        })}
                        disabled={release.isPending || consume.isPending}
                      >
                        Release
                      </Button>
                    </div>}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InventoryDrilldown() {
  const [locationId, setLocationId] = useState("");
  const [binId, setBinId] = useState("");
  const { data: parts } = useListParts();
  const locationsQuery = useGetLocations();
  const binsQuery = useGetBins(locationId ? Number(locationId) : undefined);
  const levelsQuery = useGetInventoryLevels({
    locationId: locationId ? Number(locationId) : undefined,
    binId: binId ? Number(binId) : undefined,
  });
  const partOptions = (parts ?? []) as PartOption[];
  const locations = (locationsQuery.data ?? []) as LocationOption[];
  const bins = (binsQuery.data ?? []) as BinOption[];
  const levels = (levelsQuery.data ?? []) as InventoryLevel[];

  return (
    <Card className="glass-panel border-white/10">
      <CardContent className="space-y-3 p-4">
        <div>
          <h3 className="font-semibold">Stock by location and bin</h3>
          <p className="text-xs text-muted-foreground">Drill down to on-hand, reserved, non-sellable, and available quantities.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <StyledSelect
            value={locationId}
            onValueChange={(value) => {
              setLocationId(value);
              setBinId("");
            }}
            options={[
              { value: "", label: "All locations" },
              ...locations.filter((location) => location.active !== false).map((location) => ({
                value: String(location.id),
                label: location.name,
              })),
            ]}
            className="h-9 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm"
          />
          <StyledSelect
            value={binId}
            onValueChange={setBinId}
            disabled={!locationId || binsQuery.isLoading}
            options={[
              { value: "", label: binsQuery.isLoading ? "Loading bins…" : "All bins" },
              ...bins.filter((bin) => bin.active !== false).map((bin) => ({
                value: String(bin.id),
                label: bin.code,
              })),
            ]}
            className="h-9 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm"
          />
        </div>
        {(locationsQuery.isError || binsQuery.isError || levelsQuery.isError) && (
          <p role="alert" className="text-sm text-destructive">Could not load the inventory drilldown. Try again.</p>
        )}
        {levelsQuery.isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading stock levels…
          </div>
        ) : levels.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No stock rows match this scope.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full min-w-[650px] text-sm">
              <thead className="bg-white/[0.03] text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Part</th>
                  <th className="px-3 py-2 text-left">Location / bin</th>
                  <th className="px-3 py-2 text-right">On hand</th>
                  <th className="px-3 py-2 text-right">Reserved</th>
                  <th className="px-3 py-2 text-right">Non-sellable</th>
                  <th className="px-3 py-2 text-right">Available</th>
                </tr>
              </thead>
              <tbody>
                {levels.map((level) => {
                  const part = partOptions.find((item) => item.id === level.partId);
                  const location = locations.find((item) => item.id === level.locationId);
                  const bin = bins.find((item) => item.id === level.binId);
                  return (
                    <tr key={level.id} className="border-t border-white/5">
                      <td className="px-3 py-2 font-medium">{part ? `${part.sku} — ${part.name}` : `Part #${level.partId}`}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {location?.name ?? `Location #${level.locationId}`}{level.binId ? ` / ${bin?.code ?? `Bin #${level.binId}`}` : ""}
                      </td>
                      <td className="px-3 py-2 text-right">{level.quantityOnHand}</td>
                      <td className="px-3 py-2 text-right">{level.quantityReserved}</td>
                      <td className="px-3 py-2 text-right">{level.quantityNonSellable}</td>
                      <td className="px-3 py-2 text-right font-semibold">{level.quantityAvailable}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TransactionDialog({ type }: { type: "issue" | "transfer" | "adjustment" }) {
  const { toast } = useToast();
  const [sourceLocationId, setSourceLocationId] = useState("");
  const [destinationLocationId, setDestinationLocationId] = useState("");
  const issue = useCreateIssue();
  const transfer = useCreateTransfer();
  const adjust = useCreateAdjustment();
  const partsQuery = useListParts();
  const locationsQuery = useGetLocations();
  const binsQuery = useGetBins();
  const parts = (partsQuery.data ?? []) as PartOption[];
  const locations = (locationsQuery.data ?? []) as LocationOption[];
  const bins = (binsQuery.data ?? []) as BinOption[];

  const isIssue = type === "issue";
  const isTransfer = type === "transfer";
  const isAdjust = type === "adjustment";

  const mutation = isIssue ? issue : isTransfer ? transfer : adjust;
  const title = isIssue ? "Direct Stock Issue (Picking)" : isTransfer ? "Transfer Stock" : "Adjust Inventory";
  const icon = isIssue ? <PackageMinus className="w-3.5 h-3.5" /> : isTransfer ? <ArrowRightLeft className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />;

  const fields: any[] = [
    {
      name: "partId",
      label: "Part",
      type: "custom",
      required: true,
      span: "full",
      render: (value: string, set: (value: string) => void) => (
        <div className="flex flex-col gap-2 sm:flex-row">
          <StyledSelect
            value={value}
            onValueChange={set}
            options={[
              { value: "", label: partsQuery.isLoading ? "Loading parts…" : "Select part…" },
              ...parts.map((part) => ({ value: String(part.id), label: `${part.sku} — ${part.name}` })),
            ]}
            disabled={partsQuery.isLoading || partsQuery.isError}
            className="h-9 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm"
          />
          <PartBarcodeScanner
            disabled={partsQuery.isLoading || partsQuery.isError}
            onScan={(scanned) => {
              const match = resolveScannedPart(parts, scanned);
              if (match) {
                set(String(match.id));
                toast({ title: "Part selected", description: `${match.sku} — ${match.name}` });
              } else {
                toast({ title: "Part not found", description: `No SKU or barcode matches “${scanned}”.`, variant: "destructive" });
              }
            }}
          />
        </div>
      ),
    },
    {
      name: "locationId",
      label: isTransfer ? "From Location" : "Location",
      type: "select",
      required: true,
      span: "half",
      options: locations.filter((location) => location.active !== false).map((location) => ({ value: String(location.id), label: location.name })),
      onChange: (value: string, _autofill: unknown, setField: (name: string, value: string) => void) => {
        setSourceLocationId(value);
        setField("binId", "");
      },
    },
    {
      name: "binId",
      label: "Source bin (optional)",
      type: "select",
      span: "half",
      options: bins.filter((bin) => bin.active !== false && (!sourceLocationId || String(bin.locationId) === sourceLocationId)).map((bin) => ({
        value: String(bin.id),
        label: `${locations.find((location) => location.id === bin.locationId)?.name ?? `Location #${bin.locationId}`} — ${bin.code}`,
      })),
    },
  ];

  if (isTransfer) {
    fields.push(
      {
        name: "toLocationId",
        label: "To Location",
        type: "select",
        required: true,
        span: "half",
        options: locations.filter((location) => location.active !== false).map((location) => ({ value: String(location.id), label: location.name })),
        onChange: (value: string, _autofill: unknown, setField: (name: string, value: string) => void) => {
          setDestinationLocationId(value);
          setField("toBinId", "");
        },
      },
      {
        name: "toBinId",
        label: "Destination bin (optional)",
        type: "select",
        span: "half",
        options: bins.filter((bin) => bin.active !== false && (!destinationLocationId || String(bin.locationId) === destinationLocationId)).map((bin) => ({
          value: String(bin.id),
          label: `${locations.find((location) => location.id === bin.locationId)?.name ?? `Location #${bin.locationId}`} — ${bin.code}`,
        })),
      },
    );
  }

  fields.push({
    name: isAdjust ? "quantityDelta" : "quantity",
    label: isAdjust ? "Quantity Delta (+/-)" : "Quantity",
    type: "number",
    required: true,
    span: "half",
    min: isAdjust ? undefined : 1,
    validate: (value: string) => Number.isInteger(Number(value)) && Number(value) !== 0 ? null : "Enter a whole, non-zero quantity",
  });

  if (isAdjust) {
    fields.push({ name: "reason", label: "Reason Code", type: "text", required: true, span: "half" });
    fields.push({ name: "unitCost", label: "Unit Cost (optional override)", type: "number", span: "full" });
    fields.push({
      name: "approvalConfirmed",
      label: "Approval confirmation",
      type: "custom",
      required: true,
      span: "full",
      render: (value: string, set: (value: string) => void) => (
        <label className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm">
          <Checkbox
            checked={value === "confirmed"}
            onCheckedChange={(checked) => set(checked === true ? "confirmed" : "")}
            aria-label="Confirm inventory adjustment approval"
          />
          <span>I approve this audited manual stock adjustment and have verified the physical quantity.</span>
        </label>
      ),
    });
  }

  fields.push(
    { name: "referenceId", label: "Reference ID", type: "text", required: true, span: "half" },
    { name: "notes", label: "Notes", type: "text", span: "full" }
  );

  return (
    <CreateRecordDialog
      title={title}
      description={`Record a manual ${type} transaction in the ledger.`}
      pending={mutation.isPending}
      submitLabel={`Record ${type}`}
      trigger={
        <Button variant="outline" size="sm" className="rounded-full gap-2 border-white/10">
          {icon} <span className="hidden sm:inline capitalize">{type}</span>
        </Button>
      }
      fields={fields as any}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        if (partsQuery.isError || locationsQuery.isError || binsQuery.isError) {
          throw new Error("Part locations or bins could not be loaded. Reload and try again.");
        }
        const payload: any = {
          partId: Number(v.partId),
          locationId: Number(v.locationId),
          ...(v.binId ? { binId: Number(v.binId) } : {}),
          referenceId: String(v.referenceId),
          idempotencyKey: crypto.randomUUID(),
          ...(v.notes ? { notes: String(v.notes) } : {}),
        };

        if (isTransfer) {
          payload.toLocationId = Number(v.toLocationId);
          if (v.toBinId) payload.toBinId = Number(v.toBinId);
          payload.quantity = Number(v.quantity);
        } else if (isAdjust) {
          payload.quantityDelta = Number(v.quantityDelta);
          payload.reason = String(v.reason);
          if (v.unitCost !== undefined) payload.unitCost = Number(v.unitCost);
        } else {
          payload.quantity = Number(v.quantity);
        }

        await mutation.mutateAsync(payload);
        toast({ title: `${title} completed` });
      }}
    />
  );
}

function CreateHoldDialog() {
  const { toast } = useToast();
  const [locationId, setLocationId] = useState("");
  const create = useCreateHold();
  const partsQuery = useListParts();
  const locationsQuery = useGetLocations();
  const binsQuery = useGetBins();
  const parts = (partsQuery.data ?? []) as PartOption[];
  const locations = (locationsQuery.data ?? []) as LocationOption[];
  const bins = (binsQuery.data ?? []) as BinOption[];

  return (
    <CreateRecordDialog
      title="Create Hold"
      description="Reserve parts for an estimate, quote, or job."
      pending={create.isPending}
      submitLabel="Create Hold"
      trigger={
        <Button size="sm" variant="outline" className="rounded-full gap-2 border-white/10 bg-primary/10 text-primary hover:bg-primary/20 border-primary/20">
          <Plus className="w-3.5 h-3.5" /> New Hold
        </Button>
      }
      fields={[
        {
          name: "partId",
          label: "Part",
          type: "custom",
          required: true,
          span: "full",
          render: (value: string, set: (value: string) => void) => (
            <div className="flex flex-col gap-2 sm:flex-row">
              <StyledSelect
                value={value}
                onValueChange={set}
                options={[
                  { value: "", label: partsQuery.isLoading ? "Loading parts…" : "Select part…" },
                  ...parts.map((part) => ({ value: String(part.id), label: `${part.sku} — ${part.name}` })),
                ]}
                disabled={partsQuery.isLoading || partsQuery.isError}
                className="h-9 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm"
              />
              <PartBarcodeScanner
                disabled={partsQuery.isLoading || partsQuery.isError}
                onScan={(scanned) => {
                  const match = resolveScannedPart(parts, scanned);
                  if (match) set(String(match.id));
                  else toast({ title: "Part not found", description: `No SKU or barcode matches “${scanned}”.`, variant: "destructive" });
                }}
              />
            </div>
          ),
        },
        {
          name: "locationId",
          label: "Location",
          type: "select",
          required: true,
          span: "half",
          options: locations.filter((location) => location.active !== false).map((location) => ({ value: String(location.id), label: location.name })),
          onChange: (value: string, _autofill: unknown, setField: (name: string, value: string) => void) => {
            setLocationId(value);
            setField("binId", "");
          },
        },
        {
          name: "binId",
          label: "Bin (optional)",
          type: "select",
          span: "half",
          options: bins.filter((bin) => bin.active !== false && (!locationId || String(bin.locationId) === locationId)).map((bin) => ({
            value: String(bin.id),
            label: `${locations.find((location) => location.id === bin.locationId)?.name ?? `Location #${bin.locationId}`} — ${bin.code}`,
          })),
        },
        { name: "quantity", label: "Quantity", type: "number", required: true, min: 1, span: "half", validate: (value: string) => Number.isInteger(Number(value)) ? null : "Enter a whole quantity" },
        { 
          name: "referenceType", 
          label: "Reference Type", 
          type: "select", 
          required: true, 
          span: "half",
          options: [{value: "job", label: "Job"}, {value: "estimate", label: "Estimate"}, {value: "quote", label: "Quote"}],
          defaultValue: "job"
        },
        { name: "referenceId", label: "Existing quote / estimate / job ID", type: "number", required: true, min: 1, span: "half" },
        { name: "expiresAt", label: "Expires At", type: "date", span: "half" },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        if (partsQuery.isError || locationsQuery.isError || binsQuery.isError) {
          throw new Error("Parts, locations, or bins could not be loaded. Reload and try again.");
        }
        await create.mutateAsync({
          partId: Number(v.partId),
          locationId: Number(v.locationId),
          ...(v.binId ? { binId: Number(v.binId) } : {}),
          quantity: Number(v.quantity),
          referenceType: String(v.referenceType),
          referenceId: Number(v.referenceId),
          ...(v.expiresAt ? { expiresAt: String(v.expiresAt) } : {}),
        });
        toast({ title: "Hold created" });
      }}
    />
  );
}

function OTCInvoiceDialog() {
  const { toast } = useToast();
  const create = useCreateOtcInvoice();
  const { data: parts } = useListParts();
  const { data: locations } = useGetLocations();
  const [open, setOpen] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [lines, setLines] = useState<{ partId: string; locationId: string; quantity: string }[]>([
    { partId: "", locationId: "", quantity: "1" },
  ]);

  const reset = () => {
    setCustomerName("");
    setLines([{ partId: "", locationId: "", quantity: "1" }]);
  };

  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    if (!customerName.trim()) {
      toast({ title: "Customer Name Required", variant: "destructive" });
      return;
    }

    const parsedLines = lines
      .filter((l) => l.partId && l.locationId)
      .map((l) => ({
        partId: Number(l.partId),
        locationId: Number(l.locationId),
        quantity: Math.max(1, Math.floor(Number(l.quantity) || 1)),
      }));

    if (parsedLines.length === 0) {
      toast({ title: "Add at least one complete line", variant: "destructive" });
      return;
    }

    try {
      await create.mutateAsync({
        payload: {
          customerName: customerName.trim(),
          lines: parsedLines,
        },
        idempotencyKey: crypto.randomUUID(),
      });
      toast({ title: "OTC Invoice created", description: "Stock issued and invoice generated." });
      setOpen(false);
      reset();
    } catch (err: any) {
      toast({ title: "Could not create invoice", description: err.message || "An error occurred", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="rounded-full gap-2 bg-primary text-white hover:bg-primary/90">
          <Receipt className="w-3.5 h-3.5" /> <span className="hidden sm:inline">OTC Invoice</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="glass-panel border-white/10 sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="text-xl tracking-tight">Over-the-Counter Sale</DialogTitle>
          <DialogDescription>
            Issue parts immediately and generate a real finance invoice for walk-in customers.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Customer Name</label>
            <Input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Walk-in Customer"
              className="h-9 rounded-xl bg-white/[0.04] border-white/10"
            />
          </div>
          
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_120px_80px_36px] gap-2 text-[10px] uppercase tracking-widest text-muted-foreground px-1">
              <span>Part</span>
              <span>Location</span>
              <span>Qty</span>
              <span />
            </div>
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_80px_36px] gap-2">
                <StyledSelect
                  value={line.partId}
                  onValueChange={(value) => setLine(i, { partId: value })}
                  options={[
                    { value: "", label: "Select part…" },
                    ...(parts?.map((p: any) => ({
                      value: String(p.id),
                      label: `${p.sku} — ${p.name}`,
                    })) ?? []),
                  ]}
                  className="h-9 rounded-xl bg-white/[0.04] border border-white/10 px-3 text-sm min-w-0"
                />
                <StyledSelect
                  value={line.locationId}
                  onValueChange={(value) => setLine(i, { locationId: value })}
                  options={[
                    { value: "", label: "Location" },
                    ...(locations?.map((l: any) => ({
                      value: String(l.id),
                      label: l.name,
                    })) ?? []),
                  ]}
                  className="h-9 rounded-xl bg-white/[0.04] border border-white/10 px-3 text-sm min-w-0"
                />
                <Input
                  type="number"
                  min={1}
                  value={line.quantity}
                  onChange={(e) => setLine(i, { quantity: e.target.value })}
                  className="h-9 rounded-xl bg-white/[0.04] border-white/10 text-right"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-xl text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                  disabled={lines.length === 1}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="rounded-full gap-2 border-white/15 h-8 mt-2"
              onClick={() => setLines((prev) => [...prev, { partId: "", locationId: "", quantity: "1" }])}
            >
              <Plus className="w-3.5 h-3.5" /> Add line
            </Button>
          </div>
        </div>
        <DialogFooter className="mt-6">
          <Button
            onClick={submit}
            disabled={create.isPending}
            className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2 w-full sm:w-auto"
          >
            {create.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Generate Invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
