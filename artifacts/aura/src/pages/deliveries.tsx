import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusParam } from "@/lib/use-focus-param";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDeliveries,
  useAdvanceDelivery,
  useUpdateDelivery,
  useUpdateDeliveryPdi,
  useListDeliveryAdvisors,
  useListLeadAdvisors,
  useUpdateDeal,
  useListBookings,
  useUpdateBooking,
  useSendBookingPaymentReminder,
  getListDeliveriesQueryKey,
  getListBookingsQueryKey,
  getListGatesQueryKey,
} from "@workspace/api-client-react";
import type {
  Delivery,
  Booking,
  DeliveryStepState,
  DeliveryAdvanceInput,
} from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Truck,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  FileText,
  CalendarClock,
  PenLine,
  Star,
  BellRing,
  KeyRound,
  Loader2,
  ChevronRight,
  X,
} from "lucide-react";
import { useMoney, formatGuyanaDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { PageHero } from "@/components/layout/page-hero";
import { DocumentsCard } from "@/components/documents-card";
import { useReviewDocumentExtraction } from "@workspace/api-client-react";
import { DutyFiling } from "@/components/gra/duty-filing";
import { ShieldCheck } from "lucide-react";

const STEP_ICONS: Record<string, React.ReactNode> = {
  sales_order: <FileText className="w-4 h-4" />,
  pdi_checklist: <ClipboardCheck className="w-4 h-4" />,
  registration: <FileText className="w-4 h-4" />,
  insurance: <FileText className="w-4 h-4" />,
  invoice: <FileText className="w-4 h-4" />,
  delivery: <Truck className="w-4 h-4" />,
  appointment: <CalendarClock className="w-4 h-4" />,
  warranty: <ShieldCheck className="w-4 h-4" />,
  signature: <PenLine className="w-4 h-4" />,
  feedback: <Star className="w-4 h-4" />,
};

const fmtDate = (s?: string | null) => (s ? formatGuyanaDate(s) : "—");

export default function Deliveries() {
  const [tab, setTab] = useState<"deliveries" | "bookings">("deliveries");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data: deliveries, isLoading } = useListDeliveries();
  const { data: bookings } = useListBookings();

  /* Triage deep link: /deliveries?delivery=<id> opens that delivery. */
  const focusDeliveryId = useFocusParam("delivery");
  useEffect(() => {
    if (
      focusDeliveryId != null &&
      (deliveries ?? []).some((d) => d.id === focusDeliveryId)
    ) {
      setTab("deliveries");
      setSelectedId(focusDeliveryId);
    }
  }, [focusDeliveryId, deliveries]);

  const active = (deliveries ?? []).filter((d) => d.status !== "completed");
  const completed = (deliveries ?? []).filter((d) => d.status === "completed");
  const selected =
    (deliveries ?? []).find((d) => d.id === selectedId) ?? null;

  return (
    <div className="h-full overflow-y-auto">
      <PageHero

        eyebrow="Handover Lane"
        title="Deliveries"
        subtitle="Bookings, pre-delivery workflow and customer handover — end to end."
      />
      <div className="w-full px-5 md:px-8 py-6 md:py-8 space-y-6">
        <div className="flex flex-wrap items-end justify-end gap-4">
          <div className="flex items-center gap-1 rounded-full border border-border bg-foreground/[0.03] p-1">
            {(
              [
                ["deliveries", `Deliveries (${active.length})`],
                ["bookings", `Bookings (${(bookings ?? []).filter((b) => b.status === "active").length})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`px-5 h-9 rounded-full text-sm font-medium transition-colors ${
                  tab === key
                    ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab === "deliveries" ? (
          <div className="space-y-8">
            {isLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <div
                    key={i}
                    className="h-24 rounded-2xl bg-foreground/[0.03] animate-pulse"
                  />
                ))}
              </div>
            ) : active.length === 0 && completed.length === 0 ? (
              <EmptyState
                icon={<Truck className="w-10 h-10" />}
                title="No deliveries yet"
                sub="Deliveries start automatically when a deal is committed or finance is approved."
              />
            ) : (
              <>
                <div className="space-y-3">
                  {active.map((d) => (
                    <DeliveryRow
                      key={d.id}
                      delivery={d}
                      onOpen={() => setSelectedId(d.id)}
                    />
                  ))}
                </div>
                {completed.length > 0 && (
                  <div>
                    <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-3">
                      Completed handovers
                    </h2>
                    <div className="space-y-3">
                      {completed.map((d) => (
                        <DeliveryRow
                          key={d.id}
                          delivery={d}
                          onOpen={() => setSelectedId(d.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <BookingsTab bookings={bookings ?? []} />
        )}
      </div>

      <DeliveryDetail
        delivery={selected}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}

function EmptyState({
  icon,
  title,
  sub,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div className="text-center py-24 text-muted-foreground">
      <div className="mx-auto mb-4 opacity-25 w-fit">{icon}</div>
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-sm mt-1 max-w-md mx-auto">{sub}</p>
    </div>
  );
}

function progressOf(d: Delivery) {
  const done = d.steps.filter((s) => s.status === "completed").length;
  return { done, total: d.steps.length };
}

function DeliveryRow({
  delivery,
  onOpen,
}: {
  delivery: Delivery;
  onOpen: () => void;
}) {
  const { done, total } = progressOf(delivery);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const current = delivery.steps.find((s) => s.key === delivery.currentStep);
  return (
    <button
      onClick={onOpen}
      className="w-full text-left rounded-2xl border border-border bg-foreground/[0.02] hover:border-primary/40 hover:bg-foreground/[0.04] transition-all p-5 group"
    >
      <div className="flex flex-wrap items-center gap-4">
        <div className="w-11 h-11 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
          {delivery.status === "completed" ? (
            <KeyRound className="w-5 h-5" />
          ) : (
            <Truck className="w-5 h-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold tracking-tight truncate">
              {delivery.customerName ?? `Deal #${delivery.dealId}`}
            </span>
            <Badge
              variant="secondary"
              className={`text-[10px] uppercase tracking-widest border-none ${
                delivery.status === "completed"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-primary/15 text-primary"
              }`}
            >
              {delivery.status.replace("_", " ")}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground truncate mt-0.5">
            {delivery.vehicleLabel ?? `Vehicle #${delivery.vehicleId}`}
            {delivery.advisorName ? ` · ${delivery.advisorName}` : ""}
          </p>
        </div>
        <div className="hidden md:block text-right shrink-0">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            {delivery.status === "completed" ? "Delivered" : "Next step"}
          </p>
          <p className="text-sm font-medium mt-0.5">
            {delivery.status === "completed"
              ? fmtDate(delivery.completedAt)
              : current?.label}
          </p>
        </div>
        <div className="w-full md:w-52 shrink-0">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
            <span>
              {done}/{total} steps
            </span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-foreground/[0.08] overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
      </div>
    </button>
  );
}

function DeliveryDetail({
  delivery,
  onClose,
}: {
  delivery: Delivery | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: advisors } = useListDeliveryAdvisors();
  const { data: salesAdvisors } = useListLeadAdvisors();
  const updateDeal = useUpdateDeal();
  const advance = useAdvanceDelivery();
  const updateDelivery = useUpdateDelivery();
  const updatePdi = useUpdateDeliveryPdi();

  const [form, setForm] = useState<Record<string, string>>({});
  const [showDuty, setShowDuty] = useState(false);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListDeliveriesQueryKey() });

  if (!delivery) return null;

  const current = delivery.steps.find(
    (s) => s.key === delivery.currentStep && delivery.status !== "completed",
  );

  const handleAdvance = () => {
    if (
      delivery.currentStep === "registration" &&
      form.registrationNumber &&
      !/^[A-Z]{3}[0-9]{1,4}$/.test(form.registrationNumber)
    ) {
      toast({
        title: "Invalid registration number",
        description:
          "Must be 3 uppercase letters followed by 1–4 digits (e.g. PAB1234)",
        variant: "destructive",
      });
      return;
    }
    const data: DeliveryAdvanceInput = {
      step: delivery.currentStep,
      ...(form.note ? { note: form.note } : {}),
      ...(form.registrationNumber
        ? { registrationNumber: form.registrationNumber }
        : {}),
      ...(form.insurancePolicy
        ? { insurancePolicy: form.insurancePolicy }
        : {}),
      ...(form.insuranceProvider
        ? { insuranceProvider: form.insuranceProvider }
        : {}),
      ...(form.appointmentAt
        ? { appointmentAt: new Date(form.appointmentAt).toISOString() }
        : {}),
      ...(form.signatureName ? { signatureName: form.signatureName } : {}),
      ...(form.signatureData ? { signatureData: form.signatureData } : {}),
      ...(form.deliveredAt
        ? { deliveredAt: new Date(form.deliveredAt).toISOString() }
        : {}),
      ...(form.feedbackRating
        ? { feedbackRating: Number(form.feedbackRating) }
        : {}),
      ...(form.feedbackComment
        ? { feedbackComment: form.feedbackComment }
        : {}),
    };
    advance.mutate(
      { id: delivery.id, data },
      {
        onSuccess: (d) => {
          invalidate();
          setForm({});
          toast({
            title:
              d.status === "completed"
                ? "Vehicle delivered"
                : "Step completed",
            description:
              d.status === "completed"
                ? "Handover complete — keys are with the customer."
                : `Next: ${d.steps.find((s) => s.key === d.currentStep)?.label}`,
          });
        },
        onError: (err: unknown) => {
          const data = (
            err as {
              response?: { data?: { error?: string; unmet?: string[] } };
            }
          )?.response?.data;
          toast({
            title: "Cannot advance",
            description:
              data?.unmet && data.unmet.length > 0
                ? data.unmet.join(" · ")
                : (data?.error ?? "Something went wrong."),
            variant: "destructive",
          });
          invalidate();
        },
      },
    );
  };

  const handleSkip = () => {
    if (!current) return;
    if (
      !window.confirm(
        `Skip "${current.label}"? Its requirements will not be enforced and the workflow moves to the next step.`,
      )
    )
      return;
    advance.mutate(
      {
        id: delivery.id,
        data: {
          step: current.key,
          skip: true,
          ...(form.note ? { note: form.note } : {}),
        },
      },
      {
        onSuccess: (d) => {
          invalidate();
          setForm({});
          toast({
            title:
              d.status === "completed" ? "Vehicle delivered" : "Step skipped",
            description:
              d.status === "completed"
                ? "Handover complete — keys are with the customer."
                : `Next: ${d.steps.find((s) => s.key === d.currentStep)?.label}`,
          });
        },
        onError: (err: unknown) => {
          const data = (
            err as {
              response?: { data?: { error?: string } };
            }
          )?.response?.data;
          toast({
            title: "Cannot skip",
            description: data?.error ?? "Something went wrong.",
            variant: "destructive",
          });
          invalidate();
        },
      },
    );
  };

  const setPdi = (idx: number, status: "pass" | "fail" | "waived" | "pending") => {
    let waiveReason: string | null = null;
    if (status === "waived") {
      waiveReason = window.prompt(
        "Waive reason (required to waive this check):",
        delivery.pdiItems[idx]?.waiveReason ?? "",
      );
      if (!waiveReason?.trim()) return;
    }
    const items = delivery.pdiItems.map((it, i) =>
      i === idx
        ? { ...it, status, waiveReason: status === "waived" ? waiveReason : null }
        : it,
    );
    updatePdi.mutate(
      { id: delivery.id, data: { items } },
      {
        onSuccess: invalidate,
        onError: (err: unknown) =>
          toast({
            title: "PDI update failed",
            description:
              (err as { response?: { data?: { error?: string } } })?.response
                ?.data?.error ?? "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  const stepInputs = () => {
    switch (delivery.currentStep) {
      case "registration":
        return (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="Plate number, e.g. PAB1234"
                value={form.registrationNumber ?? delivery.registrationNumber ?? ""}
                onChange={(e) =>
                  setForm({ ...form, registrationNumber: e.target.value.toUpperCase() })
                }
              />
              <Select
                value={delivery.registrationStatus}
                onValueChange={(v) =>
                  updateDelivery.mutate(
                    {
                      id: delivery.id,
                      data: {
                        registrationStatus: v as
                          | "pending"
                          | "submitted"
                          | "issued",
                      },
                    },
                    {
                      onSuccess: () => {
                        invalidate();
                        toast({ title: `Registration marked ${v}` });
                      },
                    },
                  )
                }
              >
                <SelectTrigger className="bg-foreground/[0.04] border-border">
                  <SelectValue placeholder="Registration status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="submitted">Submitted to GRA</SelectItem>
                  <SelectItem value="issued">Plate issued</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {delivery.registrationStuck && (
              <p className="text-xs text-amber-400 flex items-center gap-1.5">
                <BellRing className="w-3.5 h-3.5" />
                Registration has been sitting at “submitted” for more than 72
                hours — chase it up.
              </p>
            )}
          </div>
        );
      case "insurance":
        return (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="Policy number"
                value={form.insurancePolicy ?? ""}
                onChange={(e) =>
                  setForm({ ...form, insurancePolicy: e.target.value })
                }
              />
              <Input
                placeholder="Provider"
                value={form.insuranceProvider ?? ""}
                onChange={(e) =>
                  setForm({ ...form, insuranceProvider: e.target.value })
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {delivery.insuranceDocId
                ? "Cover note attached."
                : "Attach the insurance cover note under Documents below (type: Insurance)."}
            </p>
          </div>
        );
      case "appointment":
        return (
          <Input
            type="datetime-local"
            value={form.appointmentAt ?? ""}
            onChange={(e) => setForm({ ...form, appointmentAt: e.target.value })}
          />
        );
      case "warranty":
        return (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" asChild>
                <a
                  href={`${import.meta.env.BASE_URL}api/deliveries/${delivery.id}/warranty.pdf?doc=certificate`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <FileText className="w-4 h-4 mr-2" />
                  Warranty certificate (1 page)
                </a>
              </Button>
              <Button variant="outline" asChild>
                <a
                  href={`${import.meta.env.BASE_URL}api/deliveries/${delivery.id}/warranty.pdf?doc=booklet`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <FileText className="w-4 h-4 mr-2" />
                  Full warranty booklet
                </a>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Both documents are pre-filled with the customer, vehicle and
              dealer details. Capture the customer's signature below — it is
              placed in the certificate's "Customer signature" box.
            </p>
            <Input
              placeholder="Customer's full name (warranty signature)"
              value={form.signatureName ?? ""}
              onChange={(e) =>
                setForm({ ...form, signatureName: e.target.value })
              }
            />
            <SignaturePad
              value={form.signatureData ?? ""}
              onChange={(dataUrl) =>
                setForm({ ...form, signatureData: dataUrl })
              }
            />
            {delivery.warrantySignatureData ? (
              <p className="text-xs text-emerald-500">
                Warranty signature already captured — re-sign above to replace
                it, then re-download the documents.
              </p>
            ) : null}
          </div>
        );
      case "signature":
        return (
          <div className="space-y-2">
            <Input
              placeholder="Customer's full name (signature)"
              value={form.signatureName ?? ""}
              onChange={(e) =>
                setForm({ ...form, signatureName: e.target.value })
              }
            />
            <SignaturePad
              value={form.signatureData ?? ""}
              onChange={(dataUrl) =>
                setForm({ ...form, signatureData: dataUrl })
              }
            />
            <p className="text-xs text-muted-foreground">
              {delivery.handoverSheetDocId
                ? "Signed handover sheet uploaded."
                : "Alternatively, upload the scanned signed handover sheet under Documents below (type: Signed Handover) — A5 will verify it."}
            </p>
          </div>
        );
      case "delivery":
        return (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-xl border border-border bg-foreground/[0.03] px-3 py-2">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  Expected
                </p>
                <p className="mt-0.5">{fmtDate(delivery.appointmentAt)}</p>
              </div>
              <div className="rounded-xl border border-border bg-foreground/[0.03] px-3 py-2">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  Actual handover
                </p>
                <Input
                  type="datetime-local"
                  value={form.deliveredAt ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, deliveredAt: e.target.value })
                  }
                  className="mt-1 h-8 bg-background/60 border-border"
                />
              </div>
            </div>
          </div>
        );
      case "feedback":
        return (
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((r) => (
                <button
                  key={r}
                  onClick={() => setForm({ ...form, feedbackRating: String(r) })}
                  aria-label={`${r} star${r > 1 ? "s" : ""}`}
                >
                  <Star
                    className={`w-6 h-6 transition-colors ${
                      Number(form.feedbackRating ?? 0) >= r
                        ? "text-amber-400 fill-amber-400"
                        : "text-muted-foreground"
                    }`}
                  />
                </button>
              ))}
            </div>
            <Textarea
              placeholder="Customer comments (optional)"
              value={form.feedbackComment ?? ""}
              onChange={(e) =>
                setForm({ ...form, feedbackComment: e.target.value })
              }
            />
          </div>
        );
      default:
        return null;
    }
  };

  const pdiPending =
    delivery.currentStep === "pdi_checklist" &&
    delivery.pdiItems.some(
      (i) => i.status !== "pass" && i.status !== "waived",
    );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl w-[95vw] max-h-[88vh] overflow-y-auto border-border bg-card p-0">
        <div className="p-7">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-9 h-9 rounded-full bg-foreground/[0.06] hover:bg-foreground/[0.12] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="text-[11px] font-bold uppercase tracking-widest text-primary mb-1">
            Delivery workflow · Deal #{delivery.dealId}
          </div>
          <DialogTitle className="text-3xl font-semibold tracking-tight">
            {delivery.customerName ?? "Customer"}
          </DialogTitle>
          <p className="text-muted-foreground mt-1">
            {delivery.vehicleLabel ?? `Vehicle #${delivery.vehicleId}`}
          </p>

          <div className="flex flex-wrap items-center gap-3 mt-5">
            <div className="min-w-52">
              <Select
                value={
                  delivery.advisorUserId ? String(delivery.advisorUserId) : ""
                }
                onValueChange={(v) =>
                  updateDelivery.mutate(
                    { id: delivery.id, data: { advisorUserId: Number(v) } },
                    {
                      onSuccess: () => {
                        invalidate();
                        toast({ title: "Delivery advisor assigned" });
                      },
                    },
                  )
                }
              >
                <SelectTrigger className="bg-foreground/[0.04] border-border">
                  <SelectValue placeholder="Assign delivery advisor" />
                </SelectTrigger>
                <SelectContent>
                  {(advisors ?? []).map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                  {(advisors ?? []).length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      No Delivery Advisors yet
                    </div>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-52">
              <Select
                value={
                  delivery.salesAdvisorUserId
                    ? String(delivery.salesAdvisorUserId)
                    : ""
                }
                onValueChange={(v) => {
                  const advisor = (salesAdvisors ?? []).find(
                    (a) => a.id === Number(v),
                  );
                  updateDeal.mutate(
                    {
                      id: delivery.dealId,
                      data: {
                        salesAdvisorUserId: Number(v),
                        ...(advisor ? { salesAdvisor: advisor.name } : {}),
                      } as never,
                    },
                    {
                      onSuccess: () => {
                        invalidate();
                        toast({ title: "Sales advisor assigned" });
                      },
                      onError: (err: unknown) => {
                        const status = (err as { status?: number })?.status;
                        toast({
                          variant: "destructive",
                          title: "Couldn't assign sales advisor",
                          description:
                            status === 404
                              ? "The deal linked to this delivery no longer exists, so it can't be updated."
                              : "Something went wrong saving the assignment. Please try again.",
                        });
                      },
                    },
                  );
                }}
              >
                <SelectTrigger className="bg-foreground/[0.04] border-border">
                  <SelectValue placeholder="Assign sales advisor" />
                </SelectTrigger>
                <SelectContent>
                  {(salesAdvisors ?? []).map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                  {(salesAdvisors ?? []).length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      No Sales Advisors yet
                    </div>
                  )}
                </SelectContent>
              </Select>
            </div>
            {delivery.invoiceId && (
              <a
                href={`${import.meta.env.BASE_URL}api/deliveries/${delivery.id}/invoice.pdf`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-border text-sm font-medium hover:bg-foreground/[0.05] transition-colors"
              >
                <FileText className="w-4 h-4" /> Invoice PDF
              </a>
            )}
            <a
              href={`${import.meta.env.BASE_URL}api/deliveries/${delivery.id}/handover.pdf`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-border text-sm font-medium hover:bg-foreground/[0.05] transition-colors"
            >
              <FileText className="w-4 h-4" /> Handover Form
            </a>
          </div>

          {/* Steps */}
          <div className="mt-7 space-y-1.5">
            {delivery.steps.map((s) => (
              <StepRow
                key={s.key}
                step={s}
                isCurrent={
                  s.key === delivery.currentStep &&
                  delivery.status !== "completed"
                }
              />
            ))}
          </div>

          {/* Customs & duty (GRA) — embedded in the delivery process */}
          {delivery.status !== "completed" && (
            <div className="mt-6 rounded-2xl border border-border bg-foreground/[0.02] overflow-hidden">
              <button
                onClick={() => setShowDuty((v) => !v)}
                className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-foreground/[0.03] transition-colors"
              >
                <span className="flex items-center gap-2.5 text-sm font-bold uppercase tracking-widest text-muted-foreground">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  Customs duty pack (GRA)
                </span>
                <span className="text-xs text-muted-foreground">
                  {showDuty ? "Hide" : "Scan import document"}
                </span>
              </button>
              {showDuty && (
                <div className="px-5 pb-5">
                  <DutyFiling
                    compact
                    dealId={delivery.dealId}
                    prefillNotes={`Delivery #${delivery.id} · Deal #${delivery.dealId} · ${delivery.customerName ?? "Customer"}`}
                  />
                </div>
              )}
            </div>
          )}

          {/* PDI checklist */}
          {delivery.currentStep === "pdi_checklist" &&
            delivery.status !== "completed" && (
              <div className="mt-6 rounded-2xl border border-border bg-foreground/[0.02] p-5">
                <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-3">
                  Pre-delivery inspection
                </h3>
                <div className="space-y-2">
                  {delivery.pdiItems.map((item, i) => (
                    <div
                      key={item.label}
                      className="flex flex-wrap items-center gap-2.5 rounded-xl px-3 py-2 text-sm bg-foreground/[0.02]"
                    >
                      {item.status === "pass" ? (
                        <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                      ) : item.status === "fail" ? (
                        <X className="w-5 h-5 text-red-400 shrink-0" />
                      ) : item.status === "waived" ? (
                        <CheckCircle2 className="w-5 h-5 text-amber-400 shrink-0" />
                      ) : (
                        <Circle className="w-5 h-5 text-muted-foreground shrink-0" />
                      )}
                      <span
                        className={`flex-1 min-w-32 ${
                          item.status === "pending"
                            ? "text-muted-foreground"
                            : ""
                        }`}
                      >
                        {item.label}
                        {item.status === "waived" && item.waiveReason && (
                          <span className="block text-[11px] text-amber-400/80">
                            Waived — {item.waiveReason}
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-1">
                        {(
                          [
                            ["pass", "Pass"],
                            ["fail", "Fail"],
                            ["waived", "Waive"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            onClick={() =>
                              setPdi(
                                i,
                                item.status === value ? "pending" : value,
                              )
                            }
                            disabled={updatePdi.isPending}
                            className={`h-7 px-2.5 rounded-full text-xs font-medium border transition-colors ${
                              item.status === value
                                ? value === "pass"
                                  ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400"
                                  : value === "fail"
                                    ? "border-red-500/50 bg-red-500/15 text-red-400"
                                    : "border-amber-500/50 bg-amber-500/15 text-amber-400"
                                : "border-border text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05]"
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {delivery.pdiWorkOrderId != null &&
                  delivery.pdiItems.some((i) => i.status === "fail") && (
                    <p className="mt-3 text-xs text-red-400">
                      Failed checks opened rectification work order #
                      {delivery.pdiWorkOrderId} in Service. The delivery is
                      blocked until every item is marked Pass or Waived.
                    </p>
                  )}
              </div>
            )}

          {/* Handover sheet verification banner */}
          {delivery.handoverVerification &&
            delivery.handoverVerification.status !== "none" && (
              <HandoverVerificationBanner
                delivery={delivery}
                onDone={invalidate}
              />
            )}

          {/* Documents (insurance cover note, signed handover sheet, …) */}
          {delivery.status !== "completed" && (
            <div className="mt-6">
              <DocumentsCard
                entityType="delivery"
                entityId={delivery.id}
                canEdit
              />
            </div>
          )}

          {/* Advance panel */}
          {current && (
            <div className="mt-6 rounded-2xl border border-primary/25 bg-primary/[0.05] p-5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                {STEP_ICONS[current.key]}
                Current step — {current.label}
              </div>
              {(delivery.unmet ?? []).length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
                  <p className="text-xs font-bold uppercase tracking-widest text-amber-400 mb-1.5">
                    Before you can advance
                  </p>
                  <ul className="space-y-1">
                    {(delivery.unmet ?? []).map((u) => (
                      <li
                        key={u}
                        className="text-sm text-amber-200/90 flex items-start gap-2"
                      >
                        <Circle className="w-2 h-2 mt-1.5 shrink-0 fill-amber-400 text-amber-400" />
                        {u}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-3 space-y-2">
                {stepInputs()}
                <Input
                  placeholder="Note (optional)"
                  value={form.note ?? ""}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                />
              </div>
              <button
                onClick={handleAdvance}
                disabled={advance.isPending || pdiPending}
                className="mt-4 inline-flex items-center gap-2 h-11 px-6 rounded-full bg-primary text-primary-foreground text-sm font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {advance.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                {pdiPending
                  ? "Complete the PDI checklist first"
                  : `Mark "${current.label}" complete`}
              </button>
              <button
                onClick={handleSkip}
                disabled={advance.isPending}
                className="mt-4 ml-2 inline-flex items-center gap-2 h-11 px-5 rounded-full border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors disabled:opacity-50"
              >
                Skip this step
              </button>
            </div>
          )}

          {delivery.status === "completed" && (
            <div className="mt-6 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-5 flex items-center gap-3">
              <KeyRound className="w-5 h-5 text-emerald-400" />
              <div>
                <p className="font-semibold">Handover complete</p>
                <p className="text-sm text-muted-foreground">
                  Delivered {fmtDate(delivery.completedAt)}
                  {delivery.feedbackRating
                    ? ` · rated ${delivery.feedbackRating}/5`
                    : ""}
                </p>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SignaturePad({
  value,
  onChange,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = pos(e);
    ctx.strokeStyle = "#e8e2d9";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    hasInk.current = true;
  };

  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (hasInk.current && canvasRef.current) {
      onChange(canvasRef.current.toDataURL("image/png"));
    }
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
    onChange("");
  };

  return (
    <div className="rounded-xl border border-border bg-background/60 overflow-hidden">
      <canvas
        ref={canvasRef}
        width={620}
        height={140}
        className="w-full h-[140px] touch-none cursor-crosshair"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border">
        <span className="text-[11px] text-muted-foreground">
          {value ? "Signature captured" : "Customer signs here"}
        </span>
        <button
          onClick={clear}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function HandoverVerificationBanner({
  delivery,
  onDone,
}: {
  delivery: Delivery;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const review = useReviewDocumentExtraction();
  const v = delivery.handoverVerification;
  if (!v || v.status === "none") return null;

  const badge = (match: boolean) =>
    match ? (
      <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">
        Match
      </span>
    ) : (
      <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400">
        Mismatch
      </span>
    );

  const act = (action: "accept" | "dismiss") => {
    if (!delivery.handoverSheetDocId) return;
    review.mutate(
      {
        id: delivery.handoverSheetDocId,
        data:
          action === "accept"
            ? {
                action,
                fields: v.fields
                  .filter((f) => f.extracted)
                  .map((f) => ({ field: f.field, value: f.extracted ?? "" })),
              }
            : { action },
      },
      {
        onSuccess: () => {
          toast({
            title:
              action === "accept"
                ? "Handover sheet verified"
                : "Verification dismissed",
          });
          onDone();
        },
        onError: (err: unknown) =>
          toast({
            title: "Verification failed",
            description:
              (err as { response?: { data?: { error?: string } } })?.response
                ?.data?.error ?? "Try again.",
            variant: "destructive",
          }),
      },
    );
  };

  const tone =
    v.status === "accepted"
      ? "border-emerald-500/25 bg-emerald-500/[0.05]"
      : v.status === "failed"
        ? "border-red-500/25 bg-red-500/[0.05]"
        : v.allMatch
          ? "border-emerald-500/25 bg-emerald-500/[0.05]"
          : "border-amber-500/25 bg-amber-500/[0.05]";

  return (
    <div className={`mt-6 rounded-2xl border p-5 ${tone}`}>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="w-4 h-4" />
        Signed handover sheet — A5 verification
        <Badge
          variant="secondary"
          className="text-[10px] uppercase tracking-widest border-none bg-foreground/10 text-muted-foreground"
        >
          {v.status}
        </Badge>
      </div>
      {v.summary && (
        <p className="text-xs text-muted-foreground mt-1">{v.summary}</p>
      )}
      {v.fields.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {v.fields.map((f) => (
            <div key={f.field} className="flex items-center gap-2 text-sm">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground w-28 shrink-0">
                {f.label}
              </span>
              <span className="flex-1 truncate">
                {f.extracted ?? "—"}
                {!f.match && f.expected && (
                  <span className="text-muted-foreground">
                    {" "}
                    (expected {f.expected})
                  </span>
                )}
              </span>
              {badge(f.match)}
            </div>
          ))}
        </div>
      )}
      {v.status === "proposed" && delivery.handoverSheetDocId && (
        <div className="flex items-center gap-2 mt-3.5">
          <button
            onClick={() => act("accept")}
            disabled={review.isPending}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {review.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5" />
            )}
            Confirm sheet
          </button>
          <button
            onClick={() => act("dismiss")}
            disabled={review.isPending}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full border border-border text-sm font-medium hover:bg-foreground/[0.05] transition-colors disabled:opacity-50"
          >
            <X className="w-3.5 h-3.5" /> Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function StepRow({
  step,
  isCurrent,
}: {
  step: DeliveryStepState;
  isCurrent: boolean;
}) {
  const done = step.status === "completed";
  const skipped = step.status === "skipped";
  return (
    <div
      className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 ${
        isCurrent
          ? "bg-primary/[0.08] border border-primary/25"
          : "border border-transparent"
      }`}
    >
      {done ? (
        <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
      ) : skipped ? (
        <Circle className="w-5 h-5 text-amber-400/70 shrink-0" />
      ) : isCurrent ? (
        <motion.span
          animate={{ scale: [1, 1.15, 1] }}
          transition={{ repeat: Infinity, duration: 1.6 }}
          className="w-5 h-5 rounded-full border-2 border-primary shrink-0"
        />
      ) : (
        <Circle className="w-5 h-5 text-muted-foreground/40 shrink-0" />
      )}
      <span
        className={`text-sm flex-1 ${
          done || skipped
            ? "text-muted-foreground line-through decoration-foreground/20"
            : isCurrent
              ? "font-semibold"
              : "text-muted-foreground"
        }`}
      >
        {step.label}
        {skipped && (
          <span className="ml-2 no-underline inline-block text-[10px] font-semibold uppercase tracking-wider text-amber-500 bg-amber-500/10 rounded-full px-2 py-0.5">
            Skipped
          </span>
        )}
      </span>
      {(done || skipped) && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {step.completedBy ? `${step.completedBy} · ` : ""}
          {fmtDate(step.completedAt)}
        </span>
      )}
    </div>
  );
}

const BOOKING_CANCEL_REASONS: { value: string; label: string }[] = [
  { value: "customer_changed_mind", label: "Customer changed mind" },
  { value: "financing_declined", label: "Financing declined" },
  { value: "found_elsewhere", label: "Found vehicle elsewhere" },
  { value: "price", label: "Price" },
  { value: "delivery_delay", label: "Delivery delay" },
  { value: "vehicle_defect", label: "Vehicle defect" },
  { value: "duplicate", label: "Duplicate booking" },
  { value: "other", label: "Other" },
];

function BookingsTab({ bookings }: { bookings: Booking[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const rawMoney = useMoney();
  const money = (n: number) => rawMoney.gyd(n);
  const updateBooking = useUpdateBooking();
  const remind = useSendBookingPaymentReminder();
  const [cancelBooking, setCancelBooking] = useState<Booking | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const submitBookingCancellation = () => {
    if (!cancelBooking || !cancelReason) return;
    updateBooking.mutate(
      {
        id: cancelBooking.id,
        data: {
          status: "cancelled",
          cancellationReason: cancelReason as never,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          qc.invalidateQueries({ queryKey: getListGatesQueryKey() });
          toast({
            title: "Booking cancelled",
            description:
              cancelBooking.amountPaid > 0
                ? "A refund release request is now waiting for manager approval; the vehicle stays held until it is approved."
                : "The vehicle has been released.",
          });
          setCancelBooking(null);
          setCancelReason("");
        },
        onError: (err) => {
          const detail = (
            err as { response?: { data?: { error?: string; unmet?: string[] } } }
          )?.response?.data;
          toast({
            title: "Could not cancel the booking",
            description: detail?.unmet?.[0] ?? detail?.error ?? "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListBookingsQueryKey() });
    qc.invalidateQueries({ queryKey: getListDeliveriesQueryKey() });
  };

  const sorted = useMemo(
    () =>
      [...bookings].sort((a, b) =>
        a.status === b.status ? 0 : a.status === "active" ? -1 : 1,
      ),
    [bookings],
  );

  if (sorted.length === 0) {
    return (
      <EmptyState
        icon={<KeyRound className="w-10 h-10" />}
        title="No bookings yet"
        sub="Reserve a vehicle from the Inventory showroom to create a booking."
      />
    );
  }

  return (
    <div className="space-y-3">
      {sorted.map((b) => {
        const outstanding = b.bookingAmount - b.amountPaid;
        const lapsedSoon =
          b.status === "active" &&
          new Date(b.expiresAt).getTime() - Date.now() < 48 * 3600 * 1000;
        return (
          <div
            key={b.id}
            className="rounded-2xl border border-border bg-foreground/[0.02] p-5 flex flex-wrap items-center gap-4"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold tracking-tight">
                  {b.customerName}
                </span>
                <Badge
                  variant="secondary"
                  className={`text-[10px] uppercase tracking-widest border-none ${
                    b.status === "active"
                      ? "bg-primary/15 text-primary"
                      : b.status === "converted"
                        ? "bg-emerald-500/15 text-emerald-400"
                        : "bg-foreground/10 text-muted-foreground"
                  }`}
                >
                  {b.status}
                </Badge>
                <Badge
                  variant="secondary"
                  className={`text-[10px] uppercase tracking-widest border-none ${
                    b.paymentStatus === "paid"
                      ? "bg-emerald-500/15 text-emerald-400"
                      : b.paymentStatus === "partial"
                        ? "bg-amber-500/15 text-amber-400"
                        : "bg-foreground/10 text-muted-foreground"
                  }`}
                >
                  {b.paymentStatus}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Vehicle #{b.vehicleId} · {money(b.amountPaid)} paid of{" "}
                {money(b.bookingAmount)}
                {b.status === "active" && (
                  <span className={lapsedSoon ? "text-amber-400" : ""}>
                    {" "}
                    · expires {fmtDate(b.expiresAt)}
                  </span>
                )}
              </p>
            </div>
            {b.status === "active" && (
              <div className="flex items-center gap-2">
                {outstanding > 0 && (
                  <>
                    <button
                      onClick={() =>
                        remind.mutate(
                          { id: b.id },
                          {
                            onSuccess: () =>
                              toast({ title: "Payment reminder sent" }),
                            onError: (err: unknown) =>
                              toast({
                                title: "Could not send reminder",
                                description:
                                  (
                                    err as {
                                      response?: {
                                        data?: { error?: string };
                                      };
                                    }
                                  )?.response?.data?.error ?? "Failed.",
                                variant: "destructive",
                              }),
                          },
                        )
                      }
                      className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-border text-sm font-medium hover:bg-foreground/[0.05] transition-colors"
                    >
                      <BellRing className="w-4 h-4" /> Remind
                    </button>
                    <button
                      onClick={() =>
                        updateBooking.mutate(
                          {
                            id: b.id,
                            data: { amountPaid: b.bookingAmount },
                          },
                          {
                            onSuccess: () => {
                              invalidate();
                              toast({ title: "Booking marked fully paid" });
                            },
                          },
                        )
                      }
                      className="inline-flex items-center gap-2 h-10 px-4 rounded-full bg-primary text-primary-foreground text-sm font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-colors"
                    >
                      <CheckCircle2 className="w-4 h-4" /> Mark paid
                    </button>
                  </>
                )}
                <button
                  onClick={() => setCancelBooking(b)}
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        );
      })}
      <Dialog
        open={cancelBooking != null}
        onOpenChange={(o) => {
          if (!o) {
            setCancelBooking(null);
            setCancelReason("");
          }
        }}
      >
        <DialogContent className="glass-panel border-border sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-tight">
              Cancel booking #{cancelBooking?.id}
            </DialogTitle>
            <DialogDescription>
              {cancelBooking && cancelBooking.amountPaid > 0
                ? `${money(cancelBooking.amountPaid)} has been captured — cancelling raises a refund release request for manager approval, and the vehicle stays held until it is approved.`
                : "No funds captured — the vehicle returns to available stock immediately."}
            </DialogDescription>
          </DialogHeader>
          <div className="py-1">
            <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Reason
            </label>
            <select
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              className="mt-1.5 w-full bg-foreground/[0.04] border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-primary/60"
            >
              <option value="">Select a reason…</option>
              {BOOKING_CANCEL_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setCancelBooking(null)}
              className="rounded-full px-5"
            >
              Keep booking
            </Button>
            <Button
              onClick={submitBookingCancellation}
              disabled={!cancelReason || updateBooking.isPending}
              variant="destructive"
              className="rounded-full px-6 gap-2"
            >
              {updateBooking.isPending && (
                <Loader2 className="w-4 h-4 animate-spin" />
              )}
              Cancel booking
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
