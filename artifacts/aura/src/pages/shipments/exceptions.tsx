import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Ship } from "lucide-react";
import { useListShipmentExceptions } from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { EmptyBlock, ErrorBlock, Pill, RowsSkeleton, ShipmentsNav } from "@/components/shipments/shared";

const KIND_LABEL: Record<string, string> = {
  shortage: "Shortage",
  blocked_proposal: "Blocked confirmation",
  hold_lapsed: "Hold lapsed",
  unmatched_vin: "Unmatched VIN",
  withheld_email: "Email withheld",
  line_unallocated: "Unallocated capacity",
};
const KIND_TONE: Record<string, string> = {
  shortage: "rejected",
  blocked_proposal: "pending",
  hold_lapsed: "lapsed",
  unmatched_vin: "unmatched",
  withheld_email: "withheld",
  line_unallocated: "open",
};

export default function ShipmentExceptionsPage() {
  const { data, isLoading, error, refetch } = useListShipmentExceptions();
  const [kind, setKind] = useState<string>("all");
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data ?? []) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
    return m;
  }, [data]);
  const rows = (data ?? []).filter((e) => kind === "all" || e.kind === kind);
  return (
    <Page>
      <PageHero icon={Ship} eyebrow="Shipments" title="Exceptions" subtitle="Shortages, blocked confirmations, lapsed holds and withheld customer emails that need a person." />
      <ShipmentsNav />
      <div className="flex flex-wrap gap-2 mb-4">
        {["all", ...Object.keys(KIND_LABEL)].map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} data-testid={`filter-exception-${k}`}
            className={`text-xs rounded-full px-3 py-1 ring-1 ring-inset ${kind === k ? "bg-foreground text-background ring-foreground" : "ring-border text-muted-foreground"}`}>
            {k === "all" ? `All ${data?.length ?? 0}` : `${KIND_LABEL[k]} ${counts.get(k) ?? 0}`}
          </button>
        ))}
      </div>
      {isLoading ? <RowsSkeleton /> : error ? <ErrorBlock error={error} onRetry={() => refetch()} /> : rows.length === 0 ? (
        <EmptyBlock title="Nothing needs attention" body="No shortages, blocked confirmations or withheld emails in this view." />
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border">
          {rows.map((e, i) => (
            <Link key={`${e.kind}-${e.refId}-${i}`} href={`/shipments/${e.shipmentId}`} className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4 px-5 py-3 hover:bg-muted/40" data-testid={`row-exception-${e.kind}-${e.refId}`}>
              <span className="w-44 shrink-0"><Pill status={KIND_TONE[e.kind] ?? "draft"} label={KIND_LABEL[e.kind] ?? e.kind} /></span>
              <span className="flex-1 min-w-0">
                <span className="block font-medium truncate">{e.title}</span>
                <span className="block text-xs text-muted-foreground">{e.detail}</span>
              </span>
              <span className="text-xs text-muted-foreground">{e.shipmentReference}</span>
            </Link>
          ))}
        </div>
      )}
    </Page>
  );
}
