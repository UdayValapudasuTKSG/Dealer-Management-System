import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  useListDeals,
  useListLeads,
  useListVehicles,
  useCreateLead,
  useListLeadSources,
  getListLeadsQueryKey,
  useListCustomers,
  useCreateCustomer,
  useLinkLeadAccount,
  getListCustomersQueryKey,
  type Lead,
  type LeadInput,
  type ListLeadsParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Phone,
  Mail,
  ArrowUpRight,
  Car,
  Clock,
  UserCheck,
  Search,
  Link2,
  UserPlus,
  Loader2,
  X,
  ChevronDown,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { motion } from "framer-motion";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { VehicleCascade } from "@/components/vehicle-cascade";
import { VehicleInterestsField } from "@/components/vehicle-interests-field";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useViewMode } from "@/hooks/use-view-mode";
import { Pagination } from "@/components/pagination";
import { ViewControls } from "@/components/view-controls";
import { useAuthz } from "@/lib/auth";
import { SendFeedbackDialog } from "@/components/send-feedback-dialog";
import { StyledSelect } from "@/components/ui/styled-select";
import { CONTACT_SLA_HOURS, hoursSince, humanHours } from "@/lib/triage";

const STAGES = [
  "new_lead",
  "contacted",
  "engaged",
  "pre_book",
  "vehicle_allocated",
  "payment",
  "pre_delivery",
  "delivered",
] as const;
type Stage = (typeof STAGES)[number];

const STAGE_LABEL: Record<Stage, string> = {
  new_lead: "New",
  contacted: "Contacted",
  engaged: "Engaged",
  pre_book: "Pre-Book",
  vehicle_allocated: "Vehicle Allocated",
  payment: "Payment",
  pre_delivery: "Pre-Delivery",
  delivered: "Delivered",
};

// Four master phases drive the queue tabs; the 8 rail stages fold into them.
type Macro = "lead" | "prebooking" | "payment" | "delivery";

const MACRO_OF: Record<Stage, Macro> = {
  new_lead: "lead",
  contacted: "lead",
  engaged: "lead",
  pre_book: "prebooking",
  vehicle_allocated: "prebooking",
  payment: "payment",
  pre_delivery: "delivery",
  delivered: "delivery",
};

const MACRO_LABEL: Record<Macro, string> = {
  lead: "Lead",
  prebooking: "Pre-Booking",
  payment: "Payment",
  delivery: "Delivery",
};

const MACRO_ORDER: Macro[] = ["lead", "prebooking", "payment", "delivery"];

const SOURCE_LABEL: Record<string, string> = {
  website: "Website",
  walk_in: "Walk-in",
  phone: "Phone",
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  referral: "Referral",
  social_media: "Social Media",
  gmail: "Email",
  email: "Email",
};

const SOCIAL_SUB_PLATFORMS = [
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "youtube", label: "YouTube" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "other", label: "Other" },
];

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

const PRIORITY_STYLE: Record<string, string> = {
  high: "bg-primary/15 text-primary ring-primary/30",
  medium: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  low: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
};

const withBase = (url: string) =>
  `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`;

/** Contact SLA: shared 48h window from createdAt until the lead is contacted. Null once
 * contacted (or past the contacted status). */
function contactSla(lead: {
  status: string;
  contactedDate?: Date | string | null;
  createdAt: Date | string;
}): { left: number; overdue: boolean } | null {
  const contacted =
    !!lead.contactedDate ||
    (lead.status !== "new" && lead.status !== "assigned");
  if (contacted) return null;
  const elapsed = hoursSince(String(lead.createdAt));
  const left = CONTACT_SLA_HOURS - elapsed;
  return { left, overdue: left <= 0 };
}

function removeToken(q: string, key: string): string {
  const regex = new RegExp(`(?:^|\\s)${key}:(?:"[^"]+"|[^\\s]+)`, "gi");
  return q.replace(regex, "").replace(/\s+/g, " ").trim();
}

function setToken(q: string, key: string, value: string): string {
  let newQ = removeToken(q, key);
  if (value) {
    const safeValue = value.includes(" ") ? `"${value}"` : value;
    newQ = `${newQ} ${key}:${safeValue}`.trim();
  }
  return newQ;
}

export default function Leads() {
  const [, navigate] = useLocation();
  const searchStr = useSearch();
  const searchParams = new URLSearchParams(searchStr);
  const createdFrom = searchParams.get("from") || "";
  const createdTo = searchParams.get("to") || "";

  const initialAdvisor = searchParams.get("advisor");
  const initialSource = searchParams.get("source");
  const initialPhase = searchParams.get("phase");

  const [filterQuery, setFilterQuery] = useState(() => {
    let q = "";
    if (initialAdvisor) q += `advisor:"${initialAdvisor}" `;
    if (initialSource) q += `source:"${initialSource}" `;
    if (initialPhase) q += `phase:"${initialPhase}" `;
    return q.trim();
  });

  const updateDateRange = (from: string, to: string) => {
    const next = new URLSearchParams(searchStr);
    if (from) next.set("from", from);
    else next.delete("from");

    if (to) next.set("to", to);
    else next.delete("to");

    navigate(`~?${next.toString()}`, { replace: true });
  };

  const isInvalidRange = Boolean(createdFrom && createdTo && new Date(createdFrom) > new Date(createdTo));

  const leadQueryParams: ListLeadsParams = {
    createdFrom: createdFrom || undefined,
    createdTo: createdTo || undefined,
  };
  const { data: leads, isLoading } = useListLeads(leadQueryParams, {
    query: {
      queryKey: getListLeadsQueryKey(leadQueryParams),
      enabled: !isInvalidRange,
    },
  });
  const { data: vehicles } = useListVehicles();
  const { data: deals } = useListDeals();
  const { data: leadSources } = useListLeadSources();
  const { data: accounts } = useListCustomers();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createLead = useCreateLead();
  const { me } = useAuthz();
  const { density, setDensity, layout, setLayout } = useViewMode("pipeline");
  const [slaClock, setSlaClock] = useState(() => Date.now());

  // The data query need not refetch just to tick a visual countdown. Rebuild
  // the derived rows once a minute so the displayed value and SLA sort remain
  // accurate while a user keeps the pipeline open.
  useEffect(() => {
    const timer = window.setInterval(() => setSlaClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Social sub-platform lives outside the dialog's own field state because
  // its visibility depends on the selected source (config-driven).
  const [newSource, setNewSource] = useState<string>("");
  const [sourceDetail, setSourceDetail] = useState<string>("");
  const selectedSourceCfg = (leadSources ?? []).find(
    (s) => s.code === (newSource || "website"),
  );

  const filters = useMemo(() => {
    const regex = /(?:([a-z0-9_-]+):"([^"]+)")|(?:([a-z0-9_-]+):([^\s]+))|(?:"([^"]+)")|([^\s]+)/gi;

    let isMine = false;
    let phase: Macro | "lost" | "all" = "all";
    let source = "__all__";
    let advisor = "all";
    const text: string[] = [];

    let match;
    while ((match = regex.exec(filterQuery)) !== null) {
      const key = (match[1] || match[3])?.toLowerCase();
      const val = match[2] || match[4];
      const textQuote = match[5];
      const textPlain = match[6];

      if (key && val) {
        const vLower = val.toLowerCase();
        if (key === "is" && vLower === "mine") isMine = true;
        else if (
          key === "phase" &&
          (vLower === "lead" ||
            vLower === "prebooking" ||
            vLower === "payment" ||
            vLower === "delivery" ||
            vLower === "lost")
        ) {
          phase = vLower;
        }
        else if (key === "source") source = val;
        else if (key === "advisor") advisor = val;
        else text.push(match[0]);
      } else if (textQuote) {
        text.push(textQuote);
      } else if (textPlain) {
        text.push(textPlain);
      }
    }

    return {
      isMine,
      phase,
      source,
      advisor,
      search: text.join(" ").toLowerCase()
    };
  }, [filterQuery]);

  const compact = density === "compact";
  const myId = me?.id ?? null;
  const myName = me?.name?.trim().toLowerCase() ?? null;
  const isLeadership =
    !!me && (me.isSuperAdmin || me.roleName === "General Manager");

  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // Three-state sort cycle: ascending → descending → off (original order).
  const toggleSort = (key: string) => {
    if (sortKey === key) {
      if (sortDir === "asc") {
        setSortDir("desc");
      } else {
        setSortKey(null);
        setSortDir("asc");
      }
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // Derive the rail stage for a lead: pre-sale stages map 1:1 from the lead
  // phase; won leads split into Vehicle Allocated / Payment / Pre-Delivery /
  // Delivered by their furthest-along linked deal. Lost leads → null.
  const stageOf = useMemo(() => {
    const rank = (stage: string) =>
      stage === "delivered" ? 3 : stage === "committed" ? 2 : 0;
    const dealByLead = new Map<number, string>();
    const dealByCustomer = new Map<number, string>();
    for (const d of deals ?? []) {
      if (d.leadId != null) {
        const prev = dealByLead.get(d.leadId);
        if (prev === undefined || rank(d.stage) > rank(prev))
          dealByLead.set(d.leadId, d.stage);
      }
      if (d.customerId != null) {
        const prev = dealByCustomer.get(d.customerId);
        if (prev === undefined || rank(d.stage) > rank(prev))
          dealByCustomer.set(d.customerId, d.stage);
      }
    }
    return (l: {
      id: number;
      phase: string;
      customerId?: number | null;
    }): Stage | null => {
      switch (l.phase) {
        case "new":
          return "new_lead";
        case "contacted":
          return "contacted";
        case "qualified":
        case "proposal":
          return "engaged";
        case "negotiation":
          return "pre_book";
        case "won": {
          const dealStage =
            dealByLead.get(l.id) ??
            (l.customerId != null
              ? dealByCustomer.get(l.customerId)
              : undefined);
          if (dealStage === "delivered") return "delivered";
          if (dealStage === "committed") return "pre_delivery";
          return "vehicle_allocated";
        }
        default:
          return null; // lost
      }
    };
  }, [deals]);

  const isMine = (l: {
    ownerUserId?: number | null;
    assignedTo?: string | null;
  }) =>
    (myId != null && l.ownerUserId === myId) ||
    (l.ownerUserId == null &&
      myName != null &&
      (l.assignedTo ?? "").trim().toLowerCase() === myName);

  // Enrich every lead once with its stage, macro phase, vehicle, customer
  // location, preferred branch and SLA.
  const rows = useMemo(() => {
    const q = filters.search;
    const customerById = new Map(
      (accounts ?? []).map((customer) => [customer.id, customer]),
    );
    return (leads ?? [])
      .map((lead) => {
        const stage = stageOf(lead);
        const macro = stage ? MACRO_OF[stage] : null;
        const vehicle = vehicles?.find(
          (v) => v.id === lead.interestedVehicleId,
        );
        const model = vehicle
          ? `${vehicle.make} ${vehicle.model}`
          : (lead.selectedModel ?? lead.interestedModelText ?? null);
        const customer =
          lead.customerId != null ? customerById.get(lead.customerId) : null;
        const locationParts = [
          customer?.location,
          customer?.city,
          customer?.country,
        ].reduce<string[]>((parts, value) => {
          const normalized = value?.trim();
          if (
            normalized &&
            !parts.some(
              (part) => part.toLowerCase() === normalized.toLowerCase(),
            )
          ) {
            parts.push(normalized);
          }
          return parts;
        }, []);
        const customerLocation =
          locationParts.join(", ") ||
          customer?.address?.trim() ||
          lead.address?.trim() ||
          null;
        const preferredBranch = lead.preferredBranch?.trim() || null;
        const sla = contactSla(lead);
        return {
          lead,
          stage,
          macro,
          vehicle,
          model,
          customerLocation,
          preferredBranch,
          sla,
        };
      })
      .filter((r) => {
        if (!q) return true;
        const l = r.lead;
        return (
          l.name.toLowerCase().includes(q) ||
          (r.model ?? "").toLowerCase().includes(q) ||
          (r.customerLocation ?? "").toLowerCase().includes(q) ||
          (r.preferredBranch ?? "").toLowerCase().includes(q) ||
          (l.phone ?? "").toLowerCase().includes(q) ||
          (l.email ?? "").toLowerCase().includes(q) ||
          (l.assignedTo ?? "").toLowerCase().includes(q)
        );
      });
  }, [leads, vehicles, accounts, stageOf, filters.search, slaClock]);

  const advisorOptions = useMemo(
    () =>
      Array.from(
        new Set(
          (leads ?? [])
            .map((l) => (l.assignedTo ?? "").trim())
            .filter((a) => a.length > 0),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [leads],
  );

  // Source options: configured lead sources plus any legacy/ad-hoc codes
  // still present on leads, so no lead is ever unfilterable.
  const sourceOptions = useMemo(() => {
    const byCode = new Map<string, string>();
    for (const s of leadSources ?? []) byCode.set(s.code, s.name);
    for (const l of leads ?? []) {
      const code = (l.source ?? "").trim();
      if (code && !byCode.has(code))
        byCode.set(code, SOURCE_LABEL[code] ?? code);
    }
    return Array.from(byCode, ([code, label]) => ({ code, label })).sort(
      (a, b) => a.label.localeCompare(b.label),
    );
  }, [leadSources, leads]);

  const visible = useMemo(() => {
    return rows.filter((r) => {
      if (filters.source !== "__all__" && r.lead.source !== filters.source)
        return false;
      if (
        filters.advisor !== "all" &&
        (r.lead.assignedTo ?? "").trim() !== filters.advisor
      )
        return false;
      if (filters.isMine && !isMine(r.lead)) return false;
      if (filters.phase !== "all") {
        if (filters.phase === "lost") {
          if (r.macro !== null) return false;
        } else {
          if (r.macro !== filters.phase) return false;
        }
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters.phase, filters.isMine, filters.advisor, filters.source, myId, myName]);

  const PAGE_SIZE = layout === "list" ? 25 : compact ? 30 : 24;
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [filterQuery, createdFrom, createdTo, layout, density]);
  const sortedVisible = useMemo(() => {
    if (!sortKey) return visible;
    const dir = sortDir === "asc" ? 1 : -1;
    const stageOrder: readonly string[] = STAGES;
    const val = (
      r: (typeof visible)[number],
    ): string | number | null => {
      switch (sortKey) {
        case "client": return r.lead.name.toLowerCase();
        case "model": return r.model?.toLowerCase() ?? null;
        case "location": return r.customerLocation?.toLowerCase() ?? null;
        case "branch": return r.preferredBranch?.toLowerCase() ?? null;
        case "phase": {
          if (!r.stage) return stageOrder.length; // Lost sorts last
          const idx = stageOrder.indexOf(r.stage);
          return idx === -1 ? stageOrder.length : idx;
        }
        case "advisor": return (r.lead.assignedTo ?? "").toLowerCase();
        case "sla":
          // Contacted (no SLA) sorts last; overdue first when ascending.
          return r.sla ? r.sla.left : Number.MAX_SAFE_INTEGER;
        default: return 0;
      }
    };
    return [...visible].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      const aEmpty = av == null || av === "";
      const bEmpty = bv == null || bv === "";
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      if (av == null || bv == null) return 0;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [visible, sortKey, sortDir]);
  const pageCount = Math.max(1, Math.ceil(sortedVisible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const paged = useMemo(
    () => sortedVisible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [sortedVisible, safePage, PAGE_SIZE],
  );

  // GM bulk feedback-form selection: checkboxes on the list view plus a
  // "select all filtered" that spans every result page (not just the visible
  // one). The send dialog can also target all_matching via server filters.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sendFeedbackOpen, setSendFeedbackOpen] = useState(false);
  const toggleSelected = (id: number) =>
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pageIds = paged.map((r) => r.lead.id);
  const allPageSelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const togglePage = () =>
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  const selectAllFiltered = () =>
    setSelectedIds(new Set(sortedVisible.map((r) => r.lead.id)));

  // Link-account dialog: pick an existing account or create one from the lead.
  const [linkTarget, setLinkTarget] = useState<Lead | null>(null);
  const [accountSearch, setAccountSearch] = useState("");
  const linkAccount = useLinkLeadAccount();
  const createCustomer = useCreateCustomer();
  const linkBusy = linkAccount.isPending || createCustomer.isPending;

  const matchedAccounts = useMemo(() => {
    const list = accounts ?? [];
    const q = accountSearch.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.email ?? "").toLowerCase().includes(q) ||
            (c.phone ?? "").replace(/\D/g, "").includes(q.replace(/\D/g, "") || "\u0000"),
        )
      : list;
    return filtered.slice(0, 8);
  }, [accounts, accountSearch]);

  const finishLink = async (leadId: number, customerId: number, name: string) => {
    try {
      await linkAccount.mutateAsync({ id: leadId, data: { customerId } });
      await queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      toast({ title: "Account linked", description: `Lead linked to ${name}.` });
      setLinkTarget(null);
      setAccountSearch("");
    } catch (e) {
      toast({
        title: "Could not link account",
        description: e instanceof Error ? e.message : "Unexpected error",
        variant: "destructive",
      });
    }
  };

  const createAndLink = async (lead: Lead) => {
    try {
      const customer = await createCustomer.mutateAsync({
        data: {
          name: lead.name,
          email: lead.email || undefined,
          phone: lead.phone || undefined,
          accountType: "person",
        },
      });
      await queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      await finishLink(lead.id, customer.id, customer.name);
    } catch (e: unknown) {
      // Duplicate email/phone → the API returns the existing account id in
      // the ApiError payload (error.data.existingId); link that account.
      const existingId = (e as { data?: { existingId?: number } | null })?.data
        ?.existingId;
      if (existingId) {
        await finishLink(lead.id, existingId, "the existing matching account");
        return;
      }
      toast({
        title: "Could not create account",
        description: e instanceof Error ? e.message : "Unexpected error",
        variant: "destructive",
      });
    }
  };

  function SlaChip({ sla }: { sla: { left: number; overdue: boolean } | null }) {
    if (!sla) {
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
          <Clock className="w-3 h-3" />
          Contacted
        </span>
      );
    }
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full",
          sla.overdue
            ? "text-red-400 bg-red-500/10"
            : "text-amber-400 bg-amber-500/10",
        )}
      >
        <Clock className="w-3 h-3" />
        {sla.overdue
          ? `Overdue ${humanHours(-sla.left)}`
          : `${Math.max(1, Math.floor(sla.left))}h left`}
      </span>
    );
  }

  const heroActions = (
    <div className="flex items-center gap-3">
            <ViewControls
              layout={layout}
              onLayoutChange={setLayout}
              density={density}
              onDensityChange={setDensity}
            />
            <CreateRecordDialog
              title="New Lead"
              description="Capture a prospect — AURA scores and routes it instantly."
              pending={createLead.isPending}
              submitLabel="Add to pipeline"
              trigger={
                <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-4 h-9 text-sm shadow-md shadow-primary/20 gap-1.5 font-medium tracking-wide">
                  <Plus className="w-4 h-4" />
                  New Lead
                </Button>
              }
              fields={[
                { name: "name", label: "Name", type: "text", required: true, span: "full", placeholder: "Kojo Asante", section: "Prospect" },
                { name: "phone", label: "Phone", type: "phone", required: true, span: "half", placeholder: "+592", section: "Prospect" },
                { name: "email", label: "Email", type: "email", required: true, span: "half", placeholder: "kojo@email.com", section: "Prospect" },
                { name: "address", label: "Address", type: "text", required: true, span: "full", placeholder: "Lot 12 Main Street, Georgetown", section: "Prospect" },
                {
                  name: "source",
                  label: "Lead source",
                  type: "select",
                  required: true,
                  span: "half",
                  section: "Enquiry",
                  defaultValue: "website",
                  options:
                    leadSources && leadSources.length > 0
                      ? leadSources.map((s) => ({ value: s.code, label: s.name }))
                      : Object.entries(SOURCE_LABEL).map(([value, label]) => ({
                          value,
                          label,
                        })),
                  onChange: (v: string) => {
                    setNewSource(v);
                    setSourceDetail("");
                  },
                },
                ...(selectedSourceCfg?.isSocial
                  ? [
                      {
                        name: "sourceDetail",
                        label: "Social platform",
                        type: "custom" as const,
                        required: true,
                        span: "half" as const,
                        section: "Enquiry",
                        render: (_value: string, set: (v: string) => void) => (
                          <StyledSelect
                            value={sourceDetail}
                            onValueChange={(value) => {
                              setSourceDetail(value);
                              set(value);
                            }}
                            options={[
                              { value: "", label: "Pick a platform…" },
                              ...SOCIAL_SUB_PLATFORMS,
                            ]}
                            className="w-full h-10 rounded-md bg-white/[0.04] border border-white/10 px-3 text-sm focus:outline-none focus:border-primary/50"
                          />
                        ),
                      },
                    ]
                  : []),
                {
                  name: "vehicleInterests",
                  label: "Interested vehicles",
                  type: "custom",
                  required: true,
                  span: "full",
                  section: "Enquiry",
                  render: (value, set) => (
                    <VehicleInterestsField
                      value={value}
                      onChange={set}
                      vehicles={vehicles ?? []}
                    />
                  ),
                },
                {
                  name: "isRetailCustomer",
                  label: "Retail customer",
                  type: "custom",
                  span: "half",
                  section: "Enquiry",
                  render: (value, set) => (
                    <label className="flex items-center gap-2.5 h-10 px-3 rounded-md bg-white/[0.04] border border-white/10 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={value === "true"}
                        onChange={(e) => set(e.target.checked ? "true" : "")}
                        className="w-4 h-4 accent-[var(--primary)] rounded"
                      />
                      <span className="text-sm">Is a retail customer</span>
                    </label>
                  ),
                },
                {
                  name: "priority",
                  label: "Priority (optional)",
                  type: "select",
                  required: false,
                  span: "half",
                  section: "Enquiry",
                  defaultValue: "medium",
                  options: [
                    { value: "high", label: "High" },
                    { value: "medium", label: "Medium" },
                    { value: "low", label: "Low" },
                  ],
                },
                { name: "notes", label: "Notes", type: "textarea", span: "full", placeholder: "Optional — what are they looking for?", section: "Details" },
              ]}
              onSubmit={async (values) => {
                const payload = { ...values };
                // The channel is implied by the lead source rather than asked
                // twice: social sources → social, walk-in → walkin, else web.
                payload.channel = selectedSourceCfg?.isSocial
                  ? "social"
                  : ["walk_in", "walkin"].includes(String(payload.source))
                    ? "walkin"
                    : "web";
                payload.isRetailCustomer = payload.isRetailCustomer === "true";
                if (payload.vehicleInterests) {
                  try {
                    const parsedInterests = JSON.parse(payload.vehicleInterests as string);
                    payload.vehicleInterests = parsedInterests;

                    if (parsedInterests.length > 0 && parsedInterests[0].vehicleId != null) {
                      const firstVehicleId = parsedInterests[0].vehicleId;
                      const v = (vehicles ?? []).find((x) => x.id === firstVehicleId);
                      if (v) {
                        const version = v.trim || v.variant;
                        if (version) payload.variant = version;
                        if (v.exteriorColor) payload.color = v.exteriorColor;
                        payload.selectedModel = [v.make, v.model, version]
                          .filter(Boolean)
                          .join(" ");
                      }
                    }
                  } catch {
                    delete payload.vehicleInterests;
                  }
                }
                const result = await createLead.mutateAsync({
                  data: payload as unknown as LeadInput,
                });
                queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
                if (result.merged) {
                  toast({
                    title: "Merged into an existing lead",
                    description:
                      result.mergeNotice ??
                      "This enquiry matched an open lead, so it was merged instead of creating a duplicate.",
                  });
                } else {
                  toast({ title: "Lead captured", description: "AURA is scoring and routing this prospect." });
                }
              }}
            />
    </div>
  );

  return (
    <>
      <PageHero
        eyebrow="Sales"
        title="Pipeline"
        subtitle="Every lead, from first enquiry to delivery."
        className="pb-3"
        action={heroActions}
      />
      <Page className="space-y-3 pt-0">
        <div className="flex flex-col gap-3 mt-2 mb-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1 flex items-center group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
              <Input
                value={filterQuery}
                onChange={e => setFilterQuery(e.target.value)}
                className="w-full pl-9 bg-foreground/[0.02] border-white/10 font-mono text-sm focus-visible:ring-1 focus-visible:ring-primary/50"
                placeholder="Filter by text or tags (e.g. is:mine phase:lead source:website)"
                data-testid="input-pipeline-search"
              />
              {filterQuery && (
                 <button
                   type="button"
                   onClick={() => setFilterQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  data-testid="btn-clear-query"
                   aria-label="Clear filter query"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="gap-2 bg-foreground/[0.02] border-white/10 whitespace-nowrap shrink-0" data-testid="btn-filters-menu">
                  Filters <ChevronDown className="w-4 h-4 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[320px] p-4 flex flex-col gap-4 border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Ownership</Label>
                  <Select value={filters.isMine ? "mine" : "all"} onValueChange={v => setFilterQuery(setToken(filterQuery, 'is', v === 'mine' ? 'mine' : ''))}>
                    <SelectTrigger className="bg-foreground/[0.02] border-white/10 h-8 text-sm" data-testid="select-filter-ownership">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Everything</SelectItem>
                      <SelectItem value="mine">Assigned to me</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Phase</Label>
                  <Select value={filters.phase} onValueChange={v => setFilterQuery(setToken(filterQuery, 'phase', v === 'all' ? '' : v))}>
                    <SelectTrigger className="bg-foreground/[0.02] border-white/10 h-8 text-sm" data-testid="select-filter-phase">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All phases</SelectItem>
                      {MACRO_ORDER.map(m => <SelectItem key={m} value={m}>{MACRO_LABEL[m]}</SelectItem>)}
                      <SelectItem value="lost">Lost</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Source</Label>
                  <Select value={filters.source} onValueChange={v => setFilterQuery(setToken(filterQuery, 'source', v === '__all__' ? '' : v))}>
                    <SelectTrigger className="bg-foreground/[0.02] border-white/10 h-8 text-sm" data-testid="select-filter-source">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All sources</SelectItem>
                      {sourceOptions.map(s => <SelectItem key={s.code} value={s.code}>{s.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                {isLeadership && advisorOptions.length > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Advisor</Label>
                    <Select value={filters.advisor} onValueChange={v => setFilterQuery(setToken(filterQuery, 'advisor', v === 'all' ? '' : v))}>
                      <SelectTrigger className="bg-foreground/[0.02] border-white/10 h-8 text-sm" data-testid="select-filter-advisor">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All advisors</SelectItem>
                        {advisorOptions.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Created Date</Label>
                  <div className="flex gap-2">
                    <Input
                      type="date"
                      value={createdFrom}
                      onChange={e => updateDateRange(e.target.value, createdTo)}
                      className="flex-1 bg-foreground/[0.02] border-white/10 h-8 text-xs"
                      data-testid="input-filter-date-from"
                    />
                    <Input
                      type="date"
                      value={createdTo}
                      onChange={e => updateDateRange(createdFrom, e.target.value)}
                      className="flex-1 bg-foreground/[0.02] border-white/10 h-8 text-xs"
                      data-testid="input-filter-date-to"
                    />
                  </div>
                  {isInvalidRange && (
                    <p className="text-xs text-red-400" role="alert" data-testid="error-filter-date-range">
                      Start date must be before or equal to end date.
                    </p>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 min-h-[24px]">
            <div className="flex flex-wrap items-center gap-2">
              {(filters.isMine || filters.phase !== "all" || filters.source !== "__all__" || filters.advisor !== "all" || createdFrom || createdTo) && (
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mr-1 flex items-center h-6">Active:</span>
              )}

              {filters.isMine && (
                <Badge variant="secondary" className="gap-1.5 bg-primary/10 text-primary hover:bg-primary/20 border-primary/20 transition-colors h-6 rounded-md px-2" data-testid="badge-filter-ownership">
                  Owner: Mine
                   <button type="button" aria-label="Remove ownership filter" onClick={() => setFilterQuery(removeToken(filterQuery, 'is'))} className="opacity-70 hover:opacity-100" data-testid="btn-remove-filter-ownership"><X className="w-3 h-3" /></button>
                </Badge>
              )}

              {filters.phase !== "all" && (
                <Badge variant="secondary" className="gap-1.5 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 border-sky-500/20 transition-colors h-6 rounded-md px-2" data-testid="badge-filter-phase">
                  Phase: {filters.phase === "lost" ? "Lost" : MACRO_LABEL[filters.phase as Macro]}
                   <button type="button" aria-label="Remove phase filter" onClick={() => setFilterQuery(removeToken(filterQuery, 'phase'))} className="opacity-70 hover:opacity-100" data-testid="btn-remove-filter-phase"><X className="w-3 h-3" /></button>
                </Badge>
              )}

              {filters.source !== "__all__" && (
                <Badge variant="secondary" className="gap-1.5 bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 border-violet-500/20 transition-colors h-6 rounded-md px-2" data-testid="badge-filter-source">
                  Source: {SOURCE_LABEL[filters.source] || filters.source}
                   <button type="button" aria-label="Remove source filter" onClick={() => setFilterQuery(removeToken(filterQuery, 'source'))} className="opacity-70 hover:opacity-100" data-testid="btn-remove-filter-source"><X className="w-3 h-3" /></button>
                </Badge>
              )}

              {filters.advisor !== "all" && (
                <Badge variant="secondary" className="gap-1.5 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border-amber-500/20 transition-colors h-6 rounded-md px-2" data-testid="badge-filter-advisor">
                  Advisor: {filters.advisor}
                   <button type="button" aria-label="Remove advisor filter" onClick={() => setFilterQuery(removeToken(filterQuery, 'advisor'))} className="opacity-70 hover:opacity-100" data-testid="btn-remove-filter-advisor"><X className="w-3 h-3" /></button>
                </Badge>
              )}

              {(createdFrom || createdTo) && (
                <Badge
                  variant="secondary"
                  className={cn(
                    "gap-1.5 transition-colors h-6 rounded-md px-2",
                    isInvalidRange
                      ? "bg-red-500/10 text-red-400 hover:bg-red-500/20 border-red-500/20"
                      : "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border-emerald-500/20",
                  )}
                  data-testid="badge-filter-date"
                >
                  Date: {[createdFrom, createdTo].filter(Boolean).join(" - ")}
                   <button type="button" aria-label="Remove created date filter" onClick={() => updateDateRange("", "")} className="opacity-70 hover:opacity-100" data-testid="btn-remove-filter-date"><X className="w-3 h-3" /></button>
                </Badge>
              )}

              {(filters.isMine || filters.phase !== "all" || filters.source !== "__all__" || filters.advisor !== "all" || createdFrom || createdTo) && (
                <button
                   type="button"
                  onClick={() => {
                    setFilterQuery("");
                    updateDateRange("", "");
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2 ml-1"
                  data-testid="btn-clear-all-filters"
                >
                  Clear all
                </button>
              )}
            </div>

            <div className="text-sm font-medium text-muted-foreground" data-testid="text-filter-count">
              <span className="text-foreground">{sortedVisible.length}</span> {sortedVisible.length === 1 ? 'result' : 'results'}
            </div>
          </div>
        </div>

        {isLeadership && selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/30 bg-primary/[0.07] px-4 py-2.5">
            <span className="text-sm font-semibold">
              {selectedIds.size} lead{selectedIds.size === 1 ? "" : "s"} selected
            </span>
            {selectedIds.size < sortedVisible.length && (
              <button
                type="button"
                onClick={selectAllFiltered}
                className="text-xs font-semibold text-primary hover:underline"
              >
                Select all {sortedVisible.length} filtered leads
              </button>
            )}
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear selection
            </button>
            <div className="flex-1" />
            <Button
              size="sm"
              onClick={() => setSendFeedbackOpen(true)}
              className="rounded-full h-8 text-xs bg-primary hover:bg-primary/90"
            >
              Send Feedback Form
            </Button>
          </div>
        )}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-16 rounded-2xl bg-foreground/[0.04] animate-pulse"
              />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-40 rounded-2xl border-2 border-dashed border-border/60 text-muted-foreground/60 text-sm uppercase tracking-widest font-semibold">
            No leads in this view
          </div>
        ) : layout === "list" ? (
          /* List view — dense table */
          <div className="glass-panel rounded-2xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                  {isLeadership && (
                    <th className="pl-4 pr-1 py-3 w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all leads on this page"
                        checked={allPageSelected}
                        onChange={togglePage}
                        className="w-4 h-4 accent-[var(--primary)] cursor-pointer align-middle"
                      />
                    </th>
                  )}
                  {(
                    [
                      ["Client", "client"],
                      ["Model", "model"],
                      ["Customer location", "location"],
                      ["Preferred branch", "branch"],
                      ["Phase", "phase"],
                      ["Advisor", "advisor"],
                      ["Contact SLA", "sla"],
                    ] as const
                  ).map(([label, k]) => (
                    <th key={k} className="px-4 py-3 font-semibold">
                      <button
                        onClick={() => toggleSort(k)}
                        className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-foreground transition-colors"
                      >
                        {label}
                        <span className="text-[9px] leading-none">
                          {sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : ""}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.map((r) => (
                  <tr
                    key={r.lead.id}
                    onClick={() => navigate(`/lead/${r.lead.id}`)}
                    className={cn(
                      "border-b border-white/5 last:border-0 cursor-pointer hover:bg-foreground/[0.04] transition-colors",
                      compact ? "h-11" : "h-14",
                    )}
                  >
                    {isLeadership && (
                      <td
                        className="pl-4 pr-1 py-2 w-8"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.lead.name}`}
                          checked={selectedIds.has(r.lead.id)}
                          onChange={() => toggleSelected(r.lead.id)}
                          className="w-4 h-4 accent-[var(--primary)] cursor-pointer align-middle"
                        />
                      </td>
                    )}
                    <td className="px-4 py-2">
                      <div className="font-medium truncate max-w-[200px]">
                        {r.lead.name}
                      </div>
                      {!compact && (
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                          {r.lead.phone && (
                            <span className="inline-flex items-center gap-1">
                              <Phone className="w-3 h-3" />
                              {r.lead.phone}
                            </span>
                          )}
                          {r.lead.email && (
                            <span className="inline-flex items-center gap-1 truncate max-w-[160px]">
                              <Mail className="w-3 h-3" />
                              {r.lead.email}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground truncate max-w-[180px]">
                      {r.model ?? "—"}
                    </td>
                    <td
                      className="px-4 py-2 text-muted-foreground truncate max-w-[190px]"
                      title={r.customerLocation ?? "No customer location"}
                    >
                      {r.customerLocation ?? (
                        <span className="text-muted-foreground/50">Not provided</span>
                      )}
                    </td>
                    <td
                      className="px-4 py-2 text-muted-foreground truncate max-w-[160px]"
                      title={r.preferredBranch ?? "No preferred branch"}
                    >
                      {r.preferredBranch ?? (
                        <span className="text-muted-foreground/50">Not provided</span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {r.stage ? (
                        <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                          {STAGE_LABEL[r.stage]}
                        </span>
                      ) : (
                        <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-foreground/[0.06] px-2 py-0.5 rounded-full">
                          Lost
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground truncate max-w-[150px]">
                      {r.lead.assignedTo || (
                        <span className="text-amber-400">Needs advisor</span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <SlaChip sla={r.sla} />
                        {!r.lead.customerId && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setLinkTarget(r.lead);
                            }}
                            className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-primary inline-flex items-center gap-0.5 transition-colors"
                            title="Link or create a customer account"
                          >
                            <Link2 className="w-3 h-3" />
                            Link
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          /* Card view — compact cards */
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {paged.map((r, i) => (
              <motion.div
                key={r.lead.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.3) }}
                onClick={() => navigate(`/lead/${r.lead.id}`)}
                className="group rounded-2xl border border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06] hover:border-primary/30 transition-all duration-300 cursor-pointer p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="shrink-0 w-12 h-12 rounded-xl overflow-hidden bg-foreground/[0.04] flex items-center justify-center">
                    {r.vehicle?.imageUrl ? (
                      <img
                        src={withBase(r.vehicle.imageUrl)}
                        alt={`${r.vehicle.make} ${r.vehicle.model}`}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                      />
                    ) : (
                      <Car className="w-5 h-5 text-muted-foreground/30" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold leading-tight truncate group-hover:text-primary transition-colors">
                      {r.lead.name}
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                      {r.model ?? SOURCE_LABEL[r.lead.source] ?? r.lead.source}
                    </div>
                  </div>
                  {r.lead.customerId ? (
                    <Link
                      href={`/customers/${r.lead.customerId}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] font-bold uppercase tracking-wider text-primary inline-flex items-center gap-0.5 hover:underline shrink-0"
                    >
                      Account
                      <ArrowUpRight className="w-3 h-3" />
                    </Link>
                  ) : me?.roleName === "Sales Advisor" && !isMine(r.lead) ? null : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setLinkTarget(r.lead);
                      }}
                      className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-primary inline-flex items-center gap-0.5 shrink-0 transition-colors"
                      title="Link or create a customer account"
                    >
                      <Link2 className="w-3 h-3" />
                      Link account
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1.5 flex-wrap mt-3">
                  {r.stage ? (
                    <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                      {STAGE_LABEL[r.stage]}
                    </span>
                  ) : (
                    <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-foreground/[0.06] px-2 py-0.5 rounded-full">
                      Lost
                    </span>
                  )}
                  <span
                    className={cn(
                      "inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1",
                      PRIORITY_STYLE[r.lead.priority] ?? PRIORITY_STYLE.low,
                    )}
                  >
                    {r.lead.priority}
                  </span>
                  <SlaChip sla={r.sla} />
                </div>

                <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-white/5">
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground truncate">
                    {r.lead.assignedTo ? (
                      <>
                        <UserCheck className="w-3.5 h-3.5" />
                        {r.lead.assignedTo}
                      </>
                    ) : (
                      <span className="text-amber-400 font-semibold uppercase tracking-wider text-[10px]">
                        Needs advisor
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-2 text-muted-foreground/70 shrink-0">
                    {r.lead.phone && <Phone className="w-3.5 h-3.5" />}
                    {r.lead.email && <Mail className="w-3.5 h-3.5" />}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {!isLoading && visible.length > 0 && (
          <>
            {visible.length > PAGE_SIZE && (
              <div className="text-center text-xs text-muted-foreground tabular-nums">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, visible.length)} of{" "}
                {visible.length}
              </div>
            )}
            <Pagination
              page={safePage}
              pageCount={pageCount}
              onPageChange={(p) => {
                setPage(p);
                document
                  .querySelector("main, [data-page-scroll]")
                  ?.scrollTo({ top: 0 });
                window.scrollTo({ top: 0 });
              }}
            />
          </>
        )}
        <Dialog
          open={linkTarget != null}
          onOpenChange={(open) => {
            if (!open) {
              setLinkTarget(null);
              setAccountSearch("");
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Link customer account</DialogTitle>
              <DialogDescription>
                {linkTarget
                  ? `Attach ${linkTarget.name} to an existing account, or open a new one from their details.`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                  placeholder="Search accounts by name, email or phone"
                  className="pl-9"
                />
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1">
                {matchedAccounts.length === 0 ? (
                  <p className="text-sm text-muted-foreground px-1 py-3">
                    No matching accounts.
                  </p>
                ) : (
                  matchedAccounts.map((c) => (
                    <button
                      key={c.id}
                      disabled={linkBusy}
                      onClick={() =>
                        linkTarget && finishLink(linkTarget.id, c.id, c.name)
                      }
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-foreground/[0.06] transition-colors disabled:opacity-50"
                    >
                      <div className="font-medium text-sm">{c.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {[c.email, c.phone].filter(Boolean).join(" · ") ||
                          "No contact details"}
                      </div>
                    </button>
                  ))
                )}
              </div>
              <div className="pt-2 border-t border-white/10">
                <Button
                  variant="outline"
                  disabled={linkBusy || !linkTarget}
                  onClick={() => linkTarget && createAndLink(linkTarget)}
                  className="w-full gap-2"
                >
                  {linkBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <UserPlus className="w-4 h-4" />
                  )}
                  Create a new account from this lead
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </Page>
      {sendFeedbackOpen && (
        <SendFeedbackDialog
          open={sendFeedbackOpen}
          onClose={() => setSendFeedbackOpen(false)}
          selectedLeadIds={[...selectedIds]}
        />
      )}
    </>
  );
}
