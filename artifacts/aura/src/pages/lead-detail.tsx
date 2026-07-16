import { useState } from "react";
import { useRoute, Link } from "wouter";
import {
  useGetLead,
  useGetVehicle,
  useGetLeadTimeline,
  useGetLeadQuote,
  useCreateLeadNote,
  useUpdateLead,
  useListVehicles,
  getGetLeadQueryKey,
  getGetLeadTimelineQueryKey,
  getListLeadsQueryKey,
} from "@workspace/api-client-react";
import type { Lead, LeadUpdate, Vehicle } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Car,
  Check,
  ChevronDown,
  CircleCheck,
  Compass,
  FileText,
  KeyRound,
  Loader2,
  Mail,
  MessageSquare,
  Paperclip,
  Pencil,
  Phone,
  Send,
  User,
  Workflow,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Page } from "@/components/layout/page";
import { LeadWorkflowDialog } from "@/components/lead-workflow-dialog";
import {
  CreateRecordDialog,
  type FieldDef,
} from "@/components/create-record-dialog";
import { useAuthz } from "@/lib/auth";
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

const CHANNEL_LABEL: Record<string, string> = {
  web: "Web",
  social: "Social",
  mobile: "Mobile",
  walkin: "Walk-in",
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

type EditorSpec =
  | { kind: "text"; value: string; placeholder?: string }
  | { kind: "textarea"; value: string }
  | { kind: "date"; value: string }
  | { kind: "checkbox"; value: boolean }
  | {
      kind: "select";
      value: string;
      options: { value: string; label: string }[];
      allowEmpty?: boolean;
    };

function InlineField({
  label,
  children,
  canEdit,
  editor,
  onSave,
  full,
}: {
  label: string;
  children: React.ReactNode;
  canEdit?: boolean;
  editor?: EditorSpec;
  onSave?: (value: string | boolean) => Promise<void>;
  full?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | boolean>("");
  const [saving, setSaving] = useState(false);

  const editable = !!canEdit && !!editor && !!onSave;

  const begin = () => {
    if (!editor) return;
    setDraft(editor.value);
    setEditing(true);
  };

  const save = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch {
      // toast handled by the mutation's onError
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn(
        "group py-3 border-b border-white/5 last:border-0",
        full && "md:col-span-2",
      )}
    >
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
        {label}
      </div>
      {!editing ? (
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm text-foreground break-words min-w-0 flex-1">
            {children ?? <span className="text-muted-foreground/60">—</span>}
          </div>
          {editable && (
            <button
              onClick={begin}
              aria-label={`Edit ${label}`}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-primary shrink-0 mt-0.5"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            {editor!.kind === "text" && (
              <Input
                autoFocus
                value={draft as string}
                placeholder={editor!.placeholder}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                  if (e.key === "Escape") setEditing(false);
                }}
                className="h-9 bg-background/60 border-white/15"
              />
            )}
            {editor!.kind === "date" && (
              <Input
                autoFocus
                type="date"
                value={draft as string}
                onChange={(e) => setDraft(e.target.value)}
                className="h-9 bg-background/60 border-white/15"
              />
            )}
            {editor!.kind === "textarea" && (
              <Textarea
                autoFocus
                value={draft as string}
                onChange={(e) => setDraft(e.target.value)}
                className="bg-background/60 border-white/15 resize-none min-h-[72px]"
              />
            )}
            {editor!.kind === "checkbox" && (
              <label className="inline-flex items-center gap-2 h-9 cursor-pointer text-sm">
                <Checkbox
                  checked={draft as boolean}
                  onCheckedChange={(c) => setDraft(c === true)}
                />
                {(draft as boolean) ? "True" : "False"}
              </label>
            )}
            {editor!.kind === "select" && (
              <select
                autoFocus
                value={draft as string}
                onChange={(e) => setDraft(e.target.value)}
                className="h-9 w-full rounded-md border border-white/15 bg-background/60 px-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {editor!.allowEmpty && <option value="">—</option>}
                {editor!.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0 mt-1">
            <button
              onClick={() => void save()}
              disabled={saving}
              aria-label="Save"
              className="w-7 h-7 rounded-md bg-primary text-white flex items-center justify-center hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              aria-label="Cancel"
              className="w-7 h-7 rounded-md border border-white/15 text-muted-foreground flex items-center justify-center hover:text-foreground transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border border-white/10 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-5 py-3 bg-foreground/[0.04] text-left hover:bg-foreground/[0.06] transition-colors"
      >
        <ChevronDown
          className={cn(
            "w-4 h-4 text-primary transition-transform",
            !open && "-rotate-90",
          )}
        />
        <span className="text-sm font-semibold tracking-tight">{title}</span>
      </button>
      {open && (
        <div className="px-5 pb-2 grid grid-cols-1 md:grid-cols-2 gap-x-10">
          {children}
        </div>
      )}
    </div>
  );
}

const TABS = [
  { key: "details", label: "Details" },
  { key: "files", label: "Quotes & Files" },
  { key: "activity", label: "Activity" },
] as const;
type Tab = (typeof TABS)[number]["key"];

function editLeadFields(lead: Lead, vehicles: Vehicle[]): FieldDef[] {
  return [
    {
      name: "name",
      label: "Name",
      type: "text",
      required: true,
      span: "full",
      defaultValue: lead.name,
    },
    {
      name: "channel",
      label: "Channel",
      type: "select",
      span: "half",
      defaultValue: lead.channel,
      options: [
        { value: "web", label: "Web" },
        { value: "social", label: "Social" },
        { value: "mobile", label: "Mobile" },
        { value: "walkin", label: "Walk-in" },
      ],
    },
    {
      name: "source",
      label: "Source",
      type: "select",
      span: "half",
      defaultValue: lead.source,
      options: Object.entries(SOURCE_LABEL).map(([value, label]) => ({
        value,
        label,
      })),
    },
    {
      name: "interestedVehicleId",
      label: "Interested vehicle",
      type: "select",
      span: "full",
      defaultValue: lead.interestedVehicleId
        ? String(lead.interestedVehicleId)
        : undefined,
      options: vehicles.map((v) => ({
        value: String(v.id),
        label: `${v.year} ${v.make} ${v.model} ${v.trim || v.variant || ""} — ${v.exteriorColor}${v.vin ? ` · ${v.vin}` : ""}`,
      })),
    },
    {
      name: "priority",
      label: "Priority",
      type: "select",
      span: "half",
      defaultValue: lead.priority,
      options: [
        { value: "high", label: "High" },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
    },
    {
      name: "preferredBranch",
      label: "Preferred branch",
      type: "text",
      span: "half",
      defaultValue: lead.preferredBranch ?? undefined,
    },
    {
      name: "email",
      label: "Email",
      type: "text",
      span: "half",
      defaultValue: lead.email ?? undefined,
    },
    {
      name: "phone",
      label: "Phone",
      type: "text",
      span: "half",
      defaultValue: lead.phone ?? undefined,
    },
    {
      name: "notes",
      label: "Notes",
      type: "textarea",
      span: "full",
      defaultValue: lead.notes ?? undefined,
    },
  ];
}

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
  const [editOpen, setEditOpen] = useState(false);
  const [noteText, setNoteText] = useState("");

  const { can } = useAuthz();
  const canEdit = can("leads", "edit");
  const { data: vehicles } = useListVehicles(undefined, {
    query: {
      queryKey: ["lead-edit-vehicles"],
      enabled: canEdit,
    },
  });
  const updateLead = useUpdateLead({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetLeadQueryKey(id) });
        qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(id) });
        qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
        toast({ title: "Lead updated" });
      },
      onError: () =>
        toast({ title: "Could not update lead", variant: "destructive" }),
    },
  });

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

  const patchField = async (patch: LeadUpdate) => {
    await updateLead.mutateAsync({ id: lead.id, data: patch });
  };

  const text = (v: string | boolean) => (v as string).trim();
  const textOrNull = (v: string | boolean) => text(v) || null;

  const ownerDisplay = lead.ownerUserId ? (
    <Link
      href={`/team/${lead.ownerUserId}`}
      className="inline-flex items-center gap-1.5 text-primary hover:underline"
    >
      <User className="w-3.5 h-3.5" />
      {lead.assignedTo || `Advisor #${lead.ownerUserId}`}
      <ArrowUpRight className="w-3 h-3" />
    </Link>
  ) : lead.assignedTo ? (
    <>{lead.assignedTo}</>
  ) : (
    <span className="text-amber-400">Unassigned</span>
  );

  const vehicleLink = vehicle ? (
    <Link
      href={`/vehicle/${vehicle.id}`}
      className="inline-flex items-center gap-1.5 text-primary hover:underline"
    >
      <Car className="w-3.5 h-3.5" />
      {vehicle.year} {vehicle.make} {vehicle.model}
      <ArrowUpRight className="w-3 h-3" />
    </Link>
  ) : null;

  const vehicleOptions = (vehicles ?? []).map((v) => ({
    value: String(v.id),
    label: `${v.year} ${v.make} ${v.model} ${v.trim || v.variant || ""} — ${v.exteriorColor}${v.vin ? ` · ${v.vin}` : ""}`,
  }));

  const saveVehicle = async (v: string | boolean) => {
    const vehicleId = Number(v);
    if (!vehicleId) return;
    const patch: LeadUpdate = { interestedVehicleId: vehicleId };
    const veh = (vehicles ?? []).find((x) => x.id === vehicleId);
    if (veh) {
      const version = veh.trim || veh.variant;
      if (version) patch.variant = version;
      if (veh.exteriorColor) patch.color = veh.exteriorColor;
    }
    await patchField(patch);
  };

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
                  Account
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </Button>
              </Link>
            )}
            {canEdit && (
              <Button
                variant="outline"
                onClick={() => setEditOpen(true)}
                className="gap-1.5"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </Button>
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
            <Field label="Lead Owner">{ownerDisplay}</Field>
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
            <Link
              href={`/vehicle/${vehicle.id}`}
              className="block rounded-2xl border border-white/10 bg-foreground/[0.03] overflow-hidden hover:border-primary/40 transition-colors group"
            >
              <div className="h-36 bg-foreground/[0.04]">
                {vehicle.imageUrl ? (
                  <img
                    src={
                      vehicle.imageUrl.startsWith("http")
                        ? vehicle.imageUrl
                        : `${import.meta.env.BASE_URL}${vehicle.imageUrl.replace(/^\//, "")}`
                    }
                    alt={`${vehicle.make} ${vehicle.model}`}
                    className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Car className="w-8 h-8 text-muted-foreground/30" />
                  </div>
                )}
              </div>
              <div className="p-4">
                <div className="font-semibold flex items-center gap-1.5">
                  {vehicle.year} {vehicle.make} {vehicle.model}
                  <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {vehicle.trim || vehicle.variant || "Standard specification"}
                  {vehicle.exteriorColor ? ` · ${vehicle.exteriorColor}` : ""}
                </div>
                <div className="text-lg font-light text-primary mt-2">
                  ${vehicle.price.toLocaleString()}
                </div>
              </div>
            </Link>
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
                <div className="space-y-4">
                  <Section title="Lead Information">
                    <InlineField
                      label="Name"
                      canEdit={canEdit}
                      editor={{ kind: "text", value: lead.name }}
                      onSave={async (v) => {
                        if (!text(v)) return;
                        await patchField({ name: text(v) });
                      }}
                    >
                      {lead.name}
                    </InlineField>
                    <InlineField
                      label="Company"
                      canEdit={canEdit}
                      editor={{ kind: "text", value: lead.company ?? "" }}
                      onSave={(v) => patchField({ company: textOrNull(v) })}
                    >
                      {lead.company}
                    </InlineField>
                    <InlineField
                      label="Title"
                      canEdit={canEdit}
                      editor={{ kind: "text", value: lead.title ?? "" }}
                      onSave={(v) => patchField({ title: textOrNull(v) })}
                    >
                      {lead.title}
                    </InlineField>
                    <InlineField
                      label="Is Retail Customer"
                      canEdit={canEdit}
                      editor={{
                        kind: "checkbox",
                        value: lead.isRetailCustomer || !!lead.customerId,
                      }}
                      onSave={(v) => patchField({ isRetailCustomer: !!v })}
                    >
                      <Bool value={lead.isRetailCustomer || !!lead.customerId} />
                    </InlineField>
                    <InlineField
                      label="Phone"
                      canEdit={canEdit}
                      editor={{ kind: "text", value: lead.phone ?? "" }}
                      onSave={(v) => patchField({ phone: text(v) })}
                    >
                      {lead.phone ? (
                        <a
                          href={`tel:${lead.phone}`}
                          className="hover:text-primary transition-colors"
                        >
                          {lead.phone}
                        </a>
                      ) : null}
                    </InlineField>
                    <InlineField
                      label="Email"
                      canEdit={canEdit}
                      editor={{ kind: "text", value: lead.email ?? "" }}
                      onSave={(v) => patchField({ email: text(v) })}
                    >
                      {lead.email ? (
                        <a
                          href={`mailto:${lead.email}`}
                          className="hover:text-primary transition-colors break-all"
                        >
                          {lead.email}
                        </a>
                      ) : null}
                    </InlineField>
                    <InlineField
                      label="Lead Source"
                      canEdit={canEdit}
                      editor={{
                        kind: "select",
                        value: lead.source,
                        options: Object.entries(SOURCE_LABEL).map(
                          ([value, label]) => ({ value, label }),
                        ),
                      }}
                      onSave={(v) =>
                        patchField({ source: v as LeadUpdate["source"] })
                      }
                    >
                      {SOURCE_LABEL[lead.source] ?? lead.source}
                    </InlineField>
                    <InlineField
                      label="Channel"
                      canEdit={canEdit}
                      editor={{
                        kind: "select",
                        value: lead.channel,
                        options: Object.entries(CHANNEL_LABEL).map(
                          ([value, label]) => ({ value, label }),
                        ),
                      }}
                      onSave={(v) =>
                        patchField({ channel: v as LeadUpdate["channel"] })
                      }
                    >
                      {CHANNEL_LABEL[lead.channel] ?? lead.channel}
                    </InlineField>
                    <InlineField label="Lead Status">
                      <span className="inline-flex items-center gap-2">
                        {STATUS_LABEL[lead.status] ?? lead.status}
                        <button
                          onClick={() => setWorkflowOpen(true)}
                          className="text-[11px] text-primary hover:underline"
                        >
                          Change via Workflow
                        </button>
                      </span>
                    </InlineField>
                    <InlineField label="Pipeline Stage">
                      {PHASE_LABEL[lead.phase] ?? lead.phase}
                    </InlineField>
                    <InlineField
                      label="Priority"
                      canEdit={canEdit}
                      editor={{
                        kind: "select",
                        value: lead.priority,
                        options: [
                          { value: "high", label: "High" },
                          { value: "medium", label: "Medium" },
                          { value: "low", label: "Low" },
                        ],
                      }}
                      onSave={(v) =>
                        patchField({ priority: v as LeadUpdate["priority"] })
                      }
                    >
                      <span className="capitalize">{lead.priority}</span>
                    </InlineField>
                    <InlineField label="Lead Owner">{ownerDisplay}</InlineField>
                  </Section>

                  <Section title="Product Interest">
                    <InlineField
                      label="Interested Model"
                      canEdit={canEdit}
                      editor={{
                        kind: "select",
                        value: lead.interestedVehicleId
                          ? String(lead.interestedVehicleId)
                          : "",
                        options: vehicleOptions,
                        allowEmpty: !lead.interestedVehicleId,
                      }}
                      onSave={saveVehicle}
                    >
                      {vehicleLink}
                    </InlineField>
                    <InlineField label="Vehicle Version">
                      {vehicle?.trim || vehicle?.variant || lead.variant}
                    </InlineField>
                    <InlineField label="Vehicle Color">
                      {vehicle?.exteriorColor || lead.color}
                    </InlineField>
                    <InlineField label="VIN">
                      {vehicle?.vin ? (
                        <Link
                          href={`/vehicle/${vehicle.id}`}
                          className="font-mono text-xs tracking-wide text-primary hover:underline"
                        >
                          {vehicle.vin}
                        </Link>
                      ) : null}
                    </InlineField>
                    <InlineField label="Unit Price">
                      {vehicle ? `$${vehicle.price.toLocaleString()}` : null}
                    </InlineField>
                    <InlineField
                      label="Availability"
                      canEdit={canEdit}
                      editor={{
                        kind: "select",
                        value: lead.availability ?? "",
                        options: [
                          { value: "available", label: "Available" },
                          { value: "back_order", label: "Back Order" },
                        ],
                        allowEmpty: !lead.availability,
                      }}
                      onSave={async (v) => {
                        if (!v) return;
                        await patchField({
                          availability: v as LeadUpdate["availability"],
                        });
                      }}
                    >
                      {lead.availability === "back_order"
                        ? "Back Order"
                        : lead.availability === "available"
                          ? "Available"
                          : null}
                    </InlineField>
                    <InlineField
                      label="Purchase Type"
                      canEdit={canEdit}
                      editor={{
                        kind: "select",
                        value: lead.purchaseType ?? "",
                        options: [
                          { value: "cash", label: "Cash" },
                          { value: "finance", label: "Financing" },
                        ],
                        allowEmpty: !lead.purchaseType,
                      }}
                      onSave={async (v) => {
                        if (!v) return;
                        await patchField({
                          purchaseType: v as LeadUpdate["purchaseType"],
                        });
                      }}
                    >
                      {lead.purchaseType === "finance"
                        ? "Financing"
                        : lead.purchaseType === "cash"
                          ? "Cash"
                          : null}
                    </InlineField>
                    <InlineField
                      label="Preferred Branch"
                      canEdit={canEdit}
                      editor={{
                        kind: "text",
                        value: lead.preferredBranch ?? "",
                      }}
                      onSave={(v) => patchField({ preferredBranch: text(v) })}
                    >
                      {lead.preferredBranch}
                    </InlineField>
                  </Section>

                  <Section title="Sales Progress">
                    <InlineField
                      label="Quotation Sent"
                      canEdit={canEdit}
                      editor={{
                        kind: "checkbox",
                        value: lead.quotationSent || !!quote?.sentAt,
                      }}
                      onSave={(v) => patchField({ quotationSent: !!v })}
                    >
                      <Bool value={lead.quotationSent || !!quote?.sentAt} />
                    </InlineField>
                    <InlineField
                      label="Contacted Date"
                      canEdit={canEdit}
                      editor={{
                        kind: "date",
                        value: lead.contactedDate
                          ? new Date(lead.contactedDate)
                              .toISOString()
                              .slice(0, 10)
                          : "",
                      }}
                      onSave={(v) =>
                        patchField({
                          contactedDate: v
                            ? new Date(`${v}T12:00:00`).toISOString()
                            : null,
                        })
                      }
                    >
                      {lead.contactedDate
                        ? new Date(lead.contactedDate).toLocaleDateString(
                            undefined,
                            { dateStyle: "medium" },
                          )
                        : null}
                    </InlineField>
                    <InlineField
                      label="Reservation Fee Paid"
                      canEdit={canEdit}
                      editor={{
                        kind: "checkbox",
                        value: lead.reservationFeePaid,
                      }}
                      onSave={(v) => patchField({ reservationFeePaid: !!v })}
                    >
                      <Bool value={lead.reservationFeePaid} />
                    </InlineField>
                    <InlineField
                      label="Financing Qualified"
                      canEdit={canEdit}
                      editor={{
                        kind: "checkbox",
                        value: lead.financingQualified,
                      }}
                      onSave={(v) => patchField({ financingQualified: !!v })}
                    >
                      <Bool value={lead.financingQualified} />
                    </InlineField>
                    <InlineField
                      label="Reservation Comments"
                      canEdit={canEdit}
                      full
                      editor={{
                        kind: "textarea",
                        value: lead.reservationComments ?? "",
                      }}
                      onSave={(v) =>
                        patchField({ reservationComments: textOrNull(v) })
                      }
                    >
                      {lead.reservationComments}
                    </InlineField>
                  </Section>

                  <Section title="Test Drive">
                    <InlineField label="Test Drive Scheduled">
                      <Bool value={testDriveScheduled} />
                    </InlineField>
                    <InlineField label="Test Drive Date">
                      {lead.testDriveAt
                        ? new Date(lead.testDriveAt).toLocaleString(undefined, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })
                        : null}
                    </InlineField>
                    <InlineField label="Test Drive Branch">
                      {lead.testDriveBranch}
                    </InlineField>
                  </Section>

                  <Section title="Qualification Details">
                    <InlineField
                      label="Purchase Intent"
                      canEdit={canEdit}
                      editor={{
                        kind: "text",
                        value: lead.purchaseIntent ?? "",
                        placeholder: "e.g. Buying within 30 days",
                      }}
                      onSave={(v) =>
                        patchField({ purchaseIntent: textOrNull(v) })
                      }
                    >
                      {lead.purchaseIntent}
                    </InlineField>
                    <InlineField
                      label="Key Interest Driver"
                      canEdit={canEdit}
                      editor={{
                        kind: "text",
                        value: lead.keyInterestDriver ?? "",
                        placeholder: "e.g. Fuel economy, brand, styling",
                      }}
                      onSave={(v) =>
                        patchField({ keyInterestDriver: textOrNull(v) })
                      }
                    >
                      {lead.keyInterestDriver}
                    </InlineField>
                    <InlineField
                      label="Budget / Financing"
                      canEdit={canEdit}
                      editor={{
                        kind: "text",
                        value: lead.budgetFinancing ?? "",
                        placeholder: "e.g. $60k cash, pre-approved",
                      }}
                      onSave={(v) =>
                        patchField({ budgetFinancing: textOrNull(v) })
                      }
                    >
                      {lead.budgetFinancing}
                    </InlineField>
                  </Section>

                  <Section title="Follow-up & Closure">
                    <InlineField
                      label="Revisit in 3 Months"
                      canEdit={canEdit}
                      editor={{
                        kind: "checkbox",
                        value: lead.revisitIn3Months,
                      }}
                      onSave={(v) => patchField({ revisitIn3Months: !!v })}
                    >
                      <Bool value={lead.revisitIn3Months} />
                    </InlineField>
                    <InlineField
                      label="Closure Reason"
                      canEdit={canEdit}
                      full
                      editor={{
                        kind: "textarea",
                        value: lead.closureReason ?? "",
                      }}
                      onSave={(v) =>
                        patchField({ closureReason: textOrNull(v) })
                      }
                    >
                      {lead.closureReason}
                    </InlineField>
                  </Section>

                  <Section title="Additional Information">
                    <InlineField
                      label="Description"
                      canEdit={canEdit}
                      full
                      editor={{
                        kind: "textarea",
                        value: lead.description ?? "",
                      }}
                      onSave={(v) => patchField({ description: textOrNull(v) })}
                    >
                      {lead.description}
                    </InlineField>
                    <InlineField
                      label="Notes"
                      canEdit={canEdit}
                      full
                      editor={{ kind: "textarea", value: lead.notes ?? "" }}
                      onSave={(v) => patchField({ notes: textOrNull(v) })}
                    >
                      {lead.notes}
                    </InlineField>
                    <InlineField
                      label="Address"
                      canEdit={canEdit}
                      full
                      editor={{ kind: "textarea", value: lead.address ?? "" }}
                      onSave={(v) => patchField({ address: textOrNull(v) })}
                    >
                      {lead.address}
                    </InlineField>
                  </Section>

                  <Section title="System Information">
                    <InlineField label="Created">
                      {new Date(lead.createdAt).toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </InlineField>
                    <InlineField label="AI Score">
                      <span className="text-primary font-medium">
                        {lead.aiScore}
                      </span>
                    </InlineField>
                  </Section>
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

      {canEdit && editOpen && (
        <CreateRecordDialog
          title="Edit Lead"
          description="Update the record — changes apply immediately."
          trigger={<span />}
          open={editOpen}
          onOpenChange={setEditOpen}
          submitLabel="Save changes"
          pending={updateLead.isPending}
          fields={editLeadFields(lead, vehicles ?? [])}
          onSubmit={async (values) => {
            const payload = { ...values };
            if (payload.interestedVehicleId != null) {
              payload.interestedVehicleId = Number(payload.interestedVehicleId);
              const v = (vehicles ?? []).find(
                (x) => x.id === payload.interestedVehicleId,
              );
              if (v) {
                const version = v.trim || v.variant;
                if (version) payload.variant = version;
                if (v.exteriorColor) payload.color = v.exteriorColor;
              }
            }
            await updateLead.mutateAsync({ id: lead.id, data: payload as never });
          }}
        />
      )}
    </Page>
  );
}
