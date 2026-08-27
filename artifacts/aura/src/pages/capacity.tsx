import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCapacityBlocks,
  useCreateCapacityBlock,
  useDeleteCapacityBlock,
  usePreviewCapacityBlockRange,
  useApplyCapacityBlockRange,
  getListCapacityBlocksQueryKey,
  useListVehicles,
  useListLeadAdvisors,
  type CapacityBlock,
  type CapacityBlockRangeResult,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { cn } from "@/lib/utils";
import { Car, Users, Loader2 } from "lucide-react";

/**
 * Manager capacity planning for test drives: a 14-day grid (matching the
 * bookable slot window) where each cell blocks a vehicle's or advisor's
 * availability — for the full day or an hour window. Blocked time vanishes
 * from the test-drive scheduler.
 *
 * One unit per model line acts as the demo car, so the vehicle tab shows a
 * single representative per make+model rather than the whole inventory.
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

const HOURS = Array.from({ length: 12 }, (_, i) => i + 8); // 8:00 – 19:00
const hourLabel = (h: number) =>
  h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`;
type RangePreview = CapacityBlockRangeResult;

export default function CapacityPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<"vehicle" | "advisor">("vehicle");

  const days = useMemo(windowDays, []);
  const from = dateStr(days[0]!);
  const to = dateStr(days[days.length - 1]!);

  const { data: blocks, isLoading, error } = useListCapacityBlocks({ from, to });
  const { data: vehicles } = useListVehicles();
  const { data: advisors } = useListLeadAdvisors();
  const createBlock = useCreateCapacityBlock();
  const deleteBlock = useDeleteCapacityBlock();

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListCapacityBlocksQueryKey({ from, to }) });

  // kind:refId:date -> blocks (a day can hold several hour windows, e.g.
  // busy 9-10, free, busy 14-16). Full-day first, then by start hour.
  const blockIndex = useMemo(() => {
    const m = new Map<string, CapacityBlock[]>();
    for (const b of blocks ?? []) {
      // The API serializes the SQL date as UTC midnight — take the ISO date
      // part directly; local getters would shift it a day west of UTC.
      const day = new Date(b.date).toISOString().slice(0, 10);
      const key = `${b.kind}:${b.refId}:${day}`;
      m.set(key, [...(m.get(key) ?? []), b]);
    }
    for (const list of m.values())
      list.sort((a, b) => (a.startHour ?? -1) - (b.startHour ?? -1));
    return m;
  }, [blocks]);

  // One demo unit represents each model line for test drives.
  const rows = useMemo(() => {
    if (tab === "advisor")
      return (advisors ?? []).map((a) => ({ id: a.id, label: a.name, sub: "" }));
    const byModel = new Map<string, { id: number; label: string; sub: string }>();
    for (const v of vehicles ?? []) {
      if (["sold", "delivered"].includes(v.status)) continue;
      const key = `${v.make} ${v.model}`.toLowerCase();
      if (!byModel.has(key)) {
        byModel.set(key, {
          id: v.id,
          label: `${v.year} ${v.make} ${v.model}`,
          sub: v.vin ? `Demo unit · ${v.vin}` : "Demo unit",
        });
      }
    }
    return [...byModel.values()];
  }, [tab, vehicles, advisors]);

  // Block dialog state
  const [target, setTarget] = useState<{
    refId: number;
    label: string;
    day: Date;
  } | null>(null);
  const [mode, setMode] = useState<"day" | "hours">("day");
  const [startHour, setStartHour] = useState("9");
  const [endHour, setEndHour] = useState("12");
  const [reason, setReason] = useState("");
  const [busyCell, setBusyCell] = useState<string | null>(null);
  const [rangeTarget, setRangeTarget] = useState<{
    refId: number;
    label: string;
  } | null>(null);
  const [rangeFrom, setRangeFrom] = useState(from);
  const [rangeTo, setRangeTo] = useState(to);
  const [rangeDays, setRangeDays] = useState<"all" | "weekdays" | "selected">("all");
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [rangeMode, setRangeMode] = useState<"day" | "hours">("day");
  const [rangeStartHour, setRangeStartHour] = useState("9");
  const [rangeEndHour, setRangeEndHour] = useState("12");
  const [rangeReason, setRangeReason] = useState("");
  const [rangePreview, setRangePreview] = useState<RangePreview | null>(null);
  const previewRange = usePreviewCapacityBlockRange();
  const applyRange = useApplyCapacityBlockRange();
  const rangeLoading = previewRange.isPending || applyRange.isPending;

  const openBlockDialog = (refId: number, label: string, day: Date) => {
    setMode("hours");
    setStartHour("9");
    setEndHour("12");
    setReason("");
    setTarget({ refId, label, day });
  };
  const openRangeDialog = (refId: number, label: string) => {
    setRangeTarget({ refId, label });
    setRangeFrom(from);
    setRangeTo(to);
    setRangeDays("all");
    setSelectedWeekdays([1, 2, 3, 4, 5]);
    setRangeMode("day");
    setRangeStartHour("9");
    setRangeEndHour("12");
    setRangeReason("");
    setRangePreview(null);
  };
  const rangePayload = () => ({
    kind: tab,
    refId: rangeTarget!.refId,
    from: rangeFrom,
    to: rangeTo,
    days: rangeDays,
    ...(rangeDays === "selected" ? { weekdays: selectedWeekdays } : {}),
    mode: rangeMode,
    ...(rangeMode === "hours"
      ? { startHour: Number(rangeStartHour), endHour: Number(rangeEndHour) }
      : {}),
    ...(rangeReason.trim() ? { reason: rangeReason.trim() } : {}),
  });
  const requestRange = async (action: "preview" | "apply") => {
    if (!rangeTarget) return;
    if (rangeMode === "hours" && Number(rangeEndHour) <= Number(rangeStartHour)) {
      toast({ title: "Invalid hours", description: "End time must be after the start time.", variant: "destructive" });
      return;
    }
    try {
      const body =
        action === "preview"
          ? await previewRange.mutateAsync({ data: rangePayload() })
          : await applyRange.mutateAsync({ data: rangePayload() });
      if (action === "preview") setRangePreview(body);
      else {
        toast({ title: "Capacity range applied", description: `${body.summary.create} new blocks created.` });
        setRangeTarget(null);
        invalidate();
      }
    } catch (err) {
      toast({ title: action === "preview" ? "Could not preview range" : "Could not apply range", description: err instanceof Error ? err.message : "Try again.", variant: "destructive" });
    }
  };

  // Blocks for the resource/day currently open in the dialog (live — updates
  // as windows are added/removed without closing the dialog).
  const targetBlocks = target
    ? (blockIndex.get(`${tab}:${target.refId}:${dateStr(target.day)}`) ?? [])
    : [];
  const targetHasFullDay = targetBlocks.some((b) => b.startHour == null);

  const submitBlock = async () => {
    if (!target) return;
    if (mode === "hours" && Number(endHour) <= Number(startHour)) {
      toast({
        title: "Invalid hours",
        description: "End time must be after the start time.",
        variant: "destructive",
      });
      return;
    }
    try {
      await createBlock.mutateAsync({
        data: {
          kind: tab,
          refId: target.refId,
          date: dateStr(target.day),
          ...(mode === "hours"
            ? { startHour: Number(startHour), endHour: Number(endHour) }
            : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      setTarget(null);
      invalidate();
    } catch (err) {
      toast({
        title: "Could not block",
        description: err instanceof Error ? err.message : "Try again.",
        variant: "destructive",
      });
    }
  };

  const unblock = async (block: CapacityBlock, cellKey: string) => {
    setBusyCell(cellKey);
    try {
      await deleteBlock.mutateAsync({ id: block.id });
      invalidate();
    } catch (err) {
      toast({
        title: "Could not unblock",
        description: err instanceof Error ? err.message : "Try again.",
        variant: "destructive",
      });
    } finally {
      setBusyCell(null);
    }
  };

  return (
    <Page className="space-y-6">
      <PageHero
        eyebrow="Test Drive Operations"
        title="Capacity"
        accent="Planning"
        subtitle="Block out days or hours when a demo car or a sales advisor is unavailable — blocked time disappears from the test-drive scheduler."
      />

      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant={tab === "vehicle" ? "default" : "outline"}
          size="sm"
          className="rounded-full gap-1.5"
          onClick={() => setTab("vehicle")}
        >
          <Car className="w-4 h-4" /> Demo Vehicles
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
          Click a cell to manage that day — block the full day or add one or
          more hour windows (e.g. busy 9–10, free, busy 2–4), and remove
          blocks you no longer need.
        </span>
      </div>

      <Card className="glass-panel border-none rounded-2xl overflow-hidden">
        <CardContent className="p-4 overflow-x-auto">
          {error ? (
            <p className="text-sm text-destructive p-6">
              Could not load the capacity plan — you may not have manager
              access, or the server is unavailable.
            </p>
          ) : isLoading ? (
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
                    {tab === "vehicle" ? "Model (demo unit)" : "Advisor"}
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
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium truncate max-w-[160px]">{r.label}</div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[10px] rounded-full"
                          data-testid={`button-range-${tab}-${r.id}`}
                          onClick={() => openRangeDialog(r.id, r.label)}
                        >
                          Range
                        </Button>
                      </div>
                      {r.sub && (
                        <div className="text-[10px] text-muted-foreground truncate max-w-[220px]">
                          {r.sub}
                        </div>
                      )}
                    </td>
                    {days.map((d) => {
                      const key = `${tab}:${r.id}:${dateStr(d)}`;
                      const cellBlocks = blockIndex.get(key) ?? [];
                      const busy = busyCell === key;
                      const fullDay = cellBlocks.some(
                        (b) => b.startHour == null,
                      );
                      const windows = cellBlocks.filter(
                        (b) => b.startHour != null && b.endHour != null,
                      );
                      const windowsLabel = windows
                        .map((b) => `${b.startHour}–${b.endHour}h`)
                        .join(", ");
                      return (
                        <td key={key} className="p-1 text-center align-middle">
                          <button
                            aria-label={`${r.label} — ${dateStr(d)} — ${
                              fullDay
                                ? "blocked all day"
                                : windows.length > 0
                                  ? `blocked ${windowsLabel}`
                                  : "available"
                            }`}
                            title={
                              cellBlocks
                                .map((b) => b.reason)
                                .filter(Boolean)
                                .join("; ") || undefined
                            }
                            disabled={busy}
                            onClick={() => openBlockDialog(r.id, r.label, d)}
                            className={cn(
                              "min-w-9 h-9 px-1 rounded-lg border transition-colors inline-flex flex-col items-center justify-center leading-none",
                              fullDay
                                ? "bg-red-500/25 border-red-500/40 hover:bg-red-500/35 text-red-600 dark:text-red-400"
                                : windows.length > 0
                                  ? "bg-amber-500/20 border-amber-500/40 hover:bg-amber-500/30 text-amber-600 dark:text-amber-400"
                                  : "bg-emerald-500/10 border-emerald-500/20 hover:bg-emerald-500/25",
                            )}
                          >
                            {busy ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : fullDay ? (
                              "✕"
                            ) : windows.length > 0 ? (
                              <span className="text-[8px] font-bold whitespace-nowrap">
                                {windows.length > 2
                                  ? `${windows.length} blocks`
                                  : windowsLabel}
                              </span>
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

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Manage capacity</DialogTitle>
            <DialogDescription>
              {target
                ? `${target.label} — ${target.day.toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {targetBlocks.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Current blocks
              </p>
              {targetBlocks.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-foreground/[0.04] px-3 py-1.5 text-sm"
                >
                  <span>
                    {b.startHour != null && b.endHour != null
                      ? `${hourLabel(b.startHour)} – ${hourLabel(b.endHour)}`
                      : "Full day"}
                    {b.reason ? (
                      <span className="text-muted-foreground"> — {b.reason}</span>
                    ) : null}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 rounded-full text-destructive hover:text-destructive"
                    disabled={deleteBlock.isPending}
                    onClick={() =>
                      unblock(b, `${tab}:${target!.refId}:${dateStr(target!.day)}`)
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
          {targetHasFullDay ? (
            <p className="text-xs text-muted-foreground">
              The whole day is blocked. Remove the full-day block to switch to
              specific hour windows.
            </p>
          ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={mode === "day" ? "default" : "outline"}
                className="rounded-full"
                disabled={targetBlocks.length > 0}
                title={
                  targetBlocks.length > 0
                    ? "Remove the hour windows first to block the full day"
                    : undefined
                }
                onClick={() => setMode("day")}
              >
                Full day
              </Button>
              <Button
                size="sm"
                variant={mode === "hours" ? "default" : "outline"}
                className="rounded-full"
                onClick={() => setMode("hours")}
              >
                Specific hours
              </Button>
            </div>
            {mode === "hours" && (
              <div className="flex items-center gap-2">
                <Select value={startHour} onValueChange={setStartHour}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((h) => (
                      <SelectItem key={h} value={String(h)}>
                        {hourLabel(h)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">to</span>
                <Select value={endHour} onValueChange={setEndHour}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((h) => (
                      <SelectItem key={h + 1} value={String(h + 1)}>
                        {hourLabel(h + 1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (optional) — e.g. service, event, leave"
            />
          </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="rounded-full"
              onClick={() => setTarget(null)}
            >
              {targetBlocks.length > 0 ? "Done" : "Cancel"}
            </Button>
            {!targetHasFullDay && (
              <Button
                className="rounded-full"
                disabled={createBlock.isPending}
                onClick={submitBlock}
              >
                {createBlock.isPending && (
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                )}
                {mode === "day" ? "Block day" : "Add block"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!rangeTarget} onOpenChange={(open) => !open && setRangeTarget(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Block capacity range</DialogTitle>
            <DialogDescription>
              {rangeTarget ? `Create blocks for ${rangeTarget.label}. Dates are inclusive and use the dealership calendar.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-xs font-medium">
                From
                <Input data-testid="input-capacity-range-from" type="date" value={rangeFrom} onChange={(event) => { setRangeFrom(event.target.value); setRangePreview(null); }} />
              </label>
              <label className="space-y-1 text-xs font-medium">
                To
                <Input data-testid="input-capacity-range-to" type="date" value={rangeTo} onChange={(event) => { setRangeTo(event.target.value); setRangePreview(null); }} />
              </label>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium">Days to block</p>
              <div className="flex flex-wrap gap-2">
                {([["all", "All days"], ["weekdays", "Weekdays"], ["selected", "Selected weekdays"]] as const).map(([value, label]) => (
                  <Button key={value} size="sm" variant={rangeDays === value ? "default" : "outline"} className="rounded-full" data-testid={`button-range-days-${value}`} onClick={() => { setRangeDays(value); setRangePreview(null); }}>
                    {label}
                  </Button>
                ))}
              </div>
              {rangeDays === "selected" && (
                <div className="flex flex-wrap gap-1.5">
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name, weekday) => (
                    <Button
                      key={name}
                      size="sm"
                      variant={selectedWeekdays.includes(weekday) ? "default" : "outline"}
                      className="h-7 rounded-full"
                      data-testid={`button-range-weekday-${weekday}`}
                      onClick={() => {
                        setSelectedWeekdays((current) => current.includes(weekday) ? current.filter((day) => day !== weekday) : [...current, weekday]);
                        setRangePreview(null);
                      }}
                    >
                      {name}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Button size="sm" variant={rangeMode === "day" ? "default" : "outline"} className="rounded-full" data-testid="button-range-full-day" onClick={() => { setRangeMode("day"); setRangePreview(null); }}>Full day</Button>
                <Button size="sm" variant={rangeMode === "hours" ? "default" : "outline"} className="rounded-full" data-testid="button-range-hours" onClick={() => { setRangeMode("hours"); setRangePreview(null); }}>Hour window</Button>
              </div>
              {rangeMode === "hours" && (
                <div className="flex items-center gap-2">
                  <Select value={rangeStartHour} onValueChange={(value) => { setRangeStartHour(value); setRangePreview(null); }}>
                    <SelectTrigger className="w-28" data-testid="select-range-start-hour"><SelectValue /></SelectTrigger>
                    <SelectContent>{HOURS.map((hour) => <SelectItem key={hour} value={String(hour)}>{hourLabel(hour)}</SelectItem>)}</SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">to</span>
                  <Select value={rangeEndHour} onValueChange={(value) => { setRangeEndHour(value); setRangePreview(null); }}>
                    <SelectTrigger className="w-28" data-testid="select-range-end-hour"><SelectValue /></SelectTrigger>
                    <SelectContent>{HOURS.map((hour) => <SelectItem key={hour + 1} value={String(hour + 1)}>{hourLabel(hour + 1)}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <Input data-testid="input-capacity-range-reason" value={rangeReason} onChange={(event) => { setRangeReason(event.target.value); setRangePreview(null); }} placeholder="Reason (optional)" />
            {rangePreview && (
              <div className="rounded-lg border p-3 space-y-2" data-testid="status-capacity-range-preview">
                <p className="text-xs font-medium">
                  Preview: {rangePreview.summary.create} create, {rangePreview.summary.duplicate} duplicate, {rangePreview.summary.conflict} conflict, {rangePreview.summary.skipped} skipped
                </p>
                <div className="max-h-32 overflow-y-auto space-y-1 text-xs">
                  {rangePreview.items.map((item) => (
                    <p key={item.date} className={item.status === "conflict" ? "text-destructive" : item.status === "duplicate" ? "text-amber-600" : "text-muted-foreground"}>
                      {item.date}: {item.status}{item.message ? ` — ${item.message}` : ""}
                    </p>
                  ))}
                </div>
                {rangePreview.summary.conflict > 0 && <p className="text-xs text-destructive">Conflicts prevent the entire range from being applied.</p>}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-full" data-testid="button-cancel-capacity-range" onClick={() => setRangeTarget(null)}>Cancel</Button>
            <Button variant="outline" className="rounded-full" disabled={rangeLoading} data-testid="button-preview-capacity-range" onClick={() => void requestRange("preview")}>
              {rangeLoading && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />} Preview
            </Button>
            <Button className="rounded-full" disabled={rangeLoading || !rangePreview || rangePreview.summary.conflict > 0} data-testid="button-apply-capacity-range" onClick={() => void requestRange("apply")}>
              Apply range
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
