import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useListLeads,
  useListVehicles,
  useCreateLead,
  useGetPipelineSuggestions,
  getListLeadsQueryKey,
} from "@workspace/api-client-react";
import type { GetPipelineSuggestionsPhase } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Phone,
  Mail,
  ArrowUpRight,
  Car,
  Sparkles,
  Zap,
  AlertCircle,
  RefreshCw,
  Loader2,
  ChevronRight,
  Check,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Page, PageHeader } from "@/components/layout/page";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { TestDriveBoard } from "@/components/pipeline/test-drive-board";
import { VehicleCascade } from "@/components/vehicle-cascade";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const PHASES = ["aware", "consider", "engage", "negotiate", "won"] as const;
type Phase = (typeof PHASES)[number];

const PHASE_LABEL: Record<string, string> = {
  aware: "New Lead",
  consider: "Working",
  engage: "Appointment",
  negotiate: "Desking",
  won: "Delivered",
  lost: "Lost",
};

const PHASE_CAPTION: Record<string, string> = {
  aware: "Fresh interest, awaiting first contact",
  consider: "Nurturing and matching inventory",
  engage: "Test drives and showroom visits",
  negotiate: "Structuring terms and desking",
  won: "Delivered and onboarding retention",
};

const PRIORITY_STYLE: Record<string, string> = {
  high: "bg-primary/15 text-primary ring-primary/30",
  medium: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  low: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
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

const withBase = (url: string) =>
  `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`;

export default function Leads() {
  const { data: leads, isLoading } = useListLeads();
  const { data: vehicles } = useListVehicles();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createLead = useCreateLead();

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of PHASES) map[p] = 0;
    for (const l of leads ?? []) {
      if (l.phase in map) map[l.phase] += 1;
    }
    return map;
  }, [leads]);

  const [selectedPhase, setSelectedPhase] = useState<Phase>("engage");
  const activeIndex = PHASES.indexOf(selectedPhase);
  const [view, setView] = useState<"pipeline" | "test-drives">("pipeline");
  const [, navigate] = useLocation();

  const phaseLeads = (leads ?? []).filter((l) => l.phase === selectedPhase);

  const testDrives = useMemo(
    () =>
      (leads ?? [])
        .filter((l) => l.testDriveAt)
        .sort(
          (a, b) =>
            new Date(a.testDriveAt!).getTime() -
            new Date(b.testDriveAt!).getTime(),
        ),
    [leads],
  );
  const suggestions = useGetPipelineSuggestions({
    phase: selectedPhase as GetPipelineSuggestionsPhase,
  });

  return (
    <Page className="space-y-10">
      <PageHeader
        title="Pipeline"
        accent="Orchestration"
        subtitle="Move through each stage — AURA reads the room and tells you what to do next."
        action={
          <CreateRecordDialog
            title="New Lead"
            description="Capture a prospect — AURA scores and routes it instantly."
            pending={createLead.isPending}
            submitLabel="Add to pipeline"
            trigger={
              <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
                <Plus className="w-5 h-5" />
                New Lead
              </Button>
            }
            fields={[
              { name: "name", label: "Name", type: "text", required: true, span: "full", placeholder: "Kojo Asante" },
              {
                name: "channel",
                label: "Channel",
                type: "select",
                required: true,
                span: "half",
                defaultValue: "web",
                options: [
                  { value: "web", label: "Web" },
                  { value: "social", label: "Social" },
                  { value: "mobile", label: "Mobile" },
                  { value: "walkin", label: "Walk-in" },
                ],
              },
              {
                name: "interestedVehicleId",
                label: "Interested vehicle",
                type: "custom",
                required: true,
                span: "full",
                render: (_value, set) => (
                  <VehicleCascade
                    vehicles={(vehicles ?? []).map((v) => ({
                      id: v.id,
                      brand: v.make,
                      model: v.model,
                      version: v.trim || v.variant || "Standard specification",
                      color: v.exteriorColor,
                      year: v.year,
                      vin: v.vin ?? null,
                      price: v.price,
                    }))}
                    onResolve={(v) => set(v ? String(v.id) : "")}
                  />
                ),
              },
              {
                name: "source",
                label: "Source",
                type: "select",
                span: "half",
                defaultValue: "website",
                options: Object.entries(SOURCE_LABEL).map(([value, label]) => ({
                  value,
                  label,
                })),
              },
              {
                name: "priority",
                label: "Priority",
                type: "select",
                span: "half",
                defaultValue: "medium",
                options: [
                  { value: "high", label: "High" },
                  { value: "medium", label: "Medium" },
                  { value: "low", label: "Low" },
                ],
              },
              { name: "preferredBranch", label: "Preferred branch", type: "text", span: "half", placeholder: "Optional" },
              { name: "email", label: "Email", type: "text", span: "half", placeholder: "kojo@email.com" },
              { name: "phone", label: "Phone", type: "text", span: "half", placeholder: "+233 …" },
              { name: "notes", label: "Notes", type: "textarea", span: "full", placeholder: "What are they looking for?" },
            ]}
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
                  payload.color = v.exteriorColor;
                }
              }
              await createLead.mutateAsync({ data: payload as never });
              queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
              toast({ title: "Lead captured", description: "AURA is scoring and routing this prospect." });
            }}
          />
        }
      />

      {/* View toggle */}
      <div className="flex items-center gap-1 rounded-full bg-foreground/[0.04] border border-white/10 p-1 w-fit">
        {(
          [
            { key: "pipeline", label: "Pipeline" },
            { key: "test-drives", label: `Test Drives${testDrives.length ? ` (${testDrives.length})` : ""}` },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setView(t.key)}
            className={cn(
              "relative px-5 h-9 rounded-full text-xs font-semibold uppercase tracking-widest transition-colors",
              view === t.key
                ? "text-white"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {view === t.key && (
              <motion.span
                layoutId="pipeline-view-toggle"
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
                className="absolute inset-0 rounded-full bg-primary shadow-lg shadow-primary/30"
              />
            )}
            <span className="relative z-10">{t.label}</span>
          </button>
        ))}
      </div>

      {view === "test-drives" ? (
        <TestDriveBoard drives={testDrives} vehicles={vehicles ?? []} />
      ) : (
        <>
      {/* Stage rail — segmented stepper */}
      <div className="relative rounded-3xl bg-foreground/[0.03] border border-white/10 shadow-[0_18px_48px_-28px_rgba(0,0,0,0.6)] p-3 md:p-4">
        {/* Progress track */}
        <div className="relative mx-2 mb-3 h-1 rounded-full bg-foreground/[0.07] overflow-hidden">
          <motion.div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-primary/40 via-primary to-primary shadow-[0_0_16px_hsl(var(--primary)/0.6)]"
            initial={false}
            animate={{
              width: `${((activeIndex + 1) / PHASES.length) * 100}%`,
            }}
            transition={{ type: "spring", stiffness: 200, damping: 30 }}
          />
        </div>

        <div className="grid grid-cols-5 gap-2 md:gap-3">
          {PHASES.map((phase, i) => {
            const isActive = phase === selectedPhase;
            const isPast = i < activeIndex;
            return (
              <button
                key={phase}
                onClick={() => setSelectedPhase(phase)}
                className={cn(
                  "relative rounded-2xl px-3 py-3 md:px-4 md:py-4 text-left transition-colors group overflow-hidden",
                  !isActive && "hover:bg-foreground/[0.05]",
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId="pipeline-node-active"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                    className="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary via-primary to-red-900 shadow-lg shadow-primary/40"
                  />
                )}
                <span className="relative z-10 flex flex-col gap-1.5 min-w-0">
                  <span className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        "flex h-5 w-5 md:h-6 md:w-6 items-center justify-center rounded-full text-[10px] font-bold transition-colors shrink-0",
                        isActive
                          ? "bg-white/20 text-white"
                          : isPast
                            ? "bg-primary/15 text-primary"
                            : "bg-foreground/[0.07] text-muted-foreground group-hover:text-foreground",
                      )}
                    >
                      {isPast ? <Check className="h-3 w-3" /> : i + 1}
                    </span>
                    <span
                      className={cn(
                        "text-xl md:text-2xl font-bold tabular-nums leading-none transition-colors",
                        isActive
                          ? "text-white"
                          : isPast
                            ? "text-foreground"
                            : "text-muted-foreground group-hover:text-foreground",
                      )}
                    >
                      {counts[phase] ?? 0}
                    </span>
                  </span>
                  <span className="flex items-baseline justify-between gap-2 min-w-0">
                    <span
                      className={cn(
                        "text-[10px] md:text-[11px] font-semibold uppercase tracking-widest truncate transition-colors",
                        isActive
                          ? "text-white/90"
                          : "text-muted-foreground group-hover:text-foreground",
                      )}
                    >
                      {PHASE_LABEL[phase]}
                    </span>
                    <span
                      className={cn(
                        "hidden md:inline text-[9px] uppercase tracking-wider shrink-0 transition-colors",
                        isActive
                          ? "text-white/60"
                          : isPast
                            ? "text-primary/80"
                            : "text-muted-foreground/60",
                      )}
                    >
                      {isActive ? "Viewing" : isPast ? "Done" : `0${i + 1}`}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Detail — animated per stage */}
      <AnimatePresence mode="wait">
        <motion.div
          key={selectedPhase}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.3 }}
          className="grid grid-cols-1 lg:grid-cols-5 gap-6"
        >
          {/* Leads in stage */}
          <div className="lg:col-span-3 space-y-4">
            <div className="flex items-baseline justify-between">
              <div>
                <h2 className="text-2xl font-light tracking-tight">
                  {PHASE_LABEL[selectedPhase]}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {PHASE_CAPTION[selectedPhase]}
                </p>
              </div>
              <span className="text-sm font-semibold text-primary shrink-0">
                {phaseLeads.length} client{phaseLeads.length === 1 ? "" : "s"}
              </span>
            </div>

            <div className="space-y-3">
              {isLoading ? (
                [1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-20 rounded-2xl bg-foreground/[0.04] animate-pulse"
                  />
                ))
              ) : phaseLeads.length === 0 ? (
                <div className="flex items-center justify-center h-32 rounded-2xl border-2 border-dashed border-border/60 text-muted-foreground/60 text-sm uppercase tracking-widest font-semibold">
                  No clients in this stage
                </div>
              ) : (
                phaseLeads.map((lead, i) => {
                  const vehicle = vehicles?.find(
                    (v) => v.id === lead.interestedVehicleId,
                  );
                  return (
                    <motion.div
                      key={lead.id}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.04 }}
                      onClick={() => navigate(`/lead/${lead.id}`)}
                      className="group flex items-center gap-4 rounded-2xl border border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06] hover:border-primary/30 transition-all duration-300 p-3 pr-4 cursor-pointer"
                    >
                      <div className="w-16 h-16 shrink-0 rounded-xl overflow-hidden bg-foreground/[0.04] flex items-center justify-center">
                        {vehicle?.imageUrl ? (
                          <img
                            src={withBase(vehicle.imageUrl)}
                            alt={`${vehicle.make} ${vehicle.model}`}
                            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                          />
                        ) : (
                          <Car className="w-6 h-6 text-muted-foreground/30" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-base leading-tight truncate group-hover:text-primary transition-colors">
                          {lead.name}
                        </div>
                        {vehicle && (
                          <div className="text-xs text-muted-foreground truncate mt-0.5">
                            {vehicle.make} {vehicle.model}
                          </div>
                        )}
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                            {SOURCE_LABEL[lead.source] ?? lead.source}
                          </span>
                          <span
                            className={cn(
                              "inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1",
                              PRIORITY_STYLE[lead.priority] ?? PRIORITY_STYLE.low,
                            )}
                          >
                            {lead.priority}
                          </span>
                          <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-foreground/70 bg-foreground/[0.06] px-2 py-0.5 rounded-full">
                            {STATUS_LABEL[lead.status] ?? lead.status}
                          </span>
                          {!lead.ownerUserId && (
                            <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">
                              Needs advisor
                            </span>
                          )}
                          {lead.email && (
                            <Mail className="w-3.5 h-3.5 text-muted-foreground/70" />
                          )}
                          {lead.phone && (
                            <Phone className="w-3.5 h-3.5 text-muted-foreground/70" />
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-right hidden sm:block">
                          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                            AI Score
                          </div>
                          <div className="text-lg font-light text-primary">
                            {lead.aiScore}
                          </div>
                        </div>
                        {lead.customerId && (
                          <Link
                            href={`/customers/${lead.customerId}`}
                            className="text-[10px] font-bold uppercase tracking-wider text-primary inline-flex items-center gap-0.5 hover:underline"
                          >
                            Account
                            <ArrowUpRight className="w-3 h-3" />
                          </Link>
                        )}
                      </div>
                    </motion.div>
                  );
                })
              )}
            </div>
          </div>

          {/* AURA suggestions */}
          <div className="lg:col-span-2">
            <div className="sticky top-4 rounded-3xl border border-primary/20 bg-gradient-to-b from-primary/[0.06] to-foreground/[0.02] shadow-[0_18px_48px_-28px_rgba(0,0,0,0.6)] overflow-hidden">
              <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10">
                <span className="relative w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-primary" />
                  {suggestions.isFetching && (
                    <span className="absolute inset-0 rounded-full ring-2 ring-primary/40 animate-ping" />
                  )}
                </span>
                <div>
                  <div className="text-sm font-semibold tracking-tight">
                    AURA recommends
                  </div>
                  <div className="text-[10px] uppercase tracking-widest text-primary">
                    {suggestions.isFetching ? "Reading the stage…" : "Live"}
                  </div>
                </div>
              </div>

              <div className="p-5 space-y-4">
                {suggestions.isLoading ? (
                  <div className="flex items-center gap-3 text-muted-foreground text-sm py-8 justify-center">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    Thinking through {PHASE_LABEL[selectedPhase].toLowerCase()}…
                  </div>
                ) : suggestions.isError ? (
                  <div className="text-center py-8 space-y-3">
                    <AlertCircle className="w-6 h-6 text-muted-foreground/50 mx-auto" />
                    <p className="text-sm text-muted-foreground">
                      The concierge is unavailable right now.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => suggestions.refetch()}
                      className="rounded-full gap-2"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Retry
                    </Button>
                  </div>
                ) : suggestions.data ? (
                  <>
                    <p className="text-sm font-light leading-relaxed text-foreground/90">
                      {suggestions.data.headline}
                    </p>
                    <div className="space-y-3">
                      {suggestions.data.actions.map((action, i) => (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.08 }}
                          className="rounded-2xl bg-foreground/[0.04] border border-white/10 p-4"
                        >
                          <div className="flex items-start gap-3">
                            <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0 mt-0.5">
                              <Zap className="w-3.5 h-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-sm">
                                  {action.title}
                                </span>
                                <span
                                  className={cn(
                                    "text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1",
                                    PRIORITY_STYLE[action.priority] ??
                                      PRIORITY_STYLE.low,
                                  )}
                                >
                                  {action.priority}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                                {action.detail}
                              </p>
                              {action.leadName && (
                                <div className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                                  <ChevronRight className="w-3 h-3" />
                                  {action.leadName}
                                </div>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
        </>
      )}

    </Page>
  );
}
