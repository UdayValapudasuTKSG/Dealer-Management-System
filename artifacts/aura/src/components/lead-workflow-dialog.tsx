import { useMemo, useState } from "react";
import {
  useGetLead,
  useUpdateLead,
  useAssignLead,
  useScheduleTestDrive,
  useCheckLeadAvailability,
  useRecordLeadDecision,
  useListLeadAdvisors,
  useGetLeadTimeline,
  useListVehicles,
  getListLeadsQueryKey,
  getGetLeadQueryKey,
  getGetLeadTimelineQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  UserCheck,
  CalendarClock,
  PackageSearch,
  Banknote,
  Landmark,
  Loader2,
  Mail,
  Phone,
  Paperclip,
  Plus,
  CircleCheck,
  CircleAlert,
  History,
  ArrowUpRight,
  ArrowRight,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatGuyanaDateTime } from "@/lib/format";

const NEXT_ADVANCE: Record<
  string,
  { toStage: "qualified" | "test_drive" | "proposal" | "negotiation" | "sold"; label: string } | undefined
> = {
  new: { toStage: "qualified", label: "Qualified" },
  contacted: { toStage: "test_drive", label: "Test Drive" },
  qualified: { toStage: "proposal", label: "Proposal" },
  proposal: { toStage: "negotiation", label: "Negotiation" },
  negotiation: { toStage: "sold", label: "Sold" },
};

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  assigned: "Assigned",
  contacted: "Contacted",
  qualified: "Qualified",
  test_drive: "Test Drive",
  back_order: "Back Order",
  decision: "Decision",
  engaged: "Engaged",
  converted: "Converted",
  lost: "Lost",
};

const SOURCE_LABEL: Record<string, string> = {
  website: "Website",
  walk_in: "Walk-in",
  phone: "Phone",
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  referral: "Referral",
};

const PRIORITY_STYLE: Record<string, string> = {
  high: "bg-primary/15 text-primary ring-primary/30",
  medium: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  low: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
};

function SectionCard({
  icon: Icon,
  title,
  children,
  done,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
  done?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "w-7 h-7 rounded-full flex items-center justify-center shrink-0",
            done ? "bg-emerald-500/15 text-emerald-400" : "bg-primary/15 text-primary",
          )}
        >
          {done ? <CircleCheck className="w-4 h-4" /> : <Icon className="w-3.5 h-3.5" />}
        </span>
        <span className="text-sm font-semibold tracking-tight">{title}</span>
      </div>
      {children}
    </div>
  );
}

export function LeadWorkflowDialog({
  leadId,
  open,
  onOpenChange,
}: {
  leadId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const lead = useGetLead(leadId ?? 0, {
    query: { queryKey: getGetLeadQueryKey(leadId ?? 0), enabled: open && leadId != null },
  });
  const timeline = useGetLeadTimeline(leadId ?? 0, {
    query: {
      queryKey: getGetLeadTimelineQueryKey(leadId ?? 0),
      enabled: open && leadId != null,
    },
  });
  const advisors = useListLeadAdvisors({
    query: { queryKey: ["lead-advisors"], enabled: open },
  });
  const { data: vehicles } = useListVehicles();

  const assignLead = useAssignLead();
  const updateLead = useUpdateLead();
  const scheduleTestDrive = useScheduleTestDrive();
  const checkAvailability = useCheckLeadAvailability();
  const recordDecision = useRecordLeadDecision();

  const [advisorId, setAdvisorId] = useState<string>("");
  const [tdDate, setTdDate] = useState("");
  const [tdTime, setTdTime] = useState("");
  const [tdBranch, setTdBranch] = useState("");
  const [tdLicence, setTdLicence] = useState("");
  const [tdWaiver, setTdWaiver] = useState(false);
  const [attachName, setAttachName] = useState("");
  const [attachUrl, setAttachUrl] = useState("");

  const l = lead.data;
  const vehicle = useMemo(
    () => vehicles?.find((v) => v.id === l?.interestedVehicleId),
    [vehicles, l?.interestedVehicleId],
  );

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
    if (leadId != null) {
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      queryClient.invalidateQueries({
        queryKey: getGetLeadTimelineQueryKey(leadId),
      });
    }
  };

  const fail = (err: unknown) =>
    toast({
      title: "That didn't go through",
      description:
        err instanceof Error ? err.message : "Please try again in a moment.",
      variant: "destructive",
    });

  if (leadId == null) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
        {!l ? (
          <div className="py-16 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3 flex-wrap text-2xl font-light tracking-tight">
                {l.name}
                <span
                  className={cn(
                    "text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full ring-1",
                    PRIORITY_STYLE[l.priority] ?? PRIORITY_STYLE.low,
                  )}
                >
                  {l.priority} priority
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2.5 py-1 rounded-full">
                  {SOURCE_LABEL[l.source] ?? l.source}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground/80 bg-foreground/[0.06] px-2.5 py-1 rounded-full">
                  {STATUS_LABEL[l.status] ?? l.status}
                </span>
              </DialogTitle>
              <DialogDescription asChild>
                <div className="flex items-center gap-4 flex-wrap text-sm text-muted-foreground pt-1">
                  {l.email && (
                    <span className="inline-flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5" /> {l.email}
                    </span>
                  )}
                  {l.phone && (
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5" /> {l.phone}
                    </span>
                  )}
                  {vehicle && (
                    <span>
                      {vehicle.year} {vehicle.make} {vehicle.model}
                      {l.variant ? ` · ${l.variant}` : ""}
                      {l.color ? ` · ${l.color}` : ""}
                    </span>
                  )}
                  {l.preferredBranch && <span>{l.preferredBranch} branch</span>}
                </div>
              </DialogDescription>
            </DialogHeader>

            {l.notes && (
              <p className="text-sm text-muted-foreground whitespace-pre-line rounded-xl bg-foreground/[0.03] border border-white/10 p-3">
                {l.notes}
              </p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* 1 — Assignment */}
              <SectionCard icon={UserCheck} title="Advisor" done={!!l.ownerUserId}>
                {l.assignedTo && (
                  <p className="text-sm text-muted-foreground">
                    Owned by <span className="text-foreground font-medium">{l.assignedTo}</span>
                  </p>
                )}
                <div className="flex gap-2">
                  <Select value={advisorId} onValueChange={setAdvisorId}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder={l.ownerUserId ? "Reassign…" : "Choose an advisor"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(advisors.data ?? []).map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name}
                          {a.roleName ? ` — ${a.roleName}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={!advisorId || assignLead.isPending}
                    onClick={async () => {
                      try {
                        await assignLead.mutateAsync({
                          id: l.id,
                          data: { userId: Number(advisorId) },
                        });
                        refresh();
                        setAdvisorId("");
                        toast({
                          title: "Advisor assigned",
                          description: "They've been notified and the client emailed.",
                        });
                      } catch (err) {
                        fail(err);
                      }
                    }}
                  >
                    {assignLead.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      "Assign"
                    )}
                  </Button>
                </div>
              </SectionCard>

              {/* Stage advancing lives in the workbench Action Chain — this
                  dialog only handles the supporting actions. */}
              {NEXT_ADVANCE[l.phase] && (
                <SectionCard icon={ArrowRight} title="Next Stage">
                  <p className="text-xs text-muted-foreground">
                    Next stage:{" "}
                    <span className="text-foreground font-semibold">
                      {NEXT_ADVANCE[l.phase]!.label}
                    </span>
                    . Advance from the Action Chain on the lead page — it shows
                    the readiness checklist and any pending approvals.
                  </p>
                </SectionCard>
              )}

              <SectionCard icon={History} title="Status">
                <Select
                  value={l.status}
                  onValueChange={async (status) => {
                    try {
                      await updateLead.mutateAsync({
                        id: l.id,
                        data: { status: status as never },
                      });
                      refresh();
                      toast({ title: "Status updated" });
                    } catch (err) {
                      fail(err);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(STATUS_LABEL).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SectionCard>

              {/* 3 — Test drive */}
              <SectionCard
                icon={CalendarClock}
                title="Test drive"
                done={!!l.testDriveAt}
              >
                {l.testDriveAt && (
                  <p className="text-sm text-muted-foreground">
                    Booked for{" "}
                    <span className="text-foreground font-medium">
                      {formatGuyanaDateTime(l.testDriveAt)}
                    </span>
                    {l.testDriveBranch ? ` — ${l.testDriveBranch}` : ""}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    value={tdDate}
                    onChange={(e) => setTdDate(e.target.value)}
                  />
                  <Input
                    type="time"
                    value={tdTime}
                    onChange={(e) => setTdTime(e.target.value)}
                  />
                </div>
                <Input
                  placeholder="Driver's licence number"
                  value={tdLicence}
                  onChange={(e) => setTdLicence(e.target.value)}
                />
                <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tdWaiver}
                    onChange={(e) => setTdWaiver(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>Customer has signed the test-drive waiver.</span>
                </label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Branch (optional)"
                    value={tdBranch}
                    onChange={(e) => setTdBranch(e.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={
                      !tdDate ||
                      !tdTime ||
                      !tdLicence.trim() ||
                      !tdWaiver ||
                      scheduleTestDrive.isPending
                    }
                    onClick={async () => {
                      try {
                        await scheduleTestDrive.mutateAsync({
                          id: l.id,
                          data: {
                            scheduledAt: new Date(
                              `${tdDate}T${tdTime}`,
                            ).toISOString(),
                            licenceNumber: tdLicence.trim(),
                            waiverAccepted: tdWaiver,
                            ...(tdBranch ? { branch: tdBranch } : {}),
                          },
                        });
                        refresh();
                        setTdDate("");
                        setTdTime("");
                        setTdBranch("");
                        toast({
                          title: "Test drive booked",
                          description: "Confirmation email is on its way.",
                        });
                      } catch (err) {
                        fail(err);
                      }
                    }}
                  >
                    {scheduleTestDrive.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      "Book"
                    )}
                  </Button>
                </div>
              </SectionCard>

              {/* 4 — Availability */}
              <SectionCard
                icon={PackageSearch}
                title="Inventory availability"
                done={l.availability === "available"}
              >
                {l.availability === "available" ? (
                  <p className="text-sm text-emerald-400 inline-flex items-center gap-1.5">
                    <CircleCheck className="w-4 h-4" /> Vehicle in stock — proceed to decision
                  </p>
                ) : l.availability === "back_order" ? (
                  <p className="text-sm text-amber-400 inline-flex items-center gap-1.5">
                    <CircleAlert className="w-4 h-4" /> On back order — awaiting stock
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {vehicle
                      ? "Check whether the vehicle is available before desking."
                      : "Set an interested vehicle first to run the check."}
                  </p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!vehicle || checkAvailability.isPending}
                  onClick={async () => {
                    try {
                      const updated = await checkAvailability.mutateAsync({ id: l.id });
                      refresh();
                      toast({
                        title:
                          updated.availability === "available"
                            ? "Vehicle available"
                            : "Back order raised",
                        description:
                          updated.availability === "available"
                            ? "Move ahead to the cash-or-finance decision."
                            : "The lead is held until stock lands.",
                      });
                    } catch (err) {
                      fail(err);
                    }
                  }}
                >
                  {checkAvailability.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : l.availability ? (
                    "Re-check availability"
                  ) : (
                    "Check availability"
                  )}
                </Button>
              </SectionCard>
            </div>

            {/* 5 — Decision */}
            <SectionCard
              icon={Banknote}
              title="Payment decision"
              done={!!l.purchaseType}
            >
              {l.purchaseType ? (
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <p className="text-sm text-muted-foreground">
                    Customer chose{" "}
                    <span className="text-foreground font-semibold uppercase">
                      {l.purchaseType}
                    </span>
                    {l.purchaseType === "finance"
                      ? " — continue in the finance workflow."
                      : " — continue to vehicle booking."}
                  </p>
                  {l.purchaseType === "finance" && (
                    <Link
                      href={`/finance?lead=${l.id}`}
                      className="text-xs font-bold uppercase tracking-wider text-primary inline-flex items-center gap-1 hover:underline"
                    >
                      Open F&I <ArrowUpRight className="w-3.5 h-3.5" />
                    </Link>
                  )}
                </div>
              ) : (
                <div className="flex gap-2">
                  {(["cash", "finance"] as const).map((choice) => (
                    <Button
                      key={choice}
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      disabled={
                        recordDecision.isPending ||
                        l.availability !== "available"
                      }
                      onClick={async () => {
                        try {
                          await recordDecision.mutateAsync({
                            id: l.id,
                            data: { choice },
                          });
                          refresh();
                          toast({
                            title:
                              choice === "cash"
                                ? "Cash purchase recorded"
                                : "Finance route recorded",
                            description:
                              choice === "cash"
                                ? "Route the client to vehicle booking."
                                : "Hand off to the finance workflow.",
                          });
                        } catch (err) {
                          fail(err);
                        }
                      }}
                    >
                      {choice === "cash" ? (
                        <Banknote className="w-4 h-4" />
                      ) : (
                        <Landmark className="w-4 h-4" />
                      )}
                      {choice === "cash" ? "Cash" : "Finance"}
                    </Button>
                  ))}
                  {l.availability !== "available" && (
                    <span className="text-xs text-muted-foreground self-center">
                      Requires an available vehicle
                    </span>
                  )}
                </div>
              )}
            </SectionCard>

            {/* Attachments */}
            <SectionCard icon={Paperclip} title="Attachments">
              {l.attachments.length > 0 && (
                <ul className="space-y-1.5">
                  {l.attachments.map((a, i) => (
                    <li key={i}>
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-primary hover:underline inline-flex items-center gap-1.5"
                      >
                        <Paperclip className="w-3.5 h-3.5" />
                        {a.name}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <Input
                  placeholder="Name"
                  value={attachName}
                  onChange={(e) => setAttachName(e.target.value)}
                  className="w-40"
                />
                <Input
                  placeholder="Link (https://…)"
                  value={attachUrl}
                  onChange={(e) => setAttachUrl(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!attachName || !attachUrl || updateLead.isPending}
                  onClick={async () => {
                    try {
                      await updateLead.mutateAsync({
                        id: l.id,
                        data: {
                          attachments: [
                            ...l.attachments,
                            { name: attachName, url: attachUrl },
                          ],
                        },
                      });
                      refresh();
                      setAttachName("");
                      setAttachUrl("");
                      toast({ title: "Attachment added" });
                    } catch (err) {
                      fail(err);
                    }
                  }}
                >
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
            </SectionCard>

            {/* Timeline */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-primary" />
                <Label className="text-sm font-semibold">Lead timeline</Label>
              </div>
              {timeline.isLoading ? (
                <div className="h-16 rounded-xl bg-foreground/[0.04] animate-pulse" />
              ) : (timeline.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No events recorded yet.
                </p>
              ) : (
                <ol className="relative border-l border-white/10 ml-2 space-y-4 pl-5 py-1">
                  {(timeline.data ?? []).map((e) => (
                    <li key={e.id} className="relative">
                      <span className="absolute -left-[26px] top-1 w-2.5 h-2.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />
                      <div className="text-sm font-medium leading-tight">
                        {e.title}
                      </div>
                      {e.detail && (
                        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                          {e.detail}
                        </p>
                      )}
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 mt-1">
                        {e.actor} ·{" "}
                        {formatGuyanaDateTime(e.createdAt)}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
