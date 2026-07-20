import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDeliveries,
  useAdvanceDelivery,
  useUpdateDelivery,
  useUpdateDeliveryPdi,
  useListDeliveryAdvisors,
  useListBookings,
  useUpdateBooking,
  useSendBookingPaymentReminder,
  getListDeliveriesQueryKey,
  getListBookingsQueryKey,
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
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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

const STEP_ICONS: Record<string, React.ReactNode> = {
  sales_order: <FileText className="w-4 h-4" />,
  payment_clearance: <CheckCircle2 className="w-4 h-4" />,
  vehicle_allocation: <Truck className="w-4 h-4" />,
  pdi_checklist: <ClipboardCheck className="w-4 h-4" />,
  registration: <FileText className="w-4 h-4" />,
  insurance: <FileText className="w-4 h-4" />,
  accessories_fitment: <ClipboardCheck className="w-4 h-4" />,
  invoice: <FileText className="w-4 h-4" />,
  delivery_appointment: <CalendarClock className="w-4 h-4" />,
  customer_signature: <PenLine className="w-4 h-4" />,
  feedback: <Star className="w-4 h-4" />,
};

const money = (n: number) => `$${n.toLocaleString()}`;

const fmtDate = (s?: string | null) =>
  s
    ? new Date(s).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

export default function Deliveries() {
  const [tab, setTab] = useState<"deliveries" | "bookings">("deliveries");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data: deliveries, isLoading } = useListDeliveries();
  const { data: bookings } = useListBookings();

  const active = (deliveries ?? []).filter((d) => d.status !== "completed");
  const completed = (deliveries ?? []).filter((d) => d.status === "completed");
  const selected =
    (deliveries ?? []).find((d) => d.id === selectedId) ?? null;

  return (
    <div className="h-full overflow-y-auto">
      <PageHero
        video="delivery_transport.mp4"
        eyebrow="Handover Lane"
        title="Deliveries"
        subtitle="Bookings, pre-delivery workflow and customer handover — end to end."
      />
      <div className="w-full px-5 md:px-8 py-6 md:py-8 space-y-6">
        <div className="flex flex-wrap items-end justify-end gap-4">
          <div className="flex items-center gap-1 rounded-full border border-white/10 bg-foreground/[0.03] p-1">
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
                    ? "bg-primary text-white shadow-lg shadow-primary/30"
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
      className="w-full text-left rounded-2xl border border-white/10 bg-foreground/[0.02] hover:border-primary/40 hover:bg-foreground/[0.04] transition-all p-5 group"
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
  const advance = useAdvanceDelivery();
  const updateDelivery = useUpdateDelivery();
  const updatePdi = useUpdateDeliveryPdi();

  const [form, setForm] = useState<Record<string, string>>({});

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListDeliveriesQueryKey() });

  if (!delivery) return null;

  const current = delivery.steps.find(
    (s) => s.key === delivery.currentStep && delivery.status !== "completed",
  );

  const handleAdvance = () => {
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
        onError: (err: unknown) =>
          toast({
            title: "Cannot advance",
            description:
              (err as { response?: { data?: { error?: string } } })?.response
                ?.data?.error ?? "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  const togglePdi = (idx: number) => {
    const items = delivery.pdiItems.map((it, i) =>
      i === idx ? { ...it, checked: !it.checked } : it,
    );
    updatePdi.mutate(
      { id: delivery.id, data: { items } },
      { onSuccess: invalidate },
    );
  };

  const stepInputs = () => {
    switch (delivery.currentStep) {
      case "registration":
        return (
          <Input
            placeholder="Registration number (optional)"
            value={form.registrationNumber ?? ""}
            onChange={(e) =>
              setForm({ ...form, registrationNumber: e.target.value })
            }
          />
        );
      case "insurance":
        return (
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
        );
      case "delivery_appointment":
        return (
          <Input
            type="datetime-local"
            value={form.appointmentAt ?? ""}
            onChange={(e) => setForm({ ...form, appointmentAt: e.target.value })}
          />
        );
      case "customer_signature":
        return (
          <Input
            placeholder="Customer's full name (signature)"
            value={form.signatureName ?? ""}
            onChange={(e) =>
              setForm({ ...form, signatureName: e.target.value })
            }
          />
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
    delivery.pdiItems.some((i) => !i.checked);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl w-[95vw] max-h-[88vh] overflow-y-auto border-white/10 bg-[#0d0d0d] p-0">
        <div className="p-7">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
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
                <SelectTrigger className="bg-foreground/[0.04] border-white/10">
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
            {delivery.invoiceId && (
              <a
                href={`${import.meta.env.BASE_URL}api/deliveries/${delivery.id}/invoice.pdf`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-white/15 text-sm font-medium hover:bg-white/[0.05] transition-colors"
              >
                <FileText className="w-4 h-4" /> Invoice PDF
              </a>
            )}
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

          {/* PDI checklist */}
          {delivery.currentStep === "pdi_checklist" &&
            delivery.status !== "completed" && (
              <div className="mt-6 rounded-2xl border border-white/10 bg-foreground/[0.02] p-5">
                <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-3">
                  Pre-delivery inspection
                </h3>
                <div className="grid sm:grid-cols-2 gap-2">
                  {delivery.pdiItems.map((item, i) => (
                    <button
                      key={item.label}
                      onClick={() => togglePdi(i)}
                      className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-left hover:bg-foreground/[0.04] transition-colors"
                    >
                      {item.checked ? (
                        <CheckCircle2 className="w-4.5 h-4.5 w-5 h-5 text-emerald-400 shrink-0" />
                      ) : (
                        <Circle className="w-5 h-5 text-muted-foreground shrink-0" />
                      )}
                      <span
                        className={
                          item.checked ? "" : "text-muted-foreground"
                        }
                      >
                        {item.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

          {/* Advance panel */}
          {current && (
            <div className="mt-6 rounded-2xl border border-primary/25 bg-primary/[0.05] p-5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                {STEP_ICONS[current.key]}
                Current step — {current.label}
              </div>
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
                className="mt-4 inline-flex items-center gap-2 h-11 px-6 rounded-full bg-primary text-white text-sm font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-colors disabled:opacity-50"
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

function StepRow({
  step,
  isCurrent,
}: {
  step: DeliveryStepState;
  isCurrent: boolean;
}) {
  const done = step.status === "completed";
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
          done
            ? "text-muted-foreground line-through decoration-white/20"
            : isCurrent
              ? "font-semibold"
              : "text-muted-foreground"
        }`}
      >
        {step.label}
      </span>
      {done && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {step.completedBy ? `${step.completedBy} · ` : ""}
          {fmtDate(step.completedAt)}
        </span>
      )}
    </div>
  );
}

function BookingsTab({ bookings }: { bookings: Booking[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const updateBooking = useUpdateBooking();
  const remind = useSendBookingPaymentReminder();

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
            className="rounded-2xl border border-white/10 bg-foreground/[0.02] p-5 flex flex-wrap items-center gap-4"
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
                        : "bg-white/10 text-muted-foreground"
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
                        : "bg-white/10 text-muted-foreground"
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
                      className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-white/15 text-sm font-medium hover:bg-white/[0.05] transition-colors"
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
                      className="inline-flex items-center gap-2 h-10 px-4 rounded-full bg-primary text-white text-sm font-medium shadow-lg shadow-primary/30 hover:bg-primary/90 transition-colors"
                    >
                      <CheckCircle2 className="w-4 h-4" /> Mark paid
                    </button>
                  </>
                )}
                <button
                  onClick={() =>
                    updateBooking.mutate(
                      { id: b.id, data: { status: "cancelled" } },
                      {
                        onSuccess: () => {
                          invalidate();
                          toast({
                            title: "Booking cancelled",
                            description: "The vehicle has been released.",
                          });
                        },
                      },
                    )
                  }
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-white/15 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/[0.05] transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
