import { useState } from "react";
import { Link } from "wouter";
import {
  useListServiceOrders,
  useCreateServiceOrder,
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
  type JobCard,
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
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { Page, PageHeader } from "@/components/layout/page";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "bookings", label: "Bookings", icon: Calendar },
  { key: "jobcards", label: "Job Cards", icon: ClipboardList },
  { key: "invoices", label: "Invoices", icon: Receipt },
  { key: "coverage", label: "Warranty & AMC", icon: ShieldCheck },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const JOB_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  quality_check: "Quality Check",
  completed: "Completed",
};

export default function Service() {
  const [tab, setTab] = useState<TabKey>("bookings");

  return (
    <Page className="space-y-8">
      <PageHeader
        title="Service"
        accent="Operations"
        subtitle="Bookings, job cards, invoices and coverage — the full after-sales lane."
        action={<HeaderAction tab={tab} />}
      />

      <div className="flex items-center gap-1 border-b border-white/10 overflow-x-auto no-scrollbar">
        {TABS.map((t) => (
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
        ))}
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
          {tab === "invoices" && <InvoicesTab />}
          {tab === "coverage" && <CoverageTab />}
        </motion.div>
      </AnimatePresence>
    </Page>
  );
}

function HeaderAction({ tab }: { tab: TabKey }) {
  if (tab === "bookings") return <CreateBookingDialog />;
  if (tab === "jobcards") return <CreateJobCardDialog />;
  if (tab === "coverage") return <CreateCoverageDialog />;
  return null;
}

/* ------------------------------------------------------------------ */
/* Bookings                                                            */
/* ------------------------------------------------------------------ */

function CreateBookingDialog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createOrder = useCreateServiceOrder();
  return (
    <CreateRecordDialog
      title="Book Service"
      description="Log the complaint, schedule the bay — AURA handles the rest."
      pending={createOrder.isPending}
      submitLabel="Create booking"
      trigger={
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
          Book Service
        </Button>
      }
      fields={[
        { name: "customerName", label: "Customer", type: "text", span: "half", placeholder: "Nana Adjei" },
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
          ],
        },
        { name: "scheduledDate", label: "Scheduled date", type: "date", required: true, span: "half" },
        { name: "odometer", label: "Odometer (km)", type: "number", span: "half", placeholder: "42000" },
        { name: "estimatedCost", label: "Est. cost", type: "number", span: "half", placeholder: "0" },
      ]}
      onSubmit={async (values) => {
        const v = values as Record<string, unknown>;
        if (v.odometer != null && v.odometer !== "") v.odometer = Number(v.odometer);
        await createOrder.mutateAsync({ data: v as never });
        queryClient.invalidateQueries({ queryKey: getListServiceOrdersQueryKey() });
        toast({ title: "Booking created", description: "AURA scheduled the service bay." });
      }}
    />
  );
}

function BookingsTab() {
  const { data: orders, isLoading } = useListServiceOrders();
  const { toast } = useToast();
  const remind = useSendServiceReminder();

  return (
    <div className="grid grid-cols-1 gap-6">
      {isLoading ? (
        [...Array(4)].map((_, i) => (
          <div key={i} className="h-40 bg-white/[0.05] rounded-3xl animate-pulse" />
        ))
      ) : orders?.length === 0 ? (
        <EmptyState icon={Calendar} text="No bookings yet. Book the first service." />
      ) : (
        orders?.map((order, i) => (
          <motion.div
            key={order.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
          >
            <Card className="glass-panel border-none shadow-sm hover:shadow-xl transition-all duration-300 rounded-3xl overflow-hidden group relative">
              <div
                className={`absolute top-0 bottom-0 left-0 w-1.5 ${order.status === "completed" ? "bg-primary" : "bg-white/10"}`}
              />
              <CardContent className="p-6 md:p-7 flex flex-col md:flex-row gap-6 justify-between pl-7 md:pl-8">
                <div className="flex gap-4 items-start w-full md:w-2/5">
                  <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/10 flex items-center justify-center shrink-0 group-hover:border-primary/40 group-hover:bg-primary/10 transition-colors duration-300">
                    <Wrench className="w-[18px] h-[18px] text-muted-foreground group-hover:text-primary transition-colors duration-300" />
                  </div>
                  <div>
                    <div className="text-xs font-semibold tracking-widest text-primary mb-1 uppercase flex items-center gap-2">
                      RO #{order.id.toString().padStart(5, "0")}
                      <span className="w-1 h-1 rounded-full bg-primary" />
                      <span className="text-muted-foreground">{order.type}</span>
                    </div>
                    <h3 className="font-bold text-xl leading-tight mb-1">{order.vehicleInfo}</h3>
                    {order.complaint && (
                      <p className="text-sm text-muted-foreground italic mb-2 line-clamp-2">
                        “{order.complaint}”
                      </p>
                    )}
                    <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                      <User className="w-4 h-4" />
                      {order.customerId ? (
                        <Link
                          href={`/customers/${order.customerId}`}
                          className="text-primary hover:underline"
                        >
                          {order.customerName || "Unknown"}
                        </Link>
                      ) : (
                        <span>{order.customerName || "Unknown"}</span>
                      )}
                      {order.odometer != null && (
                        <span className="normal-case tracking-normal">
                          · {order.odometer.toLocaleString()} km
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-8 w-full md:w-3/5 items-center">
                  <div>
                    <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-1.5 mb-2">
                      <Calendar className="w-3.5 h-3.5" /> Scheduled
                    </div>
                    <div className="font-medium text-lg leading-tight">
                      {format(new Date(order.scheduledDate), "MMM d")}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-2">
                      Status
                    </div>
                    <Badge
                      variant="secondary"
                      className="px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest border-none bg-white/[0.05] text-foreground"
                    >
                      {order.status.replace("_", " ")}
                    </Badge>
                  </div>

                  <div>
                    <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-1.5 mb-2">
                      <PenTool className="w-3.5 h-3.5" /> Technician
                    </div>
                    <div className="font-medium text-lg">{order.technician || "Unassigned"}</div>
                  </div>

                  <div className="text-left md:text-right space-y-2">
                    <div>
                      <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase flex items-center justify-start md:justify-end gap-1.5 mb-1">
                        <DollarSign className="w-3.5 h-3.5" /> Est. Total
                      </div>
                      <div className="font-light text-2xl tracking-tight">
                        ${order.estimatedCost.toLocaleString()}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={remind.isPending}
                      className="rounded-full border-white/15 gap-1.5 text-xs"
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
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))
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
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
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
        { name: "laborRate", label: "Labour rate ($/hr)", type: "number", span: "half", placeholder: "120" },
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
      <div className="grid gap-6">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-48 bg-white/[0.05] rounded-3xl animate-pulse" />
        ))}
      </div>
    );

  if (!cards?.length)
    return <EmptyState icon={ClipboardList} text="No job cards yet. Open one from a booking." />;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {cards.map((card) => (
        <JobCardPanel key={card.id} card={card} />
      ))}
    </div>
  );
}

export function JobCardPanel({ card, technicianView = false }: { card: JobCard; technicianView?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateJobCard();
  const invoice = useCreateJobCardInvoice();
  const addPart = useAddJobCardPart();
  const { data: lines } = useListJobCardParts(card.id);
  const { data: parts } = useListParts();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListJobCardsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListJobCardPartsQueryKey(card.id) });
    queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
  };

  const toggleChecklist = async (idx: number) => {
    const next = card.checklist.map((c, i) => (i === idx ? { ...c, done: !c.done } : c));
    await update.mutateAsync({ id: card.id, data: { checklist: next } });
    invalidate();
  };

  const setStatus = async (status: JobCard["status"]) => {
    await update.mutateAsync({ id: card.id, data: { status } });
    invalidate();
    toast({ title: "Job card updated", description: `Status → ${JOB_STATUS_LABEL[status]}.` });
  };

  const partsTotal =
    lines?.reduce(
      (s, l) => s + l.unitPrice * l.quantity * (l.kind === "return" ? -1 : 1),
      0,
    ) ?? 0;
  const laborTotal = card.laborHours * card.laborRate;

  const NEXT: Record<string, JobCard["status"] | undefined> = {
    open: "in_progress",
    in_progress: "quality_check",
    quality_check: "completed",
  };
  const next = NEXT[card.status];

  return (
    <Card className="glass-panel border-none rounded-3xl overflow-hidden">
      <CardContent className="p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold tracking-widest text-primary uppercase mb-1">
              Job Card #{card.id} · RO #{card.serviceOrderId}
            </div>
            <h3 className="font-bold text-lg leading-tight">{card.title}</h3>
            <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
              <PenTool className="w-3.5 h-3.5" />
              {card.technicianName ?? "Unassigned"}
              <span>· {card.laborHours}h @ ${card.laborRate}/hr</span>
            </div>
          </div>
          <Badge
            variant="secondary"
            className={cn(
              "px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest border-none",
              card.status === "completed"
                ? "bg-primary/15 text-primary"
                : "bg-white/[0.05] text-foreground",
            )}
          >
            {JOB_STATUS_LABEL[card.status]}
          </Badge>
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

        <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            <span className="flex items-center gap-1.5">
              <Package className="w-3.5 h-3.5" /> Parts
            </span>
            <span>
              Parts ${partsTotal.toLocaleString()} · Labour ${laborTotal.toLocaleString()}
            </span>
          </div>
          {lines?.length ? (
            <div className="space-y-1">
              {lines.map((l) => (
                <div key={l.id} className="flex items-center justify-between text-sm">
                  <span className={cn(l.kind === "return" && "text-muted-foreground line-through")}>
                    {l.partName} × {l.quantity}
                    {l.kind === "return" && " (returned)"}
                  </span>
                  <span className="text-muted-foreground">
                    ${(l.unitPrice * l.quantity).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No parts issued.</p>
          )}
          <div className="flex gap-2 pt-1">
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
                  required: true,
                  span: "full",
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
          </div>
        </div>

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
                    description: `Total $${inv.total.toLocaleString()} (parts + labour + tax).`,
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

/* ------------------------------------------------------------------ */
/* Invoices                                                            */
/* ------------------------------------------------------------------ */

function InvoicesTab() {
  const { data: invoices, isLoading } = useListServiceInvoices();
  const update = useUpdateServiceInvoice();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  if (isLoading)
    return <div className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />;
  if (!invoices?.length)
    return <EmptyState icon={Receipt} text="No invoices yet. Complete a job card and generate one." />;

  const setStatus = async (id: number, status: "issued" | "paid" | "void") => {
    await update.mutateAsync({ id, data: { status } });
    queryClient.invalidateQueries({ queryKey: getListServiceInvoicesQueryKey() });
    toast({ title: "Invoice updated", description: `Marked ${status}.` });
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      {invoices.map((inv) => (
        <Card key={inv.id} className="glass-panel border-none rounded-3xl">
          <CardContent className="p-6 flex flex-col md:flex-row md:items-center gap-4 justify-between">
            <div>
              <div className="text-xs font-semibold tracking-widest text-primary uppercase mb-1">
                Invoice #{inv.id} · RO #{inv.serviceOrderId} · JC #{inv.jobCardId}
              </div>
              <h3 className="font-bold text-lg">{inv.vehicleInfo}</h3>
              <div className="text-sm text-muted-foreground">
                {inv.customerName ?? "Walk-in"} · {format(new Date(inv.createdAt), "MMM d, yyyy")}
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-sm text-muted-foreground text-right">
                <div>Parts ${inv.partsTotal.toLocaleString()}</div>
                <div>Labour ${inv.laborTotal.toLocaleString()}</div>
                <div>Tax ${inv.tax.toLocaleString()}</div>
              </div>
              <div className="text-right">
                <div className="font-light text-3xl tracking-tight">
                  ${inv.total.toLocaleString()}
                </div>
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
                    onClick={() => setStatus(inv.id, "paid")}
                    className="rounded-full bg-primary hover:bg-primary/90 text-white text-xs"
                  >
                    Mark Paid
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={update.isPending}
                    onClick={() => setStatus(inv.id, "void")}
                    className="rounded-full border-white/15 text-xs"
                  >
                    Void
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
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
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
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
            </CardContent>
          </Card>
        );
      })}
    </div>
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
