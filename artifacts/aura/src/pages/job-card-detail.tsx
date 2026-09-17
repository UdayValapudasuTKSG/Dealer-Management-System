import { useEffect, useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetJobCard,
  getGetJobCardQueryKey,
  getGetDailyTechnicianTimesheetQueryKey,
  useUpdateJobCard,
  useToggleJobCardTimer,
  useReopenJobCard,
  useCreateJobCardInvoice,
  useAddJobCardPart,
  useCreateJobCardCreditNote,
  useListServiceInvoices,
  useListJobCardParts,
  useListJobCardExternalParts,
  useListJobCardPartRequisitions,
  useListParts,
  useListJobCardCreditNotes,
  useListJobCardTechnicianNotes,
  useCreateJobCardTechnicianNote,
  getListJobCardTechnicianNotesQueryKey,
  getListJobCardsQueryKey,
  getListWorkshopWipQueryKey,
  getListJobCardPartsQueryKey,
  getListJobCardExternalPartsQueryKey,
  getListJobCardPartRequisitionsQueryKey,
  getListJobCardCreditNotesQueryKey,
  useDecideJobCardSurcharge,
  useApproveJobCardRollover,
  useRolloverJobCard,
  useListServiceTechnicians,
  useClaimServiceOrder,
  useUpdateJobCardWaiting,
  useResendJobCardEstimate,
  useAcknowledgeJobCardEstimate,
  useGetJobCardEstimatePreview,
  useApplyCurrentJobCardLabourRate,
  type JobCard,
  type ServiceOrder,
  type ServiceInvoice,
  type JobCardDetail,
  type JobCardWaitingUpdateReason,
} from "@workspace/api-client-react";
import { useAuthz, } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useMoney, formatDealerDateShort, formatDealerDayTime, formatGuyanaDate } from "@/lib/format";
import { getGetJobCardEstimatePreviewQueryKey, getListPartsQueryKey, getListServiceInvoicesQueryKey, getListServiceOrdersQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  Clock,
  Play,
  Pause,
  RotateCcw,
  User,
  CarFront,
  MessageSquareWarning,
  Wrench,
  Package,
  Receipt,
  Check,
  AlertTriangle,
  FileText,
  Trash2,
  Mail,
  MoreVertical,
  CheckCircle2
} from "lucide-react";
import { PartRequisitionForm } from "@/components/service/part-requisition-form";
import { Page } from "@/components/layout/page";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";


import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { DocumentsCard } from "@/components/documents-card";
import { Label } from "@/components/ui/label";
import { CalendarClock, Circle, PenTool, Phone, Plus } from "lucide-react";
import { Loader2 } from "lucide-react";



function useIsServiceApprover() {
  const { me } = useAuthz();
  const role = me?.roleName ?? "";
  return /service manager|general manager|leadership|management|owner.?admin|admin/i.test(role);
}

const JOB_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  on_hold: "On Hold",
  completed: "Completed",
  closed: "Closed",
  cancelled: "Cancelled",
};

const serviceAmount = new Intl.NumberFormat("en-GY", {
  style: "currency",
  currency: "GYD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatWorkDuration(start: Date, end: Date): string {
  const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function estimateDeliveryLabel(state: string): string {
  switch (state) {
    case "queued":
      return "QUEUED";
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ";
    case "failed":
      return "FAILED";
    case "not_queued":
      return "NOT QUEUED";
    default:
      return state.replace(/_/g, " ").toUpperCase();
  }
}

function estimateDeliveryBadgeClass(state: string): string {
  if (state === "failed") return "bg-rose-500/15 text-rose-300";
  if (state === "sent" || state === "delivered" || state === "read") {
    return "bg-primary/15 text-primary";
  }
  return "bg-amber-500/15 text-amber-300";
}

function estimateDecisionLabel(state: string): string {
  switch (state) {
    case "draft":
      return "NOT YET SENT";
    case "open":
      return "AWAITING CUSTOMER AUTHORIZATION";
    case "approved":
      return "CUSTOMER AUTHORIZED";
    case "declined":
      return "CUSTOMER DECLINED";
    case "expired":
      return "QUOTE EXPIRED";
    case "stale":
      return "QUOTE REVISED";
    default:
      return state.replace(/_/g, " ").toUpperCase();
  }
}

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function JobCardDetailPage() {
  const [, params] = useRoute("/service/job-cards/:id");
  const id = params ? Number(params.id) : NaN;
  const { me } = useAuthz();
  const technicianView = /technician/i.test(me?.roleName ?? "");
  const { data: detail, isLoading } = useGetJobCard(id, {
    query: {
      enabled: !isNaN(id),
      queryKey: getGetJobCardQueryKey(id),
    }
  });

  if (isLoading) {
    return (
      <Page>
        <div className="py-24 flex items-center justify-center">
          <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      </Page>
    );
  }

  if (!detail) {
    return (
      <Page>
        <div className="py-24 text-center text-muted-foreground">
          Job card not found.
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <Button asChild variant="ghost" className="mb-4 -ml-3 text-muted-foreground hover:text-foreground">
        <Link href="/service?tab=myjobs">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Job Cards
        </Link>
      </Button>
      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Job Card #{detail.jobCard.id}</h1>
        <p className="text-muted-foreground">
          Service Order #{detail.serviceOrder.id}
          {detail.serviceOrder.vehicleInfo ? ` · ${detail.serviceOrder.vehicleInfo}` : ""}
          {detail.serviceOrder.customerName ? ` · ${detail.serviceOrder.customerName}` : ""}
          {detail.serviceOrder.vin ? ` · VIN ${detail.serviceOrder.vin}` : ""}
          {detail.serviceOrder.registrationNumber ? ` · Reg ${detail.serviceOrder.registrationNumber}` : ""}
        </p>
      </div>
      <JobCardPanel
        card={detail.jobCard}
        serviceOrder={detail.serviceOrder}
        technicianView={technicianView}
      />
    </Page>
  );
}
export function JobCardPanel({ card, serviceOrder, technicianView = false }: { card: JobCard; serviceOrder?: ServiceOrder; technicianView?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateJobCard();
  const applyCurrentLabourRateMutation = useApplyCurrentJobCardLabourRate();
  const timer = useToggleJobCardTimer();
  const reopen = useReopenJobCard();
  const { can, me } = useAuthz();
  const invoice = useCreateJobCardInvoice();
  const addPart = useAddJobCardPart();
  const [creditNoteDialogOpen, setCreditNoteDialogOpen] = useState(false);
  const [creditNoteIdempotencyKey, setCreditNoteIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const createCreditNote = useCreateJobCardCreditNote({
    request: {
      headers: {
        "x-idempotency-key": creditNoteIdempotencyKey,
      },
    },
  });
  const renewCreditNoteIdempotencyKey = () =>
    setCreditNoteIdempotencyKey(crypto.randomUUID());
  const money = { ...useMoney(), gyd: (value: number) => serviceAmount.format(value) };
  const { data: lines } = useListJobCardParts(card.id);
  const { data: externalLines } = useListJobCardExternalParts(card.id);
  const { data: requisitions } = useListJobCardPartRequisitions(card.id);
  const { data: parts } = useListParts();
  const { data: creditNotes } = useListJobCardCreditNotes(card.id);
  const { data: serviceInvoices } = useListServiceInvoices();
  const [noteDraft, setNoteDraft] = useState("");
  const [quotedLaborHoursDraft, setQuotedLaborHoursDraft] = useState(() =>
    String(card.quotedLaborHours ?? card.laborHours ?? 0),
  );
  const [estimateActionError, setEstimateActionError] = useState<{
    action: "send" | "acknowledge";
    message: string;
  } | null>(null);
  const technicianNotesQuery = useListJobCardTechnicianNotes(card.id);
  const createTechnicianNote = useCreateJobCardTechnicianNote();
  const resendEstimate = useResendJobCardEstimate();
  const acknowledgeEstimate = useAcknowledgeJobCardEstimate();
  const estimatePreview = useGetJobCardEstimatePreview(card.id, {
    query: {
      queryKey: getGetJobCardEstimatePreviewQueryKey(card.id),
      refetchInterval: (query) =>
        query.state.data?.decision.state === "open" ? 12_000 : false,
    },
  });
  const technicianNotes = technicianNotesQuery.data ?? [];
  const notesLoading = technicianNotesQuery.isLoading;
  const noteSaving = createTechnicianNote.isPending;
  const isApprover = useIsServiceApprover();
  const customerPhoneSnapshot = serviceOrder?.customerPhoneSnapshot;
  const canActOnCurrentEstimate =
    isApprover || (card.technicianUserId != null && card.technicianUserId === me?.id);
  const canAddTechnicianNote =
    card.status === "in_progress" &&
    canActOnCurrentEstimate;

  useEffect(() => {
    setQuotedLaborHoursDraft(String(card.quotedLaborHours ?? card.laborHours ?? 0));
  }, [card.id, card.quotedLaborHours, card.laborHours]);

  useEffect(() => {
    if (estimatePreview.data?.decision.state !== "approved") return;
    void queryClient.invalidateQueries({
      queryKey: getGetJobCardQueryKey(card.id),
    });
  }, [
    card.id,
    estimatePreview.data?.decision.state,
    estimatePreview.data?.estimateVersion,
    queryClient,
  ]);

  const addTechnicianNote = async () => {
    const body = noteDraft.trim();
    if (!body) return;
    try {
      await createTechnicianNote.mutateAsync({ id: card.id, data: { body } });
      await queryClient.invalidateQueries({
        queryKey: getListJobCardTechnicianNotesQueryKey(card.id),
      });
      setNoteDraft("");
    } catch (error) {
      toast({
        title: "Could not add technician note",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "destructive",
      });
    }
  };

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetJobCardQueryKey(card.id) }),
      queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListJobCardPartsQueryKey(card.id) }),
      queryClient.invalidateQueries({ queryKey: getListJobCardExternalPartsQueryKey(card.id) }),
      queryClient.invalidateQueries({ queryKey: getListJobCardPartRequisitionsQueryKey(card.id) }),
      queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListJobCardCreditNotesQueryKey(card.id) }),
      queryClient.invalidateQueries({ queryKey: getListServiceInvoicesQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListWorkshopWipQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetJobCardEstimatePreviewQueryKey(card.id) }),
      // Every job-card write can change the timer ledger or its attribution:
      // status/timer transitions, waits, reassignment, repricing and parts.
      queryClient.invalidateQueries({ queryKey: getGetDailyTechnicianTimesheetQueryKey() }),
    ]);
  };

  // Issued (non-backordered) lines are creditable only up to their remaining
  // quantity. The server repeats this check transactionally for concurrent use.
  const creditedByLine = new Map<number, number>();
  for (const note of creditNotes ?? []) {
    creditedByLine.set(
      note.jobCardPartId,
      (creditedByLine.get(note.jobCardPartId) ?? 0) + note.quantity,
    );
  }
  const creditableLines =
    lines
      ?.filter((line) => line.kind === "issue" && !line.backordered)
      .map((line) => ({
        ...line,
        availableToCredit: Math.max(
          0,
          line.quantity - (creditedByLine.get(line.id) ?? 0),
        ),
      }))
      .filter((line) => line.availableToCredit > 0) ?? [];

  const toggleChecklist = async (idx: number) => {
    const next = card.checklist.map((c, i) => (i === idx ? { ...c, done: !c.done } : c));
    await update.mutateAsync({ id: card.id, data: { checklist: next } });
    invalidate();
  };

  // Completion write-up (mandatory): analysis of the service + work performed
  // must be recorded before the card can be moved to Completed.
  const [completeOpen, setCompleteOpen] = useState(false);
  const [analysisDraft, setAnalysisDraft] = useState("");
  const [performedDraft, setPerformedDraft] = useState("");

  const setStatus = async (status: JobCard["status"]) => {
    if (
      status === "completed" &&
      (!card.serviceAnalysis?.trim() || !card.workPerformed?.trim())
    ) {
      setAnalysisDraft(card.serviceAnalysis ?? "");
      setPerformedDraft(card.workPerformed ?? "");
      setCompleteOpen(true);
      return;
    }
    await update.mutateAsync({ id: card.id, data: { status } });
    invalidate();
    toast({ title: "Job card updated", description: `Status → ${JOB_STATUS_LABEL[status]}.` });
  };

  const submitCompletion = async () => {
    try {
      await update.mutateAsync({
        id: card.id,
        data: {
          status: "completed",
          serviceAnalysis: analysisDraft.trim(),
          workPerformed: performedDraft.trim(),
        },
      });
      setCompleteOpen(false);
      invalidate();
      toast({
        title: "Job card completed",
        description: "Completion write-up saved.",
      });
    } catch (err) {
      toast({
        title: "Could not complete job card",
        description: err instanceof Error ? err.message : "Try again.",
        variant: "destructive",
      });
    }
  };

  const internalPartsTotal =
    lines?.reduce(
      (s, l) => s + l.unitPrice * l.quantity * (l.kind === "return" ? -1 : 1),
      0,
    ) ?? 0;
  const externalPartsTotal =
    externalLines?.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0) ?? 0;
  const partsTotal = internalPartsTotal + externalPartsTotal;
  const effectiveQuotedLaborHours = card.quotedLaborHours ?? card.laborHours;
  const laborTotal = effectiveQuotedLaborHours * card.laborRate;
  const linkedInvoice = serviceInvoices?.find((item) => item.jobCardId === card.id);
  const canEditQuoteHours = canActOnCurrentEstimate && !linkedInvoice;
  const preview = estimatePreview.data;
  const previewPartsTotal =
    preview?.lines
      .filter((line) => line.kind === "part")
      .reduce((total, line) => total + line.amount, 0) ?? 0;
  const previewLabourTotal =
    preview?.lines
      .filter((line) => line.kind === "labour")
      .reduce((total, line) => total + line.amount, 0) ?? 0;
  const previewTaxTotal =
    preview?.lines
      .filter((line) => line.kind === "tax")
      .reduce((total, line) => total + line.amount, 0) ?? 0;
  const previewSurchargeTotal =
    preview?.lines
      .filter((line) => line.kind === "surcharge")
      .reduce((total, line) => total + line.amount, 0) ?? 0;
  const customerApprovedCurrent =
    preview?.decision.state === "approved" &&
    preview.decision.id != null;
  const staffAcknowledgedCurrent =
    customerApprovedCurrent &&
    card.estimateStaffAcknowledgedVersion === preview?.estimateVersion &&
    card.estimateStaffAcknowledgedDecisionId === preview?.decision.id;

  const saveQuotedLaborHours = async () => {
    const quotedLaborHours = Number(quotedLaborHoursDraft);
    if (!Number.isFinite(quotedLaborHours) || quotedLaborHours < 0) {
      toast({
        title: "Invalid quoted hours",
        description: "Enter a non-negative number of billable hours.",
        variant: "destructive",
      });
      return;
    }
    if (quotedLaborHours === effectiveQuotedLaborHours) return;
    try {
      await update.mutateAsync({
        id: card.id,
        data: { quotedLaborHours },
      });
      await invalidate();
      toast({
        title: "Quoted hours updated",
        description: "The estimate was repriced. Send the revised quote when ready.",
      });
    } catch (error: unknown) {
      toast({
        title: "Could not update quoted hours",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  const applyCurrentLabourRate = async () => {
    try {
      await applyCurrentLabourRateMutation.mutateAsync({ id: card.id });
      await invalidate();
      toast({
        title: "Current labour rate applied",
        description:
          "The card was repriced in GYD and its estimate authorization was reset. Send the revised quote when ready.",
      });
    } catch (error: unknown) {
      toast({
        title: "Could not apply current labour rate",
        description: apiErrorMessage(error, "Try again."),
        variant: "destructive",
      });
    }
  };

  const sendQuote = async () => {
    setEstimateActionError(null);
    try {
      const outcome = await resendEstimate.mutateAsync({ id: card.id });
      await invalidate();
      toast({
        title: "Quote queued",
        description: outcome.message,
      });
    } catch (error: unknown) {
      const message = apiErrorMessage(error, "Could not queue the current quote.");
      setEstimateActionError({ action: "send", message });
      toast({ title: "Quote not queued", description: message, variant: "destructive" });
    }
  };

  const acknowledgeCustomerAuthorization = async () => {
    setEstimateActionError(null);
    try {
      await acknowledgeEstimate.mutateAsync({ id: card.id });
      await invalidate();
      toast({
        title: "Authorization receipt recorded",
        description: "Chargeable work can proceed once the remaining job requirements are met.",
      });
    } catch (error: unknown) {
      const message = apiErrorMessage(error, "Could not record authorization receipt.");
      setEstimateActionError({ action: "acknowledge", message });
      toast({ title: "Authorization receipt not recorded", description: message, variant: "destructive" });
    }
  };

  const NEXT: Record<string, JobCard["status"] | undefined> = {
    open: "in_progress",
    in_progress: "completed",
    completed: "closed",
  };
  const next = NEXT[card.status];

  return (
    <Card className="glass-panel border-none rounded-2xl overflow-hidden">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-base leading-tight truncate">{card.title}</h3>
              <Badge
                variant="secondary"
                className={cn(
                  "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border-none shrink-0",
                  card.status === "completed"
                    ? "bg-primary/15 text-primary"
                    : "bg-white/[0.05] text-foreground",
                )}
              >
                {JOB_STATUS_LABEL[card.status]}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span className="font-semibold tracking-wider text-primary uppercase">
                JC #{card.id} · RO #{card.serviceOrderId}
              </span>
              <span>·</span>
              <PenTool className="w-3 h-3" />
              {card.technicianName ?? "Unassigned"}
               <span>
                 · Booked {bookedHoursForCard(card)}h · Quoted {card.quotedLaborHours ?? card.laborHours}h @ {money.gyd(card.laborRate)}/hr
               </span>
            </div>
            {customerPhoneSnapshot && (
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                <Phone className="w-3 h-3" />
                <span>Job contact: {customerPhoneSnapshot}</span>
              </div>
            )}
            {serviceOrder?.customerName && (
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                <User className="w-3 h-3" />
                {serviceOrder.customerId ? (
                  <Link href={`/customers/${serviceOrder.customerId}`} className="hover:text-primary hover:underline">
                    Customer: {serviceOrder.customerName}
                  </Link>
                ) : (
                  <span>Customer: {serviceOrder.customerName}</span>
                )}
              </div>
            )}
            {(card.startedAt || card.completedAt) && (
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                <Clock className="w-3 h-3" />
                {card.startedAt && (
                  <span>Started {formatDealerDayTime(card.startedAt)}</span>
                )}
                {card.completedAt && (
                  <span>· Finished {formatDealerDayTime(card.completedAt)}</span>
                )}
                {card.startedAt && card.completedAt && (
                  <span className="text-foreground font-medium">
                    · {formatWorkDuration(new Date(card.startedAt), new Date(card.completedAt))} on vehicle
                  </span>
                )}
                <TimerReadout card={card} />
              </div>
            )}
          </div>
        </div>

        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl bg-white/[0.04] p-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="parts">Parts</TabsTrigger>
            <TabsTrigger value="commercial">Commercial</TabsTrigger>
            <TabsTrigger value="work-log">Work Log</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-3">
            {serviceOrder && (
              <div className="grid gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:grid-cols-2 lg:grid-cols-4">
                <DetailDatum label="Customer" value={serviceOrder.customerName ?? "Not recorded"} />
                <DetailDatum label="Model" value={serviceOrder.vehicleInfo || "Not recorded"} />
                <DetailDatum label="Registration" value={serviceOrder.registrationNumber || "Not recorded"} />
                <DetailDatum label="VIN" value={serviceOrder.vin || "Not recorded"} />
                <DetailDatum label="Scheduled" value={formatDealerDateShort(serviceOrder.scheduledDate)} />
                <DetailDatum label="Service type" value={serviceOrder.type.replaceAll("_", " ")} />
                <DetailDatum label="Technician" value={card.technicianName ?? "Unassigned"} />
                <DetailDatum label="Payment" value={serviceOrder.payType?.replaceAll("_", " ") ?? "Not recorded"} />
              </div>
            )}
            <WaitingSection card={card} onChanged={invalidate} />

            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Service checklist
              </div>
              {card.checklist.length > 0 ? (
                <div className="space-y-2">
                  {card.checklist.map((item, idx) => (
                    <button
                      key={idx}
                      onClick={() => toggleChecklist(idx)}
                      className="flex items-center gap-2.5 text-sm w-full text-left group"
                    >
                      {item.done ? (
                        <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                      ) : (
                        <Circle className="w-4 h-4 text-muted-foreground shrink-0 group-hover:text-primary transition-colors" />
                      )}
                      <span className={cn(item.done && "line-through text-muted-foreground")}>
                        {item.label}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No checklist items have been added.</p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="parts" className="space-y-3">
        <div className="rounded-xl bg-white/[0.03] border border-white/10 p-3 space-y-1.5">
          <div className="flex items-center justify-between text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
            <span className="flex items-center gap-1.5">
              <Package className="w-3 h-3" /> Parts
            </span>
            <span>
              Net parts {money.gyd(partsTotal)} · Labour {money.gyd(laborTotal)}
            </span>
          </div>
          <div className="py-2 border-b border-white/5 mb-2">
            <div className="flex justify-between items-center mb-3">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Requisitions</span>
              <PartRequisitionForm cardId={card.id} serviceOrderId={card.serviceOrderId} onSuccess={invalidate} />
            </div>
            {(!requisitions || requisitions.length === 0) ? (
              <p className="text-xs text-muted-foreground italic mb-2">No requisitions.</p>
            ) : (
              <div className="space-y-2 mb-2">
                {requisitions.map(req => (
                  <div key={req.id} className="bg-white/[0.02] border border-white/10 rounded-lg p-2.5 flex flex-col gap-2">
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="text-xs font-bold flex items-center gap-1.5">
                          REQ-{req.id}
                          {req.urgency === "vehicle_down" && (
                            <span className="bg-red-500/20 text-red-400 text-[8px] uppercase font-bold tracking-widest px-1 py-0 rounded-sm">VOR</span>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">By {req.requesterName}</div>
                      </div>
                      <div className="bg-white/[0.05] rounded px-1.5 py-0.5 text-[9px] tracking-widest uppercase text-muted-foreground">
                        {req.status}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mt-4 mb-2">Issued Parts</div>
          </div>
          {lines?.length ? (
            <div className="space-y-0.5">
              {lines.map((l) => (
                <div key={l.id} className="flex items-center justify-between text-xs">
                  <span className={cn(l.kind === "return" && "text-muted-foreground line-through")}>
                    {l.partName} × {l.quantity}
                    {l.kind === "return" && " (returned)"}
                    {l.backordered && (
                      <span className="ml-2 rounded-full bg-primary/15 text-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest">
                        Backordered
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {money.gyd(l.unitPrice * l.quantity)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            !externalLines?.length && <p className="text-xs text-muted-foreground">No parts issued.</p>
          )}
          {externalLines?.length ? (
            <div className="space-y-0.5">
              {externalLines.map((line) => (
                <div key={line.id} className="flex items-center justify-between gap-3 text-xs">
                  <span>
                    {line.description} × {line.quantity}
                    <span className="ml-2 rounded-full bg-primary/15 text-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest">
                      External
                    </span>
                    {line.supplierSnapshot && (
                      <span className="ml-2 text-muted-foreground">via {line.supplierSnapshot}</span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {money.gyd(line.unitPrice * line.quantity)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex gap-2 pt-0.5">
            <CreateRecordDialog
              title="Issue / Return Part"
              description="Issuing decrements stock; returning restocks it."
              pending={addPart.isPending}
              submitLabel="Post part line"
              trigger={
                <Button size="sm" variant="outline" className="rounded-full border-white/15 gap-1.5 text-xs">
                  <Plus className="w-3.5 h-3.5" /> Part
                </Button>
              }
              fields={[
                {
                  name: "partId",
                  label: "Part",
                  type: "select",
                  searchable: true,
                  required: true,
                  span: "full",
                  placeholder: "Search parts by name or number...",
                  options:
                    parts?.map((p) => ({
                      value: String(p.id),
                      label: `${p.name} (${p.sku}) — ${p.stock} in stock`,
                    })) ?? [],
                },
                { name: "quantity", label: "Quantity", type: "number", required: true, span: "half", defaultValue: "1" },
                {
                  name: "kind",
                  label: "Action",
                  type: "select",
                  span: "half",
                  defaultValue: "issue",
                  options: [
                    { value: "issue", label: "Issue to job" },
                    { value: "return", label: "Return to stock" },
                  ],
                },
              ]}
              onSubmit={async (values) => {
                const v = values as Record<string, unknown>;
                try {
                  await addPart.mutateAsync({
                    id: card.id,
                    data: {
                      partId: Number(v.partId),
                      quantity: Number(v.quantity),
                      kind: (v.kind as "issue" | "return") ?? "issue",
                    },
                  });
                  invalidate();
                  toast({ title: "Part line posted", description: "Stock adjusted." });
                } catch (e: unknown) {
                  const msg =
                    (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                    "Could not post part line.";
                  toast({ title: "Failed", description: msg, variant: "destructive" });
                  throw e;
                }
              }}
            />
            {isApprover && creditableLines.length > 0 && (
              <CreateRecordDialog
                title="Credit Note — return unused parts"
                description="Restores stock and reduces this job's parts total. Internal adjustment only — no cash refund."
                pending={createCreditNote.isPending}
                submitLabel="Issue credit note"
                open={creditNoteDialogOpen}
                onOpenChange={(open) => {
                  setCreditNoteDialogOpen(open);
                  if (open) renewCreditNoteIdempotencyKey();
                }}
                trigger={
                  <Button size="sm" variant="outline" className="rounded-full border-white/15 gap-1.5 text-xs">
                    <Receipt className="w-3.5 h-3.5" /> Credit note
                  </Button>
                }
                fields={[
                  {
                    name: "jobCardPartId",
                    label: "Issued part line",
                    type: "select",
                    required: true,
                    span: "full",
                    options: creditableLines.map((l) => ({
                      value: String(l.id),
                      label: `${l.partName} · ${l.availableToCredit} of ${l.quantity} available @ ${money.gyd(l.unitPrice)}`,
                    })),
                    onChange: renewCreditNoteIdempotencyKey,
                  },
                  {
                    name: "quantity",
                    label: "Quantity to credit",
                    type: "number",
                    required: true,
                    span: "half",
                    defaultValue: "1",
                    onChange: renewCreditNoteIdempotencyKey,
                  },
                  {
                    name: "reason",
                    label: "Reason",
                    type: "text",
                    required: true,
                    span: "full",
                    placeholder: "e.g. Part unused — customer declined the repair",
                    onChange: renewCreditNoteIdempotencyKey,
                  },
                ]}
                onSubmit={async (values) => {
                  const v = values as Record<string, unknown>;
                  try {
                    await createCreditNote.mutateAsync({
                      id: card.id,
                      data: {
                        jobCardPartId: Number(v.jobCardPartId),
                        quantity: Number(v.quantity),
                        reason: String(v.reason ?? ""),
                      },
                    });
                    // Keep this key for a failed retry, then rotate it only
                    // after the server has accepted this exact submission.
                    renewCreditNoteIdempotencyKey();
                    invalidate();
                    toast({ title: "Credit note issued", description: "Stock restored and parts total reduced." });
                  } catch (e: unknown) {
                    const msg =
                      (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                      "Could not issue the credit note.";
                    toast({ title: "Failed", description: msg, variant: "destructive" });
                    throw e;
                  }
                }}
              />
            )}
          </div>
          {creditNotes && creditNotes.length > 0 && (
            <div className="pt-2 border-t border-white/5 space-y-1">
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
                Credit notes
              </div>
              {creditNotes.map((cn) => (
                <div key={cn.id} className="flex items-center justify-between text-sm gap-3">
                  <span className="min-w-0 truncate text-muted-foreground">
                    CN-{cn.id} · {cn.partName} × {cn.quantity} — {cn.reason}
                  </span>
                  <span className="text-primary shrink-0">−{money.gyd(cn.amount)}</span>
                </div>
              ))}
            </div>
          )}
          {linkedInvoice && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs">
              <div className="font-medium">Linked invoice financial position</div>
              <div className="mt-1 grid gap-1 text-muted-foreground sm:grid-cols-3">
                <span>Issued total: {money.gyd(linkedInvoice.originalTotal)}</span>
                <span>Adjusted document total: {money.gyd(linkedInvoice.total)}</span>
                <span>Outstanding balance: {money.gyd(linkedInvoice.balance)}</span>
              </div>
              {linkedInvoice.customerCreditBalance > 0 && (
                <p className="mt-1.5 text-foreground">
                  Customer account credit: {money.gyd(linkedInvoice.customerCreditBalance)}
                  {linkedInvoice.creditReconciliationStatus === "pending_collision_settlement"
                    ? " · pending collision settlement reconciliation."
                    : " · available only through the documented refund or future-application process."}
                </p>
              )}
            </div>
          )}
        </div>
          </TabsContent>

          <TabsContent value="commercial" className="space-y-3">
        {estimatePreview.isLoading ? (
          <div className="flex min-h-40 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03]">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : estimatePreview.isError || !preview ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm">
            <div className="flex items-center gap-2 font-medium text-rose-200">
              <AlertTriangle className="h-4 w-4" />
              Quote preview unavailable
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {apiErrorMessage(estimatePreview.error, "Reload the job card before sending or acknowledging a quote.")}
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Customer quote · version {preview.estimateVersion}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Recipient: <span className="text-foreground">{preview.customerRecipient ?? "No customer email on this service order"}</span>
                </p>
              </div>
              <Badge className={`${estimateDeliveryBadgeClass(preview.delivery.state)} border-none rounded-full text-[10px] font-bold uppercase tracking-widest`}>
                {estimateDeliveryLabel(preview.delivery.state)}
              </Badge>
            </div>

             <section className="rounded-lg border border-primary/20 bg-primary/[0.04] p-3">
               <div className="flex flex-wrap items-start justify-between gap-3">
                 <div>
                   <h4 className="text-sm font-medium">Billable labour hours</h4>
                   <p className="mt-1 text-xs text-muted-foreground">
                     Planned booking: {bookedHoursForCard(card)}h · Actual timer: {formatTimerHours(card)}
                   </p>
                   <p className="mt-1 text-[11px] text-muted-foreground">
                     Only quoted hours affect the customer estimate; changing them creates a new version and does not send it.
                   </p>
                    {canEditQuoteHours && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-3 rounded-full text-xs"
                        disabled={applyCurrentLabourRateMutation.isPending}
                        onClick={applyCurrentLabourRate}
                      >
                        {applyCurrentLabourRateMutation.isPending && (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        )}
                        Apply current labour rate
                      </Button>
                    )}
                 </div>
                 {canEditQuoteHours ? (
                   <div className="flex items-end gap-2">
                     <div>
                       <Label htmlFor={`quoted-labor-hours-${card.id}`} className="text-[10px] uppercase tracking-widest text-muted-foreground">
                         Quoted hours
                       </Label>
                       <Input
                         id={`quoted-labor-hours-${card.id}`}
                         type="number"
                         min="0"
                         step="0.25"
                         value={quotedLaborHoursDraft}
                         onChange={(event) => setQuotedLaborHoursDraft(event.target.value)}
                         className="mt-1 h-9 w-28"
                         disabled={update.isPending}
                       />
                     </div>
                     <Button
                       size="sm"
                       className="h-9 rounded-full text-xs"
                       disabled={update.isPending || Number(quotedLaborHoursDraft) === effectiveQuotedLaborHours}
                       onClick={saveQuotedLaborHours}
                     >
                       {update.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                       Save
                     </Button>
                   </div>
                 ) : (
                   <div className="text-right">
                     <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Quoted hours</div>
                     <div className="mt-1 text-lg font-semibold">{effectiveQuotedLaborHours}h</div>
                   </div>
                 )}
               </div>
             </section>

            <section className="rounded-lg border border-white/10 p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">1</span>
                <h4 className="text-sm font-medium">Review the current itemized quote</h4>
              </div>
              <div className="mt-3 divide-y divide-white/10 rounded-md border border-white/10">
                {preview.lines.map((line, index) => (
                  <div key={`${line.kind}-${line.description}-${index}`} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
                    <div>
                      <p>{line.description}</p>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {line.kind === "labour" ? "Servicing / labour" : line.kind}
                        {line.quantity != null ? ` · ${line.quantity}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 font-medium">{money.gyd(line.amount)}</span>
                  </div>
                ))}
                <div className="space-y-1 bg-white/[0.02] px-3 py-3 text-xs">
                  <QuoteSummaryRow label="Parts" amount={previewPartsTotal} money={money.gyd} />
                  <QuoteSummaryRow label="Servicing / labour" amount={previewLabourTotal} money={money.gyd} />
                  <QuoteSummaryRow label="Tax" amount={previewTaxTotal} money={money.gyd} />
                  <QuoteSummaryRow label="Surcharge" amount={previewSurchargeTotal} money={money.gyd} />
                  <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2 text-sm font-semibold">
                    <span>Total quote</span>
                    <span>{money.gyd(preview.total)}</span>
                  </div>
                  <p className="pt-1 text-[10px] text-muted-foreground">All quote amounts are shown to the cent.</p>
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-white/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">2</span>
                  <h4 className="text-sm font-medium">Send quote to customer</h4>
                </div>
                {canActOnCurrentEstimate && card.payType === "customer" && preview.total > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-full text-xs"
                    disabled={resendEstimate.isPending}
                    onClick={sendQuote}
                  >
                    {resendEstimate.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    {preview.decision.state === "approved" ? "Send revised quote" : "Send quote"}
                  </Button>
                )}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                <p>
                  Email delivery status: <span className="font-medium text-foreground">{estimateDeliveryLabel(preview.delivery.state)}</span>
                  {preview.delivery.recipient ? ` · ${preview.delivery.recipient}` : ""}
                </p>
                <p className="mt-1">
                  Customer decision: <span className="font-medium text-foreground">{estimateDecisionLabel(preview.decision.state)}</span>
                </p>
                {preview.delivery.sentAt && <p className="mt-1">Sent {formatDealerDayTime(preview.delivery.sentAt)}.</p>}
                {preview.delivery.deliveredAt && <p className="mt-1">Delivered {formatDealerDayTime(preview.delivery.deliveredAt)}.</p>}
                {preview.delivery.lastError && (
                  <p className="mt-1 text-rose-300">Delivery error: {preview.delivery.lastError}</p>
                )}
                {preview.delivery.attempts > 0 && (
                  <p className="mt-1">Delivery attempts: {preview.delivery.attempts}.</p>
                )}
                {card.payType === "customer" && preview.total <= 0 && (
                  <p className="mt-1 text-amber-300">A positive customer quote is required before it can be sent.</p>
                )}
                {card.payType !== "customer" && (
                  <p className="mt-1">Customer authorization is not required for this payment type.</p>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-white/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">3</span>
                  <h4 className="text-sm font-medium">Record authorization received</h4>
                </div>
                {canActOnCurrentEstimate && preview.total > 0 && customerApprovedCurrent && !staffAcknowledgedCurrent && (
                  <Button
                    size="sm"
                    className="rounded-full text-xs"
                    disabled={acknowledgeEstimate.isPending}
                    onClick={acknowledgeCustomerAuthorization}
                  >
                    {acknowledgeEstimate.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    Confirm authorization received
                  </Button>
                )}
              </div>
              {card.payType !== "customer" ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  This payment type does not require customer quote authorization.
                </p>
              ) : preview.total <= 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  A zero-cost job does not require customer quote authorization.
                </p>
              ) : staffAcknowledgedCurrent ? (
                <div className="mt-2 text-xs text-primary">
                  <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
                  Authorization receipt recorded by {card.estimateStaffAcknowledgedByName ?? "service staff"}
                  {card.estimateStaffAcknowledgedAt ? ` · ${formatDealerDayTime(card.estimateStaffAcknowledgedAt)}` : ""}.
                </div>
              ) : customerApprovedCurrent ? (
                <p className="mt-2 text-xs text-amber-300">
                  Customer authorization is recorded for this exact quote version. Chargeable work remains blocked until staff confirms receipt.
                </p>
              ) : preview.decision.state === "declined" ? (
                <p className="mt-2 text-xs text-amber-300">
                  The customer declined this quote. Chargeable work remains blocked until a revised quote is sent, authorized, and acknowledged by staff.
                </p>
              ) : preview.decision.state === "expired" || preview.decision.state === "stale" ? (
                <p className="mt-2 text-xs text-amber-300">
                  This quote is no longer current. Chargeable work remains blocked until the current quote is sent, authorized, and acknowledged by staff.
                </p>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Waiting for customer authorization of the current quote. Chargeable work remains blocked until the customer authorizes and staff confirms receipt.
                </p>
              )}
              {preview.decision.decidedAt && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Customer decision recorded {formatDealerDayTime(preview.decision.decidedAt)}.
                </p>
              )}
            </section>

            {estimateActionError && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-100">
                <p className="font-medium">Quote action needs attention</p>
                <p className="mt-1">{estimateActionError.message}</p>
                {estimateActionError.action === "send" ? (
                  <p className="mt-1 text-rose-200/80">
                    Update the customer email on the service order, or ask a dealership administrator to resolve email delivery configuration. Do not enter credentials here; use the delivery status above to confirm the result.
                  </p>
                ) : (
                  <p className="mt-1 text-rose-200/80">
                    Reload the current quote and confirm that the customer authorization is still for this exact version before trying again.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {card.surchargeStatus !== "none" && (
          <SurchargeSection card={card} onChanged={invalidate} />
        )}

        <RolloverSection card={card} onChanged={invalidate} technicianView={technicianView} />
          </TabsContent>

          <TabsContent value="work-log" className="space-y-3">
        <div className="rounded-xl bg-white/[0.03] border border-white/10 p-3 space-y-2">
          <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
            Technician work log
          </div>
          {notesLoading ? (
            <p className="text-xs text-muted-foreground">Loading notes…</p>
          ) : technicianNotes.length ? (
            <div className="space-y-2">
              {technicianNotes.map((note) => (
                <div key={note.id} className="text-xs border-l-2 border-primary/40 pl-2">
                  <p>{note.body}</p>
                  <p className="mt-0.5 text-muted-foreground">
                    {note.authorName} · {formatDealerDayTime(note.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No technician notes yet.</p>
          )}
          {canAddTechnicianNote && (
            <div className="pt-1 space-y-2">
              <Textarea
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder="Add an attributed work-log note…"
                rows={2}
                maxLength={4000}
                data-testid={`input-technician-note-${card.id}`}
              />
              <Button
                size="sm"
                variant="outline"
                className="rounded-full border-white/15 text-xs"
                disabled={noteSaving || !noteDraft.trim()}
                onClick={() => void addTechnicianNote()}
                data-testid={`button-add-technician-note-${card.id}`}
              >
                {noteSaving && <Loader2 className="mr-1.5 w-3.5 h-3.5 animate-spin" />}
                Add work-log note
              </Button>
            </div>
          )}
        </div>
          </TabsContent>

          <TabsContent value="documents">
        {/* Diagnostic reports & other paperwork attach at any point in the
            job's life — uploads go to private object storage. */}
        <DocumentsCard
          entityType="job_card"
          entityId={card.id}
          canEdit={can("service", "edit")}
        />
          </TabsContent>
        </Tabs>

        <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Completion write-up</DialogTitle>
              <DialogDescription>
                Record the service analysis and the work performed — both are
                required before the job card can be marked completed.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`jc-analysis-${card.id}`}>Analysis of the service</Label>
                <Textarea
                  id={`jc-analysis-${card.id}`}
                  value={analysisDraft}
                  onChange={(e) => setAnalysisDraft(e.target.value)}
                  placeholder="What was found — diagnosis, root cause, condition notes…"
                  rows={3}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`jc-performed-${card.id}`}>Work performed</Label>
                <Textarea
                  id={`jc-performed-${card.id}`}
                  value={performedDraft}
                  onChange={(e) => setPerformedDraft(e.target.value)}
                  placeholder="What was done — repairs, replacements, adjustments…"
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                className="rounded-full"
                onClick={() => setCompleteOpen(false)}
              >
                Cancel
              </Button>
              <Button
                className="rounded-full bg-primary hover:bg-primary/90 text-white"
                disabled={
                  update.isPending ||
                  !analysisDraft.trim() ||
                  !performedDraft.trim()
                }
                onClick={submitCompletion}
              >
                Complete job card
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {(card.serviceAnalysis || card.workPerformed) && (
          <div className="rounded-xl bg-white/5 p-3 space-y-1.5 text-xs">
            {card.serviceAnalysis && (
              <p>
                <span className="font-bold uppercase tracking-wider text-[10px] text-muted-foreground">Analysis: </span>
                {card.serviceAnalysis}
              </p>
            )}
            {card.workPerformed && (
              <p>
                <span className="font-bold uppercase tracking-wider text-[10px] text-muted-foreground">Work performed: </span>
                {card.workPerformed}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <ClaimJobCardAction card={card} />
          {next && (
            <Button
              size="sm"
              disabled={update.isPending}
              onClick={() => setStatus(next)}
              className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs gap-1.5"
            >
              <Wrench className="w-3.5 h-3.5" />
              Move to {JOB_STATUS_LABEL[next]}
            </Button>
          )}
          {card.status === "in_progress" && (
            <Button
              size="sm"
              variant="outline"
              disabled={timer.isPending}
              className="rounded-full border-white/15 text-xs gap-1.5"
              onClick={async () => {
                try {
                  await timer.mutateAsync({
                    id: card.id,
                    data: { action: card.timerStartedAt ? "pause" : "resume" },
                  });
                  await invalidate();
                  toast({
                    title: card.timerStartedAt ? "Timer paused" : "Timer running",
                  });
                } catch (e: unknown) {
                  const msg =
                    (e as { response?: { data?: { error?: string } } })?.response
                      ?.data?.error ?? "Could not update the timer.";
                  toast({ title: "Timer", description: msg, variant: "destructive" });
                }
              }}
            >
              {card.timerStartedAt ? (
                <>
                  <Pause className="w-3.5 h-3.5" /> Pause timer
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" /> Resume timer
                </>
              )}
            </Button>
          )}
          {(card.status === "completed" || card.status === "closed") && (
            <Button
              size="sm"
              variant="outline"
              disabled={reopen.isPending}
              className="rounded-full border-white/15 text-xs gap-1.5"
              onClick={async () => {
                try {
                  await reopen.mutateAsync({ id: card.id, data: {} });
                  await invalidate();
                  toast({
                    title: "Job card reopened",
                    description: "The job is back in progress and the timer is running.",
                  });
                } catch (e: unknown) {
                  const msg =
                    (e as { response?: { data?: { error?: string } } })?.response
                      ?.data?.error ?? "Could not reopen the job card.";
                  toast({ title: "Reopen failed", description: msg, variant: "destructive" });
                }
              }}
            >
              <RotateCcw className="w-3.5 h-3.5" /> Reopen
            </Button>
          )}
          {!technicianView && card.status === "completed" && (
            <Button
              size="sm"
              variant="outline"
              disabled={invoice.isPending}
              className="rounded-full border-white/15 text-xs gap-1.5"
              onClick={async () => {
                try {
                  const inv = await invoice.mutateAsync({ id: card.id });
                  queryClient.invalidateQueries({ queryKey: getListServiceInvoicesQueryKey() });
                  toast({
                    title: `Invoice #${inv.id} issued`,
                    description: `Total ${money.gyd(inv.total)} (parts + labour + tax).`,
                  });
                } catch (e: unknown) {
                  const msg =
                    (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                    "Could not create invoice.";
                  toast({ title: "Invoice failed", description: msg, variant: "destructive" });
                }
              }}
            >
              <FileText className="w-3.5 h-3.5" /> Generate Invoice
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const WAITING_REASONS: { value: JobCardWaitingUpdateReason; label: string }[] = [
  { value: "ordered_parts", label: "Ordered parts" },
  { value: "technician_availability", label: "Technician availability" },
  { value: "diagnostics", label: "Diagnostics" },
  { value: "escalation_verdict", label: "Escalation verdict" },
  { value: "warranty_decision", label: "Warranty decision" },
  { value: "customer_decision", label: "Customer decision" },
  { value: "other", label: "Other" },
];

function waitingReasonLabel(reason: string | null | undefined) {
  return WAITING_REASONS.find((item) => item.value === reason)?.label ?? "Not recorded";
}

function WaitingSection({ card, onChanged }: { card: JobCard; onChanged: () => void }) {
  const { toast } = useToast();
  const waiting = useUpdateJobCardWaiting();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<JobCardWaitingUpdateReason>("ordered_parts");
  const [nextAction, setNextAction] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  // Every resume, including older holds without a named reason, goes through
  // the dedicated endpoint so pending rollover sign-off cannot be bypassed.
  const isWaiting = card.status === "on_hold";
  const active = card.status === "open" || card.status === "in_progress";

  const fail = (error: unknown) => {
    const message =
      (error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
      "Could not update the workshop wait.";
    toast({ title: "Workshop wait", description: message, variant: "destructive" });
  };

  const resume = async () => {
    try {
      await waiting.mutateAsync({ id: card.id, data: { action: "resume" } });
      onChanged();
      toast({
        title: "Work resumed",
        description: "The wait was recorded. Existing rollover controls still apply.",
      });
    } catch (error) {
      fail(error);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Workshop status</div>
          <div className="mt-1 text-sm font-medium">
            {isWaiting ? `Waiting: ${waitingReasonLabel(card.waitingReason)}` : "Work is not on a recorded wait"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Responsible: {card.technicianName ?? "Unassigned"}
            {card.nextAction ? ` · Next action: ${card.nextAction}` : ""}
            {card.followUpDate ? ` · Follow up ${formatGuyanaDate(card.followUpDate)}` : ""}
          </p>
        </div>
        {isWaiting ? (
          <Button size="sm" variant="outline" className="rounded-full" disabled={waiting.isPending} onClick={() => void resume()}>
            {waiting.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
            Resume work
          </Button>
        ) : active ? (
          <Button size="sm" variant="outline" className="rounded-full" onClick={() => {
            setReason("ordered_parts");
            setNextAction("");
            setFollowUpDate("");
            setOpen(true);
          }}>
            <Pause className="mr-1.5 h-3.5 w-3.5" /> Record a wait
          </Button>
        ) : null}
      </div>
      {card.waitingHistory && card.waitingHistory.length > 0 && (
        <div className="border-t border-white/10 pt-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Wait history</div>
          <div className="space-y-2">
            {[...card.waitingHistory].reverse().map((event, index) => (
              <div key={`${event.at}-${index}`} className="border-l-2 border-primary/30 pl-2 text-xs">
                <span className="font-medium">{event.action === "hold" ? "Wait recorded" : "Work resumed"}</span>
                {event.reason && <span> · {waitingReasonLabel(event.reason)}</span>}
                <span className="text-muted-foreground"> · {event.byName} · {formatDealerDayTime(event.at)}</span>
                {event.nextAction && <div className="mt-0.5 text-muted-foreground">Next action: {event.nextAction}{event.followUpDate ? ` · Follow up ${formatGuyanaDate(event.followUpDate)}` : ""}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record a workshop wait</DialogTitle>
            <DialogDescription>
              This keeps the job open and preserves diagnostics and intake evidence. It does not mark work complete.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Waiting reason</Label>
              <Select value={reason} onValueChange={(value) => {
                const selected = WAITING_REASONS.find((item) => item.value === value);
                if (selected) setReason(selected.value);
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{WAITING_REASONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`waiting-next-action-${card.id}`}>Next action</Label>
              <Textarea id={`waiting-next-action-${card.id}`} value={nextAction} onChange={(event) => setNextAction(event.target.value)} maxLength={2000} placeholder="What needs to happen before work can continue?" rows={3} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`waiting-follow-up-${card.id}`}>Expected follow-up date</Label>
              <Input id={`waiting-follow-up-${card.id}`} type="date" value={followUpDate} onChange={(event) => setFollowUpDate(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-full" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              className="rounded-full"
              disabled={waiting.isPending || !nextAction.trim()}
              onClick={async () => {
                try {
                  await waiting.mutateAsync({
                    id: card.id,
                    data: {
                      action: "hold",
                      reason,
                      nextAction: nextAction.trim(),
                      ...(followUpDate ? { followUpDate } : {}),
                    },
                  });
                  onChanged();
                  setOpen(false);
                  toast({ title: "Wait recorded", description: "The job remains open with its follow-up plan." });
                } catch (error) {
                  fail(error);
                }
              }}
            >
              {waiting.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Record wait
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium capitalize" title={value}>{value}</div>
    </div>
  );
}

/* Late-service surcharge (FR-SR-07): suggested at intake; apply or waive. */
function SurchargeSection({ card, onChanged }: { card: JobCard; onChanged: () => void }) {
  const { toast } = useToast();
  const money = useMoney();
  const decide = useDecideJobCardSurcharge();

  const act = async (action: "apply" | "waive") => {
    try {
      await decide.mutateAsync({ id: card.id, data: { action } });
      onChanged();
      toast({
        title: action === "apply" ? "Surcharge applied" : "Surcharge waived",
        description:
          action === "apply"
            ? "It will be included in the invoice total."
            : "Recorded as waived — it will not be billed.",
      });
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Could not record the decision.";
      toast({ title: "Failed", description: msg, variant: "destructive" });
    }
  };

  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/10 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-1.5 mb-0.5">
            <AlertTriangle className="w-3.5 h-3.5 text-primary" /> Late-service surcharge
          </div>
          <div className="text-sm text-muted-foreground">
            {card.surchargeOverKm != null && card.surchargeOverKm > 0 && (
              <>Arrived {card.surchargeOverKm.toLocaleString()} km past the service interval · </>
            )}
            {money.gyd(card.surchargeAmount ?? 0)}
            {card.surchargeDecidedBy && card.surchargeDecidedAt && (
              <>
                {" "}· {card.surchargeStatus === "applied" ? "Applied" : "Waived"} by{" "}
                {card.surchargeDecidedBy} on {formatDealerDateShort(card.surchargeDecidedAt)}
              </>
            )}
          </div>
        </div>
        {card.surchargeStatus === "suggested" ? (
          <div className="flex gap-2 shrink-0">
            <Button
              size="sm"
              disabled={decide.isPending}
              onClick={() => act("apply")}
              className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs"
            >
              Apply
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending}
              onClick={() => act("waive")}
              className="rounded-full border-white/15 text-xs"
            >
              Waive
            </Button>
          </div>
        ) : (
          <Badge
            className={cn(
              "border-none rounded-full text-[10px] font-bold uppercase tracking-widest shrink-0",
              card.surchargeStatus === "applied"
                ? "bg-primary/15 text-primary"
                : "bg-white/[0.06] text-muted-foreground",
            )}
          >
            {card.surchargeStatus}
          </Badge>
        )}
      </div>
    </div>
  );
}

/* Multi-day rollover (FR-SR-06): dual Service Manager + Technician sign-off. */
function RolloverSection({
  card,
  onChanged,
  technicianView,
}: {
  card: JobCard;
  onChanged: () => void;
  technicianView: boolean;
}) {
  const { toast } = useToast();
  const { me } = useAuthz();
  const isApprover = useIsServiceApprover();
  const rollover = useRolloverJobCard();
  const approve = useApproveJobCardRollover();
  const [open, setOpen] = useState(false);
  const [toDate, setToDate] = useState("");
  const [reason, setReason] = useState("");

  const isAssignedTech = me != null && card.technicianUserId === me.id;
  const active = ["open", "in_progress", "on_hold"].includes(card.status);

  const fail = (e: unknown) => {
    const msg =
      (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
      "Request failed.";
    toast({ title: "Rollover", description: msg, variant: "destructive" });
  };

  const signOff = async (as: "manager" | "technician") => {
    try {
      const updated = await approve.mutateAsync({ id: card.id, data: { as } });
      onChanged();
      toast({
        title: updated.rolloverStatus === "approved" ? "Rollover approved" : "Sign-off recorded",
        description:
          updated.rolloverStatus === "approved"
            ? `Job carries over to ${updated.rolloverToDate ? formatDealerDateShort(updated.rolloverToDate) : "the new date"}.`
            : "Waiting on the second signature.",
      });
    } catch (e) {
      fail(e);
    }
  };

  if (card.rolloverStatus === "none" && !active) return null;

  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/10 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-1.5">
          <CalendarClock className="w-3.5 h-3.5" /> Multi-day rollover
        </div>
        {card.rolloverStatus === "pending" && (
          <Badge className="bg-primary/15 text-primary border-none rounded-full text-[10px] font-bold uppercase tracking-widest">
            Awaiting sign-off
          </Badge>
        )}
        {card.rolloverStatus === "approved" && (
          <Badge className="bg-primary/15 text-primary border-none rounded-full text-[10px] font-bold uppercase tracking-widest gap-1">
            <CheckCircle2 className="w-3 h-3" /> Approved
          </Badge>
        )}
      </div>

      {card.rolloverStatus !== "none" && (
        <div className="text-sm text-muted-foreground space-y-1">
          <div>
            Carry over to{" "}
            <span className="text-foreground font-medium">
              {card.rolloverToDate
                ? formatGuyanaDate(card.rolloverToDate)
                : "—"}
            </span>
            {card.rolloverReason && <> — “{card.rolloverReason}”</>}
            {card.rolloverRequestedBy && card.rolloverRequestedAt && (
              <>
                {" "}· requested by {card.rolloverRequestedBy} on{" "}
                {formatDealerDateShort(card.rolloverRequestedAt)}
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span className={cn(card.rolloverManagerApprovedAt ? "text-foreground" : "")}>
              {card.rolloverManagerApprovedAt ? (
                <>
                  ✓ Manager: {card.rolloverManagerApprovedBy} ·{" "}
                  {formatDealerDayTime(card.rolloverManagerApprovedAt)}
                </>
              ) : (
                "○ Service Manager sign-off pending"
              )}
            </span>
            <span className={cn(card.rolloverTechApprovedAt ? "text-foreground" : "")}>
              {card.rolloverTechApprovedAt ? (
                <>
                  ✓ Technician: {card.rolloverTechApprovedBy} ·{" "}
                  {formatDealerDayTime(card.rolloverTechApprovedAt)}
                </>
              ) : (
                "○ Assigned technician sign-off pending"
              )}
            </span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {card.rolloverStatus === "pending" && isApprover && !card.rolloverManagerApprovedAt && (
          <Button
            size="sm"
            disabled={approve.isPending}
            onClick={() => signOff("manager")}
            className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs"
          >
            Sign off as Manager
          </Button>
        )}
        {card.rolloverStatus === "pending" && isAssignedTech && !card.rolloverTechApprovedAt && (
          <Button
            size="sm"
            disabled={approve.isPending}
            onClick={() => signOff("technician")}
            className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs"
          >
            Sign off as Technician
          </Button>
        )}
        {active && !technicianView && card.rolloverStatus !== "pending" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOpen(true)}
            className="rounded-full border-white/15 text-xs gap-1.5"
          >
            <CalendarClock className="w-3.5 h-3.5" /> Request rollover
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Carry job to another day</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Requires sign-off from both the Service Manager and the assigned technician
              before the job card moves to the new date.
            </p>
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            <Textarea
              placeholder="Why is the job carrying over? (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={!toDate || rollover.isPending}
              onClick={async () => {
                try {
                  await rollover.mutateAsync({
                    id: card.id,
                    data: { toDate, ...(reason.trim() ? { reason: reason.trim() } : {}) },
                  });
                  onChanged();
                  setOpen(false);
                  setToDate("");
                  setReason("");
                  toast({
                    title: "Rollover requested",
                    description: "Both sign-offs are needed before the job carries over.",
                  });
                } catch (e) {
                  fail(e);
                }
              }}
            >
              {rollover.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
              Request rollover
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Invoices                                                            */
/* ------------------------------------------------------------------ */

function ClaimJobCardAction({ card }: { card: JobCard }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const claim = useClaimServiceOrder();
  const { data: technicians } = useListServiceTechnicians();
  const { me } = useAuthz();

  const isApprover = useIsServiceApprover();
  const isTechnician = (me?.roleName ?? "").toLowerCase().includes("tech");

  if (card.technicianUserId) return null; // Already assigned
  if (!isApprover && !isTechnician) return null; // Can't claim

  if (isApprover) {
    return (
      <AssignJobCardDialog card={card} technicians={technicians ?? []} claim={claim} />
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="rounded-full border-primary/30 text-primary hover:bg-primary/10 gap-1.5 text-xs h-8"
      disabled={claim.isPending}
      onClick={async () => {
        try {
          await claim.mutateAsync({ id: card.serviceOrderId, data: {} });
          queryClient.invalidateQueries({ queryKey: getListServiceOrdersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
          toast({
            title: "Claimed",
            description: "You have claimed this job.",
          });
        } catch (e: unknown) {
          const msg = (e as any)?.response?.data?.error ?? "Could not claim job.";
          toast({ title: "Claim failed", description: msg, variant: "destructive" });
        }
      }}
    >
      <User className="w-3.5 h-3.5" /> Claim Job
    </Button>
  );
}

function AssignJobCardDialog({ card, technicians, claim }: { card: JobCard, technicians: any[], claim: any }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [selectedTech, setSelectedTech] = useState<string>("me");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="rounded-full border-primary/30 text-primary hover:bg-primary/10 gap-1.5 text-xs h-8"
        >
          <User className="w-3.5 h-3.5" /> Assign Tech
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Assign Technician</DialogTitle>
          <DialogDescription>
            Choose a technician for this job.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4 space-y-2">
          <Label>Technician</Label>
          <Select value={selectedTech} onValueChange={setSelectedTech}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="me">Myself</SelectItem>
              {technicians?.map((t: any) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button
            className="w-full rounded-full"
            disabled={claim.isPending}
            onClick={async () => {
              try {
                const data = selectedTech === "me" ? {} : { technicianUserId: Number(selectedTech) };
                await claim.mutateAsync({ id: card.serviceOrderId, data });
                queryClient.invalidateQueries({ queryKey: getListServiceOrdersQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
                toast({ title: "Assigned", description: `Job assigned successfully.` });
                setOpen(false);
              } catch (e: unknown) {
                const msg = (e as any)?.response?.data?.error ?? "Could not assign job.";
                toast({ title: "Assignment failed", description: msg, variant: "destructive" });
              }
            }}
          >
            Confirm Assignment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function TimerReadout({ card }: { card: JobCard }) {
  const running = card.status === "in_progress" && !!card.timerStartedAt;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [running]);
  const seconds =
    (card.timerSeconds ?? 0) +
    (running && card.timerStartedAt
      ? Math.max(
          0,
          Math.round((Date.now() - new Date(card.timerStartedAt).getTime()) / 1000),
        )
      : 0);
  if (seconds <= 0 && !running) return null;
  return (
    <span className={cn("font-medium", running ? "text-primary" : "text-foreground")}>
      · {formatWorkedSeconds(seconds)} worked{running ? " (running)" : card.status === "in_progress" ? " (paused)" : ""}
    </span>
  );
}

function QuoteSummaryRow({
  label,
  amount,
  money,
}: {
  label: string;
  amount: number;
  money: (amount: number) => string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span>{money(amount)}</span>
    </div>
  );
}

function formatWorkedSeconds(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}m`;
}

function formatTimerHours(card: JobCard): string {
  return (workedSecondsAt(card, Date.now()) / 3600).toFixed(2);
}

function workedSecondsAt(card: JobCard, now: number): number {
  const running =
    card.status === "in_progress" && card.timerStartedAt
      ? Math.max(
          0,
          Math.round((now - new Date(card.timerStartedAt).getTime()) / 1000),
        )
      : 0;
  const timerSeconds = (card.timerSeconds ?? 0) + running;
  if (timerSeconds > 0 || card.timerStartedAt) return timerSeconds;
  // Cards completed before pause/resume timers were introduced still have
  // trustworthy start and finish timestamps. Use that wall-clock duration as
  // a compatibility fallback instead of reporting that no work occurred.
  if (card.startedAt && card.completedAt) {
    return Math.max(
      0,
      Math.round(
        (new Date(card.completedAt).getTime() -
          new Date(card.startedAt).getTime()) /
          1000,
      ),
    );
  }
  return 0;
}

function bookedHoursForCard(card: JobCard): number {
  if (card.laborHours > 0) return card.laborHours;
  return card.durationMins && card.durationMins > 0
    ? card.durationMins / 60
    : 0;
}
