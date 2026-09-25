import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch, useListParts } from "@workspace/api-client-react";
import { formatGuyanaDate } from "@/lib/format";
import { useGetCycleCounts, useCreateCycleCount, useUpdateCycleCountLines, useApproveCycleCount, useCancelCycleCount } from "@/hooks/use-parts-operations";
import { useGetLocations, useGetBins } from "@/hooks/use-parts-operations";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Play, Check, ClipboardCheck, Loader2, Save, Download } from "lucide-react";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { PartBarcodeScanner } from "./part-barcode-scanner";
import { downloadPartsReport } from "./parts-analysis-export";

export function CycleCountsTab() {
  const { data: counts, isLoading, isError } = useGetCycleCounts();
  const [activeCountId, setActiveCountId] = useState<number | null>(null);

  if (isLoading) {
    return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  }

  if (isError) return <div role="alert" className="p-4 text-destructive">Cycle counts could not be loaded. Please retry.</div>;
  if (activeCountId) {
    const activeCount = counts?.find(c => c.id === activeCountId);
    if (!activeCount) return <div role="alert" className="p-4 text-destructive">This count is no longer available. <Button variant="ghost" onClick={() => setActiveCountId(null)}>Back to counts</Button></div>;
    return <ActiveCountView count={activeCount} onBack={() => setActiveCountId(null)} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold tracking-tight">Cycle Counts</h2>
        <StartCountDialog />
      </div>

      {!counts?.length ? (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3">
          <ClipboardCheck className="w-8 h-8 text-muted-foreground" />
          <p className="text-muted-foreground">No cycle counts active or completed.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {counts.map(count => (
            <Card 
              key={count.id} 
              className={cn(
                "glass-panel border-none rounded-2xl transition-all",
                "ring-1 ring-primary/50 cursor-pointer hover:-translate-y-0.5"
              )}
              onClick={() => setActiveCountId(count.id)}
            >
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold">Count #{count.id}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Loc {count.locationId} {count.binId ? `· Bin ${count.binId}` : ''} {count.category ? `· ${count.category}` : ''}
                    </div>
                  </div>
                  <Badge variant={count.status === "completed" ? "secondary" : "default"} className={cn(
                    "text-[10px] uppercase tracking-widest",
                    count.status === "in_progress" && "bg-primary/20 text-primary hover:bg-primary/20"
                  )}>
                    {count.status.replace('_', ' ')}
                  </Badge>
                </div>
                
                <div className="flex items-center justify-between pt-2 border-t border-white/5 text-xs text-muted-foreground">
                  <div>Started {formatGuyanaDate(count.startedAt)}</div>
                   {["in_progress", "pending_approval"].includes(count.status) && (
                    <div className="flex items-center text-primary gap-1 font-medium">
                       Resume <Play className="w-3 h-3" />
                    </div>
                  )}
                   {!["in_progress", "pending_approval"].includes(count.status) && <span>View sheet</span>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function StartCountDialog() {
  const { toast } = useToast();
  const create = useCreateCycleCount();
   const { data: locations, isError: locationsError } = useGetLocations();
   const [locationId, setLocationId] = useState<number>();
   const { data: bins, isLoading: binsLoading, isError: binsError } = useGetBins(locationId);

  return (
    <CreateRecordDialog
      title="Start Cycle Count"
      description={locationsError ? "Locations failed to load. Close and retry." : binsError ? "Bins failed to load. Close and retry." : "Scope a rolling inventory count by location, bin, or category without freezing the warehouse."}
      pending={create.isPending}
      submitLabel="Begin count"
      trigger={
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full gap-2 px-5 shadow-lg shadow-primary/20">
          <Play className="w-4 h-4" /> Start Count
        </Button>
      }
      fields={[
        {
          name: "locationId",
          label: "Location",
          type: "select",
          required: true,
          span: "half",
           options: locations?.filter((l: any) => l.active).map((l: any) => ({ value: String(l.id), label: l.name })) ?? [],
           onChange: (value, _autofill, setField) => { setLocationId(value ? Number(value) : undefined); setField("binId", ""); },
        },
        { name: "binId", label: binsLoading ? "Loading bins…" : "Bin (Optional)", type: "select", span: "half", options: [{ value: "", label: "All bins" }, ...(bins?.filter((b: any) => b.active).map((b: any) => ({ value: String(b.id), label: b.code })) ?? [])] },
        { name: "category", label: "Category Filter", type: "text", span: "full", placeholder: "e.g. Fluids" },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        if (locationsError || binsError || binsLoading) throw new Error("Location/bin data is unavailable. Please retry before starting a count.");
        await create.mutateAsync({
          locationId: Number(v.locationId),
          ...(v.binId ? { binId: Number(v.binId) } : {}),
          ...(v.category ? { category: String(v.category) } : {}),
        });
        toast({ title: "Cycle count started", description: "Targeted parts are now locked for counting." });
      }}
    />
  );
}

function ActiveCountView({ count: countStub, onBack }: { count: any; onBack: () => void }) {
  const { toast } = useToast();
  const { data: count, isLoading, isError } = useQuery({
    queryKey: ["parts-cycle-counts", countStub.id],
    queryFn: () => customFetch<any>(`/api/parts/operations/p05/cycle-counts/${countStub.id}`),
  });
  const { data: parts, isError: partsError } = useListParts();
  const updateLines = useUpdateCycleCountLines();
  const approve = useApproveCycleCount();
  const cancel = useCancelCycleCount();
  
  // Local state for fast input before saving
  const [lines, setLines] = useState<Record<number, string>>({});
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"partNumber" | "partName">("partNumber");
  const [descending, setDescending] = useState(false);
  const [exporting, setExporting] = useState(false);
  
  // Initialize lines when data arrives
  const isInitialized = useRef(false);
  if (count?.lines && !isInitialized.current) {
    const initLines: Record<number, string> = {};
    for (const line of count.lines) {
      initLines[line.id] = line.countedQty !== null && line.countedQty !== undefined ? String(line.countedQty) : '';
    }
    setLines(initLines);
    isInitialized.current = true;
  }

  if (isError) return <div role="alert" className="p-4 text-destructive">Count details could not be loaded. <Button variant="ghost" onClick={onBack}>Back</Button></div>;
  if (isLoading || !count) return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  const editable = ["in_progress", "pending_approval"].includes(count.status);
  const visibleLines = [...count.lines].filter((line: any) =>
    `${line.partNumber} ${line.partName}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  ).sort((a: any, b: any) => (descending ? -1 : 1) *
    String(a[sortBy]).localeCompare(String(b[sortBy]), undefined, { numeric: true, sensitivity: "base" }));
  const exportSheet = async (format: "csv" | "pdf") => {
    setExporting(true);
    try {
      await downloadPartsReport(`/api/parts/operations/p05/cycle-counts/${count.id}/export`, `cycle-count-${count.id}`, format);
    } catch (err) {
      toast({ title: "Export failed", description: err instanceof Error ? err.message : "Could not export count.", variant: "destructive" });
    } finally { setExporting(false); }
  };
  
  const saveLines = async () => {
    const payload = Object.entries(lines).filter(([, qty]) => qty !== "").map(([id, qty]) => ({
      id: Number(id),
      countedQuantity: qty === '' ? null : Number(qty)
    }));
    
    try {
      if (!payload.length) throw new Error("Enter at least one counted quantity before saving.");
      if (payload.some(line => line.countedQuantity !== null && (!Number.isSafeInteger(line.countedQuantity) || line.countedQuantity < 0))) throw new Error("Counted quantities must be nonnegative integers.");
      await updateLines.mutateAsync({ id: count.id, lines: payload });
      toast({ title: "Progress saved" });
      return true;
    } catch (err) {
      toast({ title: "Save failed", description: err instanceof Error ? err.message : "Could not save count.", variant: "destructive" });
      return false;
    }
  };

  const handleApprove = async () => {
    if (Object.values(lines).some(v => v === '')) {
      toast({ title: "Incomplete", description: "All lines must be counted before approval.", variant: "destructive" });
      return;
    }
    if (!await saveLines()) return;
    try {
      await approve.mutateAsync(count.id);
      toast({ title: "Count approved", description: "Variances have been posted." });
      onBack();
    } catch (err) {
      toast({ title: "Approval failed", description: err instanceof Error ? err.message : "Could not approve count.", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between bg-white/[0.02] p-4 rounded-2xl border border-white/5">
        <div>
          <div className="text-sm font-medium flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onBack} className="h-6 px-2 -ml-2 text-muted-foreground hover:text-foreground">
              ← Back
            </Button>
            Active Count #{count.id}
          </div>
          <div className="text-xs text-muted-foreground mt-1 ml-10">
            Target: Location {count.locationId}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(["csv", "pdf"] as const).map(format => <Button key={format} variant="outline" size="sm" disabled={exporting} onClick={() => exportSheet(format)}><Download className="w-3.5 h-3.5 mr-1" />{format.toUpperCase()}</Button>)}
          {editable && <Button
            variant="ghost" 
            size="sm" 
            className="text-muted-foreground hover:text-destructive"
            disabled={cancel.isPending || approve.isPending || updateLines.isPending}
            onClick={async () => {
              try {
                await cancel.mutateAsync(count.id);
                toast({ title: "Count cancelled" });
                onBack();
              } catch (err) {
                toast({ title: "Cancellation failed", description: err instanceof Error ? err.message : "Could not cancel count.", variant: "destructive" });
              }
            }}
          >
            Cancel Count
          </Button>}
          {editable && <Button
            variant="outline" 
            size="sm"
            onClick={saveLines}
            disabled={updateLines.isPending || approve.isPending || cancel.isPending}
            className="gap-2"
          >
            {updateLines.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save Draft
          </Button>}
          {editable && <Button
            className="bg-primary text-white gap-2"
            onClick={handleApprove}
            disabled={approve.isPending || updateLines.isPending || cancel.isPending}
          >
            <Check className="w-4 h-4" /> Approve & Post
          </Button>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="md:col-span-1">
          <PartBarcodeScanner 
            onScan={(code) => {
      if (partsError && !count.lines?.some((l: any) => l.partNumber === code)) {
                toast({ title: "Catalog unavailable", description: "Parts could not be loaded. Retry before scanning.", variant: "destructive" });
                return;
              }
              // Find part matching barcode or SKU
              if (!editable) return;
              const part = parts?.find((p: any) => p.barcode === code);
              const line = count.lines?.find((l: any) => l.partNumber === code || l.partId === part?.id);
              if (!line) {
                toast({ title: "Unknown Part", description: `Code ${code} not found in catalog.`, variant: "destructive" });
                return;
              }
              
              setLines((prev) => {
                const current = prev[line.id];
                const nextVal = current === '' ? 1 : Number(current) + 1;
                return { ...prev, [line.id]: String(nextVal) };
              });
              toast({ title: "Counted", description: `Added 1 to ${line.partName}` });
            }} 
          />
        </div>
        
        <div className="md:col-span-3 glass-panel rounded-2xl overflow-hidden border border-white/10">
          <div className="p-3 flex items-center gap-2">
            <Input aria-label="Search count parts" placeholder="Search part number or name" value={search} onChange={e => setSearch(e.target.value)} />
            <span className="text-xs text-muted-foreground whitespace-nowrap">{visibleLines.length} parts</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground bg-white/[0.02]">
                 {(["partNumber", "partName"] as const).map(key => <th key={key} className="px-4 py-3 font-semibold"><button type="button" onClick={() => { setDescending(sortBy === key ? !descending : false); setSortBy(key); }}>{key === "partNumber" ? "Part Number" : "Part Name"} {sortBy === key ? descending ? "↓" : "↑" : ""}</button></th>)}
                <th className="px-4 py-3 font-semibold text-right">Expected</th>
                <th className="px-4 py-3 font-semibold text-right w-32">Counted</th>
                <th className="px-4 py-3 font-semibold text-right">Variance</th>
              </tr>
            </thead>
            <tbody>
               {visibleLines.map((line: any) => {
                const expected = line.expectedQty;
                const counted = lines[line.id] === '' ? null : Number(lines[line.id]);
                const variance = counted !== null ? counted - expected : null;
                const hasVariance = variance !== null && variance !== 0;

                return (
                  <tr key={line.id} className="border-b border-white/5">
                     <td className="px-4 py-3 font-medium">{line.partNumber}</td>
                     <td className="px-4 py-3">{line.partName}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{expected}</td>
                    <td className="px-4 py-2">
                      <Input
                        type="number"
                        min="0"
                         disabled={!editable}
                        className={cn(
                          "h-8 text-right bg-white/[0.03] border-white/10",
                          hasVariance && "border-amber-500/50 bg-amber-500/10"
                        )}
                        value={lines[line.id]}
                        onChange={(e) => setLines(prev => ({ ...prev, [line.id]: e.target.value }))}
                      />
                    </td>
                    <td className={cn(
                      "px-4 py-3 text-right font-medium tabular-nums",
                      hasVariance ? (variance! > 0 ? "text-emerald-400" : "text-rose-400") : "text-muted-foreground"
                    )}>
                      {variance !== null ? (variance > 0 ? `+${variance}` : variance) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
