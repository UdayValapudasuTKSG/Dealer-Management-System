import { useEffect, useState } from "react";
import { Link, useSearch, useLocation } from "wouter";
import { useFocusParam, useFocusHighlight } from "@/lib/use-focus-param";
import {
  useListDeals,
  useListGates,
  useListVehicles,
  useListDivisions,
  useListLeads,
  useCreateDeal,
  useUpdateDeal,
  useCreateBooking,
  useListBookings,
  useListInvoices,
  useListOutstandingBalances,
  getListDealsQueryKey,
  getListBookingsQueryKey,
  getGetLeadQueryKey,
  getGetLeadTimelineQueryKey,
} from "@workspace/api-client-react";
import type { Deal } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Plus,
  FileText,
  Link2,
  Loader2,
  Unlink,
  User,
  Banknote,
  ShieldCheck,
  CheckCircle2,
  ArrowRight,
  Truck,
  PenTool,
  Ban,
  Clock,
} from "lucide-react";
import { useAuthz } from "@/lib/auth";
import { motion, AnimatePresence } from "framer-motion";
import { GateCard, GATE_LABEL } from "@/components/gate-card";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { useViewMode } from "@/hooks/use-view-mode";
import { ViewControls } from "@/components/view-controls";
import { useMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  bank_financing: "Bank Financing",
  cheque: "Cheque",
};

const STAGE_LABEL: Record<string, string> = {
  desking: "Desking",
  negotiation: "Negotiation",
  finance: "Finance",
  committed: "Committed",
  delivered: "Delivered",
  cancelled: "Cancelled",
  lost: "Lost",
};

const STAGE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  desking: PenTool,
  committed: CheckCircle2,
  delivered: Truck,
  cancelled: Ban,
};

const UNMET_LABEL: Record<string, string> = {
  deposit_required: "Reservation deposit required",
  below_floor_price: "Discount needs manager approval",
  capital_order: "Capital stock order needs manager approval",
  financing_not_approved: "Bank financing not yet approved",
};

const CANCEL_REASONS: { value: string; label: string }[] = [
  { value: "customer_changed_mind", label: "Customer changed mind" },
  { value: "financing_declined", label: "Financing declined" },
  { value: "found_elsewhere", label: "Found vehicle elsewhere" },
  { value: "price", label: "Price" },
  { value: "delivery_delay", label: "Delivery delay" },
  { value: "vehicle_defect", label: "Vehicle defect" },
  { value: "duplicate", label: "Duplicate deal" },
  { value: "other", label: "Other" },
];

export default function Deals() {
  const { data: deals, isLoading } = useListDeals();
  const { data: gates } = useListGates({ status: "pending" });
  const { data: approvedGates } = useListGates({ status: "approved" });
  const { data: vehicles } = useListVehicles();
  const { data: divisions } = useListDivisions();
  const { data: leads } = useListLeads();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createDeal = useCreateDeal();
  const updateDeal = useUpdateDeal();
  const createBooking = useCreateBooking();
  const { data: bookings } = useListBookings();
  const { data: invoices } = useListInvoices();
  const { data: outstandingBalances } = useListOutstandingBalances();

  // Amount already paid against a deal (across its non-void invoices).
  const paidForDeal = (dealId: number): number =>
    (invoices ?? [])
      .filter((inv) => inv.dealId === dealId && inv.status !== "void")
      .reduce((sum, inv) => {
        if (inv.status === "paid") return sum + inv.amount;
        const o = (outstandingBalances ?? []).find((x) => x.invoiceId === inv.id);
        return sum + (o?.paidAmount ?? 0);
      }, 0);
  const { can } = useAuthz();
  const canEditDeals = can("deals", "edit");
  const canCreateDeals = can("deals", "create");

  const [attachDeal, setAttachDeal] = useState<Deal | null>(null);
  const [attachLeadId, setAttachLeadId] = useState<string>("");
  const [attachSearch, setAttachSearch] = useState("");
  const [cancelDeal, setCancelDeal] = useState<Deal | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelNote, setCancelNote] = useState("");

  const [blockedCommit, setBlockedCommit] = useState<{
    deal: Deal;
    unmet: string[];
    messages: Record<string, string>;
  } | null>(null);
  const [blockedMode, setBlockedMode] = useState<
    "reasons" | "deposit" | "bypass"
  >("reasons");
  const [depositAmount, setDepositAmount] = useState("");
  const [waiverReason, setWaiverReason] = useState("");

  const closeBlocked = () => {
    setBlockedCommit(null);
    setBlockedMode("reasons");
    setDepositAmount("");
    setWaiverReason("");
  };

  const commitDeal = async (deal: Deal): Promise<boolean> => {
    try {
      await updateDeal.mutateAsync({
        id: deal.id,
        data: { stage: "committed" },
      });
      queryClient.invalidateQueries({ queryKey: getListDealsQueryKey() });
      queryClient.invalidateQueries({
        predicate: (q) =>
          String(q.queryKey[0] ?? "").includes("/gates") ||
          String(q.queryKey[0] ?? "").includes("/vehicles"),
      });
      toast({
        title: "Deal committed",
        description:
          "The vehicle is now reserved for this customer. Delivery and GRA filing steps are unlocked.",
      });
      return true;
    } catch (err) {
      const detail = (
        err as {
          response?: {
            data?: {
              error?: string;
              unmet?: string[];
              messages?: Record<string, string>;
              message?: string;
            };
          };
        }
      )?.response?.data;
      if (Array.isArray(detail?.unmet) && detail.unmet.length > 0) {
        setBlockedMode("reasons");
        setBlockedCommit({
          deal,
          unmet: detail.unmet,
          messages: detail.messages ?? {},
        });
      } else {
        toast({
          title: "Deal can't be committed yet",
          description:
            detail?.message ??
            detail?.error ??
            (err instanceof Error ? err.message : undefined),
          variant: "destructive",
        });
      }
      return false;
    }
  };

  const bookingExpiry = () =>
    new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

  const refreshDepositState = () => {
    queryClient.invalidateQueries({ queryKey: getListDealsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
    queryClient.invalidateQueries({
      predicate: (q) =>
        String(q.queryKey[0] ?? "").includes("/gates") ||
        String(q.queryKey[0] ?? "").includes("/vehicles") ||
        String(q.queryKey[0] ?? "").includes("/invoices"),
    });
  };

  const bookingError = (err: unknown) =>
    (err as { response?: { data?: { error?: string } } })?.response?.data
      ?.error ?? (err instanceof Error ? err.message : undefined);

  const submitDeposit = async () => {
    if (!blockedCommit) return;
    const deal = blockedCommit.deal;
    const amount = Number(depositAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    try {
      await createBooking.mutateAsync({
        data: {
          vehicleId: deal.vehicleId,
          customerId: deal.customerId ?? undefined,
          customerName: deal.customerName || "Unknown Customer",
          leadId: deal.leadId ?? undefined,
          dealId: deal.id,
          bookingAmount: amount,
          amountPaid: amount,
          expiresAt: bookingExpiry(),
          notes: `Reservation deposit recorded from Deal Structuring (deal #${deal.id})`,
        },
      });
      refreshDepositState();
      toast({
        title: "Deposit recorded",
        description:
          "Reservation created, invoice paid and receipt issued. Committing the deal…",
      });
      closeBlocked();
      await commitDeal(deal);
    } catch (err) {
      toast({
        title: "Could not record the deposit",
        description: bookingError(err),
        variant: "destructive",
      });
    }
  };

  const submitBypass = async () => {
    if (!blockedCommit) return;
    const deal = blockedCommit.deal;
    if (!waiverReason.trim()) return;
    try {
      await createBooking.mutateAsync({
        data: {
          vehicleId: deal.vehicleId,
          customerId: deal.customerId ?? undefined,
          customerName: deal.customerName || "Unknown Customer",
          leadId: deal.leadId ?? undefined,
          dealId: deal.id,
          bookingAmount: 0,
          expiresAt: bookingExpiry(),
          waiverReason: waiverReason.trim(),
        },
      });
      refreshDepositState();
      toast({
        title: "Trusted bypass requested",
        description:
          "A fee-waiver gate is now waiting for manager approval on this deal — commit unlocks once it is approved.",
      });
      closeBlocked();
    } catch (err) {
      toast({
        title: "Could not apply the trusted bypass",
        description: bookingError(err),
        variant: "destructive",
      });
    }
  };

  const submitCancellation = async () => {
    if (!cancelDeal || !cancelReason) return;
    try {
      await updateDeal.mutateAsync({
        id: cancelDeal.id,
        data: {
          stage: "cancelled",
          cancellationReason: cancelReason as never,
          cancellationNote: cancelNote.trim() || undefined,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListDealsQueryKey() });
      queryClient.invalidateQueries({ predicate: (q) =>
        String(q.queryKey[0] ?? "").includes("/gates") ||
        String(q.queryKey[0] ?? "").includes("/vehicles"),
      });
      toast({
        title: "Deal cancelled",
        description:
          "If funds were captured, a refund release request is now waiting for manager approval; otherwise the vehicle went back to available stock.",
      });
      setCancelDeal(null);
      setCancelReason("");
      setCancelNote("");
    } catch (err) {
      const detail = (
        err as { response?: { data?: { error?: string; unmet?: string[] } } }
      )?.response?.data;
      toast({
        title: "Could not cancel the deal",
        description:
          detail?.unmet?.[0] ??
          detail?.error ??
          (err instanceof Error ? err.message : undefined),
        variant: "destructive",
      });
    }
  };

  const refreshLeadLink = (leadIds: (number | null | undefined)[]) => {
    queryClient.invalidateQueries({ queryKey: getListDealsQueryKey() });
    for (const lid of leadIds) {
      if (lid != null) {
        queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(lid) });
        queryClient.invalidateQueries({
          queryKey: getGetLeadTimelineQueryKey(lid),
        });
      }
    }
  };

  const attachToLead = async () => {
    if (!attachDeal || !attachLeadId) return;
    const leadId = Number(attachLeadId);
    try {
      await updateDeal.mutateAsync({
        id: attachDeal.id,
        data: { leadId },
      });
      refreshLeadLink([attachDeal.leadId, leadId]);
      const lead = (leads ?? []).find((l) => l.id === leadId);
      toast({
        title: "Deal attached",
        description: `Deal #${attachDeal.id} is now linked to ${lead?.name ?? `lead #${leadId}`}.`,
      });
      setAttachDeal(null);
    } catch (err) {
      toast({
        title: "Could not attach deal",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  const detachFromLead = async () => {
    if (!attachDeal || attachDeal.leadId == null) return;
    try {
      await updateDeal.mutateAsync({
        id: attachDeal.id,
        data: { leadId: null },
      });
      refreshLeadLink([attachDeal.leadId]);
      toast({ title: "Deal detached from lead" });
      setAttachDeal(null);
    } catch (err) {
      toast({
        title: "Could not detach deal",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  const openAttach = (deal: Deal) => {
    setAttachLeadId(deal.leadId != null ? String(deal.leadId) : "");
    setAttachSearch("");
    setAttachDeal(deal);
  };

  const leadName = (leadId: number | null | undefined) =>
    leadId != null
      ? ((leads ?? []).find((l) => l.id === leadId)?.name ?? `Lead #${leadId}`)
      : null;

  const filteredLeads = (leads ?? []).filter(
    (l) =>
      !attachSearch.trim() ||
      l.name.toLowerCase().includes(attachSearch.trim().toLowerCase()),
  );
  const money = useMoney();
  const { density, setDensity, layout, setLayout } = useViewMode("deals");
  const compact = density === "compact";

  const search = useSearch();
  const [, navigate] = useLocation();
  const [deskOpen, setDeskOpen] = useState(false);
  /* Triage deep link: /deals?deal=<id> scrolls to and highlights the deal. */
  const focusDealId = useFocusParam("deal");
  const isFocused = useFocusHighlight(focusDealId, "deal", !!deals?.length);
  const prefillVehicleId = new URLSearchParams(search).get("vehicle") ?? "";
  const prefillVehicle = (vehicles ?? []).find(
    (v) => String(v.id) === prefillVehicleId,
  );

  useEffect(() => {
    if (prefillVehicleId && prefillVehicle) setDeskOpen(true);
  }, [prefillVehicleId, prefillVehicle]);

  const handleOpenChange = (open: boolean) => {
    setDeskOpen(open);
    if (!open && prefillVehicleId) navigate("/deals", { replace: true });
  };

  const gatesForDeal = (dealId: number) => [
    ...(gates ?? []).filter((g) => g.refType === "deal" && g.refId === dealId),
    // Pending fee-waiver (trusted bypass) gates live on the deal's booking.
    ...(gates ?? []).filter(
      (g) =>
        g.type === "fee_waiver" &&
        g.refType === "booking" &&
        (bookings ?? []).some(
          (b) => b.id === g.refId && b.dealId === dealId,
        ),
    ),
    // Approved refund gates stay visible so finance can record the refund.
    ...(approvedGates ?? []).filter(
      (g) =>
        g.type === "refund_release" &&
        g.refType === "deal" &&
        g.refId === dealId,
    ),
  ];

  const stages = ["desking", "committed", "delivered", "cancelled"];

  const heroActions = (
    <div className="flex items-center gap-3">
          <ViewControls
            layout={layout}
            onLayoutChange={setLayout}
            density={density}
            onDensityChange={setDensity}
          />
          {canCreateDeals && (
          <CreateRecordDialog
            title="Desk a New Deal"
            description="Structure a deal — AURA computes OTD and flags approvals."
            pending={createDeal.isPending}
            submitLabel="Desk deal"
            open={deskOpen}
            onOpenChange={handleOpenChange}
            trigger={
              <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-4 h-9 text-sm shadow-md shadow-primary/20 gap-1.5 font-medium tracking-wide">
                <Plus className="w-4 h-4" />
                Desk New Deal
              </Button>
            }
            fields={[
              {
                name: "leadId",
                label: "Lead (optional)",
                type: "select",
                span: "full",
                placeholder: "Link to a pipeline lead",
                options: (leads ?? []).map((l) => ({
                  value: String(l.id),
                  label: `${l.name}${l.phone ? ` · ${l.phone}` : l.email ? ` · ${l.email}` : ""}`,
                })),
                onChange: (value, setField) => {
                  const lead = (leads ?? []).find(
                    (l) => String(l.id) === value,
                  );
                  if (!lead) return;
                  if (lead.name) setField("customerName", lead.name);
                  if (lead.interestedVehicleId != null) {
                    const veh = (vehicles ?? []).find(
                      (v) => v.id === lead.interestedVehicleId,
                    );
                    if (veh) {
                      setField("vehicleId", String(veh.id));
                      setField("vehiclePrice", String(veh.price));
                    }
                  }
                },
              },
              {
                name: "vehicleId",
                label: "Vehicle",
                type: "select",
                required: true,
                span: "full",
                placeholder: "Select a vehicle",
                defaultValue: prefillVehicle ? String(prefillVehicle.id) : undefined,
                options: (vehicles ?? []).map((v) => ({
                  value: String(v.id),
                  label: `${v.year} ${v.make} ${v.model} — ${money.gyd(v.price)}`,
                })),
              },
              { name: "customerName", label: "Customer", type: "text", span: "full", placeholder: "Ama Owusu" },
              {
                name: "vehiclePrice",
                label: "Vehicle price",
                type: "number",
                required: true,
                span: "half",
                placeholder: "72000",
                defaultValue: prefillVehicle ? String(prefillVehicle.price) : undefined,
              },
              { name: "discount", label: "Discount (GYD)", type: "number", span: "half", placeholder: "0" },
              { name: "discountPercent", label: "Discount (%)", type: "number", span: "half", placeholder: "e.g. 3" },
              {
                name: "stage",
                label: "Stage",
                type: "select",
                span: "half",
                defaultValue: "desking",
                options: [
                  { value: "desking", label: "Desking" },
                  { value: "committed", label: "Committed" },
                ],
              },
              {
                name: "finalPaymentMethod",
                label: "Payment method",
                type: "select",
                span: "half",
                defaultValue: "cash",
                options: [
                  { value: "cash", label: "Cash" },
                  { value: "bank_financing", label: "Bank Financing" },
                  { value: "cheque", label: "Cheque" },
                ],
              },
            ]}
            onSubmit={async (values) => {
              const payload = { ...values };
              if (payload.vehicleId != null) payload.vehicleId = Number(payload.vehicleId);
              if (payload.leadId != null) payload.leadId = Number(payload.leadId);
              // Discount can be entered as % or GYD — % converts off the
              // vehicle price; if both are given, the GYD amount wins.
              const pct = Number(payload.discountPercent ?? 0);
              delete payload.discountPercent;
              if ((payload.discount == null || Number(payload.discount) === 0) && pct > 0) {
                payload.discount = Math.round(
                  (Number(payload.vehiclePrice ?? 0) * pct) / 100,
                );
              }
              await createDeal.mutateAsync({ data: payload as never });
              refreshLeadLink([
                payload.leadId != null ? (payload.leadId as number) : null,
              ]);
              toast({ title: "Deal desked", description: "AURA computed the OTD structure." });
            }}
          />
          )}
    </div>
  );

  return (
    <>
    <PageHero
      eyebrow="Sales Desk"
      title="Deal"
      accent="Structuring"
      subtitle="Bespoke negotiation and closing."
      className="pb-3"
      action={heroActions}
    />
    <Page className="pt-0">
      {layout === "list" ? (
        <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Customer</th>
                <th className="px-4 py-3 font-semibold">Stage</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Division</th>
                <th className="px-4 py-3 font-semibold text-right">OTD</th>
                <th className="px-4 py-3 font-semibold text-right hidden md:table-cell">Discount</th>
                <th className="px-4 py-3 font-semibold text-center hidden md:table-cell">Deposit</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Method</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Advisor</th>
                <th className="px-4 py-3 font-semibold">Lead</th>
                <th className="px-4 py-3 font-semibold text-right">Next Action</th>
              </tr>
            </thead>
            <tbody>
              {(deals ?? []).map((deal) => {
                const dealGates = gatesForDeal(deal.id);
                const hasPendingGates = dealGates.length > 0;
                return (
                  <tr
                    key={deal.id}
                    id={`deal-${deal.id}`}
                    className={`border-b border-white/5 hover:bg-foreground/[0.03] transition-colors ${
                      deal.customerId ? "cursor-pointer" : ""
                    } ${compact ? "" : "h-14"} ${
                      isFocused(deal.id) ? "bg-primary/10 ring-1 ring-inset ring-primary/50" : ""
                    }`}
                    onClick={() =>
                      deal.customerId && navigate(`/customers/${deal.customerId}`)
                    }
                  >
                    <td className={`px-4 font-medium ${compact ? "py-2.5" : "py-3.5"}`}>
                      {deal.customerName || "Unknown Customer"}
                    </td>
                    <td className="px-4 py-2">
                      <span className="rounded-full bg-primary/10 text-primary px-2.5 py-0.5 text-xs font-semibold">
                        {STAGE_LABEL[deal.stage] ?? deal.stage}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground hidden lg:table-cell">
                      {divisions?.find((d) => d.id === deal.divisionId)?.name ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">
                      {money.gyd(deal.otdPrice)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-primary hidden md:table-cell">
                      -{money.gyd(deal.discount)}
                    </td>
                    <td className="px-4 py-2 text-center hidden md:table-cell">
                      {deal.depositPaid ? (
                        <span className="text-emerald-400 text-xs font-semibold">Paid</span>
                      ) : (
                        <span className="text-muted-foreground text-xs">Pending</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground hidden lg:table-cell">
                      {deal.finalPaymentMethod
                        ? METHOD_LABEL[deal.finalPaymentMethod]
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground hidden lg:table-cell">
                      {deal.salesAdvisor ?? "—"}
                    </td>
                    <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                      {deal.leadId != null ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Link
                            href={`/lead/${deal.leadId}`}
                            className="inline-flex items-center gap-1 text-primary hover:underline text-xs font-medium"
                          >
                            <User className="w-3 h-3" />
                            {leadName(deal.leadId)}
                          </Link>
                          {canEditDeals && (
                            <button
                              onClick={() => openAttach(deal)}
                              aria-label="Change lead link"
                              className="text-muted-foreground hover:text-primary transition-colors"
                            >
                              <Link2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </span>
                      ) : canEditDeals ? (
                        <button
                          onClick={() => openAttach(deal)}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                        >
                          <Link2 className="w-3.5 h-3.5" />
                          Attach to lead
                        </button>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      {deal.stage === "desking" && canEditDeals ? (
                        <span className="inline-flex items-center gap-2">
                          {hasPendingGates && (
                            <span className="text-xs font-semibold text-amber-500 inline-flex items-center gap-1.5">
                              <Clock className="w-3.5 h-3.5" /> Approvals
                            </span>
                          )}
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-7 text-xs px-3 rounded-full font-medium"
                            onClick={() => commitDeal(deal)}
                            disabled={updateDeal.isPending}
                          >
                            Commit Deal <ArrowRight className="w-3.5 h-3.5 ml-1" />
                          </Button>
                        </span>
                      ) : hasPendingGates ? (
                        <span className="text-xs font-semibold text-amber-500 inline-flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5" /> Pending Approvals
                        </span>
                      ) : deal.stage === "committed" ? (
                        <Link href="/deliveries">
                          <Button 
                            size="sm" 
                            variant="secondary"
                            className="h-7 text-xs px-3 rounded-full font-medium"
                          >
                            Go to Deliveries <ArrowRight className="w-3.5 h-3.5 ml-1" />
                          </Button>
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">None</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {(deals ?? []).length === 0 && !isLoading && (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-muted-foreground text-sm">
                    No deals yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
      <div className="flex gap-4 items-start overflow-x-auto pb-4 hide-scrollbar -mx-1 px-1">
        {stages.map((stage, stageIndex) => {
          const stageDeals = deals?.filter((d) => d.stage === stage) ?? [];
          return (
            <div
              key={stage}
              className="flex-1 min-w-[260px] flex flex-col rounded-2xl bg-white/[0.03] backdrop-blur-2xl border border-white/10 shadow-[0_4px_24px_rgba(0,0,0,0.03)] p-3"
            >
              <div className="flex items-center justify-between mb-2.5 px-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                    {(() => {
                      const Icon = STAGE_ICONS[stage] || CheckCircle2;
                      return <Icon className="w-3.5 h-3.5" />;
                    })()}
                  </div>
                  <h3 className="font-semibold text-xs uppercase tracking-widest text-foreground">
                    {STAGE_LABEL[stage] ?? stage}
                  </h3>
                </div>
                <span className="bg-primary/10 text-primary min-w-6 h-6 px-1.5 rounded-full text-[11px] font-bold flex items-center justify-center">
                  {stageDeals.length}
                </span>
              </div>

              <div className="space-y-3">
                {isLoading ? (
                  [1].map((i) => (
                    <div
                      key={i}
                      className="h-40 bg-white/[0.05] rounded-2xl animate-pulse"
                    />
                  ))
                ) : stageDeals.length === 0 ? (
                  <div className="flex items-center justify-center h-24 text-muted-foreground/50 text-xs border-2 border-dashed border-border/60 rounded-2xl uppercase tracking-widest font-semibold">
                    Empty
                  </div>
                ) : (
                  stageDeals.map((deal, i) => {
                    const dealGates = gatesForDeal(deal.id);
                    const hasPendingGates = dealGates.length > 0;
                    return (
                      <motion.div
                        key={deal.id}
                        id={`deal-${deal.id}`}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: stageIndex * 0.06 + i * 0.04 }}
                      >
                        <Card className={`border shadow-sm hover:shadow-xl hover:shadow-primary/10 hover:border-primary/40 transition-all duration-300 rounded-[1.25rem] bg-white/[0.04] hover:bg-white/[0.07] overflow-hidden group flex flex-col ${
                          isFocused(deal.id) ? "border-primary ring-2 ring-primary/50" : "border-white/10"
                        }`}>
                          <CardContent className="p-3.5 flex-1">
                            <div className="flex justify-between items-start mb-2 gap-2">
                              {deal.customerId ? (
                                <Link
                                  href={`/customers/${deal.customerId}`}
                                  className="font-semibold text-sm leading-tight truncate hover:text-primary transition-colors"
                                >
                                  {deal.customerName || "Unknown Customer"}
                                </Link>
                              ) : (
                                <div className="font-semibold text-sm leading-tight truncate">
                                  {deal.customerName || "Unknown Customer"}
                                </div>
                              )}
                              <div className="flex items-center gap-1.5 shrink-0">
                                {canEditDeals && (
                                  <button
                                    onClick={() => openAttach(deal)}
                                    aria-label={
                                      deal.leadId != null
                                        ? "Change lead link"
                                        : "Attach to lead"
                                    }
                                    title={
                                      deal.leadId != null
                                        ? "Change lead link"
                                        : "Attach to lead"
                                    }
                                    className="w-6 h-6 rounded-full bg-foreground/[0.05] flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                                  >
                                    <Link2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>

                            {deal.leadId != null && (
                              <Link
                                href={`/lead/${deal.leadId}`}
                                className="inline-flex items-center gap-1.5 mb-2 text-[11px] font-medium text-primary bg-primary/10 rounded-full px-2 py-0.5 hover:bg-primary/15 transition-colors"
                              >
                                <User className="w-3 h-3" />
                                {leadName(deal.leadId)}
                              </Link>
                            )}

                            <div className="font-light text-lg mb-0.5 tracking-tight text-primary truncate">
                              {money.dual(deal.otdPrice)}
                            </div>

                            <div className="space-y-1.5 text-sm font-medium text-muted-foreground pt-2.5 mt-2.5 border-t border-border/50">
                              <div className="flex justify-between items-center">
                                <span className="uppercase tracking-wider text-[10px]">
                                  MSRP
                                </span>
                                <span className="text-foreground text-xs">
                                  {money.gyd(deal.vehiclePrice)}
                                </span>
                              </div>
                              {deal.discount > 0 && (
                                <div className="flex justify-between items-center text-primary">
                                  <span className="uppercase tracking-wider text-[10px]">
                                    Discount
                                  </span>
                                  <span className="text-xs">-{money.gyd(deal.discount)}</span>
                                </div>
                              )}
                              <div className="flex justify-between items-center">
                                <span className="uppercase tracking-wider text-[10px]">
                                  Settlement
                                </span>
                                {canEditDeals && deal.stage === "desking" ? (
                                  <select
                                    value={deal.finalPaymentMethod ?? "cash"}
                                    onChange={async (e) => {
                                      try {
                                        await updateDeal.mutateAsync({
                                          id: deal.id,
                                          data: {
                                            finalPaymentMethod: e.target
                                              .value as "cash" | "bank_financing" | "cheque",
                                          },
                                        });
                                        queryClient.invalidateQueries({
                                          queryKey: getListDealsQueryKey(),
                                        });
                                      } catch (err) {
                                        toast({
                                          title: "Could not update payment method",
                                          description:
                                            err instanceof Error ? err.message : undefined,
                                          variant: "destructive",
                                        });
                                      }
                                    }}
                                    className="bg-transparent border border-border/60 rounded-full px-2 py-0.5 text-xs font-semibold text-foreground focus:outline-none focus:border-primary/60"
                                  >
                                    <option value="cash">Cash</option>
                                    <option value="bank_financing">Bank Financing</option>
                                    <option value="cheque">Cheque</option>
                                  </select>
                                ) : (
                                  <span className="text-foreground text-xs">
                                    {deal.finalPaymentMethod
                                      ? METHOD_LABEL[deal.finalPaymentMethod]
                                      : "—"}
                                  </span>
                                )}
                              </div>
                              {(deal.stage === "desking" ||
                                deal.stage === "committed") &&
                                deal.otdPrice > 0 && (
                                  <>
                                    <div className="flex justify-between items-center">
                                      <span className="uppercase tracking-wider text-[10px]">
                                        Paid
                                      </span>
                                      <span className="text-emerald-500 text-xs">
                                        {money.gyd(paidForDeal(deal.id))}
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center">
                                      <span className="uppercase tracking-wider text-[10px]">
                                        Remaining
                                      </span>
                                      <span className="text-foreground text-xs font-bold">
                                        {money.gyd(
                                          Math.max(
                                            deal.otdPrice - paidForDeal(deal.id),
                                            0,
                                          ),
                                        )}
                                      </span>
                                    </div>
                                  </>
                                )}
                              {deal.monthlyPayment && (
                                <div className="flex justify-between items-center pt-1.5">
                                  <span className="uppercase tracking-wider text-[10px]">
                                    Monthly
                                  </span>
                                  <span className="text-foreground text-xs font-bold">
                                    {money.gyd(Number(deal.monthlyPayment))}/mo
                                  </span>
                                </div>
                              )}
                              {deal.stage === "cancelled" && (
                                <div className="flex justify-between items-center pt-1.5">
                                  <span className="uppercase tracking-wider text-[10px]">
                                    Reason
                                  </span>
                                  <span className="text-foreground text-[11px] font-semibold">
                                    {CANCEL_REASONS.find(
                                      (r) => r.value === deal.cancellationReason,
                                    )?.label ?? "—"}
                                  </span>
                                </div>
                              )}
                            </div>
                          </CardContent>

                          {/* Action Footer */}
                          <div className="p-2 bg-white/[0.02] border-t border-border/50 flex flex-col gap-1">
                            {hasPendingGates && (
                              <div className="py-1 flex items-center justify-center gap-2 text-amber-500 font-medium text-xs">
                                <Clock className="w-4 h-4" />
                                Waiting for Approvals
                              </div>
                            )}
                            <div className="flex items-center gap-1.5">
                              {canEditDeals && deal.stage === "desking" && (
                                <Button
                                  onClick={() => commitDeal(deal)}
                                  disabled={updateDeal.isPending}
                                  className="flex-1 text-[11px] font-bold uppercase tracking-widest text-primary-foreground bg-primary hover:bg-primary/90 transition-colors h-8 rounded-lg disabled:opacity-60 gap-1.5"
                                >
                                  Commit Deal <ArrowRight className="w-3.5 h-3.5" />
                                </Button>
                              )}
                              {!hasPendingGates && deal.stage === "committed" && (
                                <Link href="/deliveries" className="flex-1">
                                  <Button
                                    variant="secondary"
                                    className="w-full text-[11px] font-bold uppercase tracking-widest h-8 rounded-lg gap-1.5 bg-primary/10 hover:bg-primary/20 text-primary border-none"
                                  >
                                    Go to Deliveries <ArrowRight className="w-3.5 h-3.5" />
                                  </Button>
                                </Link>
                              )}
                              {deal.stage === "delivered" && (
                                <div className="flex-1 py-1 flex items-center justify-center gap-2 text-emerald-500 font-medium text-xs">
                                  <CheckCircle2 className="w-4 h-4" />
                                  Deal Completed
                                </div>
                              )}
                              {canEditDeals && (deal.stage === "desking" || deal.stage === "committed") && (
                                <button
                                  onClick={() => setCancelDeal(deal)}
                                  className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-destructive transition-colors px-2.5 h-8 rounded-lg border border-border/60 hover:border-destructive/40"
                                >
                                  Cancel
                                </button>
                              )}
                            </div>
                          </div>
                        </Card>

                        <AnimatePresence mode="popLayout">
                          {dealGates.map((gate) => (
                            <div key={gate.id} className="mt-3">
                              <GateCard
                                gate={gate}
                                label={GATE_LABEL[gate.type]}
                                showCustomerLink={false}
                              />
                            </div>
                          ))}
                        </AnimatePresence>
                      </motion.div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}

      <Dialog
        open={blockedCommit != null}
        onOpenChange={(o) => {
          if (!o) closeBlocked();
        }}
      >
        <DialogContent className="glass-panel border-white/10 sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-tight">
              {blockedMode === "deposit"
                ? "Record reservation deposit"
                : blockedMode === "bypass"
                  ? "Apply trusted bypass (manager)"
                  : "Deal can't be committed yet"}
            </DialogTitle>
            <DialogDescription>
              {blockedMode === "deposit"
                ? `Capture the reservation fee for ${blockedCommit?.deal.customerName || "this customer"} — AURA creates the booking, issues the reservation invoice, applies the payment and issues the receipt.`
                : blockedMode === "bypass"
                  ? "For fleet or repeat VIP buyers the reservation fee can be waived. This records a zero-fee reservation and raises a manager-approval gate — commit unlocks once a manager approves it."
                  : `Deal #${blockedCommit?.deal.id}${blockedCommit?.deal.customerName ? ` (${blockedCommit.deal.customerName})` : ""} has unmet commit requirements.`}
            </DialogDescription>
          </DialogHeader>

          {blockedMode === "reasons" && blockedCommit && (
            <div className="space-y-4 py-1">
              <ul className="space-y-2">
                {blockedCommit.unmet.map((code) => (
                  <li
                    key={code}
                    className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5"
                  >
                    <div className="text-sm font-semibold">
                      {UNMET_LABEL[code] ?? code}
                    </div>
                    {blockedCommit.messages[code] && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {blockedCommit.messages[code]}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {blockedCommit.unmet.includes("deposit_required") && (
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    onClick={() => setBlockedMode("deposit")}
                    className="flex-1 bg-primary hover:bg-primary/90 text-white rounded-full gap-2"
                  >
                    <Banknote className="w-4 h-4" />
                    Record deposit
                  </Button>
                  <Button
                    onClick={() => setBlockedMode("bypass")}
                    variant="outline"
                    className="flex-1 rounded-full gap-2"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    Apply trusted bypass (manager)
                  </Button>
                </div>
              )}
            </div>
          )}

          {blockedMode === "deposit" && (
            <div className="space-y-3 py-1">
              <div>
                <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Deposit amount (GYD)
                </label>
                <Input
                  type="number"
                  min={1}
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="1000"
                  className="mt-1.5 bg-white/[0.04] border-white/10"
                />
                {Number(depositAmount) > 0 && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    ≈ {money.gyd(Number(depositAmount))} — cash receipt issued
                    on capture.
                  </p>
                )}
              </div>
            </div>
          )}

          {blockedMode === "bypass" && (
            <div className="space-y-3 py-1">
              <div>
                <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Waiver reason
                </label>
                <Input
                  value={waiverReason}
                  onChange={(e) => setWaiverReason(e.target.value)}
                  placeholder="Fleet account — repeat VIP buyer, fee waived per GM policy"
                  className="mt-1.5 bg-white/[0.04] border-white/10"
                />
              </div>
            </div>
          )}

          <DialogFooter className="mt-2">
            {blockedMode !== "reasons" && (
              <Button
                variant="ghost"
                onClick={() => setBlockedMode("reasons")}
                className="rounded-full mr-auto"
              >
                Back
              </Button>
            )}
            <Button
              variant="outline"
              onClick={closeBlocked}
              className="rounded-full"
            >
              Cancel
            </Button>
            {blockedMode === "deposit" && (
              <Button
                disabled={
                  createBooking.isPending ||
                  !depositAmount ||
                  Number(depositAmount) <= 0
                }
                onClick={submitDeposit}
                className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
              >
                {createBooking.isPending && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                Capture &amp; Commit
              </Button>
            )}
            {blockedMode === "bypass" && (
              <Button
                disabled={createBooking.isPending || !waiverReason.trim()}
                onClick={submitBypass}
                className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
              >
                {createBooking.isPending && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                Request Bypass
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Attach to Lead Dialog */}
      <Dialog
        open={attachDeal != null}
        onOpenChange={(o) => {
          if (!o) setAttachDeal(null);
        }}
      >
        <DialogContent className="glass-panel border-white/10">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-tight">
              Attach to Pipeline Lead
            </DialogTitle>
            <DialogDescription>
              Link this deal to a sales lead so the timeline includes it.
            </DialogDescription>
          </DialogHeader>

          <div className="py-2 space-y-4">
            <div>
              <Input
                placeholder="Search leads..."
                value={attachSearch}
                onChange={(e) => setAttachSearch(e.target.value)}
                className="bg-white/[0.04] border-white/10"
              />
            </div>
            <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-2">
              {filteredLeads.map((l) => (
                <label
                  key={l.id}
                  className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                    attachLeadId === String(l.id)
                      ? "bg-primary/10 border-primary/50 text-foreground"
                      : "bg-white/[0.02] border-white/5 text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                  }`}
                >
                  <input
                    type="radio"
                    name="attach_lead"
                    value={String(l.id)}
                    checked={attachLeadId === String(l.id)}
                    onChange={(e) => setAttachLeadId(e.target.value)}
                    className="sr-only"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">
                      {l.name}
                    </div>
                    {(l.email || l.phone) && (
                      <div className="text-xs truncate mt-0.5 opacity-70">
                        {l.email}
                        {l.email && l.phone && " · "}
                        {l.phone}
                      </div>
                    )}
                  </div>
                  <span className="text-[10px] uppercase tracking-widest font-bold opacity-60">
                    {l.phase}
                  </span>
                </label>
              ))}
              {filteredLeads.length === 0 && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No leads found.
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="sm:justify-between">
            <div className="flex items-center gap-2">
              {attachDeal?.leadId != null && (
                <Button
                  variant="outline"
                  onClick={detachFromLead}
                  disabled={updateDeal.isPending}
                  className="rounded-full text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/20 gap-2"
                >
                  <Unlink className="w-4 h-4" />
                  Detach Link
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => setAttachDeal(null)}
                className="rounded-full"
              >
                Cancel
              </Button>
              <Button
                disabled={!attachLeadId || updateDeal.isPending}
                onClick={attachToLead}
                className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
              >
                {updateDeal.isPending && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                <Link2 className="w-4 h-4" />
                Attach Lead
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Deal Dialog */}
      <Dialog
        open={cancelDeal != null}
        onOpenChange={(o) => {
          if (!o) {
            setCancelDeal(null);
            setCancelReason("");
            setCancelNote("");
          }
        }}
      >
        <DialogContent className="glass-panel border-white/10">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-tight text-destructive">
              Cancel Deal
            </DialogTitle>
            <DialogDescription>
              Cancelling releases the vehicle hold. If a reservation fee was
              paid, a refund-release gate will be raised for manager approval.
            </DialogDescription>
          </DialogHeader>

          <div className="py-2 space-y-4">
            <div>
              <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 block">
                Primary Reason
              </label>
              <select
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full h-10 px-3 rounded-xl bg-white/[0.04] border border-white/10 text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                <option value="" disabled>
                  Select a reason...
                </option>
                {CANCEL_REASONS.map((r) => (
                  <option key={r.value} value={r.value} className="bg-background">
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 block">
                Notes (Optional)
              </label>
              <textarea
                value={cancelNote}
                onChange={(e) => setCancelNote(e.target.value)}
                placeholder="Additional context about the cancellation..."
                className="w-full min-h-[100px] p-3 rounded-xl bg-white/[0.04] border border-white/10 text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setCancelDeal(null);
                setCancelReason("");
                setCancelNote("");
              }}
              className="rounded-full"
            >
              Keep Deal Open
            </Button>
            <Button
              disabled={!cancelReason || updateDeal.isPending}
              onClick={submitCancellation}
              variant="destructive"
              className="rounded-full px-6 gap-2"
            >
              {updateDeal.isPending && (
                <Loader2 className="w-4 h-4 animate-spin" />
              )}
              Cancel &amp; Refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
    </>
  );
}
