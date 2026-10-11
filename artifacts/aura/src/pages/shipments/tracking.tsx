import { useState } from "react";
import { Link } from "wouter";
import { Ship } from "lucide-react";
import { useListShipmentTracking } from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { Input } from "@/components/ui/input";
import { EmptyBlock, ErrorBlock, Pill, RowsSkeleton, ShipmentsNav, SpecCell, monthLabel } from "@/components/shipments/shared";

export default function ShipmentTrackingPage() {
  const { data, isLoading, error, refetch } = useListShipmentTracking();
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const rows = (data ?? []).filter(
    (a) => (showClosed || a.status === "active" || a.status === "fulfilled") &&
      `${a.leadName} ${a.shipmentReference} ${a.spec.make} ${a.spec.model}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <Page>
      <PageHero icon={Ship} eyebrow="Shipments" title="Customer tracking" subtitle="Every allocated customer, their exact spec, ETA and fulfilment - separate from the sales stage." />
      <ShipmentsNav />
      <div className="flex flex-col md:flex-row gap-3 md:items-center mb-4">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer, shipment or model" className="md:max-w-sm" data-testid="input-tracking-search" />
        <label className="text-sm text-muted-foreground flex items-center gap-2">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Include released and reassigned
        </label>
      </div>
      {isLoading ? <RowsSkeleton /> : error ? <ErrorBlock error={error} onRetry={() => refetch()} /> : rows.length === 0 ? (
        <EmptyBlock title="No allocated customers" body="Allocations appear here once a Pre-Book customer is placed on a shipment line." />
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border">
          {rows.map((a) => {
            const latest = a.emails[0];
            return (
              <div key={a.id} className="grid md:grid-cols-[1.1fr_1.6fr_0.9fr_1fr_1.3fr] gap-3 px-5 py-3.5 items-center" data-testid={`row-tracking-${a.id}`}>
                <div className="min-w-0">
                  <Link href={`/lead/${a.leadId}`} className="font-medium hover:underline">{a.leadName}</Link>
                  <div className="text-xs text-muted-foreground">Priority {new Date(a.baselineAt).toLocaleDateString()}</div>
                </div>
                <SpecCell spec={a.spec} />
                <div className="text-sm">
                  <Link href={`/shipments/${a.shipmentId}`} className="hover:underline">{a.shipmentReference}</Link>
                  <div className="text-xs text-muted-foreground">ETA {monthLabel(a.currentEtaMonth)}{a.currentEtaMonth !== a.baselineEtaMonth ? ` (was ${monthLabel(a.baselineEtaMonth)})` : ""}</div>
                </div>
                <div className="flex flex-wrap gap-1.5 items-center">
                  <Pill status={a.status} />
                  {a.holdLapsedUnits > 0 && <Pill status="lapsed" label={`${a.holdLapsedUnits} hold lapsed`} />}
                  <span className="text-xs text-muted-foreground tabular-nums">{a.confirmedUnits}/{a.quantity} VIN held</span>
                </div>
                <div className="text-xs text-muted-foreground min-w-0">
                  {latest ? (<><Pill status={latest.status} /> <span className="ml-1">{latest.kind === "initial" ? "Initial email" : `ETA ${monthLabel(latest.etaMonth)} email`}</span><div className="truncate mt-0.5" title={latest.reason}>{latest.reason}</div></>) : "No email jobs"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}
