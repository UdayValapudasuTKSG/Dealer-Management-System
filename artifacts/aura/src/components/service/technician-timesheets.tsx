import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  getGetDailyTechnicianTimesheetQueryKey,
  useCreateTechnicianTimesheetEntry,
  useDeleteTechnicianTimesheetEntry,
  useGetDailyTechnicianTimesheet,
  useListJobCards,
  useListServiceTechnicians,
  useSetTechnicianDailyAvailability,
  useUpdateTechnicianTimesheetEntry,
  type JobCard,
  type DailyTechnicianTimesheetRow,
  type TechnicianTimesheetEntry,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Clock3, Edit3, Loader2, Plus, Trash2, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { dealerDayKey } from "@/lib/format";
import { cn } from "@/lib/utils";

function shiftDay(value: string, amount: number): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + amount, 12))
    .toISOString()
    .slice(0, 10);
}

function hours(value: number): string {
  return `${value.toFixed(2)}h`;
}

function percent(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(0)}%`;
}

function errorMessage(error: unknown, fallback: string): string {
  return (
    (error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
    fallback
  );
}

export function TechnicianTimesheetsTab() {
  const { me } = useAuthz();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isManager = /service manager|general manager|leadership|management|owner.?admin|admin/i.test(
    me?.roleName ?? "",
  ) || Boolean(me?.isSuperAdmin);
  const [date, setDate] = useState(() => dealerDayKey());
  const [entryDialog, setEntryDialog] = useState<{
    technicianUserId: number;
    entry?: TechnicianTimesheetEntry;
  } | null>(null);
  const [availabilityTech, setAvailabilityTech] = useState<number | null>(null);

  const timesheet = useGetDailyTechnicianTimesheet({ date });
  const jobCards = useListJobCards({});
  const technicians = useListServiceTechnicians();
  const createEntry = useCreateTechnicianTimesheetEntry();
  const updateEntry = useUpdateTechnicianTimesheetEntry();
  const deleteEntry = useDeleteTechnicianTimesheetEntry();
  const setAvailability = useSetTechnicianDailyAvailability();
  const rows = timesheet.data?.rows ?? [];
  const selectedAvailabilityRow = rows.find(
    (row) => row.technicianUserId === availabilityTech,
  );
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getGetDailyTechnicianTimesheetQueryKey({ date }),
    });

  const saveAvailability = async (value: number) => {
    if (availabilityTech == null) return;
    try {
      await setAvailability.mutateAsync({
        technicianUserId: availabilityTech,
        data: { workDate: date, availableHours: value },
      });
      await invalidate();
      setAvailabilityTech(null);
      toast({ title: "Availability saved", description: `Override saved for ${date}.` });
    } catch (error) {
      toast({
        title: "Availability not saved",
        description: errorMessage(error, "Could not save the availability override."),
        variant: "destructive",
      });
    }
  };

  const saveEntry = async (input: {
    technicianUserId: number;
    jobCardId?: number | null;
    durationMinutes: number;
    note?: string | null;
  }) => {
    try {
      if (entryDialog?.entry) {
        await updateEntry.mutateAsync({
          id: entryDialog.entry.id,
          data: { durationMinutes: input.durationMinutes, note: input.note },
        });
      } else {
        await createEntry.mutateAsync({
          data: { workDate: date, ...input },
        });
      }
      await invalidate();
      setEntryDialog(null);
      toast({ title: entryDialog?.entry ? "Time entry updated" : "Time entry added" });
    } catch (error) {
      toast({
        title: "Time entry not saved",
        description: errorMessage(error, "Check the duration and assigned job card."),
        variant: "destructive",
      });
    }
  };

  const removeEntry = async (entry: TechnicianTimesheetEntry) => {
    if (!window.confirm("Delete this manual time entry?")) return;
    try {
      await deleteEntry.mutateAsync({ id: entry.id });
      await invalidate();
      toast({ title: "Time entry deleted" });
    } catch (error) {
      toast({
        title: "Time entry not deleted",
        description: errorMessage(error, "Could not delete this entry."),
        variant: "destructive",
      });
    }
  };

  const summary = timesheet.data?.summary;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Daily technician timesheet</h2>
          <p className="text-xs text-muted-foreground">
            Dealer day in {timesheet.data?.timezone ?? "the dealership timezone"} · manual
            actuals only
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setDate(shiftDay(date, -1))}>
            Previous
          </Button>
          <Input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="w-[145px]"
            aria-label="Timesheet date"
          />
          <Button variant="outline" size="sm" onClick={() => setDate(shiftDay(date, 1))}>
            Next
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDate(dealerDayKey())}>
            Today
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-xs text-muted-foreground">
        <strong className="text-foreground">How this is measured:</strong> approved sold
        hours come from the current estimate version approved on this dealer day. Invoiced
        sold hours come from the immutable labour snapshot on invoices issued on this dealer
        day. Efficiency = approved sold ÷ manual logged actual; productivity = invoiced sold
        ÷ manual logged actual. A zero actual denominator shows “—”, never a misleading 0%.
      </div>

      {timesheet.isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-white/10 py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading dealer-day summary…
        </div>
      ) : timesheet.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          Could not load the daily timesheet. {errorMessage(timesheet.error, "Try again.")}
        </div>
      ) : (
        <>
          {summary && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
              <Metric label="Available" value={hours(summary.availableHours)} />
              <Metric label="Booked" value={hours(summary.bookedHours)} />
              <Metric label="Approved sold" value={hours(summary.approvedSoldHours)} />
              <Metric
                label="Invoiced sold"
                value={`${hours(summary.invoicedSoldHours)}${summary.invoicedHoursKnown ? "" : " *"}`}
              />
              <Metric label="Logged actual" value={hours(summary.loggedActualHours)} />
              <Metric
                label="Remaining capacity"
                value={hours(summary.remainingCapacityHours)}
                tone={summary.remainingCapacityHours < 0 ? "danger" : undefined}
              />
              <Metric label="Efficiency" value={percent(summary.efficiencyPct)} />
              <Metric label="Productivity" value={percent(summary.productivityPct)} />
            </div>
          )}
          {!summary?.invoicedHoursKnown && (
            <p className="text-xs text-muted-foreground">
              * At least one invoice on this day has no historical labour-hours snapshot;
              its invoiced hours are shown as unknown rather than guessed.
            </p>
          )}
          <div className="space-y-3">
            {rows.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-sm text-muted-foreground">
                  No technicians are set up for this dealership.
                </CardContent>
              </Card>
            ) : (
              rows.map((row) => (
                <TechnicianDayRow
                  key={row.technicianUserId}
                  row={row}
                  isManager={isManager}
                  onAdd={() => setEntryDialog({ technicianUserId: row.technicianUserId })}
                  onEdit={(entry) =>
                    setEntryDialog({ technicianUserId: row.technicianUserId, entry })
                  }
                  onDelete={removeEntry}
                  onAvailability={
                    isManager ? () => setAvailabilityTech(row.technicianUserId) : undefined
                  }
                />
              ))
            )}
          </div>
        </>
      )}

      <TimesheetEntryDialog
        open={entryDialog != null}
        onOpenChange={(open) => !open && setEntryDialog(null)}
        date={date}
        technicianUserId={entryDialog?.technicianUserId ?? me?.id ?? 0}
        entry={entryDialog?.entry}
        isManager={isManager}
        technicians={technicians.data ?? []}
        jobCards={jobCards.data ?? []}
        pending={createEntry.isPending || updateEntry.isPending}
        onSave={saveEntry}
      />
      <AvailabilityDialog
        open={availabilityTech != null}
        onOpenChange={(open) => !open && setAvailabilityTech(null)}
        technicianName={selectedAvailabilityRow?.technicianName ?? "technician"}
        currentHours={selectedAvailabilityRow?.availableHours ?? 8}
        pending={setAvailability.isPending}
        onSave={saveAvailability}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger";
}) {
  return (
    <Card className={cn("border-white/10 bg-white/[0.025]", tone === "danger" && "border-destructive/40")}>
      <CardContent className="p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className={cn("mt-1 text-lg font-semibold tabular-nums", tone === "danger" && "text-destructive")}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function TechnicianDayRow({
  row,
  isManager,
  onAdd,
  onEdit,
  onDelete,
  onAvailability,
}: {
  row: DailyTechnicianTimesheetRow;
  isManager: boolean;
  onAdd: () => void;
  onEdit: (entry: TechnicianTimesheetEntry) => void;
  onDelete: (entry: TechnicianTimesheetEntry) => void;
  onAvailability?: () => void;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.025]">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">{row.technicianName}</h3>
              {row.availabilitySource === "override" && (
                <Badge variant="outline" className="text-[10px]">override</Badge>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1 text-xs text-muted-foreground sm:grid-cols-5">
              <span>Available <strong className="text-foreground">{hours(row.availableHours)}</strong></span>
              <span>Booked <strong className="text-foreground">{hours(row.bookedHours)}</strong></span>
              <span>Approved <strong className="text-foreground">{hours(row.approvedSoldHours)}</strong></span>
              <span>Invoiced <strong className="text-foreground">{hours(row.invoicedSoldHours)}{!row.invoicedHoursKnown && " *"}</strong></span>
              <span>Actual <strong className="text-foreground">{hours(row.loggedActualHours)}</strong></span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Remaining {hours(row.remainingCapacityHours)} · Efficiency {percent(row.efficiencyPct)} · Productivity {percent(row.productivityPct)}
            </div>
          </div>
          <div className="flex gap-2">
            {onAvailability && (
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onAvailability}>
                <Clock3 className="mr-1 h-3.5 w-3.5" /> Set availability
              </Button>
            )}
            <Button size="sm" className="h-8 text-xs" onClick={onAdd}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Log time
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Manual daily entries
            </div>
            {row.entries.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/10 p-4 text-xs text-muted-foreground">
                No manual actuals logged for this day.
              </div>
            ) : (
              <div className="divide-y divide-white/10 rounded-lg border border-white/10">
                {row.entries.map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      {entry.jobCardId ? (
                        <Link
                          href={`/service/job-cards/${entry.jobCardId}`}
                          className="font-medium text-primary hover:underline"
                        >
                          JC #{entry.jobCardId} · {entry.jobCardTitle ?? "Job card"}
                        </Link>
                      ) : (
                        <span className="font-medium">Non-job time</span>
                      )}
                      <div className="truncate text-xs text-muted-foreground">
                        <Badge variant="secondary" className="mr-1 text-[9px]">manual</Badge>
                        {entry.note || "No note"}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="font-semibold tabular-nums">{hours(entry.durationMinutes / 60)}</span>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(entry)} aria-label="Edit time entry">
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => onDelete(entry)} aria-label="Delete time entry">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-3 text-xs">
            <div>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Sold-hours drilldown</div>
              <div className="space-y-1.5">
                {row.approvedJobs.map((job) => (
                  <Link key={`a-${job.jobCardId}`} href={`/service/job-cards/${job.jobCardId}`} className="block rounded-md border border-white/10 p-2 hover:border-primary/40">
                    <div className="font-medium text-primary">Approved · JC #{job.jobCardId}</div>
                    <div className="truncate text-muted-foreground">{job.title} · {hours(job.hours)}</div>
                  </Link>
                ))}
                {row.invoicedJobs.map((job) => (
                  <Link key={`i-${job.jobCardId}`} href={`/service/job-cards/${job.jobCardId}`} className="block rounded-md border border-white/10 p-2 hover:border-primary/40">
                    <div className="font-medium text-primary">Invoiced · JC #{job.jobCardId}</div>
                    <div className="truncate text-muted-foreground">{job.title} · {hours(job.hours)}</div>
                  </Link>
                ))}
                {row.approvedJobs.length === 0 && row.invoicedJobs.length === 0 && (
                  <div className="text-muted-foreground">No approved or known invoiced sold hours on this dealer day.</div>
                )}
              </div>
            </div>
            <div className="rounded-md border border-dashed border-white/10 p-2 text-muted-foreground">
              <strong className="text-foreground">Legacy timer total:</strong> {hours(row.existingTimerHours)} cumulative across job cards. Not counted as this day&apos;s logged actual.
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TimesheetEntryDialog({
  open,
  onOpenChange,
  date,
  technicianUserId,
  entry,
  isManager,
  technicians,
  jobCards,
  pending,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string;
  technicianUserId: number;
  entry?: TechnicianTimesheetEntry;
  isManager: boolean;
  technicians: { id: number; name: string }[];
  jobCards: JobCard[];
  pending: boolean;
  onSave: (input: {
    technicianUserId: number;
    jobCardId?: number | null;
    durationMinutes: number;
    note?: string | null;
  }) => Promise<void>;
}) {
  const [tech, setTech] = useState(String(entry?.technicianUserId ?? technicianUserId));
  const [duration, setDuration] = useState(
    entry ? String(entry.durationMinutes) : "60",
  );
  const [jobCard, setJobCard] = useState(String(entry?.jobCardId ?? "none"));
  const [note, setNote] = useState(entry?.note ?? "");
  useEffect(() => {
    if (!open) return;
    setTech(String(entry?.technicianUserId ?? technicianUserId));
    setDuration(entry ? String(entry.durationMinutes) : "60");
    setJobCard(String(entry?.jobCardId ?? "none"));
    setNote(entry?.note ?? "");
  }, [entry, open, technicianUserId]);
  const selectedTech = Number(tech);
  const availableCards = useMemo(
    () => jobCards.filter((card) => card.technicianUserId === selectedTech && card.status !== "cancelled"),
    [jobCards, selectedTech],
  );
  const submit = async () => {
    const minutes = Number(duration);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return;
    await onSave({
      technicianUserId: selectedTech,
      jobCardId: jobCard === "none" ? null : Number(jobCard),
      durationMinutes: minutes,
      note: note.trim() || null,
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{entry ? "Edit daily time" : "Log daily time"}</DialogTitle>
          <DialogDescription>
            {date} · manual actual, maximum 24 hours total per technician/day.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {isManager && !entry && (
            <div className="space-y-1.5">
              <Label>Technician</Label>
              <Select value={tech} onValueChange={(value) => { setTech(value); setJobCard("none"); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {technicians.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Duration (minutes)</Label>
            <Input type="number" min={1} max={1440} step={1} value={duration} onChange={(event) => setDuration(event.target.value)} />
          </div>
          {!entry && (
            <div className="space-y-1.5">
              <Label>Job card (optional)</Label>
              <Select value={jobCard} onValueChange={setJobCard}>
                <SelectTrigger><SelectValue placeholder="Non-job time" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Non-job time</SelectItem>
                  {availableCards.map((card) => (
                    <SelectItem key={card.id} value={String(card.id)}>JC #{card.id} · {card.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">Job cards are limited to those assigned to the selected technician.</p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Note (optional)</Label>
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="Diagnostics, training, admin, or work performed…" rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={pending || !Number.isInteger(Number(duration)) || Number(duration) < 1 || Number(duration) > 1440}>
            {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Save entry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AvailabilityDialog({
  open,
  onOpenChange,
  technicianName,
  currentHours,
  pending,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  technicianName: string;
  currentHours: number;
  pending: boolean;
  onSave: (hours: number) => Promise<void>;
}) {
  const [value, setValue] = useState(String(currentHours));
  useEffect(() => {
    if (open) setValue(String(currentHours));
  }, [currentHours, open]);
  const submit = async () => {
    const hoursValue = Number(value);
    if (!Number.isFinite(hoursValue) || hoursValue < 0 || hoursValue > 24) return;
    await onSave(hoursValue);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Set daily availability</DialogTitle>
          <DialogDescription>
            Override the configured workday for {technicianName}. This is capacity only; it does not represent leave or a shift calendar.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Available hours (0–24)</Label>
          <Input type="number" min={0} max={24} step={0.25} value={value} onChange={(event) => setValue(event.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={pending || Number(value) < 0 || Number(value) > 24}>
            {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Save override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
