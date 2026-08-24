import { useEffect, useMemo, useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import {
  useGetLead,
  useListDivisions,
  useGetVehicle,
  useGetLeadTimeline,
  useGetLeadQuote,
  useCreateLeadNote,
  useUpdateLead,
  useListVehicles,
  useListDeals,
  useListInvoices,
  useListOutstandingBalances,
  useListDeliveries,
  useListLeadCalls,
  useListLeadQuotes,
  useGenerateLeadQuote,
  useRequestQuoteDiscount,
  useSendLeadQuote,
  useSendTestDriveInvite,
  useListGates,
  useCreateDeal,
  useDeleteLead,
  getListLeadQuotesQueryKey,
  getGetLeadQueryKey,
  getGetLeadTimelineQueryKey,
  getListLeadsQueryKey,
  getListDealsQueryKey,
} from "@workspace/api-client-react";
import type { Lead, LeadUpdate, Vehicle, Deal } from "@workspace/api-client-react";
import {
  DealQuickFinanceDialogs,
  DealFinanceRecords,
  openInvoicesForDeal,
} from "@/components/deal-quick-finance";
import { StageNav, type StageNavStage } from "@/components/lead/stage-nav";
import { AgentBriefPanel } from "@/components/lead/agent-brief";
import { ActionChain } from "@/components/lead/lead-cockpit";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Facebook,
  FileText,
  Banknote,
  Instagram,
  Loader2,
  Mail,
  MessageSquare,
  MoreVertical,
  Pencil,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Send,
  ShieldCheck,
  Trash2,
  User,
  ClipboardList,
  X,
  XCircle,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { DutyFiling } from "@/components/gra/duty-filing";
import { Page } from "@/components/layout/page";
import { LeadWorkflowDialog } from "@/components/lead-workflow-dialog";
import {
  CreateRecordDialog,
  type FieldDef,
} from "@/components/create-record-dialog";
import {
  DealWhatsappPanel,
  WhatsappPanel,
} from "@/components/lead/whatsapp-panel";
import {
  DocumentsCard,
  DocumentPrefillBanner,
} from "@/components/documents-card";
import { CallDialog } from "@/components/lead/call-dialog";
import { TestDriveCard } from "@/components/lead/test-drive-card";
import { useAuthz } from "@/lib/auth";
import { useMoney, formatGuyanaDate, formatGuyanaDateTime } from "@/lib/format";
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

const SOURCE_LABEL: Record<string, string> = {
  website: "Website",
  walk_in: "Walk-in",
  phone: "Phone",
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  referral: "Referral",
  gmail: "Email",
  email: "Email",
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
      "This is a newly captured lead. Your goal is to reach out within 48 hours.",
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

function KpiTile({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] px-4 py-3">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="text-lg font-semibold tracking-tight mt-1 truncate">
        {children}
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
  { key: "overview", label: "Overview" },
  { key: "details", label: "Details" },
  { key: "documents", label: "Documents" },
  { key: "correspondence", label: "Correspondence" },
  { key: "notes", label: "Notes" },
  { key: "activity", label: "Activity" },
] as const;

type Tab = (typeof TABS)[number]["key"];

const CALL_STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  no_answer: "No answer",
  busy: "Busy",
  voicemail: "Voicemail",
};

const CALL_SENTIMENT_STYLE: Record<string, string> = {
  positive: "bg-emerald-500/15 text-emerald-500 ring-emerald-500/30",
  neutral: "bg-foreground/[0.06] text-foreground/70 ring-white/15",
  negative: "bg-primary/15 text-primary ring-primary/30",
};

function formatCallDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

// Product interest is a MODEL of interest, not a physical unit — collapse
// the per-VIN inventory rows into one option per make/model/year/trim/color,
// keyed on a representative unit id (the lead's current one when it belongs
// to the group, else the best-status unit). The real VIN binds at allocation.
const MODEL_STATUS_RANK: Record<string, number> = {
  available: 0,
  in_transit: 1,
  reserved: 2,
  booked: 3,
  service: 4,
  sold: 5,
  delivered: 6,
};

function modelInterestOptions(
  vehicles: Vehicle[],
  currentId?: number | null,
): { value: string; label: string }[] {
  // Only free stock is offered — plus the currently assigned unit so the
  // select can still render its label.
  const selectable = vehicles.filter(
    (v) => v.status === "available" || v.id === currentId,
  );
  const map = new Map<string, Vehicle[]>();
  for (const v of selectable) {
    const key = `${v.make}|${v.model}|${v.year}|${v.trim ?? v.variant ?? ""}|${v.exteriorColor ?? ""}`.toLowerCase();
    const arr = map.get(key);
    if (arr) arr.push(v);
    else map.set(key, [v]);
  }
  return Array.from(map.values())
    .map((units) => {
      const rep =
        (currentId != null && units.find((u) => u.id === currentId)) ||
        [...units].sort(
          (a, b) =>
            (MODEL_STATUS_RANK[a.status] ?? 9) -
            (MODEL_STATUS_RANK[b.status] ?? 9),
        )[0];
      const label = [
        `${rep.year} ${rep.make} ${rep.model}`,
        rep.trim || rep.variant || "",
        `— ${rep.exteriorColor}`,
        units.length > 1 ? `· ${units.length} in stock` : "",
        units.length === 1 && rep.vin ? `· VIN ${rep.vin}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return { value: String(rep.id), label };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

const vehicleModelKey = (v: Vehicle) =>
  `${v.year}|${v.make}|${v.model}|${v.trim ?? v.variant ?? ""}`.toLowerCase();
const vehicleModelLabel = (v: Vehicle) =>
  [`${v.year} ${v.make} ${v.model}`, v.trim || v.variant || ""]
    .filter(Boolean)
    .join(" ");

/**
 * Cascading vehicle picker: Model → Color → Unit (VIN). Only free stock is
 * offered (plus the currently assigned unit so the dialog can show it).
 */
function VehicleSwapDialog({
  open,
  onOpenChange,
  vehicles,
  currentId,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicles: Vehicle[];
  currentId?: number | null;
  onSave: (vehicleId: number) => Promise<void>;
}) {
  const [model, setModel] = useState("");
  const [color, setColor] = useState("");
  const [unitId, setUnitId] = useState("");
  const [saving, setSaving] = useState(false);

  const selectable = useMemo(
    () =>
      vehicles.filter((v) => v.status === "available" || v.id === currentId),
    [vehicles, currentId],
  );
  const current = currentId
    ? vehicles.find((v) => v.id === currentId)
    : undefined;

  // Re-seed from the currently assigned unit each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setModel(current ? vehicleModelKey(current) : "");
    setColor(current?.exteriorColor ?? "");
    setUnitId(current ? String(current.id) : "");
    setSaving(false);
  }, [open, current]);

  const modelOptions = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const v of selectable) {
      const key = vehicleModelKey(v);
      const entry = map.get(key);
      if (entry) entry.count += v.status === "available" ? 1 : 0;
      else
        map.set(key, {
          label: vehicleModelLabel(v),
          count: v.status === "available" ? 1 : 0,
        });
    }
    return Array.from(map.entries())
      .map(([value, m]) => ({ value, label: m.label, count: m.count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [selectable]);

  const colorOptions = useMemo(() => {
    if (!model) return [];
    const map = new Map<string, number>();
    for (const v of selectable) {
      if (vehicleModelKey(v) !== model) continue;
      const c = v.exteriorColor ?? "Unspecified";
      map.set(c, (map.get(c) ?? 0) + (v.status === "available" ? 1 : 0));
    }
    return Array.from(map.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value));
  }, [selectable, model]);

  const unitOptions = useMemo(() => {
    if (!model || !color) return [];
    return selectable
      .filter(
        (v) =>
          vehicleModelKey(v) === model &&
          (v.exteriorColor ?? "Unspecified") === color,
      )
      .map((v) => ({
        value: String(v.id),
        label: [
          v.vin ? `VIN ${v.vin}` : `Unit #${v.id}`,
          v.id === currentId ? "· currently assigned" : "",
        ]
          .filter(Boolean)
          .join(" "),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [selectable, model, color, currentId]);

  const pickModel = (value: string) => {
    setModel(value);
    const colors = new Set(
      selectable
        .filter((v) => vehicleModelKey(v) === value)
        .map((v) => v.exteriorColor ?? "Unspecified"),
    );
    const onlyColor = colors.size === 1 ? [...colors][0] : "";
    setColor(onlyColor);
    setUnitId("");
    if (onlyColor) autoPickUnit(value, onlyColor);
  };

  const autoPickUnit = (m: string, c: string) => {
    const units = selectable.filter(
      (v) =>
        vehicleModelKey(v) === m && (v.exteriorColor ?? "Unspecified") === c,
    );
    if (units.length === 1) setUnitId(String(units[0].id));
  };

  const pickColor = (value: string) => {
    setColor(value);
    setUnitId("");
    autoPickUnit(model, value);
  };

  const canSave =
    !!unitId && Number(unitId) !== currentId && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(Number(unitId));
      onOpenChange(false);
    } catch {
      // toast handled by the mutation's onError
    } finally {
      setSaving(false);
    }
  };

  const selectClass =
    "h-9 w-full rounded-md border border-white/15 bg-background/60 px-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change interested vehicle</DialogTitle>
          <DialogDescription>
            Pick the model, then the color, then the exact unit. Only vehicles
            in available stock are shown.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
              Vehicle model
            </div>
            <select
              value={model}
              onChange={(e) => pickModel(e.target.value)}
              className={selectClass}
              data-testid="select-swap-model"
            >
              <option value="">Select a model…</option>
              {modelOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                  {o.count > 0 ? ` · ${o.count} in stock` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
              Color
            </div>
            <select
              value={color}
              onChange={(e) => pickColor(e.target.value)}
              disabled={!model}
              className={selectClass}
              data-testid="select-swap-color"
            >
              <option value="">Select a color…</option>
              {colorOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value}
                  {o.count > 0 ? ` · ${o.count} in stock` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
              Available unit (VIN)
            </div>
            <select
              value={unitId}
              onChange={(e) => setUnitId(e.target.value)}
              disabled={!model || !color}
              className={selectClass}
              data-testid="select-swap-unit"
            >
              <option value="">Select a unit…</option>
              {unitOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="button-swap-cancel"
          >
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave} data-testid="button-swap-save">
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Assign vehicle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
      label: "Interested model",
      type: "select",
      span: "full",
      defaultValue: lead.interestedVehicleId
        ? String(lead.interestedVehicleId)
        : undefined,
      options: modelInterestOptions(vehicles, lead.interestedVehicleId),
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
      type: "email",
      span: "half",
      defaultValue: lead.email ?? undefined,
    },
    {
      name: "phone",
      label: "Phone",
      type: "phone",
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
  const money = useMoney();

  const { data: lead, isLoading, isError, error, refetch } = useGetLead(id);
  const { data: vehicle } = useGetVehicle(lead?.interestedVehicleId ?? 0, {
    query: {
      queryKey: ["lead-detail-vehicle", lead?.interestedVehicleId],
      enabled: !!lead?.interestedVehicleId,
    },
  });
  const { data: divisions } = useListDivisions();
  const { data: timeline } = useGetLeadTimeline(id);
  const { data: quote } = useGetLeadQuote(id);
  const { data: quoteVersions } = useListLeadQuotes(id);
  const sendInvite = useSendTestDriveInvite();
  const { data: allDeals } = useListDeals();
  const { data: allInvoices } = useListInvoices();
  const { data: outstandingBalances } = useListOutstandingBalances();
  const { data: allDeliveries } = useListDeliveries();
  const { data: calls } = useListLeadCalls(id);
  const gatesQuery = useListGates();

  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t && TABS.some((x) => x.key === t) ? (t as Tab) : "overview";
  });
  const [corrView, setCorrView] = useState<"calls" | "whatsapp">("calls");
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deskOpen, setDeskOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [showDuty, setShowDuty] = useState(false);
  const [noteText, setNoteText] = useState("");
  const LOST_REASONS = [
    { value: "no_contact", label: "No contact" },
    { value: "not_interested", label: "Not interested" },
    { value: "bought_elsewhere", label: "Bought elsewhere" },
    { value: "no_budget", label: "No budget" },
    { value: "duplicate", label: "Duplicate" },
  ];
  const [lostOpen, setLostOpen] = useState(false);
  const [lostReason, setLostReason] = useState("");
  const [lostReasonKey, setLostReasonKey] = useState("");
  // Reopen a lost lead into an active stage (phase + matching status).
  const REOPEN_STAGES = [
    { value: "contacted", label: "Contacted", status: "contacted" },
    { value: "qualified", label: "Qualified", status: "qualified" },
    { value: "proposal", label: "Proposal", status: "engaged" },
    { value: "negotiation", label: "Negotiation", status: "engaged" },
  ];
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenStage, setReopenStage] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [, navigate] = useLocation();

  const { can, isLoading: authLoading } = useAuthz();
  const canEdit = can("leads", "edit");
  const canDeskDeal = can("deals", "create");
  const canReplyToDeal = can("deals", "edit");
  const canDelete = can("leads", "delete");
  const canFinance = can("finance", "create");
  // Quick finance actions against the lead's linked deal (header CTAs).
  const [invoiceDeal, setInvoiceDeal] = useState<Deal | null>(null);
  const [paymentDeal, setPaymentDeal] = useState<Deal | null>(null);
  const [vehicleDialogOpen, setVehicleDialogOpen] = useState(false);

  const createDeal = useCreateDeal({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDealsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetLeadQueryKey(id) });
        qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(id) });
        toast({
          title: "Deal desked",
          description: "The deal is linked to this lead — stage gates now see it.",
        });
      },
      onError: () =>
        toast({ title: "Could not desk the deal", variant: "destructive" }),
    },
  });
  const { data: vehicles } = useListVehicles(undefined, {
    query: {
      queryKey: ["lead-edit-vehicles"],
      enabled: canEdit || canDeskDeal,
    },
  });
  const updateLead = useUpdateLead({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetLeadQueryKey(id) });
        qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(id) });
        qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
        // Vehicle swap frees the old unit / reserves the new one — refresh
        // inventory-backed queries so statuses and options stay current.
        qc.invalidateQueries({ queryKey: ["lead-edit-vehicles"] });
        qc.invalidateQueries({ queryKey: ["lead-detail-vehicle"] });
        toast({ title: "Lead updated" });
      },
      onError: () =>
        toast({ title: "Could not update lead", variant: "destructive" }),
    },
  });

  const deleteLead = useDeleteLead({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
        qc.invalidateQueries({ queryKey: getListDealsQueryKey() });
        toast({
          title: "Lead deleted",
          description:
            "Linked deals and bookings were cancelled, reserved stock released, and the contact is free for new enquiries.",
        });
        navigate("/pipeline");
      },
      onError: () =>
        toast({ title: "Could not delete lead", variant: "destructive" }),
    },
  });

  const generateQuote = useGenerateLeadQuote({
    mutation: {
      onSuccess: (q) => {
        qc.invalidateQueries({ queryKey: getListLeadQuotesQueryKey(id) });
        qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(id) });
        setQuoteGenOpen(false);
        toast({
          title: `Code ${q.quoteNumber} generated`,
          description: `Revision ${q.version} priced with current taxes.`,
        });
      },
      onError: (err: unknown) =>
        toast({
          title: "Could not generate Code",
          description:
            (err as { error?: string })?.error ??
            "Add a vehicle of interest first.",
          variant: "destructive",
        }),
    },
  });

  const requestDiscount = useRequestQuoteDiscount({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListLeadQuotesQueryKey(id) });
        qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(id) });
        setDiscountOpen(false);
        toast({
          title: "Discount requested",
          description: "Sent to management for approval — watch the Approvals queue.",
        });
      },
      onError: (err: unknown) =>
        toast({
          title: "Could not request discount",
          description: (err as { error?: string })?.error ?? undefined,
          variant: "destructive",
        }),
    },
  });
  const [discountOpen, setDiscountOpen] = useState(false);
  const [discountAmount, setDiscountAmount] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [quoteGenOpen, setQuoteGenOpen] = useState(false);
  const [quoteModelName, setQuoteModelName] = useState("");
  const [quoteModelYear, setQuoteModelYear] = useState("");

  const sendQuote = useSendLeadQuote({
    mutation: {
      onSuccess: (r) => {
        qc.invalidateQueries({ queryKey: getListLeadQuotesQueryKey(id) });
        qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(id) });
        qc.invalidateQueries({ queryKey: getGetLeadQueryKey(id) });
        toast({
          title:
            r.channel === "both"
              ? r.whatsappStatus === "queued"
                ? "Code emailed and queued on WhatsApp"
                : r.whatsappStatus === "already_sent"
                  ? "Code emailed; WhatsApp PDF was already sent"
                : "Code emailed"
              : r.channel === "email"
                ? "Code emailed"
                : r.whatsappStatus === "already_sent"
                  ? "Code PDF was already sent on WhatsApp"
                  : "Code PDF queued on WhatsApp",
          description:
            r.whatsappStatus === "blocked"
              ? `WhatsApp PDF skipped: ${r.whatsappBlockedReason ?? "WhatsApp is unavailable."}`
              : r.whatsappStatus === "queued"
                ? "The customer will receive the quote as a PDF document."
                : r.whatsappStatus === "already_sent"
                  ? "A prior delivery for this quote is already recorded."
                : undefined,
        });
      },
      onError: (err: unknown) =>
        toast({
          title: "Could not send Code",
          description: (err as { error?: string })?.error ?? undefined,
          variant: "destructive",
        }),
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

  const logTouch = useCreateLeadNote({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(id) });
        toast({ title: "Touch logged" });
      },
      onError: () =>
        toast({ title: "Could not log touch", variant: "destructive" }),
    },
  });

  // While auth / dealer context is still resolving, transient request
  // failures (dealer_selection_required, missing x-dealer-id) are expected —
  // keep showing the loader instead of a premature "Lead not found".
  if (isLoading || (authLoading && (isError || !lead))) {
    return (
      <Page>
        <div className="flex items-center justify-center py-32">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      </Page>
    );
  }

  if (isError || !lead) {
    const status = (error as { status?: number } | null)?.status;
    const trueNotFound = status === 404;
    return (
      <Page>
        <div className="text-center py-32 space-y-4">
          <div className="text-lg font-semibold">
            {trueNotFound ? "Lead not found" : "Couldn't load this lead"}
          </div>
          {!trueNotFound && (
            <div className="text-sm text-muted-foreground">
              The request failed while loading. Try again.
            </div>
          )}
          <div className="flex items-center justify-center gap-4">
            {!trueNotFound && (
              <button
                onClick={() => void refetch()}
                className="text-primary hover:underline text-sm"
              >
                Retry
              </button>
            )}
            <Link href="/pipeline" className="text-primary hover:underline text-sm">
              Back to Pipeline
            </Link>
          </div>
        </div>
      </Page>
    );
  }

  const guidance = GUIDANCE[lead.status] ?? GUIDANCE.new;
  const quotePdfUrl = `${import.meta.env.BASE_URL}api/leads/${lead.id}/quote.pdf`;
  const testDriveScheduled = !!lead.testDriveAt;

  // ----- Journey stage nav (8-phase pipeline, label-only over phase+deal) ---
  const dealRank = (s: string) =>
    s === "delivered" ? 3 : s === "committed" ? 2 : 0;
  const linkedDeal = (allDeals ?? [])
    .filter(
      (d) =>
        d.leadId === lead.id ||
        (lead.customerId != null && d.customerId === lead.customerId),
    )
    .sort((a, b) => dealRank(b.stage) - dealRank(a.stage))[0];

  // Finance CTAs must NEVER use the customer-fallback heuristic above — an
  // invoice/payment goes only to a deal explicitly desked for THIS lead.
  // Among those, prefer the furthest-progressed open deal, newest first.
  const financeDeal = (allDeals ?? [])
    .filter(
      (d) =>
        d.leadId === lead.id &&
        (d.stage === "desking" || d.stage === "committed"),
    )
    .sort(
      (a, b) =>
        dealRank(b.stage) - dealRank(a.stage) || b.id - a.id,
    )[0];

  // Reservation invoice + payment progress for this lead's deals.
  const leadDealIds = new Set(
    (allDeals ?? [])
      .filter(
        (d) =>
          d.leadId === lead.id ||
          (lead.customerId != null && d.customerId === lead.customerId),
      )
      .map((d) => d.id),
  );
  const reservationInvoice = (allInvoices ?? []).find(
    (inv) =>
      inv.kind === "reservation" &&
      inv.dealId != null &&
      leadDealIds.has(inv.dealId) &&
      inv.status !== "void",
  );
  const reservationOutstanding = reservationInvoice
    ? (outstandingBalances ?? []).find(
        (o) => o.invoiceId === reservationInvoice.id,
      )
    : undefined;
  const reservationPaid = reservationInvoice
    ? reservationInvoice.status === "paid"
      ? reservationInvoice.amount
      : (reservationOutstanding?.paidAmount ?? 0)
    : null;
  const reservationDue = reservationInvoice
    ? reservationInvoice.status === "paid"
      ? 0
      : (reservationOutstanding?.balance ??
        reservationInvoice.amount - (reservationPaid ?? 0))
    : null;
  // Total paid across ALL of the lead's deal invoices, and the balance still
  // owed toward the deal's out-the-door price.
  const dealPaidTotal = (allInvoices ?? [])
    .filter(
      (inv) =>
        inv.dealId != null && leadDealIds.has(inv.dealId) && inv.status !== "void",
    )
    .reduce((sum, inv) => {
      if (inv.status === "paid") return sum + inv.amount;
      const o = (outstandingBalances ?? []).find((x) => x.invoiceId === inv.id);
      return sum + (o?.paidAmount ?? 0);
    }, 0);

  const journeyIndex = (() => {
    switch (lead.phase) {
      case "new":
        return 0;
      case "contacted":
        return 1;
      case "qualified":
        return 2;
      case "proposal":
        return 3;
      case "negotiation":
        return 3;
      case "won": {
        const s = linkedDeal?.stage;
        if (s === "delivered") return 7;
        if (s === "committed") return 6;
        return 4;
      }
      default:
        return 0; // lost — show at start, badge already says Lost
    }
  })();
  const quoteSent = lead.quotationSent || !!quote?.sentAt;
  const vinValid = !!vehicle?.vin && vehicle.vin.length === 17;
  // Spec (A11): a specific VIN is only hard-locked to the order at deal
  // commit. Before that, interest is model-level — never surface the VIN.
  const vinAllocated =
    !!linkedDeal &&
    (linkedDeal.stage === "committed" || linkedDeal.stage === "delivered");
  const linkedDelivery = linkedDeal
    ? (allDeliveries ?? []).find((d) => d.dealId === linkedDeal.id)
    : undefined;
  const dutyDocsDone =
    linkedDelivery?.status === "completed" ||
    !!linkedDelivery?.steps.some(
      (s) =>
        (s.key === "registration" || s.key === "insurance") &&
        s.status === "completed",
    );
  const journeyStages: StageNavStage[] = [
    {
      key: "new",
      label: "New",
      caption: "Code generated, advisor assigned — call within 48 hours.",
      checklist: [
        { label: "Sales advisor assigned", done: !!lead.ownerUserId },
        { label: "Quote code generated", done: quoteSent },
        { label: "Contact details on file", done: !!(lead.phone || lead.email) },
      ],
    },
    {
      key: "contacted",
      label: "Contacted",
      caption: "First call logged inside the 48-hour SLA.",
      checklist: [
        { label: "First contact logged", done: !!lead.contactedDate },
        { label: "Address captured", done: !!lead.address },
        { label: "Budget & financing preference", done: !!lead.budgetFinancing },
      ],
    },
    {
      key: "engaged",
      label: "Engaged",
      caption: "Test drive, financing docs, and negotiation.",
      checklist: [
        { label: "Test drive scheduled", done: testDriveScheduled },
        { label: "Financing qualified", done: !!lead.financingQualified },
        { label: "Quotation sent", done: quoteSent },
      ],
    },
    {
      key: "pre_book",
      label: "Pre-Book",
      caption: "Reservation fee confirms the order.",
      checklist: [
        { label: "Reservation fee paid", done: lead.reservationFeePaid },
        { label: "Account created & linked", done: !!lead.customerId },
        { label: "Selected model locked", done: !!lead.interestedVehicleId },
      ],
    },
    {
      key: "vehicle_allocated",
      label: "Vehicle Allocated",
      caption: "A specific VIN-level unit is locked to this order.",
      checklist: [
        { label: "VIN validated (17 chars)", done: vinValid },
        { label: "Unit soft-locked", done: !!linkedDeal },
      ],
    },
    {
      key: "payment",
      label: "Payment",
      caption: "Reservation and final invoices settled.",
      checklist: [
        {
          label: "Final payment structured",
          done: dealRank(linkedDeal?.stage ?? "") >= 1,
        },
      ],
    },
    {
      key: "pre_delivery",
      label: "Pre-Delivery",
      caption: "Docs, customs duty pack, and handover checklist.",
      checklist: [
        {
          label: "Deal committed",
          done: dealRank(linkedDeal?.stage ?? "") >= 2,
        },
        { label: "Duty pack & handover docs", done: dutyDocsDone },
      ],
    },
    {
      key: "delivered",
      label: "Delivered",
      caption: "Keys handed over — feedback survey within 24 hours.",
      checklist: [
        { label: "Vehicle delivered", done: linkedDeal?.stage === "delivered" },
      ],
    },
  ];

  const pendingGates = (gatesQuery.data ?? []).filter((g) => {
    if (g.status !== "pending") return false;
    if (g.refType === "lead" && g.refId === lead.id) return true;
    if (g.refType === "deal" && linkedDeal?.id != null && g.refId === linkedDeal.id) return true;
    if (g.refType === "vehicle" && lead.interestedVehicleId != null && g.refId === lead.interestedVehicleId) return true;
    if (g.refType === "vehicle" && linkedDeal?.vehicleId != null && g.refId === linkedDeal.vehicleId) return true;
    return false;
  });

  const getGateStageKey = (type: string, fallback: string) => {
    switch (type) {
      case "below_floor_price": return "payment";
      case "credit_decline": return "payment";
      case "capital_order": return "vehicle_allocated";
      case "gra_filing": return "pre_delivery";
      case "refund_release": return "payment";
      default: return fallback;
    }
  };

  const currentStageKey = journeyStages[journeyIndex]?.key ?? "new";

  const daysInStage = lead.stageEnteredAt
    ? Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(lead.stageEnteredAt).getTime()) / 86_400_000,
        ),
      )
    : null;
  const currentQuote =
    (quoteVersions ?? []).find((q) => q.status === "current") ??
    (quoteVersions ?? [])[0];

  const oneTap = (
    href: string,
    label: string,
    sameTab: boolean = false,
  ) => {
    logTouch.mutate({ id: lead.id, data: { text: label } });
    if (typeof window !== "undefined") {
      if (sameTab) window.location.href = href;
      else window.open(href, "_blank", "noopener");
    }
  };

  const stagesWithAlerts = journeyStages.map((s) => {
    const stageGates = pendingGates.filter((g) => getGateStageKey(g.type, currentStageKey) === s.key);
    return { ...s, alert: stageGates.length > 0 };
  });

  const chainGates = pendingGates.map((g) => {
    const stageKey = getGateStageKey(g.type, currentStageKey);
    return {
      ...g,
      chainStageKey: stageKey,
      chainStageLabel:
        journeyStages.find((s) => s.key === stageKey)?.label ?? "",
    };
  });

  const phaseDisplay =
    lead.phase === "lost"
      ? "Lost"
      : (journeyStages[journeyIndex]?.label ?? lead.phase);

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
    <Page>
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
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight truncate">
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
                {phaseDisplay}
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
                onClick={() => setCallOpen(true)}
                className="gap-1.5"
              >
                <Phone className="w-3.5 h-3.5" />
                Call
              </Button>
            )}
            {canFinance && financeDeal && (
              <>
                <Button
                  variant="outline"
                  onClick={() => setInvoiceDeal(financeDeal)}
                  className="gap-1.5"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Invoice
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setPaymentDeal(financeDeal)}
                  disabled={
                    openInvoicesForDeal(allInvoices, financeDeal.id).length === 0
                  }
                  title={
                    openInvoicesForDeal(allInvoices, financeDeal.id).length === 0
                      ? "Issue an invoice first — payments are recorded against an open invoice"
                      : undefined
                  }
                  className="gap-1.5"
                >
                  <Banknote className="w-3.5 h-3.5" />
                  Payment
                </Button>
              </>
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
            {canDeskDeal && (
              <Button
                variant="outline"
                onClick={() => setDeskOpen(true)}
                className="gap-1.5"
              >
                <FileText className="w-3.5 h-3.5" />
                Desk deal
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => setWorkflowOpen(true)}
              className="gap-1.5"
            >
              <ClipboardList className="w-4 h-4" />
              Lead actions
            </Button>
            {(canEdit || canDelete) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreVertical className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canEdit && lead.phase !== "lost" && lead.phase !== "won" && (
                    <DropdownMenuItem onClick={() => setLostOpen(true)}>
                      <XCircle className="w-3.5 h-3.5 mr-2" />
                      Mark as Lost…
                    </DropdownMenuItem>
                  )}
                  {canEdit && lead.phase === "lost" && (
                    <DropdownMenuItem onClick={() => setReopenOpen(true)}>
                      <ClipboardList className="w-3.5 h-3.5 mr-2" />
                      Reopen lead…
                    </DropdownMenuItem>
                  )}
                  {canDelete && (
                    <>
                      {canEdit && lead.phase !== "lost" && lead.phase !== "won" && (
                        <DropdownMenuSeparator />
                      )}
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-2" />
                        Delete Lead…
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>

      <VehicleSwapDialog
        open={vehicleDialogOpen}
        onOpenChange={setVehicleDialogOpen}
        vehicles={vehicles ?? []}
        currentId={lead?.interestedVehicleId}
        onSave={(id) => saveVehicle(String(id))}
      />
      <CallDialog
        leadId={lead.id}
        leadName={lead.name}
        leadPhone={lead.phone ?? null}
        open={callOpen}
        onOpenChange={setCallOpen}
      />

      <DealQuickFinanceDialogs
        invoiceDeal={invoiceDeal}
        paymentDeal={paymentDeal}
        onCloseInvoice={() => setInvoiceDeal(null)}
        onClosePayment={() => setPaymentDeal(null)}
        invoices={allInvoices}
        outstandingBalances={outstandingBalances}
        onRequestPayment={setPaymentDeal}
        onDone={() => {
          qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(id) });
        }}
      />

      {/* Journey rail — single source of stage truth */}
      <div className="mb-6">
        <StageNav stages={stagesWithAlerts} currentIndex={journeyIndex} compact />
      </div>

      {/* Stage facts strip */}
      <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile label="Days in Stage">
          {daysInStage != null ? `${daysInStage}d` : "—"}
        </KpiTile>
        <KpiTile label="Quote Total">
          {currentQuote ? money.gyd(currentQuote.total) : "—"}
        </KpiTile>
        <KpiTile label="Test Drive">
          {lead.testDriveAt ? formatGuyanaDate(lead.testDriveAt) : "Not set"}
        </KpiTile>
        <KpiTile label="Reservation Fee">
          <span className={lead.reservationFeePaid ? "text-emerald-500" : "text-amber-500"}>
            {lead.reservationFeePaid ? "Paid" : "Pending"}
          </span>
        </KpiTile>
      </div>

      {/* AI next-steps strip */}
      <div className="mb-6">
        <AgentBriefPanel
          leadId={lead.id}
          leadPhone={lead.phone}
          leadEmail={lead.email}
          leadSource={lead.source}
          hasOwner={canEdit && !!lead.ownerUserId}
          compact
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6 items-start">
        {/* Main column */}
        <div className="rounded-2xl border border-white/10 bg-foreground/[0.02]">
          <div className="flex items-center gap-1 border-b border-white/10 px-4 pt-3 overflow-x-auto">
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

          <div className="px-4 pt-4 empty:hidden [&:not(:has(*))]:hidden">
            <DocumentPrefillBanner leadId={lead.id} />
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
              {tab === "overview" && (
                <div className="space-y-5">
                  <ActionChain
                    lead={lead}
                    stage={stagesWithAlerts[journeyIndex]}
                    canEdit={canEdit}
                    pendingGates={chainGates}
                    onGateResolved={() => {
                      qc.invalidateQueries({ queryKey: getGetLeadQueryKey(id) });
                      qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(id) });
                      qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
                      qc.invalidateQueries({ queryKey: getListDealsQueryKey() });
                    }}
                  />

                  <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center">
                        <CircleCheck className="w-3.5 h-3.5" />
                      </span>
                      <span className="text-sm font-semibold tracking-tight">
                        {journeyStages[journeyIndex]?.label ?? "Current"} — Stage
                        Checklist
                      </span>
                    </div>
                    <ul className="space-y-2">
                      {(journeyStages[journeyIndex]?.checklist ?? []).map((c) => (
                        <li
                          key={c.label}
                          className="flex items-start gap-2.5 text-sm"
                        >
                          <span
                            className={cn(
                              "mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0 ring-1",
                              c.done
                                ? "bg-emerald-500/20 text-emerald-500 ring-emerald-500/40"
                                : "bg-foreground/[0.05] text-muted-foreground ring-white/15",
                            )}
                          >
                            {c.done ? <Check className="w-2.5 h-2.5" /> : null}
                          </span>
                          <span
                            className={
                              c.done ? "text-foreground/70" : "text-foreground/90"
                            }
                          >
                            {c.label}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5">
                      <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
                        Linked Deal
                      </div>
                      {linkedDeal ? (
                        <Link href="/deals" className="block group">
                          <div className="font-semibold flex items-center gap-1.5 group-hover:text-primary transition-colors">
                            Deal #{linkedDeal.id}
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          </div>
                          <div className="text-xs text-muted-foreground mt-1 capitalize">
                            {linkedDeal.stage} · {money.gyd(linkedDeal.otdPrice)}
                          </div>
                        </Link>
                      ) : (
                        <div className="text-sm text-muted-foreground">
                          No linked deal yet.
                        </div>
                      )}
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5">
                      <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
                        Current Quote
                      </div>
                      {currentQuote ? (
                        <button
                          onClick={() => setTab("documents")}
                          className="text-left w-full group"
                        >
                          <div className="font-mono text-sm font-semibold group-hover:text-primary transition-colors">
                            {currentQuote.quoteNumber}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            Total {money.gyd(currentQuote.total)} · Rev{" "}
                            {currentQuote.version}
                          </div>
                        </button>
                      ) : (
                        <div className="text-sm text-muted-foreground">
                          No quote generated yet.
                        </div>
                      )}
                    </div>
                  </div>

                  {linkedDeal && (
                    <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5">
                      <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-3">
                        Invoices &amp; Payments — Deal #{linkedDeal.id}
                      </div>
                      <DealFinanceRecords
                        dealId={linkedDeal.id}
                        invoices={allInvoices}
                        outstandingBalances={outstandingBalances}
                      />
                    </div>
                  )}

                  {linkedDeal && (
                    <section
                      className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5"
                      data-testid="deal-detail-whatsapp"
                    >
                      <div className="flex items-start gap-3 mb-4">
                        <span className="w-8 h-8 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                          <MessageSquare className="w-4 h-4" />
                        </span>
                        <div>
                          <h2 className="text-sm font-semibold tracking-tight">
                            WhatsApp conversation
                          </h2>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Deal #{linkedDeal.id} · Message history and replies
                          </p>
                        </div>
                      </div>
                      <div className="h-[440px] min-h-[340px]">
                        <DealWhatsappPanel
                          dealId={linkedDeal.id}
                          canReply={canReplyToDeal}
                        />
                      </div>
                    </section>
                  )}

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
                </div>
              )}

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
                      label="Address"
                      canEdit={canEdit}
                      full
                      editor={{ kind: "textarea", value: lead.address ?? "" }}
                      onSave={(v) => patchField({ address: textOrNull(v) })}
                    >
                      {lead.address}
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
                          Change in Lead actions
                        </button>
                      </span>
                    </InlineField>
                    <InlineField label="Pipeline Stage">
                      {phaseDisplay}
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
                    <InlineField label="Sales Advisor">{ownerDisplay}</InlineField>
                  </Section>

                  <Section title="Product Interest">
                    <InlineField label="Interested Model">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          {vehicleLink ?? (
                            <span className="text-muted-foreground/60">—</span>
                          )}
                        </div>
                        {canEdit && (
                          <button
                            onClick={() => setVehicleDialogOpen(true)}
                            aria-label="Change interested vehicle"
                            data-testid="button-change-vehicle"
                            className="text-muted-foreground hover:text-primary shrink-0 mt-0.5"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </InlineField>
                    <InlineField label="Vehicle Version">
                      {vehicle?.trim || vehicle?.variant || lead.variant}
                    </InlineField>
                    <InlineField label="Vehicle Color">
                      {vehicle?.exteriorColor || lead.color}
                    </InlineField>
                    <InlineField label="VIN">
                      {vinAllocated && vehicle?.vin ? (
                        <Link
                          href={`/vehicle/${vehicle.id}`}
                          className="font-mono text-xs tracking-wide text-primary hover:underline"
                        >
                          {vehicle.vin}
                        </Link>
                      ) : vehicle ? (
                        <span className="text-xs text-muted-foreground">
                          Assigned at allocation
                        </span>
                      ) : null}
                    </InlineField>
                    <InlineField label="Unit Price">
                      {vehicle ? money.gyd(vehicle.price) : null}
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
                      label="Email Communication"
                      canEdit={canEdit}
                      editor={{
                        kind: "checkbox",
                        value: !lead.emailOptOut,
                      }}
                      onSave={(v) => patchField({ emailOptOut: !v })}
                    >
                      <span
                        className={
                          lead.emailOptOut
                            ? "text-destructive font-medium"
                            : undefined
                        }
                      >
                        {lead.emailOptOut
                          ? "Off — no emails will be sent to this customer"
                          : "On"}
                      </span>
                    </InlineField>
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
                        ? formatGuyanaDate(lead.contactedDate)
                        : null}
                    </InlineField>
                    <InlineField
                      label="Selected Model"
                      canEdit={canEdit}
                      editor={{
                        kind: "text",
                        value: lead.selectedModel ?? "",
                      }}
                      onSave={(v) =>
                        patchField({ selectedModel: v ? String(v) : null })
                      }
                    >
                      {lead.selectedModel || null}
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
                    {reservationInvoice && (
                      <>
                        <InlineField label="Reservation Invoice">
                          <span className="font-mono text-xs">
                            {reservationInvoice.invoiceNumber}
                          </span>
                        </InlineField>
                        <InlineField label="Reservation Amount">
                          {money.gyd(reservationInvoice.amount)}
                        </InlineField>
                        <InlineField label="Amount Paid">
                          <span className={reservationPaid ? "text-emerald-500" : undefined}>
                            {money.gyd(reservationPaid ?? 0)}
                          </span>
                        </InlineField>
                        <InlineField label="Reservation Remaining">
                          <span className={reservationDue ? "text-amber-500" : "text-emerald-500"}>
                            {money.gyd(reservationDue ?? 0)}
                          </span>
                        </InlineField>
                        {linkedDeal && linkedDeal.otdPrice > 0 && (
                          <>
                            <InlineField label="Deal Total (OTD)">
                              {money.gyd(linkedDeal.otdPrice)}
                            </InlineField>
                            <InlineField label="Balance Remaining">
                              <span
                                className={
                                  linkedDeal.otdPrice - dealPaidTotal > 0
                                    ? "text-amber-500"
                                    : "text-emerald-500"
                                }
                              >
                                {money.gyd(
                                  Math.max(linkedDeal.otdPrice - dealPaidTotal, 0),
                                )}
                              </span>
                            </InlineField>
                          </>
                        )}
                      </>
                    )}
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
                    <InlineField label="Booking Invite">
                      {testDriveScheduled ? (
                        <span className="text-xs text-muted-foreground">
                          Already scheduled
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1.5 text-xs"
                          disabled={sendInvite.isPending || !lead.email}
                          onClick={() =>
                            sendInvite.mutate(
                              { id: lead.id },
                              {
                                onSuccess: () =>
                                  toast({
                                    title: "Booking invite sent",
                                    description: `${lead.name} received an email with their self-service test-drive booking link.`,
                                  }),
                                onError: (e: unknown) =>
                                  toast({
                                    title: "Could not send the invite",
                                    description:
                                      (e as { response?: { data?: { error?: string } } })
                                        ?.response?.data?.error ??
                                      "Please try again.",
                                    variant: "destructive",
                                  }),
                              },
                            )
                          }
                        >
                          {sendInvite.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Send className="w-3.5 h-3.5" />
                          )}
                          {lead.email ? "Send booking invite" : "No email on file"}
                        </Button>
                      )}
                    </InlineField>
                    <InlineField label="Test Drive Date">
                      {lead.testDriveAt
                        ? formatGuyanaDateTime(lead.testDriveAt)
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

                  <Section title="System Information">
                    <InlineField label="Created">
                      {formatGuyanaDateTime(lead.createdAt)}
                    </InlineField>
                    <InlineField label="AI Score">
                      <span className="text-primary font-medium">
                        {lead.aiScore}
                      </span>
                    </InlineField>
                  </Section>
                </div>
              )}

              {tab === "documents" && (
                <div className="space-y-4">
                  {/* Quotation Codes — versioned, deterministic tax engine */}
                  <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold">Quotation Codes</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          Sequential estimates priced from inventory with dealer
                          taxes applied. Every revision is kept.
                        </div>
                      </div>
                      {canEdit && (
                        <Button
                          size="sm"
                          disabled={generateQuote.isPending}
                          onClick={() => {
                            setQuoteModelName("");
                            setQuoteModelYear("");
                            setQuoteGenOpen(true);
                          }}
                        >
                          {generateQuote.isPending ? (
                            <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                          ) : (
                            <FileText className="w-4 h-4 mr-1.5" />
                          )}
                          {quoteVersions && quoteVersions.length > 0
                            ? "Regenerate Code"
                            : "Generate Code"}
                        </Button>
                      )}
                    </div>

                    <Dialog open={quoteGenOpen} onOpenChange={setQuoteGenOpen}>
                      <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                          <DialogTitle>Generate quotation Code</DialogTitle>
                          <DialogDescription>
                            Priced from the vehicle of interest. Optionally
                            override the model name or model year printed on
                            the quote.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <Label htmlFor="quote-model-name">
                              Model name (optional)
                            </Label>
                            <Input
                              id="quote-model-name"
                              placeholder={
                                vehicle
                                  ? vehicle.model
                                  : "e.g. SHARK 6 Premium"
                              }
                              maxLength={120}
                              value={quoteModelName}
                              onChange={(e) =>
                                setQuoteModelName(e.target.value)
                              }
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="quote-model-year">
                              Model year (optional)
                            </Label>
                            <Input
                              id="quote-model-year"
                              type="number"
                              min={1980}
                              max={2100}
                              placeholder={
                                vehicle ? String(vehicle.year) : "e.g. 2026"
                              }
                              value={quoteModelYear}
                              onChange={(e) =>
                                setQuoteModelYear(e.target.value)
                              }
                            />
                          </div>
                          <div className="flex justify-end gap-2 pt-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setQuoteGenOpen(false)}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              disabled={
                                generateQuote.isPending ||
                                (quoteModelYear !== "" &&
                                  (Number(quoteModelYear) < 1980 ||
                                    Number(quoteModelYear) > 2100 ||
                                    !Number.isInteger(Number(quoteModelYear))))
                              }
                              onClick={() =>
                                generateQuote.mutate({
                                  id: lead.id,
                                  data: {
                                    ...(quoteModelName.trim()
                                      ? { modelName: quoteModelName.trim() }
                                      : {}),
                                    ...(quoteModelYear !== ""
                                      ? { modelYear: Number(quoteModelYear) }
                                      : {}),
                                  },
                                })
                              }
                            >
                              {generateQuote.isPending && (
                                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                              )}
                              Generate
                            </Button>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>

                    <Dialog open={discountOpen} onOpenChange={setDiscountOpen}>
                      <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                          <DialogTitle>Request quote discount</DialogTitle>
                          <DialogDescription>
                            Management must approve the discount before it is
                            applied to the quote total.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              Discount amount (GYD)
                            </p>
                            <Input
                              type="number"
                              min={1}
                              value={discountAmount}
                              onChange={(e) => setDiscountAmount(e.target.value)}
                              placeholder="100000"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              Reason
                            </p>
                            <Textarea
                              value={discountReason}
                              onChange={(e) => setDiscountReason(e.target.value)}
                              placeholder="Why this customer should get a discount…"
                              rows={3}
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button
                            variant="outline"
                            onClick={() => setDiscountOpen(false)}
                          >
                            Cancel
                          </Button>
                          <Button
                            disabled={
                              requestDiscount.isPending ||
                              !(Number(discountAmount) > 0)
                            }
                            onClick={() =>
                              requestDiscount.mutate({
                                id: lead.id,
                                data: {
                                  amount: Number(discountAmount),
                                  ...(discountReason.trim()
                                    ? { reason: discountReason.trim() }
                                    : {}),
                                },
                              })
                            }
                          >
                            {requestDiscount.isPending && (
                              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                            )}
                            Submit for approval
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>

                    {quoteVersions && quoteVersions.length > 0 ? (
                      <div className="space-y-2">
                        {quoteVersions.map((q) => (
                          <div
                            key={q.id}
                            className="rounded-xl border border-white/10 bg-foreground/[0.03] p-3"
                          >
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="font-mono text-sm font-semibold">
                                {q.quoteNumber}
                              </span>
                              <span className="text-[11px] uppercase tracking-wider px-2 py-0.5 rounded-full border border-white/10 text-muted-foreground">
                                Rev {q.version}
                              </span>
                              {q.status === "current" ? (
                                <span className="text-[11px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500">
                                  Current
                                </span>
                              ) : (
                                <span className="text-[11px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-foreground/10 text-muted-foreground">
                                  Superseded
                                </span>
                              )}
                              <span className="text-xs text-muted-foreground ml-auto">
                                {q.issuedOn}
                                {q.sentAt
                                  ? ` · Sent ${formatGuyanaDate(q.sentAt)}${q.sentVia ? ` via ${q.sentVia}` : ""}`
                                  : " · Not sent"}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground mt-1.5">
                              {q.modelYear} {q.vehicleLine}
                              {q.color ? ` · ${q.color}` : ""} · Base{" "}
                              {money.gyd(q.basePrice)} · Taxes{" "}
                              {money.gyd(q.totalTax)}
                            </div>
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <span className="text-sm font-semibold mr-auto">
                                Total {money.dual(q.total)}
                              </span>
                              <a
                                href={`${import.meta.env.BASE_URL}api/leads/${lead.id}/quotes/${q.id}/pdf`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <Button variant="outline" size="sm">
                                  View PDF
                                </Button>
                              </a>
                              {canEdit && q.status === "current" && (
                                <>
                                  {q.discountStatus === "pending" ? (
                                    <span className="text-[11px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500">
                                      Discount pending approval
                                    </span>
                                  ) : q.discountStatus === "approved" &&
                                    (q.discountAmount ?? 0) > 0 ? (
                                    <span className="text-[11px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500">
                                      Discount {money.gyd(q.discountAmount ?? 0)}
                                    </span>
                                  ) : (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => {
                                        setDiscountAmount("");
                                        setDiscountReason("");
                                        setDiscountOpen(true);
                                      }}
                                    >
                                      Request Discount
                                    </Button>
                                  )}
                                  {q.discountStatus === "rejected" && (
                                    <span className="text-[11px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-red-500/15 text-red-500">
                                      Discount declined
                                    </span>
                                  )}
                                  <Button
                                    size="sm"
                                    disabled={sendQuote.isPending || !lead.email}
                                    onClick={() =>
                                      sendQuote.mutate({
                                        id: lead.id,
                                        quoteId: q.id,
                                        data: { channel: "both" },
                                      })
                                    }
                                  >
                                    {sendQuote.isPending ? (
                                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                    ) : (
                                      <Send className="w-3.5 h-3.5 mr-1.5" />
                                    )}
                                    Email + WhatsApp PDF
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={sendQuote.isPending || !lead.email}
                                    onClick={() =>
                                      sendQuote.mutate({
                                        id: lead.id,
                                        quoteId: q.id,
                                        data: { channel: "email" },
                                      })
                                    }
                                  >
                                    <Mail className="w-3.5 h-3.5 mr-1.5" />
                                    Email only
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={sendQuote.isPending || !lead.phone}
                                    onClick={() =>
                                      sendQuote.mutate({
                                        id: lead.id,
                                        quoteId: q.id,
                                        data: { channel: "whatsapp" },
                                      })
                                    }
                                  >
                                    <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
                                    WhatsApp PDF
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground rounded-xl border border-dashed border-white/10 p-4 text-center">
                        No Code yet — it is generated automatically when a lead
                        arrives with a vehicle of interest, or generate one now.
                      </div>
                    )}
                  </div>

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
                              {formatGuyanaDate(quote.sentAt)}
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

                  <DocumentsCard
                    entityType="lead"
                    entityId={lead.id}
                    canEdit={canEdit}
                  />

                  {/* Customs duty pack — surfaces in the pipeline once the
                      unit is allocated (deal committed), tagged to the deal. */}
                  {vinAllocated && linkedDeal && (
                    <div className="rounded-2xl border border-white/10 bg-foreground/[0.02]">
                      <button
                        onClick={() => setShowDuty((v) => !v)}
                        className="w-full flex items-center justify-between px-5 py-4"
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
                            vehicleId={linkedDeal.vehicleId}
                            dealId={linkedDeal.id}
                            prefillNotes={`Lead #${lead.id} · Deal #${linkedDeal.id} · ${lead.name}`}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {tab === "correspondence" && (
                <div className="space-y-5">
                  <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-foreground/[0.02] p-1 w-fit">
                    <button
                      onClick={() => setCorrView("calls")}
                      className={cn(
                        "px-3 py-1.5 text-sm font-semibold rounded-lg transition-colors",
                        corrView === "calls"
                          ? "bg-primary/[0.12] text-foreground ring-1 ring-primary/30"
                          : "text-muted-foreground hover:text-foreground/80",
                      )}
                    >
                      Calls
                    </button>
                    <button
                      onClick={() => setCorrView("whatsapp")}
                      className={cn(
                        "px-3 py-1.5 text-sm font-semibold rounded-lg transition-colors",
                        corrView === "whatsapp"
                          ? "bg-primary/[0.12] text-foreground ring-1 ring-primary/30"
                          : "text-muted-foreground hover:text-foreground/80",
                      )}
                    >
                      WhatsApp
                    </button>
                  </div>

                  {corrView === "whatsapp" ? (
                    <WhatsappPanel leadId={lead.id} canReply={canEdit} />
                  ) : (
                  <div className="space-y-5">
                  <div className="flex items-center justify-between">
                    <div className="grid grid-cols-3 gap-3 flex-1">
                      <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-3">
                        <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                          Total calls
                        </div>
                        <div className="text-xl font-semibold mt-0.5">
                          {calls?.length ?? 0}
                        </div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-3">
                        <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                          Connected
                        </div>
                        <div className="text-xl font-semibold mt-0.5">
                          {calls?.filter((c) => c.status === "completed")
                            .length ?? 0}
                        </div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-3">
                        <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                          Talk time
                        </div>
                        <div className="text-xl font-semibold mt-0.5">
                          {formatCallDuration(
                            (calls ?? []).reduce(
                              (sum, c) => sum + (c.durationSeconds ?? 0),
                              0,
                            ),
                          ) || "0m"}
                        </div>
                      </div>
                    </div>
                    {canEdit && (
                      <Button
                        size="sm"
                        className="gap-1.5 ml-4 shrink-0"
                        onClick={() => setCallOpen(true)}
                      >
                        <Phone className="w-3.5 h-3.5" />
                        Log call
                      </Button>
                    )}
                  </div>

                  {calls && calls.length > 0 ? (
                    <div className="space-y-3">
                      {calls.map((c) => (
                        <div
                          key={c.id}
                          className="rounded-xl border border-white/5 bg-foreground/[0.02] p-4"
                        >
                          <div className="flex items-start gap-3">
                            <div
                              className={cn(
                                "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1",
                                c.direction === "inbound"
                                  ? "bg-emerald-500/10 text-emerald-500 ring-emerald-500/25"
                                  : "bg-primary/10 text-primary ring-primary/25",
                              )}
                            >
                              {c.direction === "inbound" ? (
                                <PhoneIncoming className="w-3.5 h-3.5" />
                              ) : (
                                <PhoneOutgoing className="w-3.5 h-3.5" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold capitalize">
                                  {c.direction} call
                                </span>
                                <span
                                  className={cn(
                                    "rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1",
                                    c.status === "completed"
                                      ? "bg-emerald-500/15 text-emerald-500 ring-emerald-500/30"
                                      : "bg-foreground/[0.06] text-foreground/70 ring-white/15",
                                  )}
                                >
                                  {CALL_STATUS_LABEL[c.status] ?? c.status}
                                </span>
                                <span
                                  className={cn(
                                    "rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1",
                                    CALL_SENTIMENT_STYLE[c.sentiment] ??
                                      "bg-foreground/[0.06] text-foreground/70 ring-white/15",
                                  )}
                                >
                                  {c.sentiment}
                                </span>
                                {c.durationSeconds != null && (
                                  <span className="text-xs text-muted-foreground">
                                    {formatCallDuration(c.durationSeconds)}
                                  </span>
                                )}
                              </div>
                              {c.notes && (
                                <p className="text-sm text-muted-foreground mt-1.5 whitespace-pre-wrap">
                                  {c.notes}
                                </p>
                              )}
                              {c.recordingUrl && (
                                <audio
                                  controls
                                  preload="none"
                                  className="mt-2.5 h-9 w-full max-w-md"
                                  src={`${import.meta.env.BASE_URL}api/leads/${lead.id}/calls/${c.id}/recording`}
                                />
                              )}
                              {c.transcriptStatus === "pending" && (
                                <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                  Transcribing the conversation…
                                </div>
                              )}
                              {c.transcriptStatus === "failed" && (
                                <div className="mt-2 text-xs text-rose-400">
                                  Transcription failed — the recording is still
                                  available above.
                                </div>
                              )}
                              {c.transcript && (
                                <details className="mt-2.5 rounded-lg border border-white/10 bg-foreground/[0.03] px-3 py-2">
                                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-widest text-muted-foreground select-none">
                                    Conversation transcript
                                  </summary>
                                  <p className="mt-2 text-sm text-foreground/85 whitespace-pre-wrap">
                                    {c.transcript}
                                  </p>
                                </details>
                              )}
                              <div className="text-xs text-muted-foreground mt-1.5">
                                {formatGuyanaDateTime(c.createdAt)} · {c.actor}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground rounded-2xl border border-dashed border-white/10 p-8 text-center">
                      No calls logged yet
                      {canEdit
                        ? " — use Log call to record the first conversation."
                        : "."}
                    </div>
                  )}
                </div>
                  )}
                </div>
              )}

              {tab === "notes" && (
                <div className="space-y-5">
                  <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-4">
                    <Textarea
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Post a note — call outcome, customer comment, next step…"
                      className="bg-transparent border-white/10 resize-none min-h-[72px]"
                    />
                    <div className="flex justify-end mt-3">
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={!noteText.trim() || createNote.isPending}
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
                        Post Note
                      </Button>
                    </div>
                  </div>

                  <Section title="Lead Notes & Context">
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
                  </Section>

                  {(() => {
                    const notes = (timeline ?? []).filter(
                      (e) => e.kind === "note" || e.kind === "call_summary",
                    );
                    return notes.length > 0 ? (
                      <div className="space-y-3">
                        {notes.map((e) => (
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
                              <MessageSquare className="w-4 h-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline justify-between gap-3">
                                <span className="text-sm font-semibold truncate">
                                  {e.title}
                                </span>
                                <span className="text-[11px] text-muted-foreground shrink-0">
                                  {formatGuyanaDateTime(e.createdAt)}
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
                        No notes yet.
                      </div>
                    );
                  })()}
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
                                {formatGuyanaDateTime(e.createdAt)}
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

        {/* Right rail */}
        <div className="space-y-6 lg:sticky lg:top-6">
          {(() => {
            const linkedDeals = (allDeals ?? []).filter(
              (d) => d.leadId === lead.id,
            );
            const DEAL_STAGE_LABEL: Record<string, string> = {
              desking: "Desking",
              negotiation: "Negotiation",
              finance: "Finance",
              committed: "Committed",
              delivered: "Delivered",
              lost: "Lost",
            };
            return (
              <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center">
                      <FileText className="w-3.5 h-3.5" />
                    </span>
                    <span className="text-sm font-semibold tracking-tight">
                      Linked Deals
                    </span>
                  </div>
                  {canDeskDeal && (
                    <button
                      onClick={() => setDeskOpen(true)}
                      className="text-xs font-semibold text-primary hover:underline"
                    >
                      Desk deal
                    </button>
                  )}
                </div>
                {linkedDeals.length === 0 ? (
                  <div className="space-y-2.5">
                    <p className="text-xs text-muted-foreground">
                      {lead.phase === "negotiation" || lead.phase === "won"
                        ? "This lead is in negotiation with no deal on file — desk one now so the numbers are tracked and later stage gates can pass."
                        : "No deal yet — that's normal at this stage. The sales advisor desks the deal when negotiation starts; if a vehicle is selected, AURA auto-desks a draft deal the moment this lead advances to Negotiation."}
                    </p>
                    <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-primary mb-1">
                        Next step
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {!lead.interestedVehicleId
                          ? "Select a vehicle of interest first — a deal is always desked against a specific vehicle."
                          : lead.phase === "negotiation" || lead.phase === "won"
                            ? "Desk the deal against the selected vehicle, then take a deposit to clear the Sold-stage gates."
                            : "Complete the current stage checklist. On advancing to Negotiation, a draft deal is created automatically at the listed price for the advisor to refine."}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {linkedDeals.map((d) => (
                      <Link
                        key={d.id}
                        href="/deals"
                        className="block rounded-xl border border-white/10 bg-foreground/[0.03] px-3 py-2.5 hover:border-primary/40 transition-colors group"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium truncate">
                            Deal #{d.id}
                            {d.customerName ? ` · ${d.customerName}` : ""}
                          </span>
                          <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0">
                            {DEAL_STAGE_LABEL[d.stage] ?? d.stage}
                          </span>
                        </div>
                        <div className="flex items-center justify-between mt-1.5 text-xs text-muted-foreground">
                          <span>
                            OTD{" "}
                            <span className="text-foreground font-semibold">
                              {money.gyd(d.otdPrice)}
                            </span>
                          </span>
                          <span className="inline-flex items-center gap-1 group-hover:text-primary transition-colors">
                            Deals
                            <ArrowUpRight className="w-3 h-3" />
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-3">
              One-Tap Contact
            </div>
            <div className="space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                disabled={!lead.phone}
                onClick={() => {
                  logTouch.mutate({
                    id: lead.id,
                    data: { text: "One-tap call to customer" },
                  });
                  if (canEdit) setCallOpen(true);
                  else if (lead.phone)
                    window.location.href = `tel:${lead.phone}`;
                }}
              >
                <Phone className="w-4 h-4 text-primary" />
                Call
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                disabled={!lead.phone}
                onClick={() =>
                  oneTap(
                    `https://wa.me/${(lead.phone ?? "").replace(/\D/g, "")}`,
                    "One-tap WhatsApp to customer",
                  )
                }
              >
                <MessageSquare className="w-4 h-4 text-primary" />
                WhatsApp
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                disabled={!lead.email}
                onClick={() =>
                  oneTap(
                    `mailto:${lead.email}`,
                    "One-tap email to customer",
                    true,
                  )
                }
              >
                <Mail className="w-4 h-4 text-primary" />
                Email
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                onClick={() =>
                  oneTap(
                    "https://www.facebook.com/messages",
                    "One-tap Facebook message to customer",
                  )
                }
              >
                <Facebook className="w-4 h-4 text-primary" />
                Facebook
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                onClick={() =>
                  oneTap(
                    "https://www.instagram.com/direct/inbox/",
                    "One-tap Instagram message to customer",
                  )
                }
              >
                <Instagram className="w-4 h-4 text-primary" />
                Instagram
              </Button>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center">
                <User className="w-3.5 h-3.5" />
              </span>
              <span className="text-sm font-semibold tracking-tight">
                Sales Advisor
              </span>
            </div>
            <div className="text-sm">{ownerDisplay}</div>
            {lead.divisionId != null && (
              <div className="text-xs text-muted-foreground mt-2">
                {divisions?.find((d) => d.id === lead.divisionId)?.name ?? "—"}
              </div>
            )}
          </div>

          <TestDriveCard leadId={lead.id} onBook={() => setWorkflowOpen(true)} />

          {pendingGates.length > 0 && (
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-5">
              <div className="flex items-center gap-2 mb-3 text-amber-500">
                <span className="text-sm font-semibold tracking-tight">
                  Pending Approvals
                </span>
                <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/20">
                  {pendingGates.length}
                </span>
              </div>
              <ul className="space-y-1.5 mb-3">
                {pendingGates.map((g) => (
                  <li
                    key={g.id}
                    className="text-sm text-foreground/90 capitalize"
                  >
                    {g.type.replace(/_/g, " ")}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => setTab("overview")}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
              >
                Resolve in the Action Chain
                <ArrowUpRight className="w-3 h-3" />
              </button>
            </div>
          )}

          <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-3">
              Quick Actions
            </div>
            <div className="space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                onClick={() => setTab("documents")}
              >
                <FileText className="w-4 h-4 text-primary" />
                Build Quote
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                onClick={() => setWorkflowOpen(true)}
              >
                <Car className="w-4 h-4 text-primary" />
                Book Test Drive
              </Button>
            </div>
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
                  {money.gyd(vehicle.price)}
                </div>
              </div>
            </Link>
          )}
          {!vehicle && lead.interestedModelText && (
            <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1">
                Enquired about
              </div>
              <div className="font-semibold">{lead.interestedModelText}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Not yet matched to a unit in inventory.
              </div>
            </div>
          )}
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

      {canDeskDeal && deskOpen && (
        <CreateRecordDialog
          title="Desk a Deal for This Lead"
          description="The deal is created pre-linked to this lead so its stage gates recognize it."
          trigger={<span />}
          open={deskOpen}
          onOpenChange={setDeskOpen}
          submitLabel="Desk deal"
          pending={createDeal.isPending}
          fields={[
            {
              name: "vehicleId",
              label: "Vehicle",
              type: "select",
              required: true,
              span: "full",
              placeholder: "Select a vehicle",
              defaultValue: lead.interestedVehicleId
                ? String(lead.interestedVehicleId)
                : undefined,
              options: (vehicles ?? []).map((v) => ({
                value: String(v.id),
                label: `${v.year} ${v.make} ${v.model} — ${money.gyd(v.price)}`,
              })),
              onChange: (value, setField) => {
                const v = (vehicles ?? []).find((x) => String(x.id) === value);
                if (v) setField("vehiclePrice", String(v.price));
              },
            },
            {
              name: "customerName",
              label: "Customer",
              type: "text",
              span: "full",
              defaultValue: lead.name,
            },
            {
              name: "vehiclePrice",
              label: "Vehicle price",
              type: "number",
              required: true,
              span: "half",
              defaultValue: (() => {
                const v = (vehicles ?? []).find(
                  (x) => x.id === lead.interestedVehicleId,
                );
                return v ? String(v.price) : undefined;
              })(),
            },
            {
              name: "discount",
              label: "Discount",
              type: "number",
              span: "half",
              placeholder: "0",
            },
          ]}
          onSubmit={async (values) => {
            await createDeal.mutateAsync({
              data: {
                vehicleId: Number(values.vehicleId),
                vehiclePrice: Number(values.vehiclePrice),
                ...(values.discount != null
                  ? { discount: Number(values.discount) }
                  : {}),
                ...(values.customerName
                  ? { customerName: String(values.customerName) }
                  : {}),
                ...(lead.customerId != null
                  ? { customerId: lead.customerId }
                  : {}),
                leadId: lead.id,
              },
            });
          }}
        />
      )}

      <AlertDialog open={lostOpen} onOpenChange={setLostOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this lead as Lost?</AlertDialogTitle>
            <AlertDialogDescription>
              The lead moves to the Lost column and stops absorbing new
              enquiries — a fresh enquiry from {lead.name} will create a new
              lead. This can be reversed by editing the lead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Reason (required)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {LOST_REASONS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => setLostReasonKey(r.value)}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors",
                      lostReasonKey === r.value
                        ? "bg-primary text-white ring-primary"
                        : "bg-foreground/[0.04] text-muted-foreground ring-white/10 hover:text-foreground",
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <Textarea
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              placeholder="Extra detail (optional)"
              rows={2}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={updateLead.isPending || !lostReasonKey}
              onClick={async () => {
                const label =
                  LOST_REASONS.find((r) => r.value === lostReasonKey)?.label ??
                  lostReasonKey;
                const closureReason = lostReason.trim()
                  ? `${label} — ${lostReason.trim()}`
                  : label;
                await updateLead.mutateAsync({
                  id: lead.id,
                  data: { phase: "lost", closureReason },
                });
                await createNote.mutateAsync({
                  id: lead.id,
                  data: { text: `Marked lost: ${closureReason}` },
                });
                setLostReason("");
                setLostReasonKey("");
                setLostOpen(false);
              }}
            >
              Mark as Lost
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={reopenOpen}
        onOpenChange={(open) => {
          setReopenOpen(open);
          if (!open) setReopenStage("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reopen this lead?</AlertDialogTitle>
            <AlertDialogDescription>
              The lead leaves the Lost column and returns to the pipeline at
              the stage you pick. The closure reason is cleared.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div>
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Return to stage (required)
            </div>
            <div className="flex flex-wrap gap-1.5">
              {REOPEN_STAGES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setReopenStage(s.value)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors",
                    reopenStage === s.value
                      ? "bg-primary text-white ring-primary"
                      : "bg-foreground/[0.04] text-muted-foreground ring-white/10 hover:text-foreground",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={updateLead.isPending || !reopenStage}
              onClick={async () => {
                const target = REOPEN_STAGES.find(
                  (s) => s.value === reopenStage,
                )!;
                try {
                  await updateLead.mutateAsync({
                    id: lead.id,
                    data: {
                      phase: target.value as never,
                      status: target.status as never,
                    },
                  });
                } catch {
                  toast({
                    title: "Could not reopen the lead",
                    variant: "destructive",
                  });
                  return;
                }
                try {
                  await createNote.mutateAsync({
                    id: lead.id,
                    data: {
                      text: `Lead reopened — returned to ${target.label}.`,
                    },
                  });
                } catch {
                  // The reopen itself succeeded and is audited server-side;
                  // the note is a nicety.
                }
                setReopenStage("");
                setReopenOpen(false);
              }}
            >
              Reopen lead
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this lead?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>This removes the lead and cleans up everything linked to it:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Undelivered deals are cancelled</li>
                  <li>Active bookings are cancelled</li>
                  <li>Reserved vehicles are released back to available</li>
                  <li>Pending approvals are dismissed</li>
                </ul>
                <p>
                  The phone number and email become free for a brand-new lead
                  capture immediately.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteLead.isPending}
              onClick={() => deleteLead.mutate({ id: lead.id })}
            >
              {deleteLead.isPending ? "Deleting…" : "Delete Lead"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
