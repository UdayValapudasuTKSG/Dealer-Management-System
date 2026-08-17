import { useState } from "react";
import { Link } from "wouter";
import { useFocusParam, useFocusHighlight } from "@/lib/use-focus-param";
import {
  useListServiceOrders,
  useCreateServiceOrder,
  useAdvanceServiceOrder,
  useDeleteServiceOrder,
  getListServiceOrdersQueryKey,
  useSendServiceReminder,
  useListJobCards,
  useCreateJobCard,
  useUpdateJobCard,
  getListJobCardsQueryKey,
  useListJobCardParts,
  useAddJobCardPart,
  getListJobCardPartsQueryKey,
  useCreateJobCardInvoice,
  useListServiceInvoices,
  useUpdateServiceInvoice,
  getListServiceInvoicesQueryKey,
  useListCoveragePlans,
  useCreateCoveragePlan,
  getListCoveragePlansQueryKey,
  useSendCoverageReminder,
  useListServiceTechnicians,
  useListParts,
  getListPartsQueryKey,
  useListJobCardCreditNotes,
  useCreateJobCardCreditNote,
  getListJobCardCreditNotesQueryKey,
  useCreateCase,
  getListCasesQueryKey,
  useRolloverJobCard,
  useApproveJobCardRollover,
  useDecideJobCardSurcharge,
  useRequestServiceInvoiceDiscount,
  useDecideServiceInvoiceDiscount,
  useAdjustServiceInvoice,
  useListReviews,
  useCreateReview,
  getListReviewsQueryKey,
  type JobCard,
  type ServiceOrder,
  type ServiceInvoice,
  type ServiceOrderAdvanceBodyTargetStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Wrench,
  Calendar,
  DollarSign,
  PenTool,
  Mail,
  ClipboardList,
  Receipt,
  ShieldCheck,
  Package,
  CheckCircle2,
  Circle,
  FileText,
  User,
  MessageSquareWarning,
  Loader2,
  CalendarClock,
  Clock,
  AlertTriangle,
  BadgePercent,
  Lock,
  Star,
  Printer,
  Archive,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { useViewMode } from "@/hooks/use-view-mode";
import { useAuthz } from "@/lib/auth";
import { ViewControls } from "@/components/view-controls";
import { cn } from "@/lib/utils";
import { useMoney } from "@/lib/format";

/** "3h 25m" between two timestamps (wall-clock time the card was open). */
function formatWorkDuration(start: Date, end: Date): string {
  const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const TABS = [
  { key: "bookings", label: "Bookings", icon: Calendar },
  { key: "jobcards", label: "Job Cards", icon: ClipboardList },
  { key: "myjobs", label: "My Jobs", icon: Wrench },
  { key: "invoices", label: "Invoices", icon: Receipt },
  { key: "coverage", label: "Warranty & AMC", icon: ShieldCheck },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/* Adjacent-only case state machine — mirrors SERVICE_ADVANCE_MAP server-side. */
const ORDER_NEXT: Partial<Record<ServiceOrder["status"], ServiceOrderAdvanceBodyTargetStatus>> = {
  open: "acknowledged",
  acknowledged: "in_progress",
  in_progress: "resolved",
  on_hold: "in_progress",
  resolved: "closed",
};

const ORDER_NEXT_LABEL: Record<string, string> = {
  acknowledged: "Acknowledge",
  in_progress: "Start work",
  resolved: "Mark resolved",
  closed: "Close case",
};

const PAY_TYPE_LABEL: Record<string, string> = {
  customer: "Customer pay",
  warranty: "Warranty",
  goodwill: "Goodwill",
  rectify: "Rectify",
};

const JOB_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  on_hold: "On Hold",
  completed: "Completed",
  closed: "Closed",
  cancelled: "Cancelled",
};

export default function Service() {
  // Technicians land on their own job queue; everyone else on Bookings.
  const { me } = useAuthz();
  const isTechnician = (me?.roleName ?? "").toLowerCase().includes("tech");
  // `me` loads async, so keep the tab unset until the user picks one and
  // derive the default from the (eventually loaded) role.
  const [pickedTab, setTab] = useState<TabKey | null>(null);
  /* Triage deep link: /service?order=<id> lands on the Bookings tab and
     highlights that repair order. */
  const focusOrderId = useFocusParam("order");
  const tab: TabKey =
    pickedTab ?? (focusOrderId != null ? "bookings" : isTechnician ? "myjobs" : "bookings");
  const { density, setDensity, layout, setLayout } = useViewMode("service");

  return (
    <>
    <PageHero
      className="pb-0"
      eyebrow="After-Sales"
      title="Service"
      accent="Operations"
      subtitle="Bookings, job cards, invoices and coverage — the full after-sales lane."
      action={<HeaderAction tab={tab} />}
    />
    <Page className="space-y-4">

      <div className="flex items-center gap-1 border-b border-white/10 overflow-x-auto no-scrollbar">
        {TABS.map((raw) => {
          // Technicians see only their own bookings (server-enforced), so the
          // tab reads as their personal day plan.
          const t =
            isTechnician && raw.key === "bookings" ? { ...raw, label: "My Day" } : raw;
          return (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors shrink-0",
              tab === t.key
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {tab === t.key && (
              <motion.span
                layoutId="service-tab-active"
                className="absolute inset-x-2 -bottom-px h-0.5 bg-primary rounded-full"
              />
            )}
          </button>
          );
        })}
        {tab === "bookings" && (
          <div className="ml-auto shrink-0 pl-2">
            <ViewControls
              layout={layout}
              onLayoutChange={setLayout}
              density={density}
              onDensityChange={setDensity}
            />
          </div>
        )}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {tab === "bookings" && <BookingsTab />}
          {tab === "jobcards" && <JobCardsTab />}
          {tab === "myjobs" && <MyJobsTab />}
          {tab === "invoices" && <InvoicesTab />}
          {tab === "coverage" && <CoverageTab />}
        </motion.div>
      </AnimatePresence>
    </Page>
    </>
  );
}

function HeaderAction({ tab }: { tab: TabKey }) {
  if (tab === "bookings") return <CreateBookingDialog />;
  if (tab === "jobcards") return <CreateJobCardDialog />;
  if (tab === "coverage") return <CreateCoverageDialog />;
  return null;
}

/* ------------------------------------------------------------------ */
/* My Jobs — the technician's own queue (merged from Workshop, 2026-07) */
/* ------------------------------------------------------------------ */

function MyJobsTab() {
  const { data: cards, isLoading } = useListJobCards({ mine: "1" });

  const open = cards?.filter((c) => c.status !== "completed") ?? [];
  const done = cards?.filter((c) => c.status === "completed") ?? [];
  const hours = cards?.reduce((s, c) => s + c.laborHours, 0) ?? 0;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MyJobsStatCard icon={ClipboardList} label="Active jobs" value={String(open.length)} />
        <MyJobsStatCard icon={CheckCircle2} label="Completed" value={String(done.length)} />
        <MyJobsStatCard icon={Calendar} label="Booked hours" value={`${hours.toFixed(1)}h`} />
      </div>

      {isLoading ? (
        <div className="grid gap-6">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-48 bg-white/[0.05] rounded-3xl animate-pulse" />
          ))}
        </div>
      ) : !cards?.length ? (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-24 flex flex-col items-center gap-3 text-center">
          <Wrench className="w-8 h-8 text-muted-foreground" />
          <p className="text-muted-foreground">
            No job cards assigned to you yet. When a service manager assigns you a job, it appears here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {[...open, ...done].map((card) => (
            <JobCardPanel key={card.id} card={card} technicianView />
          ))}
        </div>
      )}
    </div>
  );
}

function MyJobsStatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Calendar;
  label: string;
  value: string;
}) {
  return (
    <Card className="glass-panel border-none rounded-3xl">
      <CardContent className="p-5 flex items-center gap-4">
        <div className="w-11 h-11 rounded-2xl bg-primary/10 ring-1 ring-primary/25 flex items-center justify-center">
          <Icon className="w-5 h-5 text-primary" />
        </div>
        <div>
          <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            {label}
          </div>
          <div className="font-light text-2xl tracking-tight">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Bookings                                                            */
/* ------------------------------------------------------------------ */

function CreateBookingDialog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createOrder = useCreateServiceOrder();
  const { data: technicians } = useListServiceTechnicians();
  return (
    <CreateRecordDialog
      title="Book Service"
      description="Log the complaint, schedule the bay — AURA handles the rest."
      pending={createOrder.isPending}
      submitLabel="Create booking"
      trigger={
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-4 h-9 text-sm shadow-md shadow-primary/20 gap-1.5 font-medium tracking-wide">
          <Plus className="w-4 h-4" />
          Book Service
        </Button>
      }
      fields={[
        { name: "customerName", label: "Customer", type: "text", span: "half", placeholder: "Nana Adjei" },
        { name: "customerEmail", label: "Customer email (for confirmations & invoice)", type: "email", span: "half", placeholder: "customer@email.com" },
        { name: "vehicleInfo", label: "Vehicle", type: "text", required: true, span: "half", placeholder: "2022 BMW X5" },
        { name: "complaint", label: "Customer complaint", type: "textarea", span: "full", placeholder: "Grinding noise when braking..." },
        {
          name: "type",
          label: "Type",
          type: "select",
          required: true,
          span: "half",
          defaultValue: "maintenance",
          options: [
            { value: "maintenance", label: "Maintenance" },
            { value: "repair", label: "Repair" },
            { value: "warranty", label: "Warranty" },
            { value: "recall", label: "Recall" },
            { value: "inspection", label: "Inspection" },
            { value: "comeback", label: "Comeback" },
            { value: "unscheduled", label: "Unscheduled" },
          ],
        },
        { name: "scheduledDate", label: "Scheduled date", type: "date", required: true, span: "half" },
        { name: "odometer", label: "Odometer (km)", type: "number", span: "half", placeholder: "42000" },
        { name: "estimatedCost", label: "Est. cost", type: "number", span: "half", placeholder: "0" },
        { name: "estimatedHours", label: "Booked hours (blank = dealer default)", type: "number", span: "half", placeholder: "2" },
        {
          name: "technicianUserId",
          label: "Technician (default: unassigned)",
          type: "select",
          span: "half",
          options: [
            { value: "none", label: "Unassigned — pick later" },
            { value: "auto", label: "Auto — round-robin" },
            ...(technicians?.map((t) => ({ value: String(t.id), label: t.name })) ?? []),
          ],
          defaultValue: "none",
        },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        if (!v.customerEmail) delete v.customerEmail;
        if (v.odometer != null && v.odometer !== "") v.odometer = Number(v.odometer);
        if (v.estimatedHours != null && v.estimatedHours !== "") {
          v.estimatedHours = Number(v.estimatedHours);
        } else {
          delete v.estimatedHours;
        }
        if (v.technicianUserId && v.technicianUserId !== "auto" && v.technicianUserId !== "none") {
          const tech = technicians?.find((t) => String(t.id) === String(v.technicianUserId));
          v.technicianUserId = Number(v.technicianUserId);
          if (tech) v.technician = tech.name;
        } else {
          if (v.technicianUserId === "auto") v.autoAssign = true;
          delete v.technicianUserId;
        }
        const order = await createOrder.mutateAsync({ data: v as never });
        queryClient.invalidateQueries({ queryKey: getListServiceOrdersQueryKey() });
        if (order.technician) {
          toast({
            title: "Booking created",
            description: `Assigned to ${order.technician} for ${order.estimatedHours}h.`,
          });
        } else {
          toast({
            title: "Booking created — unassigned",
            description:
              "No technicians are set up for this dealership yet, so the booking has no assignee.",
            variant: "destructive",
          });
        }
      }}
    />
  );
}

/* Delete a booking (and its job cards) after confirmation. The server
   refuses once an invoice exists — surface that as a clear error. */
function DeleteOrderButton({ order }: { order: ServiceOrder }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const del = useDeleteServiceOrder();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="rounded-full border-white/15 h-8 w-8 p-0 text-muted-foreground hover:text-red-400 hover:border-red-400/40"
          aria-label={`Delete booking #${order.id}`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete RO #{order.id.toString().padStart(5, "0")}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {order.vehicleInfo} — this permanently removes the booking and any
            job cards opened for it. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 hover:bg-red-700 text-white"
            disabled={del.isPending}
            onClick={async () => {
              try {
                await del.mutateAsync({ id: order.id });
                queryClient.invalidateQueries({ queryKey: getListServiceOrdersQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
                toast({ title: "Booking deleted", description: `RO #${order.id} removed.` });
              } catch (e: unknown) {
                const msg =
                  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "";
                toast({
                  title: "Could not delete",
                  description: msg.startsWith("order_invoiced")
                    ? "This booking already has an issued invoice — void the invoice first."
                    : msg || "Delete failed.",
                  variant: "destructive",
                });
              }
            }}
          >
            Delete booking
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* One-step advance CTA — server validates gates and returns 422 {unmet}.
   Closing the case prompts for customer feedback (FR-SR-12). */
function AdvanceOrderButton({
  order,
  onClosed,
}: {
  order: ServiceOrder;
  onClosed?: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const advance = useAdvanceServiceOrder();
  const [open, setOpen] = useState(false);
  const [justification, setJustification] = useState("");
  const target = ORDER_NEXT[order.status];
  if (!target) return null;
  const canSubmit = justification.trim().length >= 3 && !advance.isPending;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setJustification("");
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs gap-1.5"
        >
          <Wrench className="w-3.5 h-3.5" />
          {ORDER_NEXT_LABEL[target]}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{ORDER_NEXT_LABEL[target]}</DialogTitle>
          <DialogDescription>
            RO #{order.id} → {target.replace(/_/g, " ")}. A justification is required for every
            stage change and is kept on the case's audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Justification</Label>
          <Textarea
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="Why is this case moving to the next stage?"
            rows={3}
          />
        </div>
        <Button
          disabled={!canSubmit}
          className="w-full rounded-full bg-primary hover:bg-primary/90 text-white gap-1.5"
          onClick={async () => {
            try {
              await advance.mutateAsync({
                id: order.id,
                data: { targetStatus: target, justification: justification.trim() },
              });
              queryClient.invalidateQueries({ queryKey: getListServiceOrdersQueryKey() });
              toast({
                title: "Case advanced",
                description: `RO #${order.id} → ${target.replace(/_/g, " ")}.`,
              });
              setOpen(false);
              setJustification("");
              if (target === "closed") onClosed?.();
            } catch (e: unknown) {
              const data = (e as { response?: { data?: { unmet?: string[]; error?: string } } })
                ?.response?.data;
              const msg = data?.unmet?.join(" · ") ?? data?.error ?? "Could not advance the case.";
              toast({ title: "Advance blocked", description: msg, variant: "destructive" });
            }
          }}
        >
          {advance.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Confirm {ORDER_NEXT_LABEL[target]}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/* Advance CTA + feedback prompt share state so closing auto-opens the dialog. */
function AdvanceAndFeedback({
  order,
  review,
}: {
  order: ServiceOrder;
  review: { rating: number; comment?: string | null } | undefined;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  return (
    <>
      <AdvanceOrderButton order={order} onClosed={() => setFeedbackOpen(true)} />
      <ServiceFeedback order={order} review={review} open={feedbackOpen} setOpen={setFeedbackOpen} />
    </>
  );
}

/* Post-service feedback (FR-SR-12): capture a service_csat review linked to
   the repair order. Auto-prompts when the case closes; the closed card keeps
   a Feedback button until one is recorded. */
function ServiceFeedback({
  order,
  review,
  open,
  setOpen,
}: {
  order: ServiceOrder;
  review: { rating: number; comment?: string | null } | undefined;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createReview = useCreateReview();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");

  if (review) {
    return (
      <div className="flex items-center justify-start md:justify-end gap-0.5 text-primary">
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            className={cn(
              "w-3.5 h-3.5",
              n <= review.rating ? "fill-primary" : "text-muted-foreground",
            )}
          />
        ))}
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">
          CSAT
        </span>
      </div>
    );
  }

  return (
    <>
      {order.status === "closed" && (
        <Button
          size="sm"
          variant="outline"
          className="rounded-full border-white/15 gap-1.5 text-xs"
          onClick={() => setOpen(true)}
        >
          <Star className="w-3.5 h-3.5" /> Feedback
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>How was the service?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              RO #{order.id.toString().padStart(5, "0")} — {order.vehicleInfo}. Record the
              customer's rating; it is saved as a service CSAT review on their profile.
            </p>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} onClick={() => setRating(n)} className="p-1">
                  <Star
                    className={cn(
                      "w-7 h-7 transition-colors",
                      n <= rating ? "text-primary fill-primary" : "text-muted-foreground",
                    )}
                  />
                </button>
              ))}
            </div>
            <Textarea
              placeholder="Customer comments (optional)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} className="rounded-full">
              Skip for now
            </Button>
            <Button
              disabled={rating < 1 || createReview.isPending}
              onClick={async () => {
                try {
                  await createReview.mutateAsync({
                    data: {
                      source: "service_csat",
                      rating,
                      ...(comment.trim() ? { comment: comment.trim() } : {}),
                      ...(order.customerId != null ? { customerId: order.customerId } : {}),
                      ...(order.customerName ? { customerName: order.customerName } : {}),
                      refType: "service_order",
                      refId: order.id,
                      vehicleLabel: order.vehicleInfo,
                    },
                  });
                  queryClient.invalidateQueries({ queryKey: getListReviewsQueryKey() });
                  setOpen(false);
                  toast({ title: "Feedback recorded", description: "Saved as a service CSAT review." });
                } catch (e: unknown) {
                  const msg =
                    (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                    "Could not save feedback.";
                  toast({ title: "Feedback failed", description: msg, variant: "destructive" });
                }
              }}
            >
              {createReview.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
              Save feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function BookingsTab() {
  const { data: orders, isLoading } = useListServiceOrders();
  const { toast } = useToast();
  const money = useMoney();
  const remind = useSendServiceReminder();
  const { data: csatReviews } = useListReviews({ source: "service_csat" });
  const reviewFor = (orderId: number) =>
    csatReviews?.find((r) => r.refType === "service_order" && r.refId === orderId);
  const { density, setDensity, layout, setLayout } = useViewMode("service");
  /* Triage deep link: /service?order=<id> scrolls to and highlights the RO. */
  const focusOrderId = useFocusParam("order");
  const isFocused = useFocusHighlight(focusOrderId, "service-order", !!orders?.length);

  if (!isLoading && orders?.length !== 0 && layout === "list") {
    return (
      <div className="space-y-4">
        <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">RO</th>
                <th className="px-4 py-3 font-semibold">Vehicle</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Customer</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Type</th>
                <th className="px-4 py-3 font-semibold">Scheduled</th>
                <th className="px-4 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {(orders ?? []).map((order) => (
                <tr
                  key={order.id}
                  id={`service-order-${order.id}`}
                  className={`border-b border-white/5 hover:bg-foreground/[0.03] transition-colors ${
                    isFocused(order.id) ? "bg-primary/10 ring-1 ring-inset ring-primary/50" : ""
                  }`}
                >
                  <td className={`px-4 tabular-nums text-primary font-semibold ${density === "compact" ? "py-2.5" : "py-3.5"}`}>
                    #{order.id.toString().padStart(5, "0")}
                  </td>
                  <td className="px-4 py-2 font-medium">{order.vehicleInfo}</td>
                  <td className="px-4 py-2 text-muted-foreground hidden md:table-cell">
                    {order.customerName || "Unknown"}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground capitalize hidden md:table-cell">
                    {order.type}
                  </td>
                  <td className="px-4 py-2 tabular-nums">
                    {format(new Date(order.scheduledDate), "MMM d")}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
                        order.status === "resolved" || order.status === "closed"
                          ? "bg-primary/15 text-primary"
                          : "bg-foreground/[0.06] text-muted-foreground"
                      }`}
                    >
                      {order.status.replace(/_/g, " ")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3">
      {isLoading ? (
        [...Array(4)].map((_, i) => (
          <div key={i} className="h-24 bg-white/[0.05] rounded-2xl animate-pulse" />
        ))
      ) : orders?.length === 0 ? (
        <EmptyState icon={Calendar} text="No bookings yet. Book the first service." />
      ) : (
        orders?.map((order, i) => (
          <motion.div
            key={order.id}
            id={`service-order-${order.id}`}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
          >
            <Card className={`glass-panel shadow-sm hover:shadow-xl transition-all duration-300 rounded-3xl overflow-hidden group relative ${
              isFocused(order.id) ? "border border-primary ring-2 ring-primary/50" : "border-none"
            }`}>
              <div
                className={`absolute top-0 bottom-0 left-0 w-1.5 ${order.status === "resolved" || order.status === "closed" ? "bg-primary" : "bg-white/10"}`}
              />
              <CardContent className="px-4 py-3.5 md:px-5 md:py-4 pl-5 md:pl-6">
                <div className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-5">
                  {/* Identity */}
                  <div className="flex gap-3 items-center min-w-0 lg:w-[34%]">
                    <div className="w-9 h-9 rounded-lg bg-white/[0.04] border border-white/10 flex items-center justify-center shrink-0 group-hover:border-primary/40 group-hover:bg-primary/10 transition-colors duration-300">
                      <Wrench className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors duration-300" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-base leading-tight truncate">{order.vehicleInfo}</h3>
                        <Badge
                          variant="secondary"
                          className={cn(
                            "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border-none shrink-0",
                            order.status === "in_progress"
                              ? "bg-primary/15 text-primary"
                              : order.status === "resolved" || order.status === "closed"
                                ? "bg-emerald-500/15 text-emerald-400"
                                : "bg-white/[0.06] text-foreground",
                          )}
                        >
                          {order.status.replace("_", " ")}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap mt-0.5">
                        <span className="font-semibold tracking-wider text-primary uppercase">
                          RO #{order.id.toString().padStart(5, "0")}
                        </span>
                        <span>· {order.type}</span>
                        {order.payType && order.payType !== "customer" && (
                          <span className="rounded-full bg-primary/15 text-primary px-1.5 py-px text-[10px] font-bold">
                            {PAY_TYPE_LABEL[order.payType] ?? order.payType}
                          </span>
                        )}
                        <span>·</span>
                        {order.customerId ? (
                          <Link
                            href={`/customers/${order.customerId}`}
                            className="text-primary hover:underline truncate"
                          >
                            {order.customerName || "Unknown"}
                          </Link>
                        ) : (
                          <span className="truncate">{order.customerName || "Unknown"}</span>
                        )}
                        {order.odometer != null && (
                          <span>· {order.odometer.toLocaleString()} km</span>
                        )}
                      </div>
                      {order.complaint && (
                        <p className="text-xs text-muted-foreground/80 italic line-clamp-1 mt-0.5">
                          “{order.complaint}”
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Facts */}
                  <div className="flex items-center gap-5 lg:gap-6 lg:w-[38%] flex-wrap">
                    <div>
                      <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-1 mb-0.5">
                        <Calendar className="w-3 h-3" /> Scheduled
                      </div>
                      <div className="font-medium text-sm leading-tight">
                        {format(new Date(order.scheduledDate), "MMM d")}
                        <span className="text-muted-foreground"> · {order.estimatedHours}h</span>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-1 mb-0.5">
                        <PenTool className="w-3 h-3" /> Technician
                      </div>
                      <div className={cn("font-medium text-sm truncate", !order.technician && "text-muted-foreground")}>
                        {order.technician || "Unassigned"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-1 mb-0.5">
                        <DollarSign className="w-3 h-3" /> Est. Total
                      </div>
                      <div className="font-medium text-sm tracking-tight">
                        {money.gyd(order.estimatedCost)}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-wrap lg:justify-end lg:flex-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={remind.isPending}
                      className="rounded-full border-white/15 gap-1.5 text-xs h-8"
                      onClick={async () => {
                        try {
                          const r = await remind.mutateAsync({ id: order.id });
                          toast({ title: "Reminder sent", description: `Email queued to ${r.recipient}.` });
                        } catch (e: unknown) {
                          const msg =
                            (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                            "Could not send reminder.";
                          toast({ title: "Reminder failed", description: msg, variant: "destructive" });
                        }
                      }}
                    >
                      <Mail className="w-3.5 h-3.5" /> Remind
                    </Button>
                    <AdvanceAndFeedback order={order} review={reviewFor(order.id)} />
                    <OpenCaseButton
                      customerId={order.customerId ?? null}
                      customerName={order.customerName ?? null}
                      refId={order.id}
                      contextLabel={`RO #${order.id.toString().padStart(5, "0")} — ${order.vehicleInfo}`}
                    />
                    <DeleteOrderButton order={order} />
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))
      )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Job cards                                                           */
/* ------------------------------------------------------------------ */

function CreateJobCardDialog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateJobCard();
  const { data: orders } = useListServiceOrders();
  const { data: technicians } = useListServiceTechnicians();

  return (
    <CreateRecordDialog
      title="Open Job Card"
      description="Attach labour and checklist to a booking; assign a technician."
      pending={create.isPending}
      submitLabel="Open job card"
      trigger={
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-4 h-9 text-sm shadow-md shadow-primary/20 gap-1.5 font-medium tracking-wide">
          <Plus className="w-4 h-4" />
          Open Job Card
        </Button>
      }
      fields={[
        {
          name: "serviceOrderId",
          label: "Booking",
          type: "select",
          required: true,
          span: "full",
          options:
            orders?.map((o) => ({
              value: String(o.id),
              label: `RO #${o.id} — ${o.vehicleInfo}`,
            })) ?? [],
        },
        { name: "title", label: "Job title", type: "text", required: true, span: "full", placeholder: "Front brake overhaul" },
        {
          name: "technicianUserId",
          label: "Technician",
          type: "select",
          span: "half",
          options:
            technicians?.map((t) => ({ value: String(t.id), label: t.name })) ?? [],
        },
        { name: "laborHours", label: "Labour hours", type: "number", span: "half", placeholder: "2.5" },
        { name: "laborRate", label: "Labour rate (GYD/hr)", type: "number", span: "half", placeholder: "120" },
        { name: "checklistText", label: "Checklist (one item per line)", type: "textarea", span: "full", placeholder: "Inspect pads\nReplace rotors\nRoad test" },
        { name: "notes", label: "Notes", type: "textarea", span: "full" },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        const tech = technicians?.find((t) => String(t.id) === String(v.technicianUserId));
        const checklist = String(v.checklistText ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((label) => ({ label, done: false }));
        await create.mutateAsync({
          data: {
            serviceOrderId: Number(v.serviceOrderId),
            title: String(v.title),
            ...(tech ? { technicianUserId: tech.id, technicianName: tech.name } : {}),
            ...(v.laborHours ? { laborHours: Number(v.laborHours) } : {}),
            ...(v.laborRate ? { laborRate: Number(v.laborRate) } : {}),
            ...(checklist.length > 0 ? { checklist } : {}),
            ...(v.notes ? { notes: String(v.notes) } : {}),
          },
        });
        queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
        toast({ title: "Job card opened", description: "Technician has been notified." });
      }}
    />
  );
}

function JobCardsTab() {
  const { data: cards, isLoading } = useListJobCards();

  if (isLoading)
    return (
      <div className="grid gap-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-32 bg-white/[0.05] rounded-2xl animate-pulse" />
        ))}
      </div>
    );

  if (!cards?.length)
    return <EmptyState icon={ClipboardList} text="No job cards yet. Open one from a booking." />;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {cards.map((card) => (
        <JobCardPanel key={card.id} card={card} />
      ))}
    </div>
  );
}

/* Client-side mirror of the server's Service Manager / Management check. */
function useIsServiceApprover() {
  const { me } = useAuthz();
  const role = me?.roleName ?? "";
  return /service manager|general manager|leadership|management|owner.?admin|admin/i.test(role);
}

export function JobCardPanel({ card, technicianView = false }: { card: JobCard; technicianView?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateJobCard();
  const invoice = useCreateJobCardInvoice();
  const addPart = useAddJobCardPart();
  const createCreditNote = useCreateJobCardCreditNote();
  const money = useMoney();
  const { data: lines } = useListJobCardParts(card.id);
  const { data: parts } = useListParts();
  const { data: creditNotes } = useListJobCardCreditNotes(card.id);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListJobCardPartsQueryKey(card.id) });
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

  const partsTotal =
    lines?.reduce(
      (s, l) => s + l.unitPrice * l.quantity * (l.kind === "return" ? -1 : 1),
      0,
    ) ?? 0;
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
              <span>· {card.laborHours}h @ {money.gyd(card.laborRate)}/hr</span>
            </div>
            {(card.startedAt || card.completedAt) && (
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                <Clock className="w-3 h-3" />
                {card.startedAt && (
                  <span>Started {format(new Date(card.startedAt), "MMM d, h:mm a")}</span>
                )}
                {card.completedAt && (
                  <span>· Finished {format(new Date(card.completedAt), "MMM d, h:mm a")}</span>
                )}
                {card.startedAt && card.completedAt && (
                  <span className="text-foreground font-medium">
                    · {formatWorkDuration(new Date(card.startedAt), new Date(card.completedAt))} on vehicle
                  </span>
                )}
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
            <p className="text-xs text-muted-foreground">No parts issued.</p>
          )}
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
                Approved {format(new Date(card.quoteApprovedAt), "MMM d")}
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
                {card.surchargeDecidedBy} on {format(new Date(card.surchargeDecidedAt), "MMM d")}
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
            ? `Job carries over to ${updated.rolloverToDate ? format(new Date(`${updated.rolloverToDate}T00:00:00`), "MMM d") : "the new date"}.`
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
                ? format(new Date(`${card.rolloverToDate}T00:00:00`), "MMM d, yyyy")
                : "—"}
            </span>
            {card.rolloverReason && <> — “{card.rolloverReason}”</>}
            {card.rolloverRequestedBy && card.rolloverRequestedAt && (
              <>
                {" "}· requested by {card.rolloverRequestedBy} on{" "}
                {format(new Date(card.rolloverRequestedAt), "MMM d")}
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span className={cn(card.rolloverManagerApprovedAt ? "text-foreground" : "")}>
              {card.rolloverManagerApprovedAt ? (
                <>
                  ✓ Manager: {card.rolloverManagerApprovedBy} ·{" "}
                  {format(new Date(card.rolloverManagerApprovedAt), "MMM d, HH:mm")}
                </>
              ) : (
                "○ Service Manager sign-off pending"
              )}
            </span>
            <span className={cn(card.rolloverTechApprovedAt ? "text-foreground" : "")}>
              {card.rolloverTechApprovedAt ? (
                <>
                  ✓ Technician: {card.rolloverTechApprovedBy} ·{" "}
                  {format(new Date(card.rolloverTechApprovedAt), "MMM d, HH:mm")}
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

function InvoicesTab() {
  const { data: invoices, isLoading } = useListServiceInvoices();

  if (isLoading)
    return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  if (!invoices?.length)
    return <EmptyState icon={Receipt} text="No invoices yet. Complete a job card and generate one." />;

  return (
    <div className="grid grid-cols-1 gap-4">
      {invoices.map((inv) => (
        <InvoiceCard key={inv.id} inv={inv} />
      ))}
    </div>
  );
}

function InvoiceCard({ inv }: { inv: ServiceInvoice }) {
  const update = useUpdateServiceInvoice();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const money = useMoney();
  const isApprover = useIsServiceApprover();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListServiceInvoicesQueryKey() });

  const setStatus = async (status: "issued" | "paid" | "void") => {
    await update.mutateAsync({ id: inv.id, data: { status } });
    invalidate();
    toast({ title: "Invoice updated", description: `Marked ${status}.` });
  };

  return (
    <Card className="glass-panel border-none rounded-3xl">
      <CardContent className="p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center gap-4 justify-between">
          <div>
            <div className="text-xs font-semibold tracking-widest text-primary uppercase mb-1 flex items-center gap-2">
              Invoice #{inv.id} · RO #{inv.serviceOrderId} · JC #{inv.jobCardId}
              {inv.lockedAt && (
                <span className="inline-flex items-center gap-1 text-muted-foreground normal-case tracking-normal font-medium">
                  <Lock className="w-3 h-3" /> Totals locked
                </span>
              )}
            </div>
            <h3 className="font-bold text-lg">{inv.vehicleInfo}</h3>
            <div className="text-sm text-muted-foreground">
              {inv.customerName ?? "Walk-in"} · {format(new Date(inv.createdAt), "MMM d, yyyy")}
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="text-sm text-muted-foreground text-right">
              <div>Parts {money.gyd(inv.partsTotal)}</div>
              <div>Labour {money.gyd(inv.laborTotal)}</div>
              {inv.surchargeTotal > 0 && <div>Surcharge {money.gyd(inv.surchargeTotal)}</div>}
              <div>Tax {money.gyd(inv.tax)}</div>
              {inv.discountStatus === "approved" && inv.discountTotal > 0 && (
                <div className="text-primary">Discount −{money.gyd(inv.discountTotal)}</div>
              )}
              {(inv.adjustments ?? []).length > 0 && (
                <div>
                  Adjustments{" "}
                  {money.gyd((inv.adjustments ?? []).reduce((s, a) => s + a.amount, 0))}
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="font-light text-3xl tracking-tight">{money.gyd(inv.total)}</div>
              <Badge
                variant="secondary"
                className={cn(
                  "mt-1 px-3 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border-none",
                  inv.status === "paid"
                    ? "bg-primary/15 text-primary"
                    : inv.status === "void"
                      ? "bg-white/[0.05] text-muted-foreground line-through"
                      : "bg-white/[0.08] text-foreground",
                )}
              >
                {inv.status}
              </Badge>
            </div>
            {inv.status === "issued" && (
              <div className="flex flex-col gap-2">
                <Button
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => setStatus("paid")}
                  className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs"
                >
                  Mark Paid
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={update.isPending}
                  onClick={() => setStatus("void")}
                  className="rounded-full border-white/15 text-xs"
                >
                  Void
                </Button>
              </div>
            )}
          </div>
        </div>

        <DiscountRow inv={inv} onChanged={invalidate} />

        <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-white/5">
          <a
            href={`${import.meta.env.BASE_URL}api/service-invoices/${inv.id}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-white/15 text-xs font-medium hover:bg-white/[0.05] transition-colors"
          >
            <FileText className="w-3.5 h-3.5" /> Invoice PDF
          </a>
          <a
            href={`${import.meta.env.BASE_URL}api/service-invoices/${inv.id}/receipt-pdf`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-white/15 text-xs font-medium hover:bg-white/[0.05] transition-colors"
          >
            <Printer className="w-3.5 h-3.5" /> Receipt PDF
          </a>
          {inv.signedCopyFiledAt ? (
            <Badge className="bg-primary/15 text-primary border-none rounded-full text-[10px] font-bold uppercase tracking-widest gap-1">
              <Archive className="w-3 h-3" />
              Signed copy filed by {inv.signedCopyFiledBy} ·{" "}
              {format(new Date(inv.signedCopyFiledAt), "MMM d")}
            </Badge>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              className="rounded-full border-white/15 text-xs gap-1.5"
              onClick={async () => {
                await update.mutateAsync({ id: inv.id, data: { signedCopyFiled: true } });
                invalidate();
                toast({
                  title: "Signed copy filed",
                  description: "Recorded that the customer's signed receipt was collected.",
                });
              }}
            >
              <Archive className="w-3.5 h-3.5" /> Mark signed copy filed
            </Button>
          )}
          {inv.status === "issued" && isApprover && (
            <AdjustInvoiceButton inv={inv} onChanged={invalidate} />
          )}
        </div>

        {(inv.adjustments ?? []).length > 0 && (
          <div className="text-xs text-muted-foreground space-y-0.5">
            {(inv.adjustments ?? []).map((a, i) => (
              <div key={i}>
                Adjustment {a.amount >= 0 ? "+" : ""}
                {money.gyd(a.amount)} — {a.reason} · {a.by} ·{" "}
                {format(new Date(a.at), "MMM d, HH:mm")}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* Discount approval workflow (FR-SR-08). */
function DiscountRow({ inv, onChanged }: { inv: ServiceInvoice; onChanged: () => void }) {
  const { toast } = useToast();
  const money = useMoney();
  const isApprover = useIsServiceApprover();
  const request = useRequestServiceInvoiceDiscount();
  const decide = useDecideServiceInvoiceDiscount();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const fail = (e: unknown) => {
    const msg =
      (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
      "Request failed.";
    toast({ title: "Discount", description: msg, variant: "destructive" });
  };

  if (inv.discountStatus === "none" && inv.status !== "issued") return null;

  return (
    <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-4 flex items-center justify-between gap-3 flex-wrap">
      <div className="text-sm">
        <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-1.5 mb-0.5">
          <BadgePercent className="w-3.5 h-3.5" /> Discount
        </div>
        {inv.discountStatus === "none" && (
          <span className="text-muted-foreground">
            No discount. Any discount needs Service Manager / Management approval.
          </span>
        )}
        {inv.discountStatus === "pending" && (
          <span className="text-muted-foreground">
            {money.gyd(inv.discountRequestedAmount ?? 0)} requested by {inv.discountRequestedBy}
            {inv.discountRequestedAt && (
              <> on {format(new Date(inv.discountRequestedAt), "MMM d")}</>
            )}
            {inv.discountReason && <> — “{inv.discountReason}”</>} · awaiting approval
          </span>
        )}
        {inv.discountStatus === "approved" && (
          <span className="text-muted-foreground">
            {money.gyd(inv.discountTotal)} approved by {inv.discountDecidedBy}
            {inv.discountDecidedAt && <> on {format(new Date(inv.discountDecidedAt), "MMM d")}</>}
            {" "}(requested by {inv.discountRequestedBy})
          </span>
        )}
        {inv.discountStatus === "rejected" && (
          <span className="text-muted-foreground">
            {money.gyd(inv.discountRequestedAmount ?? 0)} rejected by {inv.discountDecidedBy}
            {inv.discountDecidedAt && <> on {format(new Date(inv.discountDecidedAt), "MMM d")}</>}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        {inv.discountStatus === "pending" && isApprover && (
          <>
            <Button
              size="sm"
              disabled={decide.isPending}
              className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs"
              onClick={async () => {
                try {
                  await decide.mutateAsync({ id: inv.id, data: { action: "approve" } });
                  onChanged();
                  toast({ title: "Discount approved", description: "Total updated." });
                } catch (e) {
                  fail(e);
                }
              }}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending}
              className="rounded-full border-white/15 text-xs"
              onClick={async () => {
                try {
                  await decide.mutateAsync({ id: inv.id, data: { action: "reject" } });
                  onChanged();
                  toast({ title: "Discount rejected" });
                } catch (e) {
                  fail(e);
                }
              }}
            >
              Reject
            </Button>
          </>
        )}
        {(inv.discountStatus === "none" || inv.discountStatus === "rejected") &&
          inv.status === "issued" && (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-white/15 text-xs gap-1.5"
              onClick={() => setOpen(true)}
            >
              <BadgePercent className="w-3.5 h-3.5" /> Request discount
            </Button>
          )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Request a discount</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              A Service Manager or Management must approve before the discounted total is final.
            </p>
            <Input
              type="number"
              min={0}
              placeholder="Discount amount (GYD)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Textarea
              placeholder="Reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={!amount || Number(amount) <= 0 || request.isPending}
              onClick={async () => {
                try {
                  await request.mutateAsync({
                    id: inv.id,
                    data: {
                      amount: Number(amount),
                      ...(reason.trim() ? { reason: reason.trim() } : {}),
                    },
                  });
                  onChanged();
                  setOpen(false);
                  setAmount("");
                  setReason("");
                  toast({
                    title: "Discount requested",
                    description: "Sent for manager approval.",
                  });
                } catch (e) {
                  fail(e);
                }
              }}
            >
              {request.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
              Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* Post-issue adjustment (FR-SR-09): the documented follow-up path. */
function AdjustInvoiceButton({ inv, onChanged }: { inv: ServiceInvoice; onChanged: () => void }) {
  const { toast } = useToast();
  const adjust = useAdjustServiceInvoice();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="rounded-full border-white/15 text-xs gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Plus className="w-3.5 h-3.5" /> Adjustment
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Post-issue adjustment</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Issued totals are locked. Adjustments are the only sanctioned change and stay on
              record — use a negative amount for credits.
            </p>
            <Input
              type="number"
              placeholder="Amount (GYD, negative for credit)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Textarea
              placeholder="Reason (required)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={
                !amount || Number(amount) === 0 || reason.trim().length < 3 || adjust.isPending
              }
              onClick={async () => {
                try {
                  await adjust.mutateAsync({
                    id: inv.id,
                    data: { amount: Number(amount), reason: reason.trim() },
                  });
                  onChanged();
                  setOpen(false);
                  setAmount("");
                  setReason("");
                  toast({ title: "Adjustment recorded", description: "Total updated." });
                } catch (e: unknown) {
                  const msg =
                    (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                    "Could not record adjustment.";
                  toast({ title: "Adjustment failed", description: msg, variant: "destructive" });
                }
              }}
            >
              {adjust.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
              Record adjustment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Coverage (warranty / AMC)                                           */
/* ------------------------------------------------------------------ */

function CreateCoverageDialog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateCoveragePlan();
  return (
    <CreateRecordDialog
      title="Add Coverage"
      description="Track a factory warranty or annual maintenance contract."
      pending={create.isPending}
      submitLabel="Add coverage"
      trigger={
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-4 h-9 text-sm shadow-md shadow-primary/20 gap-1.5 font-medium tracking-wide">
          <Plus className="w-4 h-4" />
          Add Coverage
        </Button>
      }
      fields={[
        { name: "customerName", label: "Customer", type: "text", span: "half" },
        { name: "vehicleInfo", label: "Vehicle", type: "text", required: true, span: "half", placeholder: "2023 Audi Q7" },
        {
          name: "type",
          label: "Type",
          type: "select",
          required: true,
          span: "half",
          defaultValue: "warranty",
          options: [
            { value: "warranty", label: "Warranty" },
            { value: "amc", label: "AMC" },
          ],
        },
        { name: "provider", label: "Provider", type: "text", span: "half", placeholder: "Factory / AURA Care" },
        { name: "startDate", label: "Start date", type: "date", required: true, span: "half" },
        { name: "endDate", label: "End date", type: "date", required: true, span: "half" },
        { name: "notes", label: "Notes", type: "textarea", span: "full" },
      ]}
      onSubmit={async (values) => {
        await create.mutateAsync({ data: values as never });
        queryClient.invalidateQueries({ queryKey: getListCoveragePlansQueryKey() });
        toast({ title: "Coverage added" });
      }}
    />
  );
}

function CoverageTab() {
  const { data: plans, isLoading } = useListCoveragePlans();
  const remind = useSendCoverageReminder();
  const { toast } = useToast();

  if (isLoading)
    return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  if (!plans?.length)
    return <EmptyState icon={ShieldCheck} text="No warranty or AMC plans recorded yet." />;

  const now = new Date();
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {plans.map((plan) => {
        const end = new Date(plan.endDate);
        const daysLeft = Math.ceil((end.getTime() - now.getTime()) / 86400000);
        const expiring = daysLeft <= 60;
        return (
          <Card key={plan.id} className="glass-panel border-none rounded-3xl relative overflow-hidden">
            <div
              className={cn(
                "absolute top-0 bottom-0 left-0 w-1.5",
                daysLeft < 0 ? "bg-white/10" : expiring ? "bg-primary" : "bg-white/20",
              )}
            />
            <CardContent className="p-6 pl-8 flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold tracking-widest text-primary uppercase mb-1">
                  {plan.type === "amc" ? "AMC" : "Warranty"}
                  {plan.provider && <span className="text-muted-foreground"> · {plan.provider}</span>}
                </div>
                <h3 className="font-bold text-lg">{plan.vehicleInfo}</h3>
                <div className="text-sm text-muted-foreground">
                  {plan.customerName ?? "—"} · {format(new Date(plan.startDate), "MMM yyyy")} →{" "}
                  {format(end, "MMM d, yyyy")}
                </div>
                <div
                  className={cn(
                    "text-sm mt-1 font-medium",
                    daysLeft < 0
                      ? "text-muted-foreground"
                      : expiring
                        ? "text-primary"
                        : "text-foreground",
                  )}
                >
                  {daysLeft < 0 ? "Expired" : `${daysLeft} days remaining`}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={remind.isPending}
                className="rounded-full border-white/15 gap-1.5 text-xs shrink-0"
                onClick={async () => {
                  try {
                    const r = await remind.mutateAsync({ id: plan.id });
                    toast({ title: "Reminder sent", description: `Email queued to ${r.recipient}.` });
                  } catch (e: unknown) {
                    const msg =
                      (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                      "Could not send reminder.";
                    toast({ title: "Reminder failed", description: msg, variant: "destructive" });
                  }
                }}
              >
                <Mail className="w-3.5 h-3.5" /> Remind
              </Button>
              <a
                href={`${import.meta.env.BASE_URL}api/coverage/${plan.id}/pdf`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-white/15 text-xs font-medium hover:bg-white/[0.05] transition-colors shrink-0"
              >
                <FileText className="w-3.5 h-3.5" /> Certificate
              </a>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function OpenCaseButton({
  customerId,
  customerName,
  refId,
  contextLabel,
}: {
  customerId: number | null;
  customerName: string | null;
  refId: number;
  contextLabel: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createCase = useCreateCase();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<"low" | "medium" | "high">("medium");

  const submit = async () => {
    try {
      await createCase.mutateAsync({
        data: {
          customerId,
          customerName,
          title,
          description: description ? `${contextLabel}: ${description}` : contextLabel,
          type: "complaint",
          severity,
          refType: "service_order",
          refId,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      setOpen(false);
      setTitle("");
      setDescription("");
      toast({
        title: "Case opened",
        description: customerId
          ? "Track it from the customer's Care tab."
          : "Case logged for this repair order.",
      });
    } catch (e) {
      toast({
        title: "Couldn't open the case",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="rounded-full border-white/15 gap-1.5 text-xs"
        onClick={() => setOpen(true)}
      >
        <MessageSquareWarning className="w-3.5 h-3.5" /> Open Case
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Open a case</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">{contextLabel}</div>
            <Input
              placeholder="Case title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Textarea
              placeholder="What happened? (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
            <Select
              value={severity}
              onValueChange={(v) => setSeverity(v as typeof severity)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              onClick={submit}
              disabled={title.trim().length < 3 || createCase.isPending}
            >
              {createCase.isPending && (
                <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
              )}
              Open Case
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function EmptyState({ icon: Icon, text }: { icon: typeof Calendar; text: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3 text-center">
      <Icon className="w-8 h-8 text-muted-foreground" />
      <p className="text-muted-foreground">{text}</p>
    </div>
  );
}
