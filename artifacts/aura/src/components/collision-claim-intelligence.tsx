import { useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  Bot,
  CalendarDays,
  CarFront,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  FileWarning,
  Gauge,
  Loader2,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import {
  getGetCustomerQueryKey,
  getGetVehicleQueryKey,
  useGenerateCollisionClaimAnalysis,
  useGetCustomer,
  useGetVehicle,
  useListServiceOrders,
  type CollisionClaim,
  type CollisionClaimAnalysis,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { formatGuyanaDate, formatGuyanaDateTime, useMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

function Fact({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 truncate text-sm font-medium text-foreground">
        {value || "—"}
      </div>
    </div>
  );
}

function ProfileCard({
  eyebrow,
  title,
  icon,
  href,
  children,
}: {
  eyebrow: string;
  title: string;
  icon: React.ReactNode;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden border-border/60 bg-background shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/50 bg-muted/20 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary">
            {icon}
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">
              {eyebrow}
            </p>
            <h3 className="truncate text-sm font-semibold">{title}</h3>
          </div>
        </div>
        {href && (
          <Button asChild variant="ghost" size="sm" className="h-8 shrink-0 text-xs">
            <Link href={href}>
              Full record
              <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </Link>
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-4">{children}</CardContent>
    </Card>
  );
}

function AnalysisList({
  title,
  items,
  icon,
  tone = "default",
}: {
  title: string;
  items: string[];
  icon: React.ReactNode;
  tone?: "default" | "risk";
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/70 p-4">
      <div
        className={cn(
          "mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em]",
          tone === "risk" ? "text-rose-600 dark:text-rose-400" : "text-primary",
        )}
      >
        {icon}
        {title}
      </div>
      {items.length ? (
        <ul className="space-y-2.5">
          {items.map((item) => (
            <li key={item} className="flex gap-2.5 text-sm leading-5 text-foreground/85">
              <span
                className={cn(
                  "mt-2 h-1.5 w-1.5 shrink-0 rounded-full",
                  tone === "risk" ? "bg-rose-500" : "bg-primary",
                )}
              />
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No issues identified from the current record.</p>
      )}
    </div>
  );
}

export function CollisionClaimIntelligence({ claim }: { claim: CollisionClaim }) {
  const { toast } = useToast();
  const { gyd } = useMoney();
  const [analysis, setAnalysis] = useState<CollisionClaimAnalysis | null>(null);
  const analysisMutation = useGenerateCollisionClaimAnalysis();
  const { data: serviceOrders } = useListServiceOrders();
  const order = serviceOrders?.find((item) => item.id === claim.serviceOrderId);
  const customerId = claim.customerId ?? order?.customerId ?? 0;
  const vehicleId = claim.vehicleId ?? order?.vehicleId ?? 0;
  const { data: customer } = useGetCustomer(customerId, {
    query: {
      queryKey: getGetCustomerQueryKey(customerId),
      enabled: customerId > 0,
    },
  });
  const { data: vehicle } = useGetVehicle(vehicleId, {
    query: {
      queryKey: getGetVehicleQueryKey(vehicleId),
      enabled: vehicleId > 0,
    },
  });

  const runAnalysis = () => {
    analysisMutation.mutate(
      { id: claim.id },
      {
        onSuccess: setAnalysis,
        onError: (error) =>
          toast({
            title: "A5 could not complete the assessment",
            description:
              (error as { error?: string })?.error ??
              (error instanceof Error ? error.message : "Please try again."),
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <ProfileCard
          eyebrow="Customer"
          title={customer?.name ?? claim.customerName ?? "Customer not linked"}
          icon={<UserRound className="h-4 w-4" />}
          href={customerId > 0 ? `/customers/${customerId}` : undefined}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            <Fact
              label="Phone"
              value={
                customer?.phone ? (
                  <a className="inline-flex items-center gap-1.5 hover:text-primary" href={`tel:${customer.phone}`}>
                    <Phone className="h-3.5 w-3.5" />
                    {customer.phone}
                  </a>
                ) : (
                  order?.customerPhoneSnapshot
                )
              }
            />
            <Fact
              label="Email"
              value={
                customer?.email ? (
                  <a className="inline-flex items-center gap-1.5 hover:text-primary" href={`mailto:${customer.email}`}>
                    <Mail className="h-3.5 w-3.5" />
                    {customer.email}
                  </a>
                ) : null
              }
            />
            <Fact label="Account" value={customer?.accountType} />
            <Fact label="Loyalty" value={customer?.loyaltyTier} />
            <div className="col-span-2">
              <Fact
                label="Address"
                value={
                  customer?.address ? (
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                      {[customer.address, customer.city, customer.country].filter(Boolean).join(", ")}
                    </span>
                  ) : null
                }
              />
            </div>
          </div>
        </ProfileCard>

        <ProfileCard
          eyebrow="Vehicle"
          title={
            vehicle
              ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
              : claim.vehicleInfo
          }
          icon={<CarFront className="h-4 w-4" />}
          href={vehicleId > 0 ? `/vehicle/${vehicleId}` : undefined}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            <Fact label="Registration" value={vehicle?.registration} />
            <Fact label="VIN / Chassis" value={vehicle?.vin} />
            <Fact label="Colour" value={vehicle?.exteriorColor} />
            <Fact label="Powertrain" value={vehicle?.powertrain} />
            <Fact
              label="Mileage"
              value={
                vehicle
                  ? `${vehicle.mileageKm.toLocaleString()} km`
                  : order?.odometer != null
                    ? `${order.odometer.toLocaleString()} km`
                    : null
              }
            />
            <Fact label="Workshop status" value={order?.status.replace(/_/g, " ")} />
          </div>
        </ProfileCard>

        <ProfileCard
          eyebrow="Insurance"
          title={claim.insurerName}
          icon={<ShieldCheck className="h-4 w-4" />}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            <Fact label="Claim number" value={claim.claimNumber} />
            <Fact label="Policy number" value={claim.policyNumber} />
            <Fact label="Adjuster" value={claim.adjusterName} />
            <Fact label="Adjuster contact" value={claim.adjusterContact} />
            <Fact label="Loss date" value={formatGuyanaDate(claim.lossDate)} />
            <Fact label="Deductible" value={gyd(claim.deductible)} />
          </div>
        </ProfileCard>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border/60 bg-background shadow-sm">
        <div className="flex flex-col gap-4 border-b border-primary/15 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/15 text-primary">
              <Bot className="h-5 w-5" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">A5 claim intelligence</h3>
                {analysis && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "uppercase tracking-wider",
                      analysis.riskLevel === "high"
                        ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                        : analysis.riskLevel === "moderate"
                          ? "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400"
                          : "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
                    )}
                  >
                    {analysis.riskLevel} attention
                  </Badge>
                )}
              </div>
              <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">
                A live operational assessment grounded in this claim’s status, evidence,
                estimates, supplements, workshop record, and payment position.
              </p>
            </div>
          </div>
          <Button
            onClick={runAnalysis}
            disabled={analysisMutation.isPending}
            className="shrink-0"
          >
            {analysisMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : analysis ? (
              <RefreshCw className="mr-2 h-4 w-4" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            {analysis ? "Refresh analysis" : "Run A5 analysis"}
          </Button>
        </div>

        {analysis ? (
          <div className="space-y-4 p-5">
            <p className="max-w-5xl text-sm leading-6 text-foreground/90">
              {analysis.summary}
            </p>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
              <AnalysisList
                title="Recommended next moves"
                items={analysis.nextActions}
                icon={<CheckCircle2 className="h-4 w-4" />}
              />
              <AnalysisList
                title="Evidence gaps"
                items={analysis.evidenceGaps}
                icon={<FileWarning className="h-4 w-4" />}
                tone="risk"
              />
              <AnalysisList
                title="Financial watchpoints"
                items={analysis.financialObservations}
                icon={<CircleDollarSign className="h-4 w-4" />}
              />
            </div>
            <div className="flex flex-wrap items-center gap-4 border-t border-primary/10 pt-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="h-3.5 w-3.5" />
                Generated {formatGuyanaDateTime(analysis.generatedAt)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5" />
                Review before acting — A5 does not make coverage or liability decisions
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 p-5 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            Run the assessment when you need a fresh claim brief. Nothing is changed
            automatically; staff remain responsible for every decision and workflow action.
          </div>
        )}
      </div>
    </div>
  );
}