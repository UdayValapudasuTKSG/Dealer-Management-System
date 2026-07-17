import { useRoute, Link } from "wouter";
import { useGetCustomerOverview } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Timeline } from "@/components/timeline";
import { GateCard, GATE_LABEL } from "@/components/gate-card";
import { CommunicationCenter } from "@/components/communication-center";
import { Page } from "@/components/layout/page";
import { ProfileTab } from "@/components/customer/profile-tab";
import { PersonaTab } from "@/components/customer/persona-tab";
import { DocumentsTab } from "@/components/customer/documents-tab";
import { NotesPanel } from "@/components/customer/notes-panel";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  Loader2,
  ArrowLeft,
  MapPin,
  Crown,
  Car,
  ShieldAlert,
  Gauge,
} from "lucide-react";

const withBase = (path: string) =>
  `${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`;

export default function CustomerDetail() {
  const [, params] = useRoute("/customers/:id");
  const id = params ? Number(params.id) : NaN;
  const { data, isLoading, isError } = useGetCustomerOverview(id);

  if (isLoading) {
    return (
      <div className="flex justify-center py-32">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="text-center py-32 text-muted-foreground font-light">
        Account not found.
        <div className="mt-4">
          <Link
            href="/customers"
            className="text-primary font-medium hover:underline"
          >
            Back to portfolio
          </Link>
        </div>
      </div>
    );
  }

  const {
    customer,
    ownedVehicles,
    activeDeal,
    deals,
    appraisals,
    financeApplications,
    serviceOrders,
    leads,
    timeline,
    openGates,
    persona,
    notes,
    documents,
  } = data;

  const money = (n: number) => `$${n.toLocaleString("en-US")}`;

  const JOURNEY_PHASES = ["aware", "consider", "engage", "negotiate", "won"] as const;
  const JOURNEY_LABEL: Record<string, string> = {
    aware: "New Lead",
    consider: "Qualified",
    engage: "Test Drive",
    negotiate: "Desking",
    won: "Delivered",
  };
  const leadPhaseIndex = leads.reduce(
    (max, l) => Math.max(max, JOURNEY_PHASES.indexOf(l.phase as never)),
    -1,
  );
  const dealStageIndex = deals.reduce((max, d) => {
    const idx =
      d.stage === "delivered"
        ? 4
        : ["desking", "negotiation", "finance", "committed"].includes(d.stage)
          ? 3
          : -1;
    return Math.max(max, idx);
  }, -1);
  const currentIndex = Math.max(leadPhaseIndex, dealStageIndex);

  const leadScore = persona?.leadScore ?? 0;
  const tags = customer.tags ?? [];

  return (
    <Page className="space-y-8">
      <Link
        href="/customers"
        className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Account Portfolio
      </Link>

      {/* Identity header */}
      <Card className="glass-panel border-none shadow-xl overflow-hidden">
        <CardContent className="p-8 flex flex-col md:flex-row md:items-center gap-6">
          <div className="w-24 h-24 rounded-full bg-white/[0.06] shadow-md flex items-center justify-center overflow-hidden border-2 border-white/10 shrink-0">
            {customer.avatarUrl ? (
              <img
                src={customer.avatarUrl}
                alt={customer.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-3xl font-light text-muted-foreground/40">
                {customer.name.charAt(0)}
              </span>
            )}
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <h1 className="text-2xl md:text-3xl font-light tracking-tight">
                {customer.name}
              </h1>
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest bg-primary/10 text-primary">
                <Crown className="w-3.5 h-3.5" />
                {customer.loyaltyTier}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
              {customer.location && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-4 h-4" /> {customer.location}
                </span>
              )}
              {customer.email && <span>{customer.email}</span>}
              {customer.phone && <span>{customer.phone}</span>}
              {customer.occupation && <span>{customer.occupation}</span>}
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="rounded-full bg-white/[0.06] border border-white/10 text-muted-foreground text-[10px] uppercase tracking-widest"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-8">
            <div>
              <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1 flex items-center gap-1.5">
                <Gauge className="w-3.5 h-3.5" /> Lead Score
              </div>
              <div
                className={cn(
                  "font-light text-3xl tracking-tight",
                  leadScore >= 70
                    ? "text-emerald-400"
                    : leadScore >= 40
                      ? "text-amber-400"
                      : "text-foreground",
                )}
              >
                {leadScore}
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Lifetime Value
              </div>
              <div className="font-light text-3xl tracking-tight text-primary">
                ${(customer.lifetimeValue / 1000).toFixed(1)}k
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1">
                Owned
              </div>
              <div className="font-light text-3xl tracking-tight">
                {ownedVehicles.length}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList className="bg-white/[0.04] border border-white/10 rounded-full h-11 p-1 gap-1">
          {[
            { value: "overview", label: "Overview" },
            { value: "profile", label: "Profile" },
            { value: "persona", label: "Persona" },
            { value: "documents", label: "Documents" },
            { value: "activity", label: "Activity" },
          ].map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="rounded-full px-5 text-xs font-semibold uppercase tracking-widest data-[state=active]:bg-primary data-[state=active]:text-white data-[state=active]:shadow-lg data-[state=active]:shadow-primary/25"
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ---------------- Overview ---------------- */}
        <TabsContent value="overview" className="space-y-8 mt-0">
          {/* Journey stage — where this client sits in the pipeline */}
          {currentIndex >= 0 && (
            <Card className="glass-panel border-none shadow-lg overflow-hidden">
              <CardContent className="p-6 md:p-8">
                <div className="flex items-baseline justify-between mb-6">
                  <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-muted-foreground">
                    Journey Stage
                  </h2>
                  <span className="text-sm font-semibold text-primary">
                    {JOURNEY_LABEL[JOURNEY_PHASES[currentIndex]]}
                  </span>
                </div>
                <div className="relative flex items-start justify-between gap-2">
                  <div className="pointer-events-none absolute left-0 right-0 top-4 mx-6 h-[2px] bg-white/10 rounded-full" />
                  <div
                    className="pointer-events-none absolute left-0 top-4 mx-6 h-[2px] bg-primary rounded-full shadow-[0_0_12px_hsl(var(--primary))] transition-all duration-700"
                    style={{
                      width:
                        JOURNEY_PHASES.length > 1
                          ? `calc(${(currentIndex / (JOURNEY_PHASES.length - 1)) * 100}% - ${
                              (currentIndex / (JOURNEY_PHASES.length - 1)) * 3
                            }rem)`
                          : "0%",
                    }}
                  />
                  {JOURNEY_PHASES.map((phase, i) => {
                    const isCurrent = i === currentIndex;
                    const isPast = i < currentIndex;
                    return (
                      <div
                        key={phase}
                        className="relative z-10 flex flex-col items-center gap-2.5 flex-1 min-w-0"
                      >
                        <span
                          className={cn(
                            "relative flex h-8 w-8 items-center justify-center rounded-full transition-colors",
                            isCurrent
                              ? "text-white"
                              : isPast
                                ? "bg-primary/25 text-primary"
                                : "bg-foreground/[0.06] text-muted-foreground",
                          )}
                        >
                          {isCurrent && (
                            <motion.span
                              layoutId="customer-journey-node"
                              className="absolute inset-0 rounded-full bg-primary shadow-lg shadow-primary/40"
                            />
                          )}
                          <span className="relative z-10 h-1.5 w-1.5 rounded-full bg-current" />
                        </span>
                        <span
                          className={cn(
                            "text-[10px] md:text-[11px] font-semibold uppercase tracking-widest text-center transition-colors",
                            isCurrent
                              ? "text-foreground"
                              : "text-muted-foreground/70",
                          )}
                        >
                          {JOURNEY_LABEL[phase]}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Communication center — emails, calls, meetings */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold tracking-wide">
              Communication
            </h2>
            <CommunicationCenter
              customerId={customer.id}
              customerEmail={customer.email}
              customerName={customer.name}
            />
          </div>

          {/* Open gates for this client — actionable in-context */}
          {openGates.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary text-white flex items-center justify-center shrink-0">
                  <ShieldAlert className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-wide">
                    {openGates.length} decision
                    {openGates.length > 1 ? "s" : ""} awaiting your approval
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Resolve these here without leaving the client.
                  </p>
                </div>
              </div>
              <AnimatePresence mode="popLayout">
                {openGates.map((gate) => (
                  <GateCard
                    key={gate.id}
                    gate={gate}
                    label={GATE_LABEL[gate.type]}
                    showCustomerLink={false}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Timeline */}
            <div className="lg:col-span-2 space-y-4">
              <h2 className="text-lg font-semibold tracking-wide">
                Relationship Timeline
              </h2>
              <Card className="glass-panel border-none shadow-lg">
                <CardContent className="p-6">
                  <Timeline events={timeline} />
                </CardContent>
              </Card>
            </div>

            {/* Right column */}
            <div className="space-y-8">
              {activeDeal && (
                <Section title="Active Deal">
                  <div className="p-4 rounded-2xl bg-white/[0.03]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold capitalize">
                        {activeDeal.stage}
                      </span>
                      <Badge className="rounded-full text-[10px] uppercase tracking-widest">
                        {money(activeDeal.otdPrice)} OTD
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {activeDeal.salesAdvisor
                        ? `Advisor: ${activeDeal.salesAdvisor}`
                        : "Concierge-led"}
                    </p>
                  </div>
                </Section>
              )}

              {ownedVehicles.length > 0 && (
                <Section title="Owned Vehicles">
                  <div className="space-y-3">
                    {ownedVehicles.map((v) => (
                      <div
                        key={v.id}
                        className="flex items-center gap-3 p-3 rounded-2xl bg-white/[0.03]"
                      >
                        <div className="w-14 h-10 rounded-lg bg-white/[0.05] overflow-hidden shrink-0 flex items-center justify-center">
                          {v.imageUrl ? (
                            <img
                              src={withBase(v.imageUrl)}
                              alt={`${v.make} ${v.model}`}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Car className="w-5 h-5 text-muted-foreground/40" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">
                            {v.year} {v.make} {v.model}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {v.powertrain}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {financeApplications.length > 0 && (
                <Section title="Financing">
                  <div className="space-y-2">
                    {financeApplications.map((f) => (
                      <RowItem
                        key={f.id}
                        label={money(f.amount)}
                        value={f.status}
                      />
                    ))}
                  </div>
                </Section>
              )}

              {appraisals.length > 0 && (
                <Section title="Trade Appraisals">
                  <div className="space-y-2">
                    {appraisals.map((a) => (
                      <RowItem
                        key={a.id}
                        label={`${a.year} ${a.make} ${a.model}`}
                        value={a.status}
                      />
                    ))}
                  </div>
                </Section>
              )}

              {serviceOrders.length > 0 && (
                <Section title="Service">
                  <div className="space-y-2">
                    {serviceOrders.map((s) => (
                      <RowItem
                        key={s.id}
                        label={s.vehicleInfo}
                        value={s.status.replace(/_/g, " ")}
                      />
                    ))}
                  </div>
                </Section>
              )}

              {leads.length > 0 && (
                <Section title="Origin">
                  <div className="space-y-2">
                    {leads.map((l) => (
                      <RowItem
                        key={l.id}
                        label={`${l.channel} lead`}
                        value={l.phase}
                      />
                    ))}
                  </div>
                </Section>
              )}

              {deals.length > 0 && (
                <Section title="All Deals">
                  <div className="space-y-2">
                    {deals.map((d) => (
                      <RowItem
                        key={d.id}
                        label={money(d.otdPrice)}
                        value={d.stage}
                      />
                    ))}
                  </div>
                </Section>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ---------------- Profile ---------------- */}
        <TabsContent value="profile" className="mt-0">
          <ProfileTab customer={customer} />
        </TabsContent>

        {/* ---------------- Persona ---------------- */}
        <TabsContent value="persona" className="mt-0">
          <PersonaTab customerId={customer.id} persona={persona} />
        </TabsContent>

        {/* ---------------- Documents ---------------- */}
        <TabsContent value="documents" className="mt-0">
          <DocumentsTab customerId={customer.id} documents={documents ?? []} />
        </TabsContent>

        {/* ---------------- Activity ---------------- */}
        <TabsContent value="activity" className="mt-0">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-4">
              <h2 className="text-lg font-semibold tracking-wide">
                Relationship Timeline
              </h2>
              <Card className="glass-panel border-none shadow-lg">
                <CardContent className="p-6">
                  <Timeline events={timeline} />
                </CardContent>
              </Card>
            </div>
            <div className="space-y-4">
              <h2 className="text-lg font-semibold tracking-wide">Notes</h2>
              <NotesPanel customerId={customer.id} notes={notes ?? []} />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold tracking-wide">{title}</h2>
      <Card className="glass-panel border-none shadow-lg">
        <CardContent className="p-4">{children}</CardContent>
      </Card>
    </div>
  );
}

function RowItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-white/[0.03]">
      <span className="text-sm font-medium truncate">{label}</span>
      <span className="text-xs font-semibold uppercase tracking-widest text-primary capitalize shrink-0">
        {value}
      </span>
    </div>
  );
}
