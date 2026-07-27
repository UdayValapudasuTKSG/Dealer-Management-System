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
  getListDealsQueryKey,
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
import { Plus, FileText, Link2, Loader2, Unlink, User } from "lucide-react";
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
  const { can } = useAuthz();
  const canEditDeals = can("deals", "edit");
  const canCreateDeals = can("deals", "create");

  const [attachDeal, setAttachDeal] = useState<Deal | null>(null);
  const [attachLeadId, setAttachLeadId] = useState<string>("");
  const [attachSearch, setAttachSearch] = useState("");
  const [cancelDeal, setCancelDeal] = useState<Deal | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelNote, setCancelNote] = useState("");

  const commitDeal = async (deal: Deal) => {
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
    } catch (err) {
      const detail = (
        err as {
          response?: { data?: { error?: string; unmet?: string[]; message?: string } };
        }
      )?.response?.data;
      toast({
        title: "Deal can't be committed yet",
        description:
          detail?.unmet?.[0] ??
          detail?.message ??
          detail?.error ??
          (err instanceof Error ? err.message : undefined),
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
    // Approved refund gates stay visible so finance can record the refund.
    ...(approvedGates ?? []).filter(
      (g) =>
        g.type === "refund_release" &&
        g.refType === "deal" &&
        g.refId === dealId,
    ),
  ];

  const stages = ["desking", "committed", "delivered", "cancelled"];

  return (
    <>
    <PageHero

      eyebrow="Sales Desk"
      title="Deal"
      accent="Structuring"
      subtitle="Bespoke negotiation and closing."
    />
    <Page fill>
      <div className="mb-8 shrink-0 flex items-center justify-end gap-3">
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
              <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
                <Plus className="w-5 h-5" />
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
              { name: "discount", label: "Discount", type: "number", span: "half", placeholder: "0" },
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
              await createDeal.mutateAsync({ data: payload as never });
              refreshLeadLink([
                payload.leadId != null ? (payload.leadId as number) : null,
              ]);
              toast({ title: "Deal desked", description: "AURA computed the OTD structure." });
            }}
          />
          )}
      </div>

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
              </tr>
            </thead>
            <tbody>
              {(deals ?? []).map((deal) => (
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
                    {divisions?.find((d) => d.id === deal.divisionId)?.name ??
                      "—"}
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
                </tr>
              ))}
              {(deals ?? []).length === 0 && !isLoading && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-muted-foreground text-sm">
                    No deals yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
      <div className="flex gap-6 overflow-x-auto pb-4 flex-1 hide-scrollbar -mx-1 px-1">
        {stages.map((stage, stageIndex) => {
          const stageDeals = deals?.filter((d) => d.stage === stage) ?? [];
          return (
            <div
              key={stage}
              className="w-[340px] shrink-0 flex flex-col rounded-3xl bg-white/[0.03] backdrop-blur-2xl border border-white/10 shadow-[0_4px_24px_rgba(0,0,0,0.03)] p-5"
            >
              <div className="flex items-center justify-between mb-5 px-1">
                <div className="flex items-center gap-2.5">
                  <span className="w-2 h-2 rounded-full bg-primary" />
                  <h3 className="font-semibold text-sm uppercase tracking-widest text-foreground">
                    {STAGE_LABEL[stage] ?? stage}
                  </h3>
                </div>
                <span className="bg-primary/10 text-primary min-w-7 h-7 px-2 rounded-full text-xs font-bold flex items-center justify-center">
                  {stageDeals.length}
                </span>
              </div>

              <div className="space-y-3.5 flex-1 overflow-y-auto pr-1.5 -mr-1.5 hide-scrollbar">
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
                  stageDeals.map((deal, i) => (
                    <motion.div
                      key={deal.id}
                      id={`deal-${deal.id}`}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: stageIndex * 0.06 + i * 0.04 }}
                    >
                      <Card className={`border shadow-sm hover:shadow-xl hover:shadow-primary/10 hover:border-primary/40 transition-all duration-300 rounded-2xl bg-white/[0.04] hover:bg-white/[0.07] overflow-hidden group ${
                        isFocused(deal.id) ? "border-primary ring-2 ring-primary/50" : "border-white/10"
                      }`}>
                        <CardContent className="p-5">
                          <div className="flex justify-between items-start mb-4 gap-3">
                            {deal.customerId ? (
                              <Link
                                href={`/customers/${deal.customerId}`}
                                className="font-semibold text-base leading-tight truncate hover:text-primary transition-colors"
                              >
                                {deal.customerName || "Unknown Customer"}
                              </Link>
                            ) : (
                              <div className="font-semibold text-base leading-tight truncate">
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
                                  className="w-8 h-8 rounded-full bg-foreground/[0.05] flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                                >
                                  <Link2 className="w-4 h-4" />
                                </button>
                              )}
                              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                                <FileText className="w-4 h-4 text-primary" />
                              </div>
                            </div>
                          </div>

                          {deal.leadId != null && (
                            <Link
                              href={`/lead/${deal.leadId}`}
                              className="inline-flex items-center gap-1.5 mb-3 text-xs font-medium text-primary bg-primary/10 rounded-full px-2.5 py-1 hover:bg-primary/15 transition-colors"
                            >
                              <User className="w-3 h-3" />
                              {leadName(deal.leadId)}
                            </Link>
                          )}

                          <div className="font-light text-3xl mb-4 tracking-tight text-primary">
                            {money.dual(deal.otdPrice)}
                          </div>

                          <div className="space-y-2 text-sm font-medium text-muted-foreground pt-4 border-t border-border/50">
                            <div className="flex justify-between items-center">
                              <span className="uppercase tracking-wider text-xs">
                                MSRP
                              </span>
                              <span className="text-foreground">
                                {money.gyd(deal.vehiclePrice)}
                              </span>
                            </div>
                            <div className="flex justify-between items-center text-primary">
                              <span className="uppercase tracking-wider text-xs">
                                Discount
                              </span>
                              <span>-{money.gyd(deal.discount)}</span>
                            </div>
                            <div className="flex justify-between items-center">
                              <span className="uppercase tracking-wider text-xs">
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
                                  className="bg-transparent border border-border/60 rounded-full px-2.5 py-1 text-xs font-semibold text-foreground focus:outline-none focus:border-primary/60"
                                >
                                  <option value="cash">Cash</option>
                                  <option value="bank_financing">Bank Financing</option>
                                  <option value="cheque">Cheque</option>
                                </select>
                              ) : (
                                <span className="text-foreground">
                                  {deal.finalPaymentMethod
                                    ? METHOD_LABEL[deal.finalPaymentMethod]
                                    : "—"}
                                </span>
                              )}
                            </div>
                            {deal.monthlyPayment && (
                              <div className="flex justify-between items-center pt-2">
                                <span className="uppercase tracking-wider text-xs">
                                  Monthly
                                </span>
                                <span className="text-foreground font-bold">
                                  {money.gyd(Number(deal.monthlyPayment))}/mo
                                </span>
                              </div>
                            )}
                            {deal.stage === "cancelled" && (
                              <div className="flex justify-between items-center pt-2">
                                <span className="uppercase tracking-wider text-xs">
                                  Reason
                                </span>
                                <span className="text-foreground text-xs font-semibold">
                                  {CANCEL_REASONS.find(
                                    (r) => r.value === deal.cancellationReason,
                                  )?.label ?? "—"}
                                </span>
                              </div>
                            )}
                          </div>
                          {canEditDeals && deal.stage === "desking" && (
                            <button
                              onClick={() => commitDeal(deal)}
                              disabled={updateDeal.isPending}
                              className="mt-4 w-full text-center text-xs font-semibold uppercase tracking-widest text-primary-foreground bg-primary hover:bg-primary/90 transition-colors py-2 rounded-full disabled:opacity-60"
                            >
                              Commit Deal
                            </button>
                          )}
                          {canEditDeals &&
                            (deal.stage === "desking" ||
                              deal.stage === "committed") && (
                              <button
                                onClick={() => setCancelDeal(deal)}
                                className="mt-4 w-full text-center text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-destructive transition-colors py-1.5 rounded-full border border-border/50 hover:border-destructive/40"
                              >
                                Cancel &amp; Refund
                              </button>
                            )}
                        </CardContent>
                      </Card>
                      <AnimatePresence mode="popLayout">
                        {gatesForDeal(deal.id).map((gate) => (
                          <div key={gate.id} className="mt-4">
                            <GateCard
                              gate={gate}
                              label={GATE_LABEL[gate.type]}
                              showCustomerLink={false}
                            />
                          </div>
                        ))}
                      </AnimatePresence>
                    </motion.div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}

      <Dialog
        open={attachDeal != null}
        onOpenChange={(o) => {
          if (!o) setAttachDeal(null);
        }}
      >
        <DialogContent className="glass-panel border-white/10 sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-tight">
              {attachDeal?.leadId != null ? "Change lead link" : "Attach to lead"}
            </DialogTitle>
            <DialogDescription>
              Link deal #{attachDeal?.id}
              {attachDeal?.customerName ? ` (${attachDeal.customerName})` : ""} to a
              pipeline lead so its stage checklist recognizes the deal.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <Input
              placeholder="Search leads…"
              value={attachSearch}
              onChange={(e) => setAttachSearch(e.target.value)}
              className="bg-white/[0.04] border-white/10"
            />
            <div className="max-h-64 overflow-y-auto rounded-xl border border-white/10 divide-y divide-white/5">
              {filteredLeads.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No matching leads.
                </div>
              ) : (
                filteredLeads.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => setAttachLeadId(String(l.id))}
                    className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition-colors ${
                      attachLeadId === String(l.id)
                        ? "bg-primary/15 text-primary"
                        : "hover:bg-foreground/[0.04]"
                    }`}
                  >
                    <span className="font-medium truncate">{l.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {l.phone || l.email || ""}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
          <DialogFooter className="gap-2">
            {attachDeal?.leadId != null && (
              <Button
                variant="outline"
                onClick={detachFromLead}
                disabled={updateDeal.isPending}
                className="gap-1.5"
              >
                <Unlink className="w-3.5 h-3.5" />
                Detach
              </Button>
            )}
            <Button
              onClick={attachToLead}
              disabled={
                !attachLeadId ||
                attachLeadId === String(attachDeal?.leadId ?? "") ||
                updateDeal.isPending
              }
              className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
            >
              {updateDeal.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              <Link2 className="w-4 h-4" />
              Attach
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
        <DialogContent className="glass-panel border-white/10 sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-tight">
              Cancel deal #{cancelDeal?.id}
            </DialogTitle>
            <DialogDescription>
              {cancelDeal?.customerName
                ? `${cancelDeal.customerName} — `
                : ""}
              If a deposit has been captured, cancelling raises a refund
              release request for manager approval and the vehicle stays held
              until it is approved. With no funds captured, the vehicle
              returns to available stock immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Reason
              </label>
              <select
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="mt-1.5 w-full bg-white/[0.04] border border-white/10 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-primary/60"
              >
                <option value="">Select a reason…</option>
                {CANCEL_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Note (optional)
              </label>
              <Input
                value={cancelNote}
                onChange={(e) => setCancelNote(e.target.value)}
                placeholder="Anything worth recording about this cancellation"
                className="mt-1.5 bg-white/[0.04] border-white/10"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setCancelDeal(null)}
              className="rounded-full px-5"
            >
              Keep deal
            </Button>
            <Button
              onClick={submitCancellation}
              disabled={!cancelReason || updateDeal.isPending}
              variant="destructive"
              className="rounded-full px-6 gap-2"
            >
              {updateDeal.isPending && (
                <Loader2 className="w-4 h-4 animate-spin" />
              )}
              Cancel deal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
    </>
  );
}
