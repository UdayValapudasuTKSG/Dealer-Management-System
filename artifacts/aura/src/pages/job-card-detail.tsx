import { useEffect, useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetJobCard,
  getGetJobCardQueryKey,
  useUpdateJobCard,
  useToggleJobCardTimer,
  useReopenJobCard,
  useCreateJobCardInvoice,
  useAddJobCardPart,
  useCreateJobCardCreditNote,
  useListJobCardParts,
  useListJobCardExternalParts,
  useListJobCardPartRequisitions,
  useListParts,
  useListJobCardCreditNotes,
  useListJobCardTechnicianNotes,
  useCreateJobCardTechnicianNote,
  getListJobCardTechnicianNotesQueryKey,
  getListJobCardsQueryKey,
  getListJobCardPartsQueryKey,
  getListJobCardExternalPartsQueryKey,
  getListJobCardPartRequisitionsQueryKey,
  getListJobCardCreditNotesQueryKey,
  useDecideJobCardSurcharge,
  useApproveJobCardRollover,
  useRolloverJobCard,
  useListServiceTechnicians,
  useClaimServiceOrder,
  type JobCard,
  type ServiceOrder,
  type ServiceInvoice,
  type JobCardDetail
} from "@workspace/api-client-react";
import { useAuthz, } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useMoney, formatDealerDateShort, formatDealerDayTime, formatGuyanaDate } from "@/lib/format";
import { getListPartsQueryKey, getListServiceInvoicesQueryKey, getListServiceOrdersQueryKey } from "@workspace/api-client-react";
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

function formatWorkDuration(start: Date, end: Date): string {
  const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
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
          Back to My Jobs
        </Link>
      </Button>
      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Job Card #{detail.jobCard.id}</h1>
        <p className="text-muted-foreground">
          Service Order #{detail.serviceOrder.id}
          {detail.serviceOrder.vehicleInfo ? ` · ${detail.serviceOrder.vehicleInfo}` : ""}
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
  const timer = useToggleJobCardTimer();
  const reopen = useReopenJobCard();
  const { can, me } = useAuthz();
  const invoice = useCreateJobCardInvoice();
  const addPart = useAddJobCardPart();
  const createCreditNote = useCreateJobCardCreditNote();
  const money = useMoney();
  const { data: lines } = useListJobCardParts(card.id);
  const { data: externalLines } = useListJobCardExternalParts(card.id);
  const { data: requisitions } = useListJobCardPartRequisitions(card.id);
  const { data: parts } = useListParts();
  const { data: creditNotes } = useListJobCardCreditNotes(card.id);
  const [noteDraft, setNoteDraft] = useState("");
  const technicianNotesQuery = useListJobCardTechnicianNotes(card.id);
  const createTechnicianNote = useCreateJobCardTechnicianNote();
  const technicianNotes = technicianNotesQuery.data ?? [];
  const notesLoading = technicianNotesQuery.isLoading;
  const noteSaving = createTechnicianNote.isPending;
  const isApprover = useIsServiceApprover();
  const customerPhoneSnapshot = serviceOrder?.customerPhoneSnapshot;
  const canAddTechnicianNote =
    card.status === "in_progress" &&
    (isApprover || (card.technicianUserId != null && card.technicianUserId === me?.id));

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

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetJobCardQueryKey(card.id) });
    queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListJobCardPartsQueryKey(card.id) });
    queryClient.invalidateQueries({ queryKey: getListJobCardExternalPartsQueryKey(card.id) });
    queryClient.invalidateQueries({ queryKey: getListJobCardPartRequisitionsQueryKey(card.id) });
    queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListJobCardCreditNotesQueryKey(card.id) });
  };

  // Issued (non-backordered) lines are what a credit note can be raised against.
  const creditableLines =
    lines?.filter((l) => l.kind === "issue" && !l.backordered) ?? [];

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
  const laborTotal = card.laborHours * card.laborRate;

  const NEXT: Record<string, JobCard["status"] | undefined> = {
    open: "in_progress",
    in_progress: "completed",
    on_hold: "in_progress",
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
                · Booked {bookedHoursForCard(card)}h @ {money.gyd(card.laborRate)}/hr
              </span>
            </div>
            {customerPhoneSnapshot && (
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                <Phone className="w-3 h-3" />
                <span>Job contact: {customerPhoneSnapshot}</span>
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

        {card.checklist.length > 0 && (
          <div className="space-y-1.5">
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
        )}

        <div className="rounded-xl bg-white/[0.03] border border-white/10 p-3 space-y-1.5">
          <div className="flex items-center justify-between text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
            <span className="flex items-center gap-1.5">
              <Package className="w-3 h-3" /> Parts
            </span>
            <span>
              Parts {money.gyd(partsTotal)} · Labour {money.gyd(laborTotal)}
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
            {creditableLines.length > 0 && (
              <CreateRecordDialog
                title="Credit Note — return unused parts"
                description="Restores stock and reduces this job's parts total. Internal adjustment only — no cash refund."
                pending={createCreditNote.isPending}
                submitLabel="Issue credit note"
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
                      label: `${l.partName} × ${l.quantity} @ ${money.gyd(l.unitPrice)}`,
                    })),
                  },
                  { name: "quantity", label: "Quantity to credit", type: "number", required: true, span: "half", defaultValue: "1" },
                  { name: "reason", label: "Reason", type: "text", required: true, span: "full", placeholder: "e.g. Part unused — customer declined the repair" },
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
        </div>

        {(card.quoteTotal ?? 0) > 0 && (
          <div className="rounded-xl bg-white/[0.03] border border-white/10 p-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-0.5">
                Customer quote
              </div>
              <div className="font-medium text-base tracking-tight">
                {money.gyd(card.quoteTotal ?? 0)}
              </div>
            </div>
            {card.quoteApprovedAt ? (
              <Badge className="bg-primary/15 text-primary border-none rounded-full text-[10px] font-bold uppercase tracking-widest gap-1">
                <CheckCircle2 className="w-3 h-3" />
                Approved {formatDealerDateShort(card.quoteApprovedAt)}
              </Badge>
            ) : technicianView ? (
              <Badge className="bg-white/[0.06] text-muted-foreground border-none rounded-full text-[10px] font-bold uppercase tracking-widest">
                Awaiting approval
              </Badge>
            ) : (
              <Button
                size="sm"
                disabled={update.isPending}
                className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs gap-1.5"
                onClick={async () => {
                  await update.mutateAsync({ id: card.id, data: { approveQuote: true } });
                  invalidate();
                  toast({ title: "Quote approved", description: "Customer approval recorded." });
                }}
              >
                <CheckCircle2 className="w-3.5 h-3.5" /> Approve Quote
              </Button>
            )}
          </div>
        )}

        {card.surchargeStatus !== "none" && (
          <SurchargeSection card={card} onChanged={invalidate} />
        )}

        <RolloverSection card={card} onChanged={invalidate} technicianView={technicianView} />

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

        {/* Diagnostic reports & other paperwork attach at any point in the
            job's life — uploads go to private object storage. */}
        <DocumentsCard
          entityType="job_card"
          entityId={card.id}
          canEdit={can("service", "edit")}
        />

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
                  invalidate();
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
                  invalidate();
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
function formatWorkedSeconds(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}m`;
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
