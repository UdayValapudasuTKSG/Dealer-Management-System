import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCapacityBlocks,
  useCreateCapacityBlock,
  useDeleteCapacityBlock,
  getListCapacityBlocksQueryKey,
  useListVehicles,
  useListLeadAdvisors,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { PageHero } from "@/components/layout/page-hero";
import { cn } from "@/lib/utils";
import { Car, Users, Loader2 } from "lucide-react";

/**
 * Manager capacity planning for test drives: a 14-day grid (matching the
 * bookable slot window) where each cell toggles a vehicle's or advisor's
 * availability. Blocked days are excluded from the test-drive scheduler.
 */

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function windowDays(): Date[] {
  const now = new Date();
  const days: Date[] = [];
  for (let offset = 1; offset <= 14; offset++) {
    days.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  }
  return days;
}

export default function CapacityPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<"vehicle" | "advisor">("vehicle");

  const days = useMemo(windowDays, []);
  const from = dateStr(days[0]!);
  const to = dateStr(days[days.length - 1]!);

  const { data: blocks, isLoading } = useListCapacityBlocks({ from, to });
  const { data: vehicles } = useListVehicles();
  const { data: advisors } = useListLeadAdvisors();
  const createBlock = useCreateCapacityBlock();
  const deleteBlock = useDeleteCapacityBlock();

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListCapacityBlocksQueryKey({ from, to }) });

  // kind:refId:date -> block id
  const blockIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of blocks ?? []) {
      m.set(`${b.kind}:${b.refId}:${dateStr(new Date(b.date))}`, b.id);
    }
    return m;
  }, [blocks]);

  const rows =
    tab === "vehicle"
      ? (vehicles ?? [])
          .filter((v) => !["sold", "delivered"].includes(v.status))
          .map((v) => ({
            id: v.id,
            label: `${v.year} ${v.make} ${v.model}`,
            sub: v.vin ?? v.exteriorColor ?? "",
          }))
      : (advisors ?? []).map((a) => ({ id: a.id, label: a.name, sub: "" }));

  const [busyCell, setBusyCell] = useState<string | null>(null);

  const toggle = async (refId: number, day: Date) => {
    const key = `${tab}:${refId}:${dateStr(day)}`;
    const existing = blockIndex.get(key);
    setBusyCell(key);
    try {
      if (existing) {
        await deleteBlock.mutateAsync({ id: existing });
      } else {
        await createBlock.mutateAsync({
          data: { kind: tab, refId, date: dateStr(day) },
        });
      }
      invalidate();
    } catch (err) {
      toast({
        title: "Could not update capacity",
        description: err instanceof Error ? err.message : "Try again.",
        variant: "destructive",
      });
    } finally {
      setBusyCell(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Test Drive Operations"
        title="Capacity Planning"
        subtitle="Block out days when a demo car or a sales advisor is unavailable — blocked days disappear from the test-drive scheduler."
      />

      <div className="flex items-center gap-2">
        <Button
          variant={tab === "vehicle" ? "default" : "outline"}
          size="sm"
          className="rounded-full gap-1.5"
          onClick={() => setTab("vehicle")}
        >
          <Car className="w-4 h-4" /> Vehicles
        </Button>
        <Button
          variant={tab === "advisor" ? "default" : "outline"}
          size="sm"
          className="rounded-full gap-1.5"
          onClick={() => setTab("advisor")}
        >
          <Users className="w-4 h-4" /> Advisors
        </Button>
        <span className="text-xs text-muted-foreground ml-2">
          Click a cell to block/unblock that day. Green = available, red = blocked.
        </span>
      </div>

      <Card className="glass-panel border-none rounded-2xl overflow-hidden">
        <CardContent className="p-4 overflow-x-auto">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading capacity plan…
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6">
              {tab === "vehicle"
                ? "No test-drivable vehicles in inventory."
                : "No sales advisors set up yet."}
            </p>
          ) : (
            <table className="w-full text-xs border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="text-left font-semibold uppercase tracking-wider text-[10px] text-muted-foreground p-2 sticky left-0 bg-background/80 backdrop-blur min-w-[180px]">
                    {tab === "vehicle" ? "Vehicle" : "Advisor"}
                  </th>
                  {days.map((d) => (
                    <th
                      key={dateStr(d)}
                      className="p-1.5 font-semibold text-[10px] text-muted-foreground text-center whitespace-nowrap"
                    >
                      {d.toLocaleDateString("en-US", { weekday: "short" })}
                      <br />
                      {d.getDate()}/{d.getMonth() + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="p-2 sticky left-0 bg-background/80 backdrop-blur">
                      <div className="font-medium truncate max-w-[220px]">{r.label}</div>
                      {r.sub && (
                        <div className="text-[10px] text-muted-foreground truncate max-w-[220px]">
                          {r.sub}
                        </div>
                      )}
                    </td>
                    {days.map((d) => {
                      const key = `${tab}:${r.id}:${dateStr(d)}`;
                      const blocked = blockIndex.has(key);
                      const busy = busyCell === key;
                      return (
                        <td key={key} className="p-1 text-center">
                          <button
                            aria-label={`${r.label} — ${dateStr(d)} — ${blocked ? "blocked" : "available"}`}
                            disabled={busy}
                            onClick={() => toggle(r.id, d)}
                            className={cn(
                              "w-8 h-8 rounded-lg border transition-colors inline-flex items-center justify-center",
                              blocked
                                ? "bg-red-500/25 border-red-500/40 hover:bg-red-500/35"
                                : "bg-emerald-500/10 border-emerald-500/20 hover:bg-emerald-500/25",
                            )}
                          >
                            {busy ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : blocked ? (
                              "✕"
                            ) : (
                              ""
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
