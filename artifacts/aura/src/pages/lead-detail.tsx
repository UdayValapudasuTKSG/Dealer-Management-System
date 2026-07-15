import { useState } from "react";
import { useRoute, Link } from "wouter";
import {
  useGetLead,
  useGetVehicle,
  useGetLeadTimeline,
  useGetLeadQuote,
  useCreateLeadNote,
  getGetLeadTimelineQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Car,
  CircleCheck,
  Compass,
  FileText,
  KeyRound,
  Loader2,
  Mail,
  MessageSquare,
  Paperclip,
  Phone,
  Send,
  User,
  Workflow,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Page } from "@/components/layout/page";
import { LeadWorkflowDialog } from "@/components/lead-workflow-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

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

const PHASE_LABEL: Record<string, string> = {
  aware: "New Lead",
  consider: "Working",
  engage: "Appointment",
  negotiate: "Desking",
  won: "Delivered",
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

const GUIDANCE: Record<string, { headline: string; steps: string[] }> = {
  new: {
    headline:
      "This is a newly captured lead. Your goal is to reach out within 24 hours.",
    steps: [
      "Review lead source and contact information.",
      "Prepare a personalized intro message.",
      "Log your first activity (call or email).",
    ],
  },
  assigned: {
    headline:
      "This lead is assigned and waiting on first contact. Reach out today.",
    steps: [
      "Call or email the customer and introduce yourself.",
      "Confirm the vehicle of interest still matches their needs.",
      "Log the outcome as a note on this record.",
    ],
  },
  contacted: {
    headline:
      "First contact is made. Keep momentum — qualify their intent and timeline.",
    steps: [
      "Confirm budget and financing preference.",
      "Understand their key interest driver.",
      "Propose a test drive or showroom visit.",
    ],
  },
  qualified: {
    headline:
      "This lead is qualified. Convert interest into a showroom appointment.",
    steps: [
      "Send the quotation if not already delivered.",
      "Book a test drive at their preferred branch.",
      "Prepare the vehicle and paperwork ahead of the visit.",
    ],
  },
  test_drive: {
    headline:
      "A test drive is in play. Make the experience flawless and capture the outcome.",
    steps: [
      "Confirm the appointment a day before.",
      "Have the exact vehicle detailed and charged/fuelled.",
      "Log drive feedback and next step immediately after.",
    ],
  },
  back_order: {
    headline:
      "The requested vehicle is on back order. Keep the customer warm.",
    steps: [
      "Share an expected availability window.",
      "Offer comparable in-stock alternatives.",
      "Schedule a follow-up reminder.",
    ],
  },
  decision: {
    headline:
      "The customer is deciding. Remove friction and desk the deal.",
    steps: [
      "Present final pricing and trade-in numbers.",
      "Resolve open objections one by one.",
      "Open F&I if financing is required.",
    ],
  },
  engaged: {
    headline:
      "Deep in negotiation. Structure terms that work for both sides.",
    steps: [
      "Align on out-the-door price.",
      "Finalize financing or payment method.",
      "Agree a delivery date.",
    ],
  },
  converted: {
    headline:
      "Converted — make delivery memorable and hand over to after-sales.",
    steps: [
      "Confirm delivery logistics with the customer.",
      "Complete documentation and registration.",
      "Introduce the service team and first-service booking.",
    ],
  },
  lost: {
    headline:
      "This lead is closed lost. Capture the reason so we learn from it.",
    steps: [
      "Record the reason for closure.",
      "Flag for a revisit in 3 months if appropriate.",
      "Keep the record clean for future re-engagement.",
    ],
  },
};

function Bool({ value }: { value: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1",
        value
          ? "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30"
          : "bg-foreground/[0.06] text-muted-foreground ring-white/10",
      )}
    >
      {value ? "True" : "False"}
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-3 border-b border-white/5 last:border-0">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
        {label}
      </div>
      <div className="text-sm text-foreground break-words">
        {children ?? <span className="text-muted-foreground/60">—</span>}
      </div>
    </div>
  );
}

const TABS = [
  { key: "details", label: "Details" },
  { key: "files", label: "Quotes & Files" },
  { key: "activity", label: "Activity" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default function LeadDetail() {
  const [, params] = useRoute("/lead/:id");
  const id = params ? Number(params.id) : NaN;
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: lead, isLoading, isError } = useGetLead(id);
  const { data: vehicle } = useGetVehicle(lead?.interestedVehicleId ?? 0, {
    query: {
      queryKey: ["lead-detail-vehicle", lead?.interestedVehicleId],
      enabled: !!lead?.interestedVehicleId,
    },
  });
  const { data: timeline } = useGetLeadTimeline(id);
  const { data: quote } = useGetLeadQuote(id);

  const [tab, setTab] = useState<Tab>("details");
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [noteText, setNoteText] = useState("");

  const createNote = useCreateLeadNote({
    mutation: {
      onSuccess: () => {
        setNoteText("");
        qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(id) });
        toast({ title: "Note posted" });
      },
      onError: () =>
        toast({ title: "Could not post note", variant: "destructive" }),
    },
  });

  if (isLoading) {
    return (
      <Page>
        <div className="flex items-center justify-center py-32">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      </Page>
    );
  }

  if (isError || !lead) {
    return (
      <Page>
        <div className="text-center py-32 space-y-4">
          <div className="text-lg font-semibold">Lead not found</div>
          <Link href="/pipeline" className="text-primary hover:underline text-sm">
            Back to Pipeline
          </Link>
        </div>
      </Page>
    );
  }

  const guidance = GUIDANCE[lead.status] ?? GUIDANCE.new;
  const quotePdfUrl = `${import.meta.env.BASE_URL}api/leads/${lead.id}/quote.pdf`;
  const testDriveScheduled = !!lead.testDriveAt;

  return (
    <Page width="wide">
      {/* Header */}
      <div className="mb-8">
        <Link
          href="/pipeline"
          className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-primary transition-colors mb-4"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Pipeline
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight truncate">
              {lead.name}
            </h1>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span className="inline-flex items-center text-[11px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2.5 py-1 rounded-full">
                {SOURCE_LABEL[lead.source] ?? lead.source}
              </span>
              <span
                className={cn(
                  "inline-flex items-center text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full ring-1",
                  PRIORITY_STYLE[lead.priority] ?? PRIORITY_STYLE.low,
                )}
              >
                {lead.priority}
              </span>
              <span className="inline-flex items-center text-[11px] font-semibold uppercase tracking-wider text-foreground/70 bg-foreground/[0.06] px-2.5 py-1 rounded-full">
                {STATUS_LABEL[lead.status] ?? lead.status}
              </span>
              <span className="inline-flex items-center text-[11px] font-semibold uppercase tracking-wider text-foreground/70 bg-foreground/[0.06] px-2.5 py-1 rounded-full">
                {PHASE_LABEL[lead.phase] ?? lead.phase}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right mr-1">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                AI Score
              </div>
              <div className="text-2xl font-light text-primary">
                {lead.aiScore}
              </div>
            </div>
            {lead.customerId && (
              <Link href={`/customers/${lead.customerId}`}>
                <Button variant="outline" className="gap-1.5">
                  Client
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </Button>
              </Link>
            )}
            <Button
              onClick={() => setWorkflowOpen(true)}
              className="gap-1.5 glow-red"
            >
              <Workflow className="w-4 h-4" />
              Workflow
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-start">
        {/* Left rail */}
        <div className="space-y-6">
          <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center">
                <KeyRound className="w-3.5 h-3.5" />
              </span>
              <span className="text-sm font-semibold tracking-tight">
                Key Fields
              </span>
            </div>
            <Field label="Lead Source">
              {SOURCE_LABEL[lead.source] ?? lead.source}
            </Field>
            <Field label="Lead Owner">
              {lead.assignedTo || (
                <span className="text-amber-400">Unassigned</span>
              )}
            </Field>
            <Field label="Phone">
              {lead.phone ? (
                <a
                  href={`tel:${lead.phone}`}
                  className="inline-flex items-center gap-1.5 hover:text-primary transition-colors"
                >
                  <Phone className="w-3.5 h-3.5 text-muted-foreground" />
                  {lead.phone}
                </a>
              ) : null}
            </Field>
            <Field label="Email">
              {lead.email ? (
                <a
                  href={`mailto:${lead.email}`}
                  className="inline-flex items-center gap-1.5 hover:text-primary transition-colors break-all"
                >
                  <Mail className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  {lead.email}
                </a>
              ) : null}
            </Field>
          </div>

          <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center">
                <Compass className="w-3.5 h-3.5" />
              </span>
              <span className="text-sm font-semibold tracking-tight">
                Guidance for Success
              </span>
            </div>
            <p className="text-sm text-foreground/90 leading-relaxed mb-3">
              {guidance.headline}
            </p>
            <ul className="space-y-2">
              {guidance.steps.map((step) => (
                <li
                  key={step}
                  className="flex items-start gap-2 text-sm text-muted-foreground"
                >
                  <CircleCheck className="w-4 h-4 text-primary/70 shrink-0 mt-0.5" />
                  {step}
                </li>
              ))}
            </ul>
          </div>

          {vehicle && (
            <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] overflow-hidden">
              <div className="h-36 bg-foreground/[0.04]">
                {vehicle.imageUrl ? (
                  <img
                    src={
                      vehicle.imageUrl.startsWith("http")
                        ? vehicle.imageUrl
                        : `${import.meta.env.BASE_URL}${vehicle.imageUrl.replace(/^\//, "")}`
                    }
                    alt={`${vehicle.make} ${vehicle.model}`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Car className="w-8 h-8 text-muted-foreground/30" />
                  </div>
                )}
              </div>
              <div className="p-4">
                <div className="font-semibold">
                  {vehicle.year} {vehicle.make} {vehicle.model}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {vehicle.trim || vehicle.variant || "Standard specification"}
                  {vehicle.exteriorColor ? ` · ${vehicle.exteriorColor}` : ""}
                </div>
                <div className="text-lg font-light text-primary mt-2">
                  ${vehicle.price.toLocaleString()}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Main column */}
        <div className="rounded-2xl border border-white/10 bg-foreground/[0.02]">
          <div className="flex items-center gap-1 border-b border-white/10 px-4 pt-3">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "relative px-4 py-2.5 text-sm font-semibold tracking-tight transition-colors",
                  tab === t.key
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground/80",
                )}
              >
                {t.label}
                {t.key === "activity" && timeline?.length ? (
                  <span className="ml-1.5 text-[10px] text-primary">
                    {timeline.length}
                  </span>
                ) : null}
                {tab === t.key && (
                  <motion.span
                    layoutId="lead-detail-tab"
                    className="absolute inset-x-2 -bottom-px h-0.5 bg-primary rounded-full"
                  />
                )}
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
              className="p-6"
            >
              {tab === "details" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10">
                  <Field label="Name">{lead.name}</Field>
                  <Field label="Retail Customer">
                    <Bool value={!!lead.customerId} />
                  </Field>
                  <Field label="Phone">{lead.phone}</Field>
                  <Field label="Email">{lead.email}</Field>
                  <Field label="Lead Source">
                    {SOURCE_LABEL[lead.source] ?? lead.source}
                  </Field>
                  <Field label="Lead Status">
                    {STATUS_LABEL[lead.status] ?? lead.status}
                  </Field>
                  <Field label="Pipeline Stage">
                    {PHASE_LABEL[lead.phase] ?? lead.phase}
                  </Field>
                  <Field label="Priority">{lead.priority}</Field>
                  <Field label="Advisor / Lead Owner">
                    {lead.assignedTo || "Unassigned"}
                  </Field>
                  <Field label="Channel">{lead.channel}</Field>
                  <Field label="Vehicle Model">
                    {vehicle
                      ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
                      : null}
                  </Field>
                  <Field label="Vehicle Version">
                    {vehicle?.trim || vehicle?.variant || lead.variant}
                  </Field>
                  <Field label="Vehicle Color">
                    {vehicle?.exteriorColor || lead.color}
                  </Field>
                  <Field label="VIN">{vehicle?.vin}</Field>
                  <Field label="Unit Price">
                    {vehicle ? `$${vehicle.price.toLocaleString()}` : null}
                  </Field>
                  <Field label="Quotation Sent">
                    <Bool value={!!quote?.sentAt} />
                  </Field>
                  <Field label="Test Drive Scheduled">
                    <Bool value={testDriveScheduled} />
                  </Field>
                  <Field label="Test Drive Date">
                    {lead.testDriveAt
                      ? new Date(lead.testDriveAt).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : null}
                  </Field>
                  <Field label="Test Drive Branch">
                    {lead.testDriveBranch}
                  </Field>
                  <Field label="Purchase Type">
                    {lead.purchaseType === "finance"
                      ? "Financing"
                      : lead.purchaseType === "cash"
                        ? "Cash"
                        : null}
                  </Field>
                  <Field label="Availability">
                    {lead.availability === "back_order"
                      ? "Back Order"
                      : lead.availability === "available"
                        ? "Available"
                        : null}
                  </Field>
                  <Field label="Preferred Branch">
                    {lead.preferredBranch}
                  </Field>
                  <Field label="Created">
                    {new Date(lead.createdAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </Field>
                  <div className="md:col-span-2">
                    <Field label="Description / Notes">{lead.notes}</Field>
                  </div>
                </div>
              )}

              {tab === "files" && (
                <div className="space-y-4">
                  {quote?.available ? (
                    <div className="flex items-center gap-4 rounded-2xl border border-white/10 bg-foreground/[0.03] p-4">
                      <span className="w-11 h-11 rounded-xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
                        <FileText className="w-5 h-5" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold truncate">
                          {quote.fileName ?? `${lead.name} - Quote.pdf`}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {quote.quoteRef}
                          {quote.vehicle ? ` · ${quote.vehicle}` : ""}
                          {quote.issuedOn ? ` · Issued ${quote.issuedOn}` : ""}
                          {" · "}
                          {quote.sentAt ? (
                            <span className="text-emerald-400">
                              Emailed{" "}
                              {new Date(quote.sentAt).toLocaleDateString()}
                            </span>
                          ) : (
                            <span className="text-amber-400">
                              Not emailed yet
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <a
                          href={quotePdfUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Button variant="outline" size="sm">
                            View
                          </Button>
                        </a>
                        <a href={quotePdfUrl} download>
                          <Button size="sm">Download</Button>
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground rounded-2xl border border-dashed border-white/10 p-6 text-center">
                      No quotation on file — add a vehicle of interest to
                      generate one.
                    </div>
                  )}

                  {lead.attachments.length > 0 && (
                    <div className="space-y-2">
                      {lead.attachments.map((a) => (
                        <a
                          key={a.url}
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-3 rounded-xl border border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06] transition-colors p-3"
                        >
                          <Paperclip className="w-4 h-4 text-muted-foreground shrink-0" />
                          <span className="text-sm truncate">{a.name}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === "activity" && (
                <div className="space-y-5">
                  <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-4">
                    <Textarea
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Post an update — call outcome, customer comment, next step…"
                      className="bg-transparent border-white/10 resize-none min-h-[72px]"
                    />
                    <div className="flex justify-end mt-3">
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={
                          !noteText.trim() || createNote.isPending
                        }
                        onClick={() =>
                          createNote.mutate({
                            id: lead.id,
                            data: { text: noteText.trim() },
                          })
                        }
                      >
                        {createNote.isPending ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Send className="w-3.5 h-3.5" />
                        )}
                        Post
                      </Button>
                    </div>
                  </div>

                  {timeline && timeline.length > 0 ? (
                    <div className="space-y-3">
                      {timeline.map((e) => (
                        <div
                          key={e.id}
                          className="flex items-start gap-3 rounded-xl border border-white/5 bg-foreground/[0.02] p-4"
                        >
                          <span
                            className={cn(
                              "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                              e.isAgent
                                ? "bg-primary/15 text-primary"
                                : "bg-foreground/[0.06] text-muted-foreground",
                            )}
                          >
                            {e.isAgent ? (
                              <Bot className="w-4 h-4" />
                            ) : e.kind === "note" ? (
                              <MessageSquare className="w-4 h-4" />
                            ) : (
                              <User className="w-4 h-4" />
                            )}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-3">
                              <span className="text-sm font-semibold truncate">
                                {e.title}
                              </span>
                              <span className="text-[11px] text-muted-foreground shrink-0">
                                {new Date(e.createdAt).toLocaleString(
                                  undefined,
                                  {
                                    dateStyle: "medium",
                                    timeStyle: "short",
                                  },
                                )}
                              </span>
                            </div>
                            {e.detail && (
                              <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap break-words">
                                {e.detail}
                              </p>
                            )}
                            <div className="text-[11px] text-muted-foreground/70 mt-1.5">
                              {e.actor}
                              {e.isAgent ? " · AI agent" : ""}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-8">
                      No activity yet.
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <LeadWorkflowDialog
        leadId={workflowOpen ? lead.id : null}
        open={workflowOpen}
        onOpenChange={setWorkflowOpen}
      />
    </Page>
  );
}
