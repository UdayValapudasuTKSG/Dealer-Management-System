import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useFocusParam, useFocusHighlight } from "@/lib/use-focus-param";
import {
  useListServiceOrders,
  useCreateServiceOrder,
  useUpdateServiceOrder,
  useAdvanceServiceOrder,
  useDeleteServiceOrder,
  getListServiceOrdersQueryKey,
  useSendServiceReminder,
  useConfirmServiceAppointment,
  useGetServiceAppointmentConfirmationDelivery,
  useRetryServiceAppointmentConfirmation,
  getGetServiceAppointmentConfirmationDeliveryQueryKey,
  useListServiceOrderOnboardingMedia,
  useClaimServiceOrder,
  useCreateVehicleOnboardingInvite,
  useListJobCards,
  useCreateJobCard,
  useUpdateJobCard,
  getListJobCardsQueryKey,
  getListWorkshopWipQueryKey,
  useListJobCardParts,
  useListJobCardExternalParts,
  useAddJobCardPart,
  getListJobCardPartsQueryKey,
  getListJobCardExternalPartsQueryKey,
  useListJobCardPartRequisitions,
  getListJobCardPartRequisitionsQueryKey,
  useCreateJobCardInvoice,
  useListServiceInvoices,
  useUpdateServiceInvoice,
  getListServiceInvoicesQueryKey,
  useListCoveragePlans,
  useCreateCoveragePlan,
  getListCoveragePlansQueryKey,
  useSendCoverageReminder,
  useListServiceTechnicians,
  useListWorkshopWip,
  useListParts,
  getListPartsQueryKey,
  useListJobCardCreditNotes,
  useCreateJobCardCreditNote,
  getListJobCardCreditNotesQueryKey,
  useCreateCase,
  getListCasesQueryKey,
  useRolloverJobCard,
  useToggleJobCardTimer,
  useReopenJobCard,
  useListJobCardHistory,
  useListJobCardTechnicianNotes,
  useCreateJobCardTechnicianNote,
  getListJobCardTechnicianNotesQueryKey,
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
  type ServiceOrderUpdate,
  type ServiceOrderUpdateType,
  type ServiceInvoice,
  type ServiceOrderAdvanceBodyTargetStatus,
  type JobCardWaitingReason,
  type ListWorkshopWipFollowUp,
  type WorkshopWipItem,
  type TechnicianRef,
  useListCustomers,
  useListServiceCustomerVehicles,
  getListServiceCustomerVehiclesQueryKey,
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
  MessageSquare,
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
  Pause,
  Play,
  RotateCcw,
  History,
  Search,
  Phone,
  CarFront,
  Check,
  ChevronsUpDown,
  X,
  ArrowRight
} from "lucide-react";
import { DocumentsCard } from "@/components/documents-card";
import { CollisionTab, CreateClaimDialog } from "@/components/collision-claims";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { motion, AnimatePresence } from "framer-motion";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { useViewMode } from "@/hooks/use-view-mode";
import { useListPagination } from "@/hooks/use-list-pagination";
import { useAuthz } from "@/lib/auth";
import { ViewControls } from "@/components/view-controls";
import { ListPagination } from "@/components/list-pagination";
import { PartRequisitionForm } from "@/components/service/part-requisition-form";
import { cn } from "@/lib/utils";
import {
  isCurrentServiceVehicleLookup,
  selectServiceCustomerVehicle,
  serviceVehicleFields,
  serviceVehicleLabel,
  shouldAutofillServiceVehicleField,
} from "@/lib/service-customer-vehicles";
import {
  formatDealerDateShort,
  formatCalendarDateShort,
  formatDealerDayTime,
  formatDealerMonthYear,
  formatGuyanaDate,
  dealerDayKey,
  useMoney,
} from "@/lib/format";

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
  { key: "collision", label: "Collision", icon: CarFront },
  { key: "invoices", label: "Invoices", icon: Receipt },
  { key: "coverage", label: "Warranty & AMC", icon: ShieldCheck },
  { key: "history", label: "History", icon: History },
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
  const [pickedTab, setTab] = useState<TabKey | null>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return TABS.some((item) => item.key === requested)
      ? (requested as TabKey)
      : null;
  });
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
          {tab === "collision" && <CollisionTab />}
          {tab === "invoices" && <InvoicesTab />}
          {tab === "coverage" && <CoverageTab />}
          {tab === "history" && <HistoryTab />}
        </motion.div>
      </AnimatePresence>
    </Page>
    </>
  );
}

function HeaderAction({ tab }: { tab: TabKey }) {
  if (tab === "bookings") return <CreateBookingDialog />;
  if (tab === "jobcards") return <CreateJobCardDialog />;
  if (tab === "collision") return <CreateClaimDialog />;
  if (tab === "coverage") return <CreateCoverageDialog />;
  return null;
}

/* ------------------------------------------------------------------ */
/* My Jobs — the technician's own queue (merged from Workshop, 2026-07) */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* History — past job cards across all customers/vehicles              */
/* ------------------------------------------------------------------ */

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

function HistoryTab() {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const { data: rows, isLoading } = useListJobCardHistory(
    applied ? { q: applied } : {},
  );
  const historyPager = useListPagination(rows ?? [], applied);

  return (
    <div className="space-y-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(q.trim());
        }}
      >
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by customer, vehicle or job title…"
            className="pl-10 rounded-full bg-white/[0.03] border-white/10"
          />
        </div>
        <Button type="submit" className="rounded-full bg-primary hover:bg-primary/90 text-white">
          Search
        </Button>
      </form>

      {isLoading ? (
        <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />
      ) : !rows?.length ? (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3 text-center">
          <History className="w-8 h-8 text-muted-foreground" />
          <p className="text-muted-foreground">
            {applied ? "No past jobs match that search." : "No job cards yet."}
          </p>
        </div>
      ) : (
        <>
        <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Job</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Customer</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Vehicle</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Technician</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right hidden sm:table-cell">Worked</th>
                <th className="px-4 py-3 font-semibold text-right">Date</th>
              </tr>
            </thead>
            <tbody>
              {historyPager.items.map((r) => (
                <tr key={r.id} className="border-b border-white/5 hover:bg-foreground/[0.03] transition-colors align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium">{r.title}</div>
                    <div className="text-xs text-muted-foreground">
                      JC #{r.id} · RO #{r.serviceOrderId}
                    </div>
                    {(r.serviceAnalysis || r.workPerformed) && (
                      <div className="text-xs text-muted-foreground mt-1 max-w-md line-clamp-2">
                        {r.workPerformed ?? r.serviceAnalysis}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">{r.customerName ?? "—"}</td>
                  <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">{r.vehicleInfo}</td>
                  <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">{r.technicianName ?? "—"}</td>
                  <td className="px-4 py-3">
                    <Badge
                      variant="secondary"
                      className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border-none"
                    >
                      {JOB_STATUS_LABEL[r.status] ?? r.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right hidden sm:table-cell">
                    {r.timerSeconds > 0
                      ? formatWorkedSeconds(r.timerSeconds)
                      : r.laborHours > 0
                        ? `${r.laborHours}h`
                        : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground whitespace-nowrap">
                    {formatGuyanaDate(r.completedAt ?? r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ListPagination {...historyPager} label="history jobs" />
        </>
      )}
    </div>
  );
}

function MyJobsTab() {
  const { data: cards, isLoading } = useListJobCards({ mine: "1" });
  const [scope, setScope] = useState<"today" | "later">("today");
  const todayKey = dealerDayKey();
  const visibleCards =
    cards?.filter((card) => {
      const scheduledKey = card.scheduledAt
        ? dealerDayKey(new Date(card.scheduledAt))
        : null;
      const active = ["open", "in_progress", "on_hold"].includes(card.status);
      if (scope === "later") {
        return active && scheduledKey != null && scheduledKey > todayKey;
      }
      return scheduledKey === todayKey || (active && (!scheduledKey || scheduledKey < todayKey));
    }) ?? [];
  const hasRunningTimer =
    visibleCards.some(
      (card) => card.status === "in_progress" && !!card.timerStartedAt,
    );
  const [, tick] = useState(0);
  useEffect(() => {
    if (!hasRunningTimer) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [hasRunningTimer]);

  const active =
    visibleCards.filter((card) =>
      ["open", "in_progress", "on_hold"].includes(card.status),
    );
  const completed =
    visibleCards.filter((card) =>
      ["completed", "closed"].includes(card.status),
    );
  const other =
    visibleCards.filter(
      (card) => !active.includes(card) && !completed.includes(card),
    );
  const orderedCards = [...active, ...completed, ...other];
  const myJobsPager = useListPagination(orderedCards, scope);
  const bookedHours =
    visibleCards.reduce((sum, card) => sum + bookedHoursForCard(card), 0);
  const now = Date.now();
  const workedSeconds =
    visibleCards.reduce((sum, card) => sum + workedSecondsAt(card, now), 0);

  return (
    <div className="space-y-5">
      <div
        className="inline-flex rounded-full border border-white/10 bg-white/[0.03] p-1"
        data-testid="tabs-my-jobs-schedule"
      >
        {(["today", "later"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setScope(value)}
            data-testid={`button-my-jobs-${value}`}
            className={cn(
              "rounded-full px-4 py-2 text-sm font-medium transition-colors",
              scope === value
                ? "bg-primary text-white shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {value === "today" ? "Today" : "Later"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <MyJobsStatCard icon={ClipboardList} label="Active jobs" value={String(active.length)} />
        <MyJobsStatCard icon={CheckCircle2} label="Completed" value={String(completed.length)} />
        <MyJobsStatCard
          icon={Clock}
          label="Worked time"
          value={formatWorkedSeconds(workedSeconds)}
        />
        <MyJobsStatCard
          icon={Calendar}
          label="Booked hours"
          value={`${bookedHours.toFixed(1)}h`}
        />
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
      ) : visibleCards.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-20 flex flex-col items-center gap-3 text-center">
          <CalendarClock className="w-8 h-8 text-muted-foreground" />
          <p className="text-muted-foreground">
            {scope === "today"
              ? "No jobs scheduled for today."
              : "No jobs scheduled for later."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {myJobsPager.items.map((card) => (
              <Link key={card.id} href={`/service/job-cards/${card.id}`}><JobCardSummary card={card} /></Link>
            ))}
          </div>
          <ListPagination {...myJobsPager} label="my jobs" />
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
  const { data: customers } = useListCustomers();
  const [open, setOpen] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const vehicleRequestRef = useRef(0);
  const vehicleCustomerRef = useRef<number | null>(null);
  const autofillFieldRef = useRef<(name: string, value: string) => void>(() => undefined);
  const { data: customerVehicles } = useListServiceCustomerVehicles(
    selectedCustomerId ?? 0,
    {
      query: {
        enabled: open && selectedCustomerId != null,
        queryKey: getListServiceCustomerVehiclesQueryKey(selectedCustomerId ?? 0),
      },
    },
  );

  const applyVehicleAutofill = (
    vehicle: NonNullable<typeof customerVehicles>[number],
    setAutofillField: (name: string, value: string) => void,
  ) => {
    const fields = serviceVehicleFields(vehicle);
    setAutofillField("vehicleInfo", fields.vehicleInfo);
    setAutofillField("vin", fields.vin);
    setAutofillField("registrationNumber", fields.registrationNumber);
  };

  useEffect(() => {
    if (
      !open ||
      selectedCustomerId == null ||
      !isCurrentServiceVehicleLookup({
        dialogOpen: open,
        activeCustomerId: vehicleCustomerRef.current,
        responseCustomerId: selectedCustomerId,
      }) ||
      !selectServiceCustomerVehicle(customerVehicles, {
        vin: "",
        registrationNumber: "",
      })
    ) return;
    if (vehicleRequestRef.current === 0) return;
    const setAutofillField = autofillFieldRef.current;
    const vehicle = selectServiceCustomerVehicle(customerVehicles, {
      vin: "",
      registrationNumber: "",
    });
    if (!vehicle) return;
    setAutofillField("customerVehicleId", String(vehicle.vehicleId));
    applyVehicleAutofill(vehicle, setAutofillField);
  }, [customerVehicles, open, selectedCustomerId]);

  return (
    <CreateRecordDialog
      title="Book Service"
      description="Log the complaint, schedule the bay — AURA handles the rest."
      pending={createOrder.isPending}
      submitLabel="Create booking"
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          vehicleRequestRef.current += 1;
          setSelectedCustomerId(null);
          vehicleCustomerRef.current = null;
          autofillFieldRef.current = () => undefined;
        }
      }}
      trigger={
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-4 h-9 text-sm shadow-md shadow-primary/20 gap-1.5 font-medium tracking-wide">
          <Plus className="w-4 h-4" />
          Book Service
        </Button>
      }
      fields={[
        {
          name: "customerId",
          label: "Linked Customer (Optional)",
          type: "select",
          searchable: true,
          span: "half",
          options: customers?.map(c => ({ value: String(c.id), label: c.name })) ?? [],
          onChange: (val, setAutofillField, setField) => {
            vehicleRequestRef.current += 1;
            const request = vehicleRequestRef.current;
            const nextCustomerId = val && val !== "none" ? Number(val) : null;
            setSelectedCustomerId(nextCustomerId);
            vehicleCustomerRef.current = nextCustomerId;
            autofillFieldRef.current = setAutofillField;
            // The selector is a deliberate choice, so always clear it.
            // Identity values are cleared only when they were autofilled;
            // manually typed edits remain protected by CreateRecordDialog.
            setField("customerVehicleId", "");
            setAutofillField("vehicleInfo", "");
            setAutofillField("vin", "");
            setAutofillField("registrationNumber", "");
            const customer = customers?.find(c => String(c.id) === val);
            if (customer) {
              setAutofillField("customerName", customer.name || "");
              setAutofillField("customerEmail", customer.email || "");
              setAutofillField("customerPhoneSnapshot", customer.phone || "");
            }
            if (!nextCustomerId || request !== vehicleRequestRef.current) {
              setSelectedCustomerId(null);
            }
          }
        },
        { name: "customerName", label: "Customer Name", type: "text", span: "half", placeholder: "Nana Adjei" },
        { name: "customerPhoneSnapshot", label: "Contact Phone (Job Card)", type: "phone", span: "half", required: true, placeholder: "+592..." },
        { name: "customerEmail", label: "Customer Email", type: "email", span: "half", placeholder: "customer@email.com" },
        {
          name: "customerVehicleId",
          label: "Saved customer vehicle",
          type: "custom",
          span: "full",
          render: (value, set) => {
            if (selectedCustomerId == null) return null;
            if (customerVehicles === undefined) {
              return <div className="h-8 rounded-md border border-white/10 bg-white/[0.04] px-3 flex items-center text-xs text-muted-foreground">Loading saved vehicles…</div>;
            }
            if (customerVehicles.length === 0) {
              return <div className="rounded-md border border-dashed border-white/10 px-3 py-2 text-xs text-muted-foreground">No delivered vehicles are linked to this customer. Enter the vehicle details below.</div>;
            }
            return (
              <Select value={value} onValueChange={set}>
                <SelectTrigger className="h-8 text-xs bg-white/[0.04] border-white/10">
                  <SelectValue placeholder={customerVehicles.length > 1 ? "Select a vehicle" : "Saved vehicle"} />
                </SelectTrigger>
                <SelectContent>
                  {customerVehicles.map((vehicle) => (
                    <SelectItem key={vehicle.vehicleId} value={String(vehicle.vehicleId)}>
                      {serviceVehicleLabel(vehicle)}{vehicle.registration ? ` · ${vehicle.registration}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          },
          onChange: (value, setAutofillField) => {
            const vehicle = customerVehicles?.find((candidate) => String(candidate.vehicleId) === value);
            if (vehicle) applyVehicleAutofill(vehicle, setAutofillField);
          },
        },
        { name: "vehicleInfo", label: "Vehicle", type: "text", required: true, span: "half", placeholder: "2022 BMW X5" },
        { name: "vin", label: "VIN", type: "text", required: true, span: "half", placeholder: "WBA..." },
        { name: "registrationNumber", label: "Registration", type: "text", required: true, span: "half", placeholder: "PAB 1234" },
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
        delete v.customerVehicleId;
        if (v.customerId != null && v.customerId !== "") {
          v.customerId = Number(v.customerId);
        } else {
          delete v.customerId;
        }
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

/* Edit an existing booking's scheduling and details */
function EditBookingDialog({
  order,
  onUpdated,
}: {
  order: ServiceOrder;
  onUpdated?: (order: ServiceOrder) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateServiceOrder();
  const { data: technicians } = useListServiceTechnicians();
  const { data: customers } = useListCustomers();
  const [open, setOpen] = useState(false);
  const [selectedVehicleId, setSelectedVehicleId] = useState("");
  const vehicleRequestRef = useRef(0);
  const vehicleCustomerRef = useRef<number | null>(null);
  const autoDerivedFields = useRef(new Set<string>());

  // States
  const [customerId, setCustomerId] = useState<string>("none");
  const [customerName, setCustomerName] = useState<string>("");
  const [customerPhoneSnapshot, setCustomerPhoneSnapshot] = useState<string>("");
  const [customerEmail, setCustomerEmail] = useState<string>("");
  const [vehicleInfo, setVehicleInfo] = useState<string>("");
  const [vin, setVin] = useState<string>("");
  const [registrationNumber, setRegistrationNumber] = useState<string>("");
  const [type, setType] = useState<string>("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [complaint, setComplaint] = useState("");
  const [odometer, setOdometer] = useState("");
  const [estimatedCost, setEstimatedCost] = useState("");
  const [estimatedHours, setEstimatedHours] = useState("");
  const [technicianUserId, setTechnicianUserId] = useState("");
  const customerVehicleId = customerId !== "none" ? Number(customerId) : 0;
  const { data: customerVehicles } = useListServiceCustomerVehicles(
    customerVehicleId,
    {
      query: {
        enabled: open && customerId !== "none",
        queryKey: getListServiceCustomerVehiclesQueryKey(customerVehicleId),
      },
    },
  );
  // Selecting a linked customer fills untouched contact fields, but never
  // overwrites a value the operator has deliberately edited.
  const editedFields = useRef(new Set<string>());

  useEffect(() => {
    if (open) {
      setCustomerId(order.customerId != null ? String(order.customerId) : "none");
      vehicleCustomerRef.current = order.customerId ?? null;
      setCustomerName(order.customerName ?? "");
      setCustomerPhoneSnapshot(order.customerPhoneSnapshot ?? "");
      setCustomerEmail(
        order.customerEmail ??
          customers?.find((customer) => customer.id === order.customerId)?.email ??
          "",
      );
      setVehicleInfo(order.vehicleInfo ?? "");
      setVin(order.vin ?? "");
      setRegistrationNumber(order.registrationNumber ?? "");
      setSelectedVehicleId("");
      setType(order.type);
      setScheduledDate(order.scheduledDate ? order.scheduledDate.split("T")[0] : "");
      setComplaint(order.complaint ?? "");
      setOdometer(order.odometer != null ? String(order.odometer) : "");
      setEstimatedCost(order.estimatedCost != null ? String(order.estimatedCost) : "");
      setEstimatedHours(order.estimatedHours != null ? String(order.estimatedHours) : "");
      setTechnicianUserId(order.technicianUserId != null ? String(order.technicianUserId) : "none");
      editedFields.current.clear();
      autoDerivedFields.current.clear();
      if (order.customerId != null) {
        for (const [field, value] of [
          ["vehicleInfo", order.vehicleInfo],
          ["vin", order.vin ?? ""],
          ["registrationNumber", order.registrationNumber ?? ""],
        ] as const) {
          if (value) autoDerivedFields.current.add(field);
        }
      }
    }
  }, [open, order]);

  // UI state for the searchable combo box
  const [customerSelectOpen, setCustomerSelectOpen] = useState(false);
  const selectedCustomer = customers?.find(c => String(c.id) === customerId);

  const applyVehicle = (
    vehicle: NonNullable<typeof customerVehicles>[number],
  ) => {
    setSelectedVehicleId(String(vehicle.vehicleId));
    const fields = serviceVehicleFields(vehicle);
    const fillVehicleField = (
      field: string,
      setter: (value: string) => void,
      value: string,
    ) => {
      if (!shouldAutofillServiceVehicleField(editedFields.current, field)) return;
      setter(value);
      autoDerivedFields.current.add(field);
    };
    fillVehicleField("vehicleInfo", setVehicleInfo, fields.vehicleInfo);
    fillVehicleField("vin", setVin, fields.vin);
    fillVehicleField("registrationNumber", setRegistrationNumber, fields.registrationNumber);
  };

  const clearAutoDerivedVehicle = () => {
    if (autoDerivedFields.current.has("vehicleInfo") && !editedFields.current.has("vehicleInfo")) {
      setVehicleInfo("");
    }
    if (autoDerivedFields.current.has("vin") && !editedFields.current.has("vin")) {
      setVin("");
    }
    if (
      autoDerivedFields.current.has("registrationNumber") &&
      !editedFields.current.has("registrationNumber")
    ) {
      setRegistrationNumber("");
    }
    autoDerivedFields.current.clear();
    setSelectedVehicleId("");
  };

  useEffect(() => {
    if (
      !open ||
      customerId === "none" ||
      !isCurrentServiceVehicleLookup({
        dialogOpen: open,
        activeCustomerId: vehicleCustomerRef.current,
        responseCustomerId: Number(customerId),
      }) ||
      !customerVehicles
    ) return;
    const savedVehicle = selectServiceCustomerVehicle(customerVehicles, {
      vin,
      registrationNumber,
    });
    // A saved VIN/registration is authoritative for edit: select the matching
    // association. Otherwise a single canonical vehicle is safe to autofill;
    // multiple vehicles must be selected explicitly.
    if (savedVehicle) {
      applyVehicle(savedVehicle);
    } else {
      setSelectedVehicleId("");
    }
  }, [customerVehicles, customerId, open]);

  const handleCustomerChange = (val: string) => {
    const isSameCustomer = val === customerId;
    if (!isSameCustomer) {
      vehicleRequestRef.current += 1;
      vehicleCustomerRef.current = val !== "none" ? Number(val) : null;
      clearAutoDerivedVehicle();
    } else if (customerVehicles?.length) {
      const savedVehicle = selectServiceCustomerVehicle(customerVehicles, {
        vin,
        registrationNumber,
      });
      if (savedVehicle) applyVehicle(savedVehicle);
    }
    setCustomerId(val);
    const fillIfUntouched = (field: string, setter: (value: string) => void, value: string) => {
      if (!editedFields.current.has(field)) setter(value);
    };
    if (val !== "none") {
      const customer = customers?.find(c => String(c.id) === val);
      if (customer) {
        fillIfUntouched("customerName", setCustomerName, customer.name ?? "");
        fillIfUntouched("customerPhoneSnapshot", setCustomerPhoneSnapshot, customer.phone ?? "");
        fillIfUntouched("customerEmail", setCustomerEmail, customer.email ?? "");
      }
    } else {
      fillIfUntouched("customerName", setCustomerName, "");
      fillIfUntouched("customerPhoneSnapshot", setCustomerPhoneSnapshot, "");
      fillIfUntouched("customerEmail", setCustomerEmail, "");
    }
    setCustomerSelectOpen(false);
  };

  const editField = <T,>(field: string, setter: (value: T) => void, value: T) => {
    editedFields.current.add(field);
    autoDerivedFields.current.delete(field);
    setter(value);
  };

  const canSubmit =
    type !== "" &&
    scheduledDate !== "" &&
    vehicleInfo.trim() !== "" &&
    !update.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    try {
      const payload: ServiceOrderUpdate = {
        type: type as ServiceOrderUpdateType,
        scheduledDate,
        vehicleInfo: vehicleInfo.trim(),
        customerId: customerId !== "none" ? Number(customerId) : null,
        customerName: customerName.trim() || null,
        customerEmail: customerEmail.trim() || null,
        customerPhoneSnapshot: customerPhoneSnapshot.trim() || null,
        vin: vin.trim() || null,
        registrationNumber: registrationNumber.trim() || null,
        complaint: complaint.trim() || null,
        odometer: odometer === "" ? null : Number(odometer),
        estimatedCost: estimatedCost === "" ? null : Number(estimatedCost),
        estimatedHours: estimatedHours === "" ? null : Number(estimatedHours),
      };

      if (technicianUserId && technicianUserId !== "none" && technicianUserId !== "auto") {
        payload.technicianUserId = Number(technicianUserId);
        const tech = technicians?.find(t => String(t.id) === technicianUserId);
        if (tech) payload.technician = tech.name;
      } else {
        payload.technicianUserId = null;
        payload.technician = null;
      }

      const updatedOrder = await update.mutateAsync({ id: order.id, data: payload });
      queryClient.invalidateQueries({ queryKey: getListServiceOrdersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListWorkshopWipQueryKey() });
      onUpdated?.(updatedOrder);
      toast({ title: "Booking updated", description: `RO #${order.id} updated successfully.` });
      setOpen(false);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Could not update booking.";
      toast({ title: "Update failed", description: msg, variant: "destructive" });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          // Invalidate any in-flight vehicle lookup before the dialog can be
          // reopened for another booking/customer.
          vehicleRequestRef.current += 1;
          vehicleCustomerRef.current = null;
          setSelectedVehicleId("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="rounded-full border-white/15 gap-1.5 text-xs h-8" aria-label={`Edit booking #${order.id}`}>
          <PenTool className="w-3.5 h-3.5" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-white/10 shrink-0">
          <DialogTitle>Edit Booking</DialogTitle>
          <DialogDescription>
            Update scheduling and details for RO #{order.id}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <form id={`edit-booking-${order.id}`} onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">

            <div className="col-span-2 space-y-1.5">
              <Label className="text-muted-foreground text-xs uppercase tracking-wider font-semibold">Customer & Vehicle</Label>
              <div className="h-px w-full bg-white/10 my-2" />
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Linked Customer</Label>
              <Popover open={customerSelectOpen} onOpenChange={setCustomerSelectOpen} modal>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={customerSelectOpen}
                    className="h-9 w-full justify-between bg-white/[0.04] border-white/10 px-3 font-normal text-sm"
                  >
                    <span className={cn("truncate", !selectedCustomer && "text-muted-foreground")}>
                      {selectedCustomer ? selectedCustomer.name : "Unlinked"}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0 w-[--radix-popover-trigger-width] max-h-none" align="start">
                  <Command>
                    <CommandInput placeholder="Search customers..." className="h-9 text-xs" />
                    <CommandList className="max-h-56">
                      <CommandEmpty>No matches.</CommandEmpty>
                      <CommandGroup>
                        <CommandItem
                          value="none"
                          onSelect={() => handleCustomerChange("none")}
                          className="text-sm"
                        >
                          <Check className={cn("mr-2 h-4 w-4", customerId === "none" ? "opacity-100" : "opacity-0")} />
                          Unlinked (None)
                        </CommandItem>
                        {customers?.map((c) => (
                          <CommandItem
                            key={c.id}
                            value={c.name}
                            onSelect={() => handleCustomerChange(String(c.id))}
                            className="text-sm"
                          >
                            <Check className={cn("mr-2 h-4 w-4", customerId === String(c.id) ? "opacity-100" : "opacity-0")} />
                            {c.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Customer Name</Label>
              <Input
                type="text"
                placeholder="Nana Adjei"
                value={customerName}
                onChange={(e) => editField("customerName", setCustomerName, e.target.value)}
                className="h-9 bg-white/[0.04]"
              />
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Contact Phone (Job Card)</Label>
              <Input
                type="tel"
                placeholder="+592..."
                value={customerPhoneSnapshot}
                onChange={(e) => editField("customerPhoneSnapshot", setCustomerPhoneSnapshot, e.target.value)}
                className="h-9 bg-white/[0.04]"
              />
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Customer Email</Label>
              <Input
                type="email"
                placeholder="customer@email.com"
                value={customerEmail}
                onChange={(e) => editField("customerEmail", setCustomerEmail, e.target.value)}
                className="h-9 bg-white/[0.04]"
              />
            </div>

            {customerId !== "none" && (
              <div className="col-span-2 space-y-1.5">
                <Label>Saved customer vehicle</Label>
                {customerVehicles === undefined ? (
                  <div className="h-9 rounded-md border border-white/10 bg-white/[0.04] px-3 flex items-center text-xs text-muted-foreground">
                    Loading saved vehicles…
                  </div>
                ) : customerVehicles.length === 0 ? (
                  <div className="rounded-md border border-dashed border-white/10 px-3 py-2 text-xs text-muted-foreground">
                    No delivered vehicles are linked to this customer. Enter the vehicle details below.
                  </div>
                ) : (
                  <Select
                    value={selectedVehicleId}
                    onValueChange={(value) => {
                      const vehicle = customerVehicles.find(
                        (candidate) => String(candidate.vehicleId) === value,
                      );
                      if (vehicle) {
                        vehicleRequestRef.current += 1;
                        applyVehicle(vehicle);
                      }
                    }}
                  >
                    <SelectTrigger className="h-9 bg-white/[0.04]">
                      <SelectValue placeholder={customerVehicles.length > 1 ? "Select a vehicle" : "Saved vehicle"} />
                    </SelectTrigger>
                    <SelectContent>
                      {customerVehicles.map((vehicle) => (
                        <SelectItem key={vehicle.vehicleId} value={String(vehicle.vehicleId)}>
                          {serviceVehicleLabel(vehicle)}{vehicle.registration ? ` · ${vehicle.registration}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Vehicle Info</Label>
              <Input
                type="text"
                required
                placeholder="2022 BMW X5"
                value={vehicleInfo}
                onChange={(e) => editField("vehicleInfo", setVehicleInfo, e.target.value)}
                className="h-9 bg-white/[0.04]"
              />
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>VIN</Label>
              <Input
                type="text"
                placeholder="Vehicle identification number"
                value={vin}
                onChange={(event) => editField("vin", setVin, event.target.value)}
                className="h-9 bg-white/[0.04]"
              />
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Registration Number</Label>
              <Input
                type="text"
                placeholder="PAB 1234"
                value={registrationNumber}
                onChange={(event) => editField("registrationNumber", setRegistrationNumber, event.target.value)}
                className="h-9 bg-white/[0.04]"
              />
            </div>

            <div className="col-span-2 space-y-1.5 mt-2">
              <Label className="text-muted-foreground text-xs uppercase tracking-wider font-semibold">Appointment</Label>
              <div className="h-px w-full bg-white/10 my-2" />
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Service Type</Label>
              <Select value={type} onValueChange={(value) => editField("type", setType, value)}>
                <SelectTrigger className="h-9 bg-white/[0.04]">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="maintenance">Maintenance</SelectItem>
                  <SelectItem value="repair">Repair</SelectItem>
                  <SelectItem value="warranty">Warranty</SelectItem>
                  <SelectItem value="recall">Recall</SelectItem>
                  <SelectItem value="inspection">Inspection</SelectItem>
                  <SelectItem value="comeback">Comeback</SelectItem>
                  <SelectItem value="unscheduled">Unscheduled</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Scheduled Date</Label>
              <Input
                type="date"
                required
                value={scheduledDate}
                onChange={(e) => editField("scheduledDate", setScheduledDate, e.target.value)}
                className="h-9 bg-white/[0.04]"
              />
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Odometer (km)</Label>
              <Input
                type="number"
                placeholder="0"
                value={odometer}
                onChange={(e) => editField("odometer", setOdometer, e.target.value)}
                className="h-9 bg-white/[0.04]"
              />
            </div>

            <div className="col-span-2 space-y-1.5 mt-2">
              <Label className="text-muted-foreground text-xs uppercase tracking-wider font-semibold">Workshop Assignment</Label>
              <div className="h-px w-full bg-white/10 my-2" />
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Estimated Cost</Label>
              <Input
                type="number"
                placeholder="0"
                value={estimatedCost}
                onChange={(e) => editField("estimatedCost", setEstimatedCost, e.target.value)}
                className="h-9 bg-white/[0.04]"
              />
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Booked Hours</Label>
              <Input
                type="number"
                step="0.1"
                placeholder="e.g. 2.5"
                value={estimatedHours}
                onChange={(e) => editField("estimatedHours", setEstimatedHours, e.target.value)}
                className="h-9 bg-white/[0.04]"
              />
            </div>

            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label>Technician</Label>
              <Select
                value={technicianUserId}
                onValueChange={(value) => editField("technicianUserId", setTechnicianUserId, value)}
              >
                <SelectTrigger className="h-9 bg-white/[0.04]">
                  <SelectValue placeholder="Select technician" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {technicians?.map(t => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="col-span-2 space-y-1.5">
              <Label>Complaint</Label>
              <Textarea
                placeholder="Customer complaint..."
                rows={3}
                value={complaint}
                onChange={(e) => editField("complaint", setComplaint, e.target.value)}
                className="bg-white/[0.04] resize-none"
              />
            </div>

          </form>
        </div>

        <DialogFooter className="px-6 py-4 border-t border-white/10 shrink-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={`edit-booking-${order.id}`}
            disabled={!canSubmit}
            className="bg-primary hover:bg-primary/90 text-white gap-2"
          >
            {update.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
                queryClient.invalidateQueries({ queryKey: getListWorkshopWipQueryKey() });
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

function BookingDetailsDialog({
  order,
  open,
  onOpenChange,
  onOrderUpdated,
}: {
  order: ServiceOrder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOrderUpdated?: (order: ServiceOrder) => void;
}) {
  const money = useMoney();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const remind = useSendServiceReminder();
  const { data: csatReviews } = useListReviews({ source: "service_csat" });
  const review = order
    ? csatReviews?.find(
        (candidate) =>
          candidate.refType === "service_order" &&
          candidate.refId === order.id,
      )
    : undefined;
  if (!order) return null;

  const confirmed = order.status === "acknowledged";
  const effectiveEmail = order.customerEmail?.trim() || "";
  const effectivePhone = order.customerPhoneSnapshot?.trim() || "";
  const reminderRecipient = confirmed ? effectivePhone : effectiveEmail;
  const reminderDisabledReason = confirmed
    ? effectivePhone
      ? `Queue the approved WhatsApp appointment confirmation to ${effectivePhone}`
      : "Cannot send a WhatsApp reminder: this customer has no phone on file"
    : effectiveEmail
      ? `Send an email reminder to ${effectiveEmail}`
      : "Cannot send a reminder: this customer has no email on file";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            RO #{order.id.toString().padStart(5, "0")}
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
              {order.status.replace(/_/g, " ")}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {order.vehicleInfo}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Customer
              </div>
              <div className="font-medium text-sm">
                {order.customerId ? (
                  <Link
                    href={`/customers/${order.customerId}`}
                    className="text-primary hover:underline"
                    onClick={() => onOpenChange(false)}
                  >
                    {order.customerName || "Unknown"}
                  </Link>
                ) : (
                  <span>{order.customerName || "Unknown"}</span>
                )}
              </div>
              {order.customerPhoneSnapshot && (
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                  <Phone className="w-3 h-3" /> {order.customerPhoneSnapshot}
                </div>
              )}
            </div>

            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Scheduled
              </div>
              <div className="font-medium text-sm">
                {formatCalendarDateShort(order.scheduledDate)}
              </div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mt-3 mb-1">
                Booking created
              </div>
              <div className="font-medium text-xs text-muted-foreground">
                {formatDealerDayTime(order.createdAt)}
                {" · "}
                {order.createdByName?.trim() ||
                  (order.createdOrigin === "import"
                    ? "Imported record"
                    : order.createdOrigin === "system"
                      ? "System"
                      : order.createdOrigin === "staff"
                        ? "Staff member not recorded"
                        : "Legacy creator unknown")}
                {" · "}
                {(order.createdOrigin ?? "legacy_unknown").replace(/_/g, " ")}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Service Type
              </div>
              <div className="font-medium text-sm capitalize">
                {order.type}
              </div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mt-3 mb-1">
                Pay Type
              </div>
              <div className="font-medium text-sm">
                {order.payType ? (PAY_TYPE_LABEL[order.payType] ?? order.payType) : "—"}
              </div>
            </div>

            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Technician
              </div>
              <div className="font-medium text-sm">
                {order.technician || <span className="text-muted-foreground italic">Unassigned</span>}
              </div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mt-3 mb-1">
                Odometer
              </div>
              <div className="font-medium text-sm">
                {order.odometer != null ? `${order.odometer.toLocaleString()} km` : "—"}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 bg-foreground/[0.02] p-4 rounded-xl border border-white/5">
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Est. Total
              </div>
              <div className="font-medium text-lg tracking-tight text-primary">
                {money.gyd(order.estimatedCost)}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Est. Hours
              </div>
              <div className="font-medium text-sm">
                {order.estimatedHours ? `${order.estimatedHours}h` : "—"}
              </div>
            </div>
          </div>

          {(order.jobs?.length > 0 || order.complaint) && (
            <div className="space-y-4 border-t border-white/10 pt-4">
              {order.jobs?.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-2">
                    Requested Jobs
                  </div>
                  <ul className="list-disc list-inside text-sm space-y-1 pl-4">
                    {order.jobs.map((job, i) => (
                      <li key={i} className="text-foreground/90">{job}</li>
                    ))}
                  </ul>
                </div>
              )}
              {order.complaint && (
                <div>
                  <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-2">
                    Customer Complaint / Notes
                  </div>
                  <div className="text-sm bg-white/[0.04] p-3 rounded-lg border border-white/5 whitespace-pre-wrap">
                    {order.complaint}
                  </div>
                </div>
              )}
            </div>
          )}

          {order.stageHistory && order.stageHistory.length > 0 && (
            <div className="border-t border-white/10 pt-4">
              <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-3">
                Stage History
              </div>
              <div className="space-y-4">
                {order.stageHistory.map((ev, i) => (
                  <div key={i} className="text-sm pl-2 border-l-2 border-white/10">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium">{ev.byName}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDealerDayTime(new Date(ev.at))}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mb-1">
                      Moved from <span className="capitalize text-foreground/80">{ev.from.replace(/_/g, " ")}</span> to <span className="capitalize text-foreground/80">{ev.to.replace(/_/g, " ")}</span>
                    </div>
                    {ev.justification && (
                      <div className="text-xs bg-white/5 p-2 rounded italic">
                        "{ev.justification}"
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <BookingOnboardingMedia orderId={order.id} />
        </div>
        <DialogFooter className="flex flex-wrap gap-2 border-t border-white/10 pt-4 sm:justify-start">
          {order.status === "open" && (
            <ConfirmAppointmentButton order={order} />
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={remind.isPending || !reminderRecipient}
            title={reminderDisabledReason}
            aria-label={
              reminderRecipient
                ? `Remind ${reminderRecipient}`
                : reminderDisabledReason
            }
            className="rounded-full border-white/15 gap-1.5 text-xs h-8"
            onClick={async () => {
              if (!reminderRecipient) return;
              try {
                const result = await remind.mutateAsync({ id: order.id });
                if (confirmed) {
                  await queryClient.invalidateQueries({
                    queryKey: getGetServiceAppointmentConfirmationDeliveryQueryKey(order.id),
                  });
                }
                const wasSent = result.status === "sent";
                toast({
                  title: wasSent ? "Reminder sent" : "Reminder queued",
                  description: confirmed
                    ? `WhatsApp appointment confirmation ${wasSent ? "sent" : "queued"} to ${result.recipient}.`
                    : `Email reminder queued to ${result.recipient}.`,
                });
              } catch (error: unknown) {
                const message =
                  (
                    error as {
                      response?: { data?: { error?: string } };
                    }
                  )?.response?.data?.error ?? "Could not send reminder.";
                toast({
                  title: "Reminder failed",
                  description: message,
                  variant: "destructive",
                });
              }
            }}
          >
            {confirmed ? (
              <MessageSquare className="w-3.5 h-3.5" />
            ) : (
              <Mail className="w-3.5 h-3.5" />
            )}{" "}
            Remind
          </Button>
          {confirmed && <AppointmentConfirmationDelivery orderId={order.id} />}
          <SelfOnboardButton order={order} />
          <AdvanceAndFeedback order={order} review={review} />
          <OpenCaseButton
            customerId={order.customerId ?? null}
            customerName={order.customerName ?? null}
            refId={order.id}
            contextLabel={`RO #${order.id.toString().padStart(5, "0")} — ${order.vehicleInfo}`}
          />
          <EditBookingDialog order={order} onUpdated={onOrderUpdated} />
          <DeleteOrderButton order={order} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BookingsTab() {
  const [selectedOrder, setSelectedOrder] = useState<ServiceOrder | null>(null);
  const [fromStr, setFromStr] = useState("");
  const [toStr, setToStr] = useState("");

  const { data: orders, isLoading } = useListServiceOrders({
    ...(fromStr ? { from: fromStr } : {}),
    ...(toStr ? { to: toStr } : {}),
  });
  const { density, setDensity, layout, setLayout } = useViewMode("service");
  const focusOrderId = useFocusParam("order");
  const bookingsPager = useListPagination(
    orders ?? [],
    `${fromStr}|${toStr}|${layout}`,
  );
  const focusedOrderIndex =
    focusOrderId == null ? -1 : (orders ?? []).findIndex((order) => order.id === focusOrderId);
  const focusedOrderPage =
    focusedOrderIndex < 0 ? null : Math.floor(focusedOrderIndex / bookingsPager.pageSize) + 1;
  const focusHandledRef = useRef<string | null>(null);

  useEffect(() => {
    if (focusOrderId == null) {
      focusHandledRef.current = null;
      return;
    }
    if (focusedOrderPage == null) return;

    // Do not depend on the pager callback (it is intentionally recreated by
    // the hook). Remembering this focus/page-size pair also leaves subsequent
    // Next/Previous navigation under the user's control.
    const focusKey = `${focusOrderId}:${bookingsPager.pageSize}`;
    if (focusHandledRef.current === focusKey) return;
    focusHandledRef.current = focusKey;
    if (bookingsPager.page !== focusedOrderPage) {
      bookingsPager.onPageChange(focusedOrderPage);
    }
  }, [focusOrderId, focusedOrderPage, bookingsPager.pageSize]);

  const isFocused = useFocusHighlight(
    focusOrderId,
    "service-order",
    focusedOrderIndex >= 0 && bookingsPager.items.some((order) => order.id === focusOrderId),
  );

  return (
    <>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 bg-white/5 rounded-full px-3 py-1.5 border border-white/10 text-sm">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <Input
            type="date"
            value={fromStr}
            onChange={(event) => setFromStr(event.target.value)}
            className="w-auto h-7 border-none bg-transparent shadow-none p-0 focus-visible:ring-0 text-xs"
            data-testid="input-filter-from"
          />
          <span className="text-muted-foreground">to</span>
          <Input
            type="date"
            value={toStr}
            onChange={(event) => setToStr(event.target.value)}
            className="w-auto h-7 border-none bg-transparent shadow-none p-0 focus-visible:ring-0 text-xs"
            data-testid="input-filter-to"
          />
          {(fromStr || toStr) && (
            <button
              type="button"
              onClick={() => {
                setFromStr("");
                setToStr("");
              }}
              className="text-muted-foreground hover:text-foreground ml-1"
              data-testid="button-clear-date-filter"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {!isLoading && orders?.length !== 0 && layout === "list" ? (
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
                <th className="px-4 py-3 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {bookingsPager.items.map((order) => (
                <tr
                  key={order.id}
                  id={`service-order-${order.id}`}
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('button, a, input, select, textarea, [role="button"]') !== null && target.closest('button, a, input, select, textarea, [role="button"]') !== e.currentTarget) return;
                    setSelectedOrder(order);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedOrder(order);
                    }
                  }}
                  className={`border-b border-white/5 hover:bg-foreground/[0.03] transition-colors focus-visible:outline-none focus-visible:bg-foreground/[0.03] cursor-pointer ${
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
                    {formatCalendarDateShort(order.scheduledDate)}
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
                  <td className="px-4 py-2 text-right">
                    {order.status === "open" && <ConfirmAppointmentButton order={order} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {isLoading ? (
            [...Array(4)].map((_, i) => (
              <div key={i} className="h-24 bg-white/[0.05] rounded-2xl animate-pulse" />
            ))
          ) : !orders?.length ? (
            <EmptyState icon={Calendar} text="No bookings yet. Book the first service." />
          ) : (
            bookingsPager.items.map((order) => (
              <div
                key={order.id}
                id={`service-order-${order.id}`}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  const target = e.target as HTMLElement;
                  if (target.closest('button, a, input, select, textarea, [role="button"]') !== null && target.closest('button, a, input, select, textarea, [role="button"]') !== e.currentTarget) return;
                  setSelectedOrder(order);
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedOrder(order);
                  }
                }}
                className={`group relative overflow-hidden bg-white/[0.035] hover:bg-white/[0.065] hover:-translate-y-0.5 hover:shadow-lg transition-all border border-white/10 rounded-2xl cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  isFocused(order.id) ? "bg-primary/10 ring-1 ring-inset ring-primary/50" : ""
                }`}
              >
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 w-1",
                    order.status === "in_progress"
                      ? "bg-primary"
                      : order.status === "resolved" || order.status === "closed"
                        ? "bg-foreground/30"
                        : "bg-primary/45",
                  )}
                />
                <div className="p-4 pl-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary">
                          Repair order
                        </span>
                        <span className="text-sm font-semibold tabular-nums">
                          #{order.id.toString().padStart(5, "0")}
                        </span>
                      </div>
                      <h3 className="mt-0.5 truncate text-base font-semibold tracking-tight text-foreground group-hover:text-primary transition-colors">
                        {order.vehicleInfo}
                      </h3>
                    </div>
                    <Badge
                      variant="secondary"
                      className={cn(
                        "px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border-none shrink-0",
                        order.status === "in_progress"
                          ? "bg-primary/15 text-primary"
                          : order.status === "resolved" || order.status === "closed"
                            ? "bg-foreground/[0.07] text-muted-foreground"
                            : "bg-primary/10 text-primary",
                      )}
                    >
                      {order.status.replace(/_/g, " ")}
                    </Badge>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="col-span-2 min-w-0 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        <User className="h-3.5 w-3.5" /> Customer
                      </div>
                      <div className="mt-1 break-words text-sm font-medium">
                        {order.customerName || "Unknown customer"}
                      </div>
                      <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                        <div className="flex min-w-0 items-start gap-1.5">
                          <Phone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span className="break-all">
                            <span className="sr-only">Phone: </span>
                            {order.customerPhoneSnapshot?.trim() || "Phone not recorded"}
                          </span>
                        </div>
                        <div className="flex min-w-0 items-start gap-1.5">
                          <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span className="break-all">
                            <span className="sr-only">Email: </span>
                            {order.customerEmail?.trim() || "Email not recorded"}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        <Calendar className="h-3.5 w-3.5" /> Appointment
                      </div>
                      <div className="mt-1 text-sm font-medium">
                        {formatCalendarDateShort(order.scheduledDate)}
                      </div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        <CarFront className="h-3.5 w-3.5" /> Registration
                      </div>
                      <div className="mt-1 truncate text-sm font-medium">
                        {order.registrationNumber || "Not recorded"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5">
                      <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Service plan
                      </div>
                      <div className="mt-1 truncate text-sm font-medium capitalize">
                        {order.type.replace(/_/g, " ")}
                        {order.estimatedHours ? ` · ${order.estimatedHours}h` : ""}
                      </div>
                    </div>
                    <div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5">
                      <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        VIN
                      </div>
                      <div className="mt-1 break-all font-mono text-sm font-medium">
                        {order.vin?.trim() || "Not recorded"}
                      </div>
                    </div>
                    <div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2.5">
                      <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Booking provenance
                      </div>
                      <div className="mt-1 truncate text-sm font-medium">
                        {order.createdByName?.trim() ??
                          (order.createdOrigin === "import"
                            ? "Imported record"
                            : order.createdOrigin === "system"
                              ? "System"
                              : order.createdOrigin === "staff"
                                ? "Staff member not recorded"
                                : "Legacy creator unknown")}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {formatDealerDayTime(order.createdAt)} · {(order.createdOrigin ?? "legacy_unknown").replace(/_/g, " ")}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-col gap-2.5 border-t border-white/10 pt-3 xl:flex-row xl:items-end xl:justify-between">
                    <div className="min-w-0">
                      <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Service concern
                      </div>
                      <p className="mt-0.5 line-clamp-1 text-sm text-foreground/80">
                        {order.complaint || order.jobs.join(", ") || "No concern recorded"}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {order.customerId && (
                        <Button asChild size="sm" variant="ghost" className="h-8 rounded-full px-3 text-xs">
                          <Link
                            href={`/customers/${order.customerId}`}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <User className="mr-1.5 h-3.5 w-3.5" />
                            Customer
                          </Link>
                        </Button>
                      )}
                      {order.status === "open" && <ConfirmAppointmentButton order={order} />}
                      <Button
                        size="sm"
                        variant={order.status === "open" ? "outline" : "default"}
                        className="h-8 rounded-full px-3 text-xs"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedOrder(order);
                        }}
                      >
                        Open booking
                        <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
      {!isLoading && !!orders?.length && (
        <ListPagination {...bookingsPager} label="bookings" />
      )}
    </div>

    <BookingDetailsDialog
      order={selectedOrder}
      open={!!selectedOrder}
      onOpenChange={(open) => !open && setSelectedOrder(null)}
      onOrderUpdated={setSelectedOrder}
    />
    </>
  );
}

function ConfirmAppointmentButton({ order }: { order: ServiceOrder }) {
  const confirm = useConfirmServiceAppointment();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const initialDate =
    typeof order.scheduledDate === "string"
      ? order.scheduledDate.slice(0, 10)
      : new Date(order.scheduledDate).toISOString().slice(0, 10);
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState("09:00");

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="rounded-full bg-primary hover:bg-primary/90 text-primary-foreground text-xs gap-1.5 h-8"
          disabled={confirm.isPending}
        >
          {confirm.isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5" />
          )}
          Confirm appointment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set appointment date & time</DialogTitle>
          <DialogDescription>
            This marks RO #{order.id.toString().padStart(5, "0")} as confirmed.
            Use the Remind button afterward to send the approved WhatsApp
            appointment confirmation; no message is sent by this action.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor={`confirm-date-${order.id}`}>Appointment date</Label>
            <Input
              id={`confirm-date-${order.id}`}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`confirm-time-${order.id}`}>Arrival time</Label>
            <Input
              id={`confirm-time-${order.id}`}
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={confirm.isPending || !date || !time}
            onClick={async () => {
              try {
                const result = await confirm.mutateAsync({
                  id: order.id,
                  data: { date, time },
                });
                await queryClient.invalidateQueries({
                  queryKey: getListServiceOrdersQueryKey(),
                });
                toast({
                  title: "Appointment confirmed",
                  description:
                    "No customer message was sent. Use Remind to queue the approved WhatsApp confirmation.",
                });
              } catch (error: unknown) {
                const message =
                  (error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                  "Could not confirm the appointment.";
                toast({
                  title: "Confirmation blocked",
                  description: message,
                  variant: "destructive",
                });
              }
            }}
          >
            {confirm.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Confirm & send email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const APPOINTMENT_DELIVERY_LABEL: Record<string, string> = {
  not_queued: "Not queued",
  queued: "Queued — waiting for provider",
  accepted: "Provider accepted",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  cancelled: "Not sent",
};

function AppointmentConfirmationDelivery({ orderId }: { orderId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const delivery = useGetServiceAppointmentConfirmationDelivery(orderId, {
    query: {
      queryKey: getGetServiceAppointmentConfirmationDeliveryQueryKey(orderId),
      refetchInterval: 10_000,
    },
  });
  const retry = useRetryServiceAppointmentConfirmation();
  const state = delivery.data;

  if (delivery.isLoading || !state || state.state === "not_queued") return null;
  const failed = state.state === "failed" || state.state === "cancelled";

  return (
    <div className="basis-full rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              failed ? "text-destructive" : "text-primary",
            )}
          />
          <div>
            <div className="text-xs font-medium">
              WhatsApp confirmation: {APPOINTMENT_DELIVERY_LABEL[state.state] ?? state.state}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {state.state === "accepted"
                ? "Meta accepted this message; delivery receipt is still pending."
                : state.recipient
                  ? `To ${state.recipient}`
                  : "No customer message has been queued."}
              {state.attempts > 0 ? ` · ${state.attempts} attempt${state.attempts === 1 ? "" : "s"}` : ""}
            </div>
          </div>
        </div>
        {state.canRetry && (
          <Button
            size="sm"
            variant="outline"
            disabled={retry.isPending}
            className="h-7 rounded-full px-2.5 text-xs"
            onClick={async () => {
              try {
                await retry.mutateAsync({ id: orderId });
                await queryClient.invalidateQueries({
                  queryKey: getGetServiceAppointmentConfirmationDeliveryQueryKey(orderId),
                });
                toast({
                  title: "One retry queued",
                  description:
                    "The confirmation will be revalidated before its single provider retry.",
                });
              } catch (error: unknown) {
                const message =
                  (error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                  "This confirmation could not be retried safely.";
                toast({ title: "Retry blocked", description: message, variant: "destructive" });
              }
            }}
          >
            {retry.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Retry once
          </Button>
        )}
      </div>
      {failed && state.lastError && (
        <p className="mt-2 break-words text-xs text-destructive/90">{state.lastError}</p>
      )}
    </div>
  );
}

function BookingOnboardingMedia({ orderId }: { orderId: number }) {
  const { data: media, isLoading } = useListServiceOrderOnboardingMedia(orderId);

  return (
    <div className="border-t border-white/10 pt-4">
      <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-3">
        Customer self-onboarding uploads
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading uploads…
        </div>
      ) : !media?.length ? (
        <div className="text-sm text-muted-foreground rounded-xl border border-dashed border-white/10 p-4 text-center">
          No customer photos or videos uploaded for this booking.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {media.map((item) => {
            const src = `/api/service-orders/${orderId}/onboarding-media/${item.id}`;
            return (
              <a
                key={item.id}
                href={src}
                target="_blank"
                rel="noreferrer"
                className="group overflow-hidden rounded-xl border border-white/10 bg-black/20"
                title={item.fileName}
              >
                {item.kind === "image" ? (
                  <img
                    src={src}
                    alt={item.fileName}
                    className="aspect-video w-full object-cover transition-transform group-hover:scale-[1.02]"
                  />
                ) : (
                  <video
                    src={src}
                    controls
                    preload="metadata"
                    className="aspect-video w-full object-cover"
                    onClick={(event) => event.stopPropagation()}
                  />
                )}
                <div className="truncate px-2.5 py-2 text-xs text-muted-foreground">
                  {item.fileName}
                </div>
              </a>
            );
          })}
        </div>
      )}
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
        { name: "laborRate", label: "Custom labour rate (GYD/hr, optional)", type: "number", span: "half", placeholder: "Uses current dealer rate" },
        { name: "checklistText", label: "Checklist (one item per line)", type: "textarea", span: "full", placeholder: "Inspect pads\nReplace rotors\nRoad test" },
        { name: "notes", label: "Notes", type: "textarea", span: "full" },
        {
          name: "customerPhoneSnapshot",
          label: "Customer phone for this job (optional override)",
          type: "phone",
          span: "half",
          placeholder: "Prefilled from the linked customer if blank",
        },
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
            ...(v.customerPhoneSnapshot
              ? { customerPhoneSnapshot: String(v.customerPhoneSnapshot) }
              : {}),
          } as never,
        });
        queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListWorkshopWipQueryKey() });
        toast({ title: "Job card opened", description: "Technician has been notified." });
      }}
    />
  );
}

function JobCardsTab() {
  const { data: cards, isLoading } = useListJobCards();
  const { data: orders, isLoading: ordersLoading } = useListServiceOrders();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [wipTech, setWipTech] = useState("all");
  const [wipAge, setWipAge] = useState("all");
  const [wipReason, setWipReason] = useState("all");
  const [wipFollowUp, setWipFollowUp] = useState("all");
  const [wipCarryOver, setWipCarryOver] = useState("all");
  const { data: technicians } = useListServiceTechnicians();
  const { data: wip, isLoading: wipLoading } = useListWorkshopWip({
    ...(wipTech !== "all" ? { technicianUserId: Number(wipTech) } : {}),
    ...(wipAge !== "all" ? { minAgeDays: Number(wipAge) } : {}),
    ...(isWaitingReason(wipReason) ? { waitingReason: wipReason } : {}),
    ...(isWipFollowUpFilter(wipFollowUp) ? { followUp: wipFollowUp } : {}),
    ...(isCarryOverFilter(wipCarryOver) ? { carryOver: wipCarryOver } : {}),
  });

  const ordersById = new Map((orders ?? []).map((order) => [order.id, order]));
  const normalizedSearch = search.trim().toLowerCase();
  const filteredCards = (cards ?? []).filter((card) => {
    const order = ordersById.get(card.serviceOrderId);
    const scheduledKey = order?.scheduledDate
      ? String(order.scheduledDate).slice(0, 10)
      : null;
    if (fromDate && (!scheduledKey || scheduledKey < fromDate)) return false;
    if (toDate && (!scheduledKey || scheduledKey > toDate)) return false;
    if (status !== "all" && card.status !== status) return false;
    if (!normalizedSearch) return true;
    return [
      card.title,
      String(card.id),
      String(card.serviceOrderId),
      card.technicianName,
      order?.customerName,
      order?.vehicleInfo,
      order?.vin,
      order?.registrationNumber,
    ].some((value) => value?.toLowerCase().includes(normalizedSearch));
  });
  const jobCardsPager = useListPagination(
    filteredCards,
    `${search}|${fromDate}|${toDate}|${status}`,
  );

  if (isLoading || ordersLoading)
    return (
      <div className="grid gap-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-32 bg-white/[0.05] rounded-2xl animate-pulse" />
        ))}
      </div>
    );

  if (!cards?.length)
    return <EmptyState icon={ClipboardList} text="No job cards yet. Open one from a booking." />;

  const hasFilters = Boolean(fromDate || toDate || search.trim() || status !== "all");

  return (
    <div className="space-y-4">
      <WorkshopWipPanel
        rows={wip ?? []}
        loading={wipLoading}
        technicians={technicians ?? []}
        technician={wipTech}
        age={wipAge}
        reason={wipReason}
        followUp={wipFollowUp}
        carryOver={wipCarryOver}
        onTechnician={setWipTech}
        onAge={setWipAge}
        onReason={setWipReason}
        onFollowUp={setWipFollowUp}
        onCarryOver={setWipCarryOver}
      />
      <Card className="glass-panel border-white/10 rounded-2xl">
        <CardContent className="p-4">
          <div className="grid items-end gap-3 md:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_170px_170px_180px_auto]">
            <div className="space-y-1">
              <Label htmlFor="job-card-search" className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Search
              </Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="job-card-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Customer, model, VIN, registration or job…"
                  className="pl-9"
                  data-testid="input-job-card-search"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="job-cards-from" className="text-[10px] uppercase tracking-widest text-muted-foreground">
                From
              </Label>
              <Input
                id="job-cards-from"
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(event) => setFromDate(event.target.value)}
                aria-label="Job cards from date"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="job-cards-to" className="text-[10px] uppercase tracking-widest text-muted-foreground">
                To
              </Label>
              <Input
                id="job-cards-to"
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(event) => setToDate(event.target.value)}
                aria-label="Job cards to date"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Status
              </Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger aria-label="Filter job cards by status">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="on_hold">On Hold</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="outline"
              className="rounded-full"
              disabled={!hasFilters}
              onClick={() => {
                setSearch("");
                setFromDate("");
                setToDate("");
                setStatus("all");
              }}
            >
              <X className="mr-1.5 h-4 w-4" />
              Clear
            </Button>
          </div>
          <div className="mt-3 text-xs text-muted-foreground">
            Showing {filteredCards.length} of {cards.length} job cards
          </div>
        </CardContent>
      </Card>

      {filteredCards.length === 0 ? (
        <EmptyState
          icon={Search}
          text="No job cards match this date range and filter combination."
        />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {jobCardsPager.items.map((card) => (
            <Link key={card.id} href={`/service/job-cards/${card.id}`}>
              <JobCardSummary card={card} order={ordersById.get(card.serviceOrderId)} />
            </Link>
          ))}
        </div>
      )}
      {filteredCards.length > 0 && (
        <ListPagination {...jobCardsPager} label="job cards" />
      )}
    </div>
  );
}

const WAITING_REASON_LABEL: Record<string, string> = {
  ordered_parts: "Ordered parts",
  technician_availability: "Technician availability",
  diagnostics: "Diagnostics",
  escalation_verdict: "Escalation verdict",
  warranty_decision: "Warranty decision",
  customer_decision: "Customer decision",
  other: "Other",
};

function isWaitingReason(value: string): value is Exclude<JobCardWaitingReason, null> {
  return value in WAITING_REASON_LABEL;
}

function isCarryOverFilter(value: string): value is "0" | "1" {
  return value === "0" || value === "1";
}

function isWipFollowUpFilter(value: string): value is ListWorkshopWipFollowUp {
  return value === "overdue" || value === "today" || value === "upcoming" || value === "none";
}

function WorkshopWipPanel({
  rows,
  loading,
  technicians,
  technician,
  age,
  reason,
  followUp,
  carryOver,
  onTechnician,
  onAge,
  onReason,
  onFollowUp,
  onCarryOver,
}: {
  rows: WorkshopWipItem[];
  loading: boolean;
  technicians: TechnicianRef[];
  technician: string;
  age: string;
  reason: string;
  followUp: string;
  carryOver: string;
  onTechnician: (value: string) => void;
  onAge: (value: string) => void;
  onReason: (value: string) => void;
  onFollowUp: (value: string) => void;
  onCarryOver: (value: string) => void;
}) {
  const wipPager = useListPagination(
    rows,
    `${technician}|${age}|${reason}|${followUp}|${carryOver}`,
  );
  const waitingLabel = (value: string | null) =>
    value ? (WAITING_REASON_LABEL[value] ?? value.replace(/_/g, " ")) : "Working";
  const download = () => {
    const escape = (value: string | number | null) =>
      `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rowsForCsv = rows.map((row) =>
      [
        `JC #${row.id}`,
        `RO #${row.serviceOrderId}`,
        row.customerName,
        row.vehicleInfo,
        `${formatDealerDayTime(row.receivedAt)}${row.receivedSource === "legacy_started" ? " (legacy work-start record)" : ""}`,
        row.elapsedDays,
        row.carryOver ? "Yes" : "No",
        row.status.replace(/_/g, " "),
        row.technicianName ?? "Unassigned",
        waitingLabel(row.waitingReason),
        row.nextAction,
        row.followUpDate,
      ]
        .map(escape)
        .join(","),
    );
    const content = [
      "Job card,Repair order,Customer,Vehicle,Received,Elapsed days,Carry-over,Status,Responsible person,Waiting reason,Next action,Expected follow-up",
      ...rowsForCsv,
    ].join("\r\n");
    const blob = new Blob([`\ufeff${content}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "workshop-wip.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="glass-panel border-white/10 rounded-2xl overflow-hidden">
      <CardContent className="p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold uppercase tracking-widest">Workshop WIP</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Open vehicles received into the workshop. Carry-over means received before today in dealership time.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="rounded-full"
            disabled={loading || rows.length === 0}
            onClick={download}
          >
            <FileText className="mr-1.5 h-3.5 w-3.5" /> Download report
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Select value={technician} onValueChange={onTechnician}>
            <SelectTrigger aria-label="Filter WIP by technician"><SelectValue placeholder="All technicians" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All technicians</SelectItem>
              {technicians.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={age} onValueChange={onAge}>
            <SelectTrigger aria-label="Filter WIP by age"><SelectValue placeholder="Any age" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any age</SelectItem>
              <SelectItem value="1">1+ days</SelectItem>
              <SelectItem value="3">3+ days</SelectItem>
              <SelectItem value="7">7+ days</SelectItem>
            </SelectContent>
          </Select>
          <Select value={reason} onValueChange={onReason}>
            <SelectTrigger aria-label="Filter WIP by waiting reason"><SelectValue placeholder="Any waiting reason" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any waiting reason</SelectItem>
              {Object.entries(WAITING_REASON_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={carryOver} onValueChange={onCarryOver}>
            <SelectTrigger aria-label="Filter WIP carry-over"><SelectValue placeholder="All open work" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All open work</SelectItem>
              <SelectItem value="1">Carry-over only</SelectItem>
              <SelectItem value="0">Received today</SelectItem>
            </SelectContent>
          </Select>
          <Select value={followUp} onValueChange={onFollowUp}>
            <SelectTrigger aria-label="Filter WIP by follow-up"><SelectValue placeholder="All follow-ups" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All follow-ups</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
              <SelectItem value="today">Due today</SelectItem>
              <SelectItem value="upcoming">Upcoming</SelectItem>
              <SelectItem value="none">Unknown / not recorded</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {loading ? (
          <div className="h-28 animate-pulse rounded-xl bg-white/[0.04]" />
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-muted-foreground">
            No open jobs match these WIP filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-xs">
              <thead>
                <tr className="border-b border-white/10 text-left uppercase tracking-wider text-muted-foreground">
                  {["Job / Customer", "Vehicle / received", "Age", "Status", "Responsible", "Waiting reason", "Next action"].map((heading) => <th key={heading} className="px-3 py-2.5 font-semibold">{heading}</th>)}
                </tr>
              </thead>
              <tbody>
                {wipPager.items.map((row) => (
                  <tr key={row.id} className="border-b border-white/[0.05] last:border-0">
                    <td className="px-3 py-3">
                      <Link href={`/service/job-cards/${row.id}`} className="font-medium hover:text-primary">JC #{row.id} · {row.customerName ?? "Customer not recorded"}</Link>
                      <div className="mt-0.5 text-muted-foreground">RO #{row.serviceOrderId} · {row.title}</div>
                    </td>
                    <td className="px-3 py-3"><div className="font-medium">{row.vehicleInfo}</div><div className="mt-0.5 text-muted-foreground">{formatDealerDayTime(row.receivedAt)}{row.receivedSource === "legacy_started" && <span className="block text-xs">Legacy work-start record; intake time unknown</span>}</div></td>
                    <td className="px-3 py-3 whitespace-nowrap">{row.elapsedDays}d {row.carryOver && <Badge className="ml-1 border-none bg-primary/15 text-primary text-[9px]">Carry-over</Badge>}</td>
                    <td className="px-3 py-3 capitalize">{row.status.replace(/_/g, " ")}</td>
                    <td className="px-3 py-3">{row.technicianName ?? "Unassigned"}</td>
                    <td className="px-3 py-3">{waitingLabel(row.waitingReason)}</td>
                    <td className="px-3 py-3">{row.nextAction ?? "—"}{row.followUpDate && <div className="mt-0.5 text-muted-foreground">Follow up {formatGuyanaDate(row.followUpDate)}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && rows.length > 0 && (
          <ListPagination {...wipPager} label="workshop WIP jobs" />
        )}
      </CardContent>
    </Card>
  );
}

/* Client-side mirror of the server's Service Manager / Management check. */
function useIsServiceApprover() {
  const { me } = useAuthz();
  const role = me?.roleName ?? "";
  return /service manager|general manager|leadership|management|owner.?admin|admin/i.test(role);
}

/** Live worked-time readout: accumulated seconds plus the running segment. */
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

function InvoicesTab() {
  const { data: invoices, isLoading } = useListServiceInvoices();
  const invoicesPager = useListPagination(invoices ?? []);

  if (isLoading)
    return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  if (!invoices?.length)
    return <EmptyState icon={Receipt} text="No invoices yet. Complete a job card and generate one." />;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-4">
        {invoicesPager.items.map((inv) => (
          <InvoiceCard key={inv.id} inv={inv} />
        ))}
      </div>
      <ListPagination {...invoicesPager} label="invoices" />
    </div>
  );
}

function InvoiceCard({ inv }: { inv: ServiceInvoice }) {
  const update = useUpdateServiceInvoice();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const money = useMoney();
  const isApprover = useIsServiceApprover();
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paymentReference, setPaymentReference] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListServiceInvoicesQueryKey() });

  const setStatus = async (
    status: "issued" | "paid" | "void",
    payment?: { paymentMethod: "cash" | "card" | "bank_transfer" | "cheque" | "mobile_money" | "other"; paymentReference?: string },
  ) => {
    try {
      await update.mutateAsync({ id: inv.id, data: { status, ...payment } });
      invalidate();
      toast({ title: "Invoice updated", description: `Marked ${status}.` });
      return true;
    } catch (error) {
      toast({
        title: "Invoice update failed",
        description: (error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Try again.",
        variant: "destructive",
      });
      return false;
    }
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
              {inv.customerName ?? "Walk-in"} · {formatGuyanaDate(inv.createdAt)}
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
                  onClick={() => setPaymentOpen(true)}
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

        {inv.status === "paid" && inv.paymentMethod && (
          <div className="text-xs text-muted-foreground">
            Payment received by {inv.paidBy ?? "Staff"} via{" "}
            <span className="font-medium text-foreground">{inv.paymentMethod.replace(/_/g, " ")}</span>
            {inv.paymentReference && <> · Ref: {inv.paymentReference}</>}
            {inv.paidAt && <> · {formatDealerDayTime(inv.paidAt)}</>}
          </div>
        )}

        <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Acknowledge payment received</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Record how {money.gyd(inv.total)} was received before closing this invoice.
              </p>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger><SelectValue placeholder="Payment method" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="card">Card</SelectItem>
                  <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                  <SelectItem value="cheque">Cheque</SelectItem>
                  <SelectItem value="mobile_money">Mobile money</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={paymentReference}
                onChange={(event) => setPaymentReference(event.target.value)}
                placeholder="Reference / receipt number (optional)"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPaymentOpen(false)}>Cancel</Button>
              <Button
                disabled={!paymentMethod || update.isPending}
                onClick={async () => {
                  const saved = await setStatus("paid", {
                    paymentMethod: paymentMethod as "cash" | "card" | "bank_transfer" | "cheque" | "mobile_money" | "other",
                    ...(paymentReference.trim() ? { paymentReference: paymentReference.trim() } : {}),
                  });
                  if (saved) setPaymentOpen(false);
                }}
              >
                Confirm payment
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

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
              {formatDealerDateShort(inv.signedCopyFiledAt)}
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
                {formatDealerDayTime(a.at)}
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
              <> on {formatDealerDateShort(inv.discountRequestedAt)}</>
            )}
            {inv.discountReason && <> — “{inv.discountReason}”</>} · awaiting approval
          </span>
        )}
        {inv.discountStatus === "approved" && (
          <span className="text-muted-foreground">
            {money.gyd(inv.discountTotal)} approved by {inv.discountDecidedBy}
            {inv.discountDecidedAt && <> on {formatDealerDateShort(inv.discountDecidedAt)}</>}
            {" "}(requested by {inv.discountRequestedBy})
          </span>
        )}
        {inv.discountStatus === "rejected" && (
          <span className="text-muted-foreground">
            {money.gyd(inv.discountRequestedAmount ?? 0)} rejected by {inv.discountDecidedBy}
            {inv.discountDecidedAt && <> on {formatDealerDateShort(inv.discountDecidedAt)}</>}
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
  const coveragePager = useListPagination(plans ?? []);

  if (isLoading)
    return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  if (!plans?.length)
    return <EmptyState icon={ShieldCheck} text="No warranty or AMC plans recorded yet." />;

  const now = new Date();
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {coveragePager.items.map((plan) => {
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
                    {plan.customerName ?? "—"} · {formatDealerMonthYear(plan.startDate)} →{" "}
                    {formatGuyanaDate(end)}
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
      <ListPagination {...coveragePager} label="coverage plans" />
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
function SelfOnboardButton({ order }: { order: ServiceOrder }) {
  const { toast } = useToast();
  const invite = useCreateVehicleOnboardingInvite();
  const customerId = order.customerId;
  if (!customerId) return null; // Needs a linked customer
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={invite.isPending}
      className="rounded-full border-white/15 gap-1.5 text-xs h-8"
      onClick={async () => {
        try {
          await invite.mutateAsync({
            id: customerId,
            data: { serviceOrderId: order.id },
          });
          toast({ title: "Invite sent", description: `Vehicle self-onboarding email sent to ${order.customerName || "customer"}.` });
        } catch (e: unknown) {
          const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Could not send invite.";
          toast({ title: "Invite failed", description: msg, variant: "destructive" });
        }
      }}
    >
      <CarFront className="w-3.5 h-3.5" /> Self-Onboard
    </Button>
  );
}

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
          queryClient.invalidateQueries({ queryKey: getListWorkshopWipQueryKey() });
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
                queryClient.invalidateQueries({ queryKey: getListWorkshopWipQueryKey() });
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

function JobCardSummary({
  card,
  order,
  onClick,
}: {
  card: JobCard;
  order?: ServiceOrder;
  onClick?: () => void;
}) {
  const workedSeconds = workedSecondsAt(card, Date.now());
  const worked = workedSeconds > 0
    ? formatWorkedSeconds(workedSeconds)
    : "—";
  const customerName = order?.customerName ?? card.customerName ?? "Unassigned customer";
  const vehicleInfo = order?.vehicleInfo ?? card.vehicleInfo ?? "Not recorded";

  return (
    <Card className="glass-panel border-white/10 hover:bg-white/[0.04] transition-colors cursor-pointer group rounded-2xl" onClick={onClick}>
      <CardContent className="p-4 flex flex-col gap-3 relative">
        <div className="flex justify-between items-start">
          <div className="flex flex-col gap-1 min-w-0 pr-4">
            <h3 className="font-semibold text-lg tracking-tight group-hover:text-primary transition-colors truncate">
              {card.title}
            </h3>
            <p className="text-xs text-muted-foreground truncate">
              JC #{card.id} · RO #{card.serviceOrderId}
              {card.technicianName && ` · Tech: ${card.technicianName}`}
            </p>
          </div>
          <Badge variant="secondary" className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border-none bg-foreground/[0.06] text-foreground shrink-0">
            {JOB_STATUS_LABEL[card.status] ?? card.status}
          </Badge>
        </div>

        {(order || card.customerName || card.vehicleInfo) && (
          <div className="grid gap-2 rounded-xl border border-white/10 bg-white/[0.025] p-3 text-xs sm:grid-cols-2">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Customer</div>
              <div className="font-medium truncate">{customerName}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Model</div>
              <div className="font-medium truncate">{vehicleInfo}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Registration</div>
              <div className="font-medium truncate">{order?.registrationNumber || "Not recorded"}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">VIN</div>
              <div className="font-medium truncate" title={order?.vin ?? undefined}>{order?.vin || "Not recorded"}</div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-4 text-sm mt-1">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Scheduled</div>
            <div className="font-medium">
              {order?.scheduledDate ? formatCalendarDateShort(order.scheduledDate) : "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Booked</div>
            <div className="font-medium">
              {bookedHoursForCard(card) > 0 ? `${bookedHoursForCard(card)}h` : "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Worked</div>
            <div className="font-medium">{worked}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
