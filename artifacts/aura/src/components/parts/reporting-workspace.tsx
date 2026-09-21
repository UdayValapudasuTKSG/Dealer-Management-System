import { useState } from "react";
import { useMoney } from "@/lib/format";
import { useGetAging, useGetValuation, useGetReplenishment, useGetLocations } from "@/hooks/use-parts-operations";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Download, TrendingDown, DollarSign, Calculator, AlertTriangle, ArrowRight, TrendingUp, Loader2, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGeneratePartsLowStockPurchaseOrders } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

function ReportError({ message }: { message: string }) {
  return <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">{message} Please retry; no financial conclusions should be drawn from unavailable data.</div>;
}

export function ReportingWorkspace() {
  const [activeView, setActiveView] = useState<"valuation" | "aging" | "replenishment">("valuation");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 border-b border-white/10 pb-4">
        {[
          { id: "valuation", label: "Valuation", icon: DollarSign },
          { id: "aging", label: "Stock Aging", icon: TrendingDown },
          { id: "replenishment", label: "Replenishment", icon: TrendingUp },
        ].map(view => (
          <Button
            key={view.id}
            variant={activeView === view.id ? "default" : "ghost"}
            className={cn(
              "rounded-full gap-2",
              activeView === view.id ? "bg-primary hover:bg-primary/90 text-white" : "text-muted-foreground hover:text-foreground hover:bg-white/5"
            )}
            onClick={() => setActiveView(view.id as any)}
          >
            <view.icon className="w-4 h-4" />
            {view.label}
          </Button>
        ))}
      </div>
      
      {activeView === "valuation" && <ValuationReport />}
      {activeView === "aging" && <AgingReport />}
      {activeView === "replenishment" && <ReplenishmentReport />}
    </div>
  );
}

function ValuationReport() {
  const [asOf, setAsOf] = useState("");
  const [locationId, setLocationId] = useState("");
  const { data: locations, isError: locationsError } = useGetLocations();
  
  const queryParams: any = {};
  if (asOf) queryParams.asOf = new Date(asOf).toISOString();
  if (locationId) queryParams.locationId = Number(locationId);

  const { data: valuation, isLoading, isError } = useGetValuation(queryParams);
  const money = useMoney();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 border-b border-white/5 pb-4">
        <div className="flex-1 min-w-[200px] max-w-xs space-y-1.5">
          <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Location</label>
          <StyledSelect
            value={locationId}
            onValueChange={setLocationId}
            options={[
              { value: "", label: "All Locations" },
              ...(locations?.map((l: any) => ({ value: String(l.id), label: l.name })) ?? [])
            ]}
            className="h-9 rounded-xl bg-white/[0.04] border-white/10 text-sm"
          />
        </div>
        <div className="flex-1 min-w-[200px] max-w-xs space-y-1.5">
          <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">As Of Date (Instant)</label>
          <Input 
            type="datetime-local" 
            value={asOf} 
            onChange={e => setAsOf(e.target.value)} 
            className="h-9 rounded-xl bg-white/[0.04] border-white/10 text-sm"
          />
        </div>
      </div>

      {locationsError && <ReportError message="Locations could not be loaded." />}
      {isError && <ReportError message="Valuation could not be loaded." />}
      {isLoading && <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />}
      {!isError && !isLoading && valuation && (
        <div className="space-y-6">
          {valuation.incomplete && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-amber-500">Historical Ledger Incomplete</h3>
                <p className="text-sm text-amber-500/80 mt-1">
                  The valuation shown represents available data. Some earlier costs are missing because historical ledger transactions are incomplete prior to system adoption.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="glass-panel border-none rounded-2xl bg-primary/10">
              <CardContent className="p-6">
                <div className="text-sm font-medium text-primary mb-1">Total Inventory Value</div>
                <div className="text-3xl font-light tracking-tight">{money.gyd(valuation.totalValue || valuation.grandTotal || 0)}</div>
                <div className="text-xs text-primary/70 mt-2 flex items-center gap-1">
                  <Calculator className="w-3.5 h-3.5" /> Computed using component costing methods
                </div>
              </CardContent>
            </Card>
          </div>

          {(valuation.byLocation || valuation.locations) && (
            <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">Location</th>
                    <th className="px-4 py-3 font-semibold text-right">Value (GYD)</th>
                  </tr>
                </thead>
                <tbody>
                  {(valuation.byLocation || valuation.locations).map((loc: any) => (
                    <tr key={loc.locationId} className="border-b border-white/5">
                      <td className="px-4 py-3 font-medium">Location #{loc.locationId}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">{money.gyd(loc.value || loc.totalValue || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {valuation.unavailable?.length > 0 && (
            <div className="mt-8 space-y-3">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <Info className="w-4 h-4 text-muted-foreground" />
                Unavailable Valuations
              </h3>
              <p className="text-xs text-muted-foreground">These items could not be valued for the requested date.</p>
              <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-3 font-semibold">Part</th>
                      <th className="px-4 py-3 font-semibold">SKU</th>
                      <th className="px-4 py-3 font-semibold">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {valuation.unavailable.map((u: any) => (
                      <tr key={`${u.partId}-${u.sku}`} className="border-b border-white/5 text-muted-foreground">
                        <td className="px-4 py-3">Part #{u.partId}</td>
                        <td className="px-4 py-3">{u.sku}</td>
                        <td className="px-4 py-3">{u.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AgingReport() {
  const [thresholds, setThresholds] = useState<string>("30,60,90");
  const [customThresholds, setCustomThresholds] = useState<string>("30,60,90");
  const [locationId, setLocationId] = useState("");
  const [category, setCategory] = useState("");
  const { data: locations, isError: locationsError } = useGetLocations();

  const queryParams: any = { thresholds };
  if (locationId) queryParams.locationId = Number(locationId);
  if (category) queryParams.category = category;

  const { data: aging, isLoading, isError } = useGetAging(queryParams);
  const [downloading, setDownloading] = useState(false);
  const { toast } = useToast();
  const money = useMoney();

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const search = new URLSearchParams({ ...queryParams, format: "csv" });
      const response = await fetch(`/api/parts/operations/aging?${search}`, { credentials: "include" });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/csv")) throw new Error("CSV export failed. Please retry.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inventory-aging.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ title: "Export failed", description: err instanceof Error ? err.message : "Could not export aging report.", variant: "destructive" });
    } finally { setDownloading(false); }
  };

  const rows = aging?.rows || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-4 border-b border-white/5 pb-4">
        <div className="flex-1 min-w-[150px] space-y-1.5">
          <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Location</label>
          <StyledSelect
            value={locationId}
            onValueChange={setLocationId}
            options={[
              { value: "", label: "All Locations" },
              ...(locations?.map((l: any) => ({ value: String(l.id), label: l.name })) ?? [])
            ]}
            className="h-9 rounded-xl bg-white/[0.04] border-white/10 text-sm"
          />
        </div>
        <div className="flex-1 min-w-[150px] space-y-1.5">
          <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Category</label>
          <Input 
            type="text" 
            placeholder="e.g. Fluids"
            value={category} 
            onChange={e => setCategory(e.target.value)} 
            className="h-9 rounded-xl bg-white/[0.04] border-white/10 text-sm"
          />
        </div>
        <div className="flex-1 min-w-[200px] space-y-1.5">
          <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Thresholds (days)</label>
          <div className="flex items-center gap-2">
            <Input 
              type="text" 
              value={customThresholds}
              onChange={e => setCustomThresholds(e.target.value)}
              placeholder="30,60,90"
              className="h-9 rounded-xl bg-white/[0.04] border-white/10 text-sm flex-1"
            />
            <Button 
              size="sm"
              variant="outline" 
              className="h-9 border-white/10"
              onClick={() => setThresholds(customThresholds || "30,60,90")}
            >
              Apply
            </Button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {["30,60,90", "90,180,365"].map(t => (
            <Button
              key={t}
              variant={thresholds === t ? "default" : "outline"}
              size="sm"
              className={cn("rounded-full h-8 text-xs", thresholds === t ? "bg-white/10 hover:bg-white/20 text-white" : "border-white/10")}
              onClick={() => {
                setThresholds(t);
                setCustomThresholds(t);
              }}
            >
              {t.split(',')[t.split(',').length-1]}+ Days
            </Button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full gap-2 border-white/10"
          onClick={handleDownload}
          disabled={downloading || isError || isLoading || !rows.length}
        >
          {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          Export CSV
        </Button>
      </div>

      {isLoading && <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />}
      
      {locationsError && <ReportError message="Locations could not be loaded." />}
      {isError && <ReportError message="Stock aging could not be loaded." />}
      {!isError && !isLoading && !rows.length && (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3">
          <AlertTriangle className="w-8 h-8 text-muted-foreground" />
          <p className="text-muted-foreground">No inventory rows match the selected scope.</p>
        </div>
      )}
      
      {!isError && !isLoading && rows.length > 0 && (
        <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Part</th>
                <th className="px-4 py-3 font-semibold">Category</th>
                <th className="px-4 py-3 font-semibold text-right">Idle Qty</th>
                <th className="px-4 py-3 font-semibold text-right">Tied Capital</th>
                <th className="px-4 py-3 font-semibold text-right">Last Movement</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: any) => (
                <tr key={`${row.partId}-${row.locationId}`} className="border-b border-white/5 hover:bg-foreground/[0.03]">
                  <td className="px-4 py-3 font-medium">Part #{row.partId}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.category || '—'}</td>
                  <td className="px-4 py-3 text-right font-medium text-rose-400">{row.quantity}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money.gyd(row.currentValue)}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {row.lastMovementAt ? new Date(row.lastMovementAt).toLocaleDateString() : 'Never'}
                    {row.historicalAgeUnknown && <span className="ml-2 text-[9px] text-amber-500 uppercase tracking-widest">Unknown</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ReplenishmentReport() {
  const [locationId, setLocationId] = useState("");
  const { data: locations, isError: locationsError } = useGetLocations();
  const generate = useGeneratePartsLowStockPurchaseOrders();
  const { toast } = useToast();
  
  const queryParams: any = {};
  if (locationId) queryParams.locationId = Number(locationId);

  const { data: suggestions, isLoading, isError } = useGetReplenishment(queryParams.locationId);
  const generateDrafts = async () => {
    if (!locationId || !window.confirm("Generate low-stock purchase-order drafts for this location? This applies low-stock rules, not individual seasonal suggestions. Nothing will be sent to suppliers.")) return;
    try {
      await generate.mutateAsync({ data: { locationId: Number(locationId) } });
      toast({ title: "Low-stock review complete", description: "Any required drafts are ready for review." });
      window.location.assign("/parts?tab=orders");
    } catch (err) {
      toast({ title: "Draft generation failed", description: err instanceof Error ? err.message : "Could not generate drafts.", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 border-b border-white/5 pb-4">
        <div className="flex-1 min-w-[200px] max-w-xs space-y-1.5">
          <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Location</label>
          <StyledSelect
            value={locationId}
            onValueChange={setLocationId}
            options={[
              { value: "", label: "All Locations" },
              ...(locations?.map((l: any) => ({ value: String(l.id), label: l.name })) ?? [])
            ]}
            className="h-9 rounded-xl bg-white/[0.04] border-white/10 text-sm"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={!locationId || !locations?.some((location: any) => String(location.id) === locationId && location.active) || isLoading || isError || locationsError || generate.isPending} onClick={generateDrafts}>
          {generate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Generate low-stock drafts
        </Button>
        <p className="text-xs text-muted-foreground">Select a location. Draft generation uses low-stock thresholds, not individual seasonal suggestions.</p>
      </div>
      {locationsError && <ReportError message="Locations could not be loaded." />}
      {isError && <ReportError message="Replenishment suggestions could not be loaded." />}
      {isLoading && <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />}
      
      {!isError && !isLoading && !suggestions?.length && (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3">
          <TrendingUp className="w-8 h-8 text-muted-foreground" />
          <p className="text-muted-foreground">No replenishment suggestions at this time.</p>
        </div>
      )}

      {!isError && !isLoading && (suggestions?.length ?? 0) > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {suggestions!.map((sug: any) => (
            <Card key={`${sug.partId}-${sug.locationId}`} className="glass-panel border-none rounded-2xl relative overflow-hidden">
              <div className="absolute top-0 inset-x-0 h-1 bg-primary/40" />
              <CardContent className="p-5 space-y-4">
                <div>
                  <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase flex items-center justify-between">
                    {sug.name || `Part #${sug.partId}`} · Location {sug.locationId}
                    <span className="text-primary bg-primary/10 px-1.5 py-0.5 rounded text-[9px]">
                      Suggested: {sug.suggestedQuantity ?? "Unavailable"}
                    </span>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground mb-0.5">Daily Velocity</div>
                    <div className="font-medium">{sug.dailyVelocity == null ? "Unavailable" : `${Number(sug.dailyVelocity).toFixed(2)} units/day`}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-0.5">Lead Time</div>
                    <div className="font-medium">{sug.leadTimeDays == null ? "Unavailable" : `${sug.leadTimeDays} days`}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-0.5">Available Stock</div>
                    <div className="font-medium">{sug.available}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-0.5">Reorder Minimum</div>
                    <div className="font-medium">{sug.min}</div>
                  </div>
                </div>

                <p className="pt-3 border-t border-white/5 text-xs text-muted-foreground">{sug.reason || sug.explanation}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
