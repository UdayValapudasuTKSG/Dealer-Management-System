/**
 * Collision Claims workspace (Task 279) — lives inside Service & Repair.
 *
 * Claims ride on top of normal repair orders: intake attaches a claim to an
 * existing (or quick-created) repair order, then the claim walks the insurer
 * workflow while the workshop keeps its normal job-card / parts / invoice
 * lifecycle. This file holds the tab (list + filters), the intake dialog and
 * the routed claim detail workspace (timeline, damage zones, supplements,
 * settlement).
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListCollisionClaims,
  getListCollisionClaimsQueryKey,
  useCreateCollisionClaim,
  useGetCollisionClaim,
  getGetCollisionClaimQueryKey,
  useUpdateCollisionClaim,
  useAdvanceCollisionClaim,
  useResumeCollisionClaim,
  useCreateCollisionSupplement,
  useDecideCollisionSupplement,
  useCreateCollisionSettlement,
  useListServiceOrders,
  useListJobCards,
  useCreateJobCardInvoice,
  useCreateServiceOrder,
  getListServiceOrdersQueryKey,
  getListServiceInvoicesQueryKey,
  type CollisionClaim,
  type CollisionClaimStatus,
  type CollisionDamagePoint,
  type CollisionDamagePointZone,
  type CollisionDamagePointSeverity,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthz } from "@/lib/auth";
import { useMoney, formatGuyanaDate, formatGuyanaDateTime } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { DocumentsCard } from "@/components/documents-card";
import { cn } from "@/lib/utils";
import {
  CarFront,
  Loader2,
  Plus,
  ShieldAlert,
  Pause,
  Play,
  Receipt,
  Download,
  ClipboardList,
  CircleDollarSign,
  History,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Lock,
} from "lucide-react";

import { CollisionChecklistPanel } from "./collision-claims-checklist";
import { CollisionPortalLinksCard } from "./collision-claims-portal-links";
import { CollisionCommunicationsCard } from "./collision-claims-communications";
import { CollisionPartRequisitionForm } from "./collision-claims-part-requisition";

/* ------------------------------------------------------------------ */
/* Status metadata (mirrors COLLISION_ADVANCE_MAP server-side)          */
/* ------------------------------------------------------------------ */

const STATUS_LABEL: Record<string, string> = {
  intake: "Intake",
  estimate_drafted: "Estimate Drafted",
  submitted: "Submitted",
  adjuster_review: "Adjuster Review",
  approved: "Approved",
  parts_ordered: "Parts Ordered",
  in_repair: "In Repair",
  quality_check: "Quality Check",
  insurer_signoff: "Insurer Sign-off",
  invoiced: "Invoiced",
  closed: "Closed",
  denied: "Denied",
  total_loss: "Total Loss",
};

const STATUS_ORDER: CollisionClaimStatus[] = [
  "intake",
  "estimate_drafted",
  "submitted",
  "adjuster_review",
  "approved",
  "parts_ordered",
  "in_repair",
  "quality_check",
  "insurer_signoff",
  "invoiced",
  "closed",
];

/** Adjacent transitions; decision targets need a service approver. */
const ADVANCE_MAP: Record<string, CollisionClaimStatus[]> = {
  intake: ["estimate_drafted"],
  estimate_drafted: ["submitted"],
  submitted: ["adjuster_review", "denied"],
  adjuster_review: ["approved", "denied", "total_loss"],
  approved: ["parts_ordered", "total_loss"],
  parts_ordered: ["in_repair"],
  in_repair: ["quality_check"],
  quality_check: ["insurer_signoff", "in_repair"],
  insurer_signoff: ["invoiced"],
  invoiced: ["closed"],
  closed: [],
  denied: [],
  total_loss: [],
};

const APPROVER_TARGETS = new Set(["approved", "insurer_signoff", "denied", "total_loss"]);
const TERMINAL = new Set(["closed", "denied", "total_loss"]);

function statusBadgeClass(status: string): string {
  if (status === "closed") return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
  if (status === "denied") return "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30";
  if (status === "total_loss") return "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30";
  if (status === "invoiced") return "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30";
  if (["approved", "insurer_signoff"].includes(status))
    return "bg-teal-500/15 text-teal-600 dark:text-teal-400 border-teal-500/30";
  return "bg-muted/50 text-foreground border-border/50";
}

/* ------------------------------------------------------------------ */
/* Fixed vehicle silhouette zones                                       */
/* ------------------------------------------------------------------ */

const ZONES: { zone: CollisionDamagePointZone; label: string }[] = [
  { zone: "front_bumper", label: "Front bumper" },
  { zone: "hood", label: "Hood" },
  { zone: "windshield", label: "Windshield" },
  { zone: "front_left_fender", label: "Front-left fender" },
  { zone: "front_right_fender", label: "Front-right fender" },
  { zone: "left_door_front", label: "Left front door" },
  { zone: "left_door_rear", label: "Left rear door" },
  { zone: "right_door_front", label: "Right front door" },
  { zone: "right_door_rear", label: "Right rear door" },
  { zone: "left_quarter_panel", label: "Left quarter panel" },
  { zone: "right_quarter_panel", label: "Right quarter panel" },
  { zone: "roof", label: "Roof" },
  { zone: "rear_glass", label: "Rear glass" },
  { zone: "trunk", label: "Trunk" },
  { zone: "rear_bumper", label: "Rear bumper" },
  { zone: "undercarriage", label: "Undercarriage" },
];

const SEVERITIES: CollisionDamagePointSeverity[] = ["minor", "moderate", "severe"];

const severityClass: Record<string, string> = {
  minor: "bg-yellow-500/15 border-yellow-500/30 text-yellow-700 dark:text-yellow-400",
  moderate: "bg-orange-500/15 border-orange-500/30 text-orange-700 dark:text-orange-400",
  severe: "bg-red-500/15 border-red-500/30 text-red-700 dark:text-red-400",
};

/** Fixed silhouette/zone selector: click cycles off → minor → moderate → severe → off. */
function DamageZoneSelector({
  points,
  onChange,
  readOnly = false,
}: {
  points: CollisionDamagePoint[];
  onChange?: (next: CollisionDamagePoint[]) => void;
  readOnly?: boolean;
}) {
  const byZone = new Map(points.map((p) => [p.zone, p]));
  const cycle = (zone: CollisionDamagePointZone) => {
    if (readOnly || !onChange) return;
    const current = byZone.get(zone);
    if (!current) {
      onChange([...points, { zone, severity: "minor" }]);
      return;
    }
    const idx = SEVERITIES.indexOf(current.severity);
    if (idx >= SEVERITIES.length - 1) {
      onChange(points.filter((p) => p.zone !== zone));
    } else {
      onChange(
        points.map((p) =>
          p.zone === zone ? { ...p, severity: SEVERITIES[idx + 1] } : p,
        ),
      );
    }
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
        {ZONES.map(({ zone, label }) => {
          const p = byZone.get(zone);
          return (
            <button
              key={zone}
              type="button"
              onClick={() => cycle(zone)}
              disabled={readOnly}
              className={cn(
                "relative flex flex-col rounded-lg border px-3 py-2 text-left transition-all",
                p
                  ? severityClass[p.severity]
                  : "border-border/60 bg-muted/20 text-muted-foreground",
                !readOnly && "hover:border-primary/40 hover:bg-muted/40 cursor-pointer",
                readOnly && !p && "opacity-60",
                !readOnly && p && "hover:brightness-105 shadow-sm",
              )}
            >
              <span className="text-xs font-medium truncate">{label}</span>
              {p ? (
                <span className="text-[10px] font-bold uppercase tracking-wider mt-1 opacity-90">{p.severity}</span>
              ) : (
                <span className="text-[10px] font-medium uppercase tracking-wider mt-1 opacity-0">-</span>
              )}
            </button>
          );
        })}
      </div>
      {!readOnly && (
        <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 mt-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          Tap a zone to cycle severity: minor → moderate → severe → clear.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Intake dialog                                                        */
/* ------------------------------------------------------------------ */

export function CreateClaimDialog() {
  const { can } = useAuthz();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [serviceOrderId, setServiceOrderId] = useState<string>("");
  const [vehicleInfo, setVehicleInfo] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [scheduledDate, setScheduledDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [lossDate, setLossDate] = useState("");
  const [insurerName, setInsurerName] = useState("");
  const [policyNumber, setPolicyNumber] = useState("");
  const [claimNumber, setClaimNumber] = useState("");
  const [adjusterName, setAdjusterName] = useState("");
  const [adjusterContact, setAdjusterContact] = useState("");
  const [severity, setSeverity] = useState<"minor" | "moderate" | "severe">("moderate");
  const [damageNotes, setDamageNotes] = useState("");
  const [damagePoints, setDamagePoints] = useState<CollisionDamagePoint[]>([]);
  const [initialEstimate, setInitialEstimate] = useState("");
  const [deductible, setDeductible] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: orders } = useListServiceOrders();
  const { data: claims } = useListCollisionClaims();
  const claimedOrders = useMemo(
    () => new Set((claims ?? []).map((c) => c.serviceOrderId)),
    [claims],
  );
  const eligibleOrders = (orders ?? []).filter(
    (o) => !["closed", "cancelled"].includes(o.status) && !claimedOrders.has(o.id),
  );

  const createOrder = useCreateServiceOrder();
  const createClaim = useCreateCollisionClaim();

  if (!can("service", "create")) return null;

  const reset = () => {
    setMode("existing");
    setServiceOrderId("");
    setVehicleInfo("");
    setCustomerName("");
    setLossDate("");
    setInsurerName("");
    setPolicyNumber("");
    setClaimNumber("");
    setAdjusterName("");
    setAdjusterContact("");
    setSeverity("moderate");
    setDamageNotes("");
    setDamagePoints([]);
    setInitialEstimate("");
    setDeductible("");
  };

  const submit = async () => {
    if (!lossDate || !insurerName.trim()) {
      toast({
        title: "Missing details",
        description: "Loss date and insurer are required.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      let orderId = Number(serviceOrderId);
      if (mode === "new") {
        if (!vehicleInfo.trim()) {
          toast({
            title: "Vehicle required",
            description: "Describe the vehicle for the new repair order.",
            variant: "destructive",
          });
          setBusy(false);
          return;
        }
        const order = await createOrder.mutateAsync({
          data: {
            vehicleInfo: vehicleInfo.trim(),
            customerName: customerName.trim() || undefined,
            type: "repair",
            payType: "customer",
            scheduledDate,
            complaint: damageNotes.trim() || "Collision repair",
            jobs: ["Collision repair"],
          },
        });
        orderId = order.id;
        queryClient.invalidateQueries({ queryKey: getListServiceOrdersQueryKey() });
      }
      if (!orderId) {
        toast({
          title: "Pick a repair order",
          description: "The claim must attach to a repair order.",
          variant: "destructive",
        });
        setBusy(false);
        return;
      }
      await createClaim.mutateAsync({
        data: {
          serviceOrderId: orderId,
          lossDate,
          insurerName: insurerName.trim(),
          policyNumber: policyNumber.trim() || undefined,
          claimNumber: claimNumber.trim() || undefined,
          adjusterName: adjusterName.trim() || undefined,
          adjusterContact: adjusterContact.trim() || undefined,
          severity,
          damageNotes: damageNotes.trim() || undefined,
          damagePoints,
          initialEstimate: initialEstimate ? Number(initialEstimate) : undefined,
          deductible: deductible ? Number(deductible) : undefined,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListCollisionClaimsQueryKey() });
      toast({ title: "Claim opened", description: "Collision claim created at Intake." });
      reset();
      setOpen(false);
    } catch (err) {
      toast({
        title: "Could not create claim",
        description: err instanceof Error ? err.message : "Unexpected error",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="rounded-full bg-primary hover:bg-primary/90 text-white shadow-sm">
          <Plus className="w-4 h-4 mr-1.5" /> New Claim
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl !p-0 !gap-0 grid grid-rows-[auto_1fr_auto] h-[90vh] max-h-[90vh] overflow-hidden">
        <div className="p-6 border-b border-border bg-background shrink-0">
          <DialogHeader>
            <DialogTitle className="text-xl pr-6">New collision claim</DialogTitle>
            <DialogDescription className="mt-1.5">
              Attach an insurance claim to a repair order. The repair itself runs
              through the normal workshop lane.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="p-6 overflow-y-auto bg-muted/10 space-y-6">
          <div className="flex flex-wrap gap-2">
            {(
              [
                { key: "existing", label: "Existing repair order" },
                { key: "new", label: "New repair order" },
              ] as const
            ).map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                className={cn(
                  "rounded-full border px-4 py-2 text-sm font-medium transition-colors shadow-sm",
                  mode === m.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/60 bg-background text-muted-foreground hover:bg-muted/40",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          <Card className="border-border/60 shadow-sm bg-background">
            <CardHeader className="py-3 px-4 border-b border-border/40 bg-muted/20">
              <h3 className="font-semibold text-sm">Vehicle & Repair</h3>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {mode === "existing" ? (
                <div className="space-y-1.5">
                  <Label>Repair order</Label>
                  <Select value={serviceOrderId} onValueChange={setServiceOrderId}>
                    <SelectTrigger data-testid="select-claim-order">
                      <SelectValue placeholder="Pick a repair order without a claim" />
                    </SelectTrigger>
                    <SelectContent>
                      {eligibleOrders.length === 0 && (
                        <div className="px-3 py-2 text-xs text-muted-foreground">
                          No eligible repair orders — create one instead.
                        </div>
                      )}
                      {eligibleOrders.map((o) => (
                        <SelectItem key={o.id} value={String(o.id)}>
                          #{o.id} · {o.vehicleInfo}
                          {o.customerName ? ` — ${o.customerName}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>Vehicle</Label>
                    <Input
                      data-testid="input-claim-vehicle"
                      value={vehicleInfo}
                      onChange={(e) => setVehicleInfo(e.target.value)}
                      placeholder="2024 Toyota Hilux — PAD 1234"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Customer</Label>
                    <Input
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      placeholder="Customer name"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Scheduled date</Label>
                    <Input
                      type="date"
                      value={scheduledDate}
                      onChange={(e) => setScheduledDate(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/60 shadow-sm bg-background">
            <CardHeader className="py-3 px-4 border-b border-border/40 bg-muted/20">
              <h3 className="font-semibold text-sm">Insurance Details</h3>
            </CardHeader>
            <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Date of loss</Label>
                <Input
                  data-testid="input-claim-loss-date"
                  type="date"
                  value={lossDate}
                  onChange={(e) => setLossDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Insurer</Label>
                <Input
                  data-testid="input-claim-insurer"
                  value={insurerName}
                  onChange={(e) => setInsurerName(e.target.value)}
                  placeholder="e.g. Assuria, GTM, Hand-in-Hand"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Policy number</Label>
                <Input value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Insurer claim number</Label>
                <Input value={claimNumber} onChange={(e) => setClaimNumber(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Adjuster</Label>
                <Input value={adjusterName} onChange={(e) => setAdjusterName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Adjuster contact</Label>
                <Input
                  value={adjusterContact}
                  onChange={(e) => setAdjusterContact(e.target.value)}
                  placeholder="Phone or email"
                />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/60 shadow-sm bg-background">
            <CardHeader className="py-3 px-4 border-b border-border/40 bg-muted/20">
              <h3 className="font-semibold text-sm">Damage Assessment</h3>
            </CardHeader>
            <CardContent className="p-4 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>Overall severity</Label>
                  <Select value={severity} onValueChange={(v) => setSeverity(v as typeof severity)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="minor">Minor</SelectItem>
                      <SelectItem value="moderate">Moderate</SelectItem>
                      <SelectItem value="severe">Severe</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Initial estimate (GYD)</Label>
                  <Input
                    type="number"
                    min="0"
                    value={initialEstimate}
                    onChange={(e) => setInitialEstimate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Deductible (GYD)</Label>
                  <Input
                    type="number"
                    min="0"
                    value={deductible}
                    onChange={(e) => setDeductible(e.target.value)}
                  />
                </div>
              </div>

              <div className="pt-2 border-t border-border/40">
                <Label className="mb-3 block">Point of impact</Label>
                <DamageZoneSelector points={damagePoints} onChange={setDamagePoints} />
              </div>

              <div className="pt-2">
                <Label className="mb-2 block">Damage notes</Label>
                <Textarea
                  value={damageNotes}
                  onChange={(e) => setDamageNotes(e.target.value)}
                  placeholder="Describe the accident damage…"
                  className="h-24"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="p-4 border-t border-border bg-background flex justify-end shrink-0">
          <Button
            data-testid="button-create-claim"
            onClick={submit}
            disabled={busy}
            className="bg-primary hover:bg-primary/90 text-white min-w-32"
          >
            {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Plus className="w-4 h-4 mr-1.5" />}
            Open claim
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Collision tab — list + filters                                       */
/* ------------------------------------------------------------------ */

export function CollisionTab() {
  const [status, setStatus] = useState<string>("all");
  const [insurer, setInsurer] = useState("");
  const [lossFrom, setLossFrom] = useState("");
  const [lossTo, setLossTo] = useState("");

  const { data: claims, isLoading } = useListCollisionClaims({
    ...(status !== "all" && { status }),
    ...(insurer.trim() && { insurer: insurer.trim() }),
    ...(lossFrom && { lossFrom }),
    ...(lossTo && { lossTo }),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 p-4 bg-muted/10 rounded-xl border border-border/50">
        <div className="space-y-1.5 flex-1 min-w-[200px]">
          <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-full bg-background" data-testid="filter-claim-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 flex-1 min-w-[200px]">
          <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Insurer</Label>
          <Input
            className="w-full bg-background"
            value={insurer}
            onChange={(e) => setInsurer(e.target.value)}
            placeholder="Any insurer"
          />
        </div>
        <div className="space-y-1.5 w-full sm:w-36">
          <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Loss from</Label>
          <Input type="date" className="w-full bg-background" value={lossFrom} onChange={(e) => setLossFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5 w-full sm:w-36">
          <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Loss to</Label>
          <Input type="date" className="w-full bg-background" value={lossTo} onChange={(e) => setLossTo(e.target.value)} />
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading claims…
        </div>
      ) : (claims ?? []).length === 0 ? (
        <Card className="border-dashed border-border/40 bg-transparent">
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            <CarFront className="w-8 h-8 mx-auto mb-3 opacity-40" />
            No collision claims match. Open one with “New Claim” — accident
            repairs stay normal repair orders with the claim tracked alongside.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(claims ?? []).map((c) => (
            <ClaimCard key={c.id} claim={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClaimCard({ claim }: { claim: CollisionClaim }) {
  const { gyd: money } = useMoney();
  return (
    <Link
      href={`/service/collision/${claim.id}`}
      className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      aria-label={`Open collision claim ${claim.id} for ${claim.vehicleInfo}`}
      data-testid={`card-claim-${claim.id}`}
    >
      <Card className="h-full border-border/50 bg-background hover:border-primary/40 hover:shadow-md transition-all cursor-pointer group">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1 flex-1">
              <div className="font-semibold text-base truncate group-hover:text-primary transition-colors">
                <span className="text-muted-foreground font-normal">#{claim.id} · </span>{claim.vehicleInfo}
              </div>
              <div className="text-sm text-muted-foreground truncate flex items-center gap-2">
                <span className="font-medium text-foreground/80">{claim.insurerName}</span>
                {claim.claimNumber && <span>· {claim.claimNumber}</span>}
                <span>· {formatGuyanaDate(claim.lossDate)}</span>
              </div>
            </div>
            <Badge variant="outline" className={cn("shrink-0 px-2.5 py-1 text-xs border-2 font-semibold", statusBadgeClass(claim.status))}>
              {STATUS_LABEL[claim.status] ?? claim.status}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground pt-1 border-t border-border/40">
            {claim.customerName && (
              <span className="font-medium text-foreground/80">{claim.customerName}</span>
            )}
            <span className="capitalize px-2 py-0.5 rounded-md bg-muted text-xs font-medium">
              {claim.severity} damage
            </span>
            <div className="flex items-center gap-1.5 font-mono text-foreground/90 bg-muted/30 px-2 py-0.5 rounded-md text-xs">
              <CircleDollarSign className="w-3.5 h-3.5 text-muted-foreground" />
              {claim.approvedEstimate != null ? (
                <span>{money(claim.approvedEstimate)} (Approved)</span>
              ) : (
                <span>{money(claim.initialEstimate)} (Est.)</span>
              )}
            </div>
            {claim.pausedAt && (
              <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-medium text-xs bg-amber-500/10 px-2 py-0.5 rounded-md">
                <Pause className="w-3.5 h-3.5" /> Paused
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Claim detail                                                         */
/* ------------------------------------------------------------------ */

export function ClaimDetail({ claimId }: { claimId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { can, me } = useAuthz();
  const { gyd: money } = useMoney();
  const isApprover = /service manager|general manager|leadership|management|owner.?admin|admin/i.test(
    me?.roleName ?? "",
  );
  const canEdit = can("service", "edit");

  const { data, isLoading, isError } = useGetCollisionClaim(claimId);
  const advance = useAdvanceCollisionClaim();
  const resume = useResumeCollisionClaim();
  const update = useUpdateCollisionClaim();
  const addSupplement = useCreateCollisionSupplement();
  const decideSupplement = useDecideCollisionSupplement();
  const settle = useCreateCollisionSettlement();
  const invoice = useCreateJobCardInvoice();
  const { data: jobCards } = useListJobCards(
    { serviceOrderId: data?.claim.serviceOrderId ?? -1 },
  );

  const [note, setNote] = useState("");
  const [totalLossValue, setTotalLossValue] = useState("");
  const [suppDesc, setSuppDesc] = useState("");
  const [suppAmount, setSuppAmount] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payPayer, setPayPayer] = useState<"insurer" | "customer">("insurer");
  const [payReference, setPayReference] = useState("");
  const [estimateDraft, setEstimateDraft] = useState<{
    contested: string;
    approved: string;
  } | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetCollisionClaimQueryKey(claimId) });
    queryClient.invalidateQueries({ queryKey: getListCollisionClaimsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListServiceInvoicesQueryKey() });
  };

  const onError = (err: unknown, title: string) => {
    const body = (err as { unmet?: string[]; error?: string; message?: string }) ?? {};
    toast({
      title,
      description:
        (Array.isArray(body.unmet) ? body.unmet.join(" · ") : null) ??
        body.error ??
        (err instanceof Error ? err.message : "Unexpected error"),
      variant: "destructive",
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground h-full">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading claim…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="py-14 text-center text-sm text-muted-foreground h-full flex flex-col items-center justify-center">
        <AlertTriangle className="w-7 h-7 mx-auto mb-2 opacity-50" />
        Could not load this claim. It may have been removed or you may not have
        access.
      </div>
    );
  }

  const { claim, supplements, settlements, approvedTotal, insurerPaid, deductiblePaid, cycleSeconds } = data;
  const targets = ADVANCE_MAP[claim.status] ?? [];
  const advanceTargets = targets.filter((target) => target !== "invoiced");
  const invoiceCard = (jobCards ?? []).find((card) => ["completed", "closed"].includes(card.status));
  const activeCard = (jobCards ?? []).find((card) => !["completed", "closed", "cancelled"].includes(card.status));
  const cycleDays = (cycleSeconds / 86400).toFixed(1);
  const approvedRepairValue = approvedTotal ?? 0;
  const expectedCustomerShare = Math.min(claim.deductible, approvedRepairValue);
  const expectedInsurerShare = Math.max(0, approvedRepairValue - expectedCustomerShare);

  const generateCollisionInvoice = () => {
    if (!invoiceCard) {
      toast({
        title: "Complete the job card first",
        description:
          "The final invoice uses the completed job card’s parts, labour and tax.",
        variant: "destructive",
      });
      return;
    }
    invoice.mutate(
      { id: invoiceCard.id },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: "Collision invoice generated",
            description:
              "The final insurer and customer responsibilities are now ready.",
          });
        },
        onError: (error) =>
          onError(error, "Could not generate collision invoice"),
      },
    );
  };

  const doAdvance = async (target: CollisionClaimStatus) => {
    try {
      await advance.mutateAsync({
        id: claim.id,
        data: {
          targetStatus: target as never,
          ...(note.trim() && { note: note.trim() }),
          ...(target === "total_loss" && totalLossValue
            ? { totalLossValue: Number(totalLossValue) }
            : {}),
        },
      });
      setNote("");
      setTotalLossValue("");
      refresh();
      toast({ title: `Claim moved to ${STATUS_LABEL[target]}` });
    } catch (err) {
      onError(err, "Cannot advance claim");
    }
  };

  return (
    <>
      {/* Header */}
      <div className="p-6 pb-4 border-b border-border/60 bg-background flex flex-col gap-4 shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 pr-8">
            <h1 className="text-2xl font-bold flex flex-wrap items-center gap-2">
              <span>Claim #{claim.id}</span>
              <span className="text-muted-foreground font-normal text-lg truncate">· {claim.vehicleInfo}</span>
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground/80">{claim.insurerName}</span>
              {claim.claimNumber && <span>· Claim {claim.claimNumber}</span>}
              {claim.policyNumber && <span>· Policy {claim.policyNumber}</span>}
              <span>· Loss {formatGuyanaDate(claim.lossDate)}</span>
              <span>· {cycleDays} cycle days (excl. pauses)</span>
            </div>
          </div>
          <Badge variant="outline" className={cn("px-3 py-1.5 text-sm font-semibold border-2 shrink-0 whitespace-nowrap", statusBadgeClass(claim.status))}>
            {STATUS_LABEL[claim.status] ?? claim.status}
          </Badge>
        </div>

        <div className="w-full overflow-x-auto no-scrollbar pb-1">
          <div className="flex items-center min-w-max">
            {STATUS_ORDER.map((st, idx) => {
              const isCurrent = claim.status === st;
              const isPast = STATUS_ORDER.indexOf(claim.status) > idx && !TERMINAL.has(claim.status);
              return (
                <div key={st} className="flex items-center">
                  <div
                    className={cn(
                      "px-3 py-1 text-xs rounded-full whitespace-nowrap font-medium transition-colors border",
                      isCurrent
                        ? "bg-primary text-primary-foreground border-primary shadow-sm"
                        : isPast
                        ? "bg-primary/10 text-primary border-primary/20"
                        : "bg-muted/40 text-muted-foreground border-transparent"
                    )}
                  >
                    {STATUS_LABEL[st]}
                  </div>
                  {idx < STATUS_ORDER.length - 1 && (
                    <div className={cn("w-4 h-[2px] mx-1 rounded-full", isPast ? "bg-primary/30" : "bg-border")} />
                  )}
                </div>
              );
            })}
            {TERMINAL.has(claim.status) && claim.status !== "closed" && (
               <div className="flex items-center ml-1">
                 <div className="w-4 h-[2px] mr-1 rounded-full bg-border" />
                 <div className="px-3 py-1 text-xs rounded-full whitespace-nowrap font-medium bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
                   {STATUS_LABEL[claim.status]} {claim.outcomeReason ? `— ${claim.outcomeReason}` : ""}
                 </div>
               </div>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 sm:p-6 bg-muted/10">
        <div className="max-w-5xl mx-auto space-y-6">

          {/* Quick Links Row */}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" asChild className="h-9 bg-background shadow-sm hover:border-primary/40 transition-colors">
              <Link href={`/service/repair/${claim.serviceOrderId}`}>
                <ClipboardList className="w-4 h-4 mr-2 text-primary" />
                Repair order #{claim.serviceOrderId}
              </Link>
            </Button>
            {activeCard ? (
              <CollisionPartRequisitionForm claimId={claimId} serviceOrderId={claim.serviceOrderId} onSuccess={refresh} />
            ) : (
              <Button size="sm" variant="outline" disabled className="h-9 shadow-sm" title="Requires an active Job Card">
                Request Parts (No Active Job Card)
              </Button>
            )}
            {claim.customerName && (
              <div className="h-9 px-3 flex items-center rounded-md border border-border/60 bg-background text-sm text-muted-foreground shadow-sm">
                 <span className="truncate max-w-[200px]">{claim.customerName}</span>
              </div>
            )}
            {claim.serviceInvoiceId != null && (
              <div className="h-9 px-3 flex items-center rounded-md border border-border/60 bg-background text-sm text-muted-foreground shadow-sm">
                 <Receipt className="w-4 h-4 mr-2 text-muted-foreground" />
                 Invoice #{claim.serviceInvoiceId}
              </div>
            )}
          </div>

          <CollisionChecklistPanel claimId={claimId} checklist={data.checklist} summary={data.checklistSummary} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <CollisionCommunicationsCard claimId={claimId} />
            <CollisionPortalLinksCard claimId={claimId} />
          </div>

          {/* Estimate Card */}
          <Card className="border-border/60 shadow-sm bg-background overflow-hidden">
            <CardHeader className="py-3 px-4 border-b border-border/40 bg-muted/20 flex flex-row items-center justify-between">
              <h3 className="font-semibold text-sm">Estimate & Financials</h3>
              {canEdit && !TERMINAL.has(claim.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shadow-sm"
                  onClick={() =>
                    setEstimateDraft(
                      estimateDraft
                        ? null
                        : {
                            contested: claim.contestedEstimate?.toString() ?? "",
                            approved: claim.approvedEstimate?.toString() ?? "",
                          }
                    )
                  }
                >
                  {estimateDraft ? "Cancel" : "Record values"}
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-4 grid grid-cols-2 md:grid-cols-4 gap-6">
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Initial</div>
                <div className="font-mono text-lg">{money(claim.initialEstimate ?? 0)}</div>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Contested</div>
                <div className="font-mono text-lg">{claim.contestedEstimate != null ? money(claim.contestedEstimate) : "—"}</div>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Approved</div>
                <div className="font-mono text-lg text-primary font-semibold">{claim.approvedEstimate != null ? money(claim.approvedEstimate) : "—"}</div>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1">
                  Total w/ Supplements <CircleDollarSign className="w-3.5 h-3.5" />
                </div>
                <div className="font-mono text-lg font-semibold">{(approvedTotal ?? 0) > 0 ? money(approvedTotal!) : "—"}</div>
              </div>
            </CardContent>

            {/* Estimate Draft inline form */}
            {estimateDraft && (
              <div className="border-t border-border/40 bg-muted/10 p-4">
                <div className="flex flex-col sm:flex-row items-end gap-3">
                  <div className="space-y-1.5 flex-1 w-full">
                    <Label className="text-xs">Contested estimate (GYD)</Label>
                    <Input
                      type="number"
                      value={estimateDraft.contested}
                      onChange={(e) => setEstimateDraft({ ...estimateDraft, contested: e.target.value })}
                      className="bg-background"
                    />
                  </div>
                  <div className="space-y-1.5 flex-1 w-full">
                    <Label className="text-xs">Approved estimate (GYD)</Label>
                    <Input
                      type="number"
                      value={estimateDraft.approved}
                      onChange={(e) => setEstimateDraft({ ...estimateDraft, approved: e.target.value })}
                      className="bg-background"
                    />
                  </div>
                  <Button
                    onClick={() => {
                      update.mutate(
                        {
                          id: claimId,
                          data: {
                            contestedEstimate: estimateDraft.contested !== "" ? Number(estimateDraft.contested) : undefined,
                            approvedEstimate: estimateDraft.approved !== "" ? Number(estimateDraft.approved) : undefined,
                          },
                        },
                        {
                          onSuccess: () => {
                            setEstimateDraft(null);
                            refresh();
                            toast({ title: "Updated estimate values" });
                          },
                          onError: (err) => onError(err, "Update failed"),
                        }
                      );
                    }}
                    disabled={update.isPending}
                    className="w-full sm:w-auto mt-2 sm:mt-0"
                  >
                    Save values
                  </Button>
                </div>
              </div>
            )}
          </Card>

          {/* Damage Zones */}
          <Card className="border-border/60 shadow-sm bg-background overflow-hidden">
             <CardHeader className="py-3 px-4 border-b border-border/40 bg-muted/20">
               <h3 className="font-semibold text-sm">Damage / Point of Impact</h3>
             </CardHeader>
             <CardContent className="p-4 space-y-4">
                <DamageZoneSelector
                  points={claim.damagePoints as CollisionDamagePoint[]}
                  readOnly={!canEdit || TERMINAL.has(claim.status)}
                  onChange={async (next) => {
                    try {
                      await update.mutateAsync({ id: claim.id, data: { damagePoints: next } });
                      refresh();
                    } catch (err) {
                      onError(err, "Could not update damage zones");
                    }
                  }}
                />
                {claim.damageNotes && (
                  <div className="text-sm bg-muted/30 p-3 rounded-md border border-border/40 text-foreground/90 whitespace-pre-wrap mt-2">
                    {claim.damageNotes}
                  </div>
                )}
             </CardContent>
          </Card>

          {/* Documents */}
          <DocumentsCard
            entityType="collision_claim"
            entityId={claimId}
            canEdit={canEdit && !TERMINAL.has(claim.status)}
            title="Photos & Documents"
          />

          {/* Supplements */}
          <Card className="border-border/60 shadow-sm bg-background overflow-hidden">
            <CardHeader className="py-3 px-4 border-b border-border/40 bg-muted/20 flex flex-row items-center justify-between">
              <h3 className="font-semibold text-sm">Supplements</h3>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {supplements.length === 0 ? (
                 <div className="text-sm text-muted-foreground text-center py-6 border border-dashed border-border/60 rounded-lg">No supplements filed.</div>
              ) : (
                 <div className="space-y-3">
                   {supplements.map((s) => (
                     <div key={s.id} className="p-3 rounded-lg border border-border/60 bg-muted/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                       <div className="space-y-1">
                         <div className="font-medium text-sm flex items-center gap-2">
                           {s.description}
                           <Badge variant="outline" className={cn(
                             "text-[10px] py-0 px-1.5 uppercase font-bold",
                             s.status === 'approved' ? 'text-emerald-600 border-emerald-600/50 bg-emerald-500/10' :
                             s.status === 'denied' ? 'text-red-600 border-red-600/50 bg-red-500/10' :
                             'text-amber-600 border-amber-600/50 bg-amber-500/10'
                           )}>
                             {s.status}
                           </Badge>
                         </div>
                         <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-1.5">
                           <span>{s.requestedBy ?? "—"} requested {formatGuyanaDateTime(s.createdAt)}</span>
                           {s.decidedBy && <span>· {s.status} by {s.decidedBy} {s.decidedAt ? formatGuyanaDateTime(s.decidedAt) : ""}</span>}
                         </div>
                       </div>
                       <div className="flex flex-col sm:flex-row items-end sm:items-center gap-3 w-full sm:w-auto">
                         <div className="font-mono font-medium text-lg">{money(s.amount)}</div>
                         {s.status === "pending" && isApprover && (
                           <div className="flex items-center gap-2">
                             <Button
                               variant="outline" size="sm" className="h-8 text-xs border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10"
                               onClick={() => decideSupplement.mutate({ id: claimId, supplementId: s.id, data: { action: "approve" } }, { onSuccess: refresh, onError: (e) => onError(e, "Approval failed") })}
                             >
                               <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Approve
                             </Button>
                             <Button
                               variant="outline" size="sm" className="h-8 text-xs border-red-500/30 text-red-600 hover:bg-red-500/10"
                               onClick={() => decideSupplement.mutate({ id: claimId, supplementId: s.id, data: { action: "deny" } }, { onSuccess: refresh, onError: (e) => onError(e, "Denial failed") })}
                             >
                               <XCircle className="w-3.5 h-3.5 mr-1" /> Deny
                             </Button>
                           </div>
                         )}
                       </div>
                     </div>
                   ))}
                 </div>
              )}

              {/* Add supplement form */}
              {!TERMINAL.has(claim.status) && canEdit && (
                <div className="pt-4 border-t border-border/40 mt-4 flex flex-col sm:flex-row items-end gap-3">
                  <div className="space-y-1.5 flex-1 w-full">
                     <Label className="text-xs">Supplement description</Label>
                     <Input value={suppDesc} onChange={e => setSuppDesc(e.target.value)} placeholder="Hidden damage found..." className="bg-background" />
                  </div>
                  <div className="space-y-1.5 w-full sm:w-40">
                     <Label className="text-xs">Amount (GYD)</Label>
                     <Input type="number" value={suppAmount} onChange={e => setSuppAmount(e.target.value)} placeholder="0" className="bg-background" />
                  </div>
                  <Button
                     className="w-full sm:w-auto mt-2 sm:mt-0"
                     disabled={!suppDesc.trim() || !suppAmount || addSupplement.isPending}
                     onClick={() => addSupplement.mutate({
                       id: claimId,
                       data: { description: suppDesc.trim(), amount: Number(suppAmount) }
                     }, {
                       onSuccess: () => { setSuppDesc(""); setSuppAmount(""); refresh(); },
                       onError: (e) => onError(e, "Could not add supplement")
                     })}
                  >
                    <Plus className="w-4 h-4 mr-1.5" /> Request
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Settlement */}
          <Card className="border-border/60 shadow-sm bg-background overflow-hidden">
            <CardHeader className="py-3 px-4 border-b border-border/40 bg-muted/20">
              <h3 className="font-semibold text-sm">Settlement & Payments</h3>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {claim.serviceInvoiceId == null ? (
                <div className="rounded-xl border border-primary/20 bg-primary/[0.03] overflow-hidden">
                  <div className="p-4 border-b border-border/50">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                      <div>
                        <div className="text-xs font-bold uppercase tracking-widest text-primary">
                          Ready for financial handoff
                        </div>
                        <h4 className="font-semibold mt-1">Generate the collision invoice here</h4>
                        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
                          The final invoice pulls parts, labour and tax from the completed job card, then separates what the insurer owes from the customer’s deductible.
                        </p>
                      </div>
                      {claim.status === "insurer_signoff" && (
                        <Button
                          onClick={generateCollisionInvoice}
                          disabled={invoice.isPending || !invoiceCard}
                          className="shrink-0"
                        >
                          {invoice.isPending ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Receipt className="w-4 h-4 mr-2" />
                          )}
                          {invoiceCard ? "Generate Final Invoice" : "Job Card Not Complete"}
                        </Button>
                      )}
                    </div>
                    {claim.status === "insurer_signoff" && !invoiceCard && (
                      <div className="mt-3 text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2">
                        Complete or close the repair job card to lock the final parts and labour totals.
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border/50">
                    <div className="p-4">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Approved Repair Value</div>
                      <div className="font-mono text-lg mt-1">{money(approvedRepairValue)}</div>
                    </div>
                    <div className="p-4">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Expected Insurer Share</div>
                      <div className="font-mono text-lg text-primary mt-1">{money(expectedInsurerShare)}</div>
                    </div>
                    <div className="p-4">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Expected Customer Share</div>
                      <div className="font-mono text-lg text-sky-600 dark:text-sky-400 mt-1">{money(expectedCustomerShare)}</div>
                    </div>
                  </div>
                  <div className="px-4 py-2.5 text-xs text-muted-foreground border-t border-border/50 bg-muted/10">
                    Preview only. The issued invoice uses the final job-card total and caps the customer share at the deductible.
                  </div>
                </div>
              ) : (
                <>
                  <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-widest text-primary">Final Collision Invoice</div>
                        <div className="flex items-baseline gap-2 mt-1">
                          <span className="font-mono text-2xl font-semibold">{money((claim.insurerDue ?? 0) + (claim.deductibleDue ?? 0))}</span>
                          <span className="text-sm text-muted-foreground">Invoice #{claim.serviceInvoiceId}</span>
                        </div>
                      </div>
                      <Button asChild variant="outline" className="shrink-0">
                        <a href={`/api/service-invoices/${claim.serviceInvoiceId}/pdf`} target="_blank" rel="noreferrer">
                          <Download className="w-4 h-4 mr-2" />
                          View Invoice PDF
                        </a>
                      </Button>
                    </div>
                    <div className="mt-3 pt-3 border-t border-primary/15 flex items-center justify-between gap-4">
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Total outstanding
                      </span>
                      <span className="font-mono text-lg font-semibold text-foreground">
                        {money(
                          Math.max(
                            0,
                            (claim.insurerDue ?? 0) +
                              (claim.deductibleDue ?? 0) -
                              insurerPaid -
                              deductiblePaid,
                          ),
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="p-4 rounded-xl border border-primary/25 bg-primary/[0.035]">
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Insurer owes</div>
                      <div className="text-[10px] font-bold uppercase tracking-widest text-primary mt-4">Outstanding due</div>
                      <div className="font-mono text-3xl font-semibold text-primary mt-1">
                        {money(Math.max(0, (claim.insurerDue ?? 0) - insurerPaid))}
                      </div>
                      <div className="grid grid-cols-2 gap-3 pt-4 mt-4 border-t border-border/50">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Responsibility</div>
                          <div className="font-mono text-sm mt-1">{money(claim.insurerDue ?? 0)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Paid to date</div>
                          <div className="font-mono text-sm mt-1">{money(insurerPaid)}</div>
                        </div>
                      </div>
                    </div>
                    <div className="p-4 rounded-xl border border-sky-500/25 bg-sky-500/[0.035]">
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Customer owes · Deductible</div>
                      <div className="text-[10px] font-bold uppercase tracking-widest text-sky-600 dark:text-sky-400 mt-4">Outstanding due</div>
                      <div className="font-mono text-3xl font-semibold text-sky-600 dark:text-sky-400 mt-1">
                        {money(Math.max(0, (claim.deductibleDue ?? 0) - deductiblePaid))}
                      </div>
                      <div className="grid grid-cols-2 gap-3 pt-4 mt-4 border-t border-border/50">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Responsibility</div>
                          <div className="font-mono text-sm mt-1">{money(claim.deductibleDue ?? 0)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Paid to date</div>
                          <div className="font-mono text-sm mt-1">{money(deductiblePaid)}</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {settlements.length > 0 && (
                    <div className="space-y-2 pt-2">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Payment History</h4>
                      {settlements.map((s) => (
                        <div key={s.id} className="text-sm flex flex-col sm:flex-row sm:items-center justify-between py-2 border-b border-border/40 last:border-0 gap-2">
                          <div className="flex items-center gap-2 text-foreground/80 font-medium">
                            <Receipt className="w-4 h-4 text-muted-foreground" />
                            <span className="capitalize">{s.payer}</span>
                            {s.reference && <span className="text-muted-foreground font-normal">· Ref: {s.reference}</span>}
                          </div>
                          <div className="flex items-center gap-3">
                             <div className="font-mono">{money(s.amount)}</div>
                             <div className="text-xs text-muted-foreground w-28 text-right">{formatGuyanaDate(s.createdAt)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {!["denied", "total_loss"].includes(claim.status) && canEdit && (
                    <div className="pt-4 border-t border-border/40 mt-4 flex flex-col sm:flex-row items-end gap-3">
                      <div className="space-y-1.5 flex-1 w-full">
                        <Label className="text-xs">Payer</Label>
                        <Select value={payPayer} onValueChange={(v) => setPayPayer(v as any)}>
                          <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="insurer">Insurer</SelectItem>
                            <SelectItem value="customer">Customer (Deductible)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5 flex-1 w-full">
                        <Label className="text-xs">Reference</Label>
                        <Input value={payReference} onChange={e => setPayReference(e.target.value)} placeholder="Cheque / EFT no." className="bg-background" />
                      </div>
                      <div className="space-y-1.5 w-full sm:w-36">
                        <Label className="text-xs">Amount (GYD)</Label>
                        <Input type="number" value={payAmount} onChange={e => setPayAmount(e.target.value)} placeholder="0" className="bg-background" />
                      </div>
                      <Button
                         className="w-full sm:w-auto mt-2 sm:mt-0"
                         disabled={!payAmount || settle.isPending}
                         onClick={() => settle.mutate({
                           id: claim.id,
                           data: { payer: payPayer as any, amount: Number(payAmount), reference: payReference.trim() || undefined }
                         }, {
                           onSuccess: () => { setPayAmount(""); setPayReference(""); refresh(); toast({ title: "Payment recorded" }); },
                           onError: (e) => onError(e, "Could not record payment")
                         })}
                      >
                        Record
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Timeline */}
          <Card className="border-border/60 shadow-sm bg-background overflow-hidden">
            <CardHeader className="py-3 px-4 border-b border-border/40 bg-muted/20">
              <h3 className="font-semibold text-sm">Timeline</h3>
            </CardHeader>
            <CardContent className="p-4 pt-6">
               <div className="space-y-5 relative before:absolute before:inset-0 before:ml-[15px] before:h-full before:w-[2px] before:bg-border/60">
                 {[...claim.history].reverse().map((h, i) => (
                   <div key={i} className="relative flex items-start gap-4">
                     <div className="flex items-center justify-center w-8 h-8 rounded-full border border-border/60 bg-background text-muted-foreground shrink-0 z-10 shadow-sm mt-0.5">
                       <History className="w-3.5 h-3.5" />
                     </div>
                     <div className="flex-1 p-3 rounded-lg border border-border/50 bg-background shadow-sm space-y-1.5">
                       <div className="flex items-start sm:items-center justify-between gap-2 flex-col sm:flex-row">
                         <div className="text-sm font-semibold text-foreground/90">
                           {h.kind === "status" && `${STATUS_LABEL[h.from ?? ""] ?? h.from} → ${STATUS_LABEL[h.to ?? ""] ?? h.to}`}
                           {h.kind === "created" && "Claim opened at Intake"}
                           {h.kind === "estimate" && "Estimate updated"}
                           {h.kind === "supplement" && `Supplement ${h.to ?? ""}`}
                           {h.kind === "payment" && `Payment from ${h.to ?? "payer"}`}
                           {h.kind === "pause" && "Cycle time paused"}
                           {h.kind === "resume" && "Cycle time resumed"}
                           {h.kind === "note" && "Note added"}
                         </div>
                         <div className="text-[11px] text-muted-foreground shrink-0 flex items-center gap-2">
                           {h.amount != null && <span className="font-mono font-medium text-foreground">{money(h.amount)}</span>}
                           <span>{formatGuyanaDateTime(h.at)}</span>
                         </div>
                       </div>
                       <div className="text-xs text-muted-foreground">by {h.byName}</div>
                       {h.note && (
                         <div className="text-sm mt-2 p-2.5 rounded-md bg-muted/40 border border-border/40 text-foreground/90 whitespace-pre-wrap">
                           {h.note}
                         </div>
                       )}
                     </div>
                   </div>
                 ))}
               </div>
            </CardContent>
          </Card>

        </div>
      </div>

      {/* Footer actions */}
      <div className="sticky bottom-0 z-20 p-4 border-t border-border/60 bg-background/95 backdrop-blur flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          {claim.pausedAt ? (
            <Button
              variant="outline"
              className="border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 shadow-sm"
              onClick={() => {
                resume.mutate({ id: claimId }, {
                  onSuccess: () => { refresh(); toast({ title: "Claim resumed" }); },
                  onError: (e) => onError(e, "Could not resume")
                });
              }}
              disabled={resume.isPending}
            >
              <Play className="w-4 h-4 mr-2" /> Resume Work
            </Button>
          ) : <div />}
        </div>

        {canEdit && advanceTargets.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 justify-end w-full sm:w-auto">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Advance note (optional)"
              className="w-full sm:w-48 bg-muted/20"
            />
            {advanceTargets.includes("total_loss" as never) && (
              <Input
                type="number"
                value={totalLossValue}
                onChange={(e) => setTotalLossValue(e.target.value)}
                placeholder="Total loss val"
                className="w-full sm:w-36 bg-muted/20"
              />
            )}
            {advanceTargets.map((t) => {
              const needsApprover = APPROVER_TARGETS.has(t);
              const destructive = t === "denied" || t === "total_loss";
              return (
                <Button
                  key={t}
                  onClick={() => {
                    if (needsApprover && !isApprover) {
                      toast({
                        title: "Manager required",
                        description: "Only a manager can sign off on this step.",
                        variant: "destructive",
                      });
                      return;
                    }
                    doAdvance(t);
                  }}
                  disabled={advance.isPending || (needsApprover && !isApprover)}
                  className={cn(
                    "w-full sm:w-auto shadow-sm",
                    t === "denied"
                      ? "bg-red-600 hover:bg-red-700 text-white"
                      : t === "total_loss"
                      ? "bg-orange-600 hover:bg-orange-700 text-white"
                      : "bg-primary hover:bg-primary/90 text-white"
                  )}
                  title={needsApprover && !isApprover ? "Needs Manager sign-off" : undefined}
                >
                  {t === "denied" && <XCircle className="w-4 h-4 mr-1.5" />}
                  {t === "total_loss" && <AlertTriangle className="w-4 h-4 mr-1.5" />}
                  {t !== "denied" && t !== "total_loss" && <CheckCircle2 className="w-4 h-4 mr-1.5" />}
                  Move to {STATUS_LABEL[t]}
                  {needsApprover && !isApprover && <Lock className="w-3.5 h-3.5 ml-1.5 opacity-70" />}
                </Button>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground font-medium px-2">
            {TERMINAL.has(claim.status) ? "Claim is finalized" : "No further workflow steps available"}
          </div>
        )}
      </div>
    </>
  );
}
