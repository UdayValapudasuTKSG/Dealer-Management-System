import { useEffect, useState } from "react";
import { Link, useSearch, useLocation } from "wouter";
import {
  useListDeals,
  useListGates,
  useListVehicles,
  useCreateDeal,
  getListDealsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, FileText } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { GateCard, GATE_LABEL } from "@/components/gate-card";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { useViewMode } from "@/hooks/use-view-mode";
import { ViewControls } from "@/components/view-controls";

const STAGE_LABEL: Record<string, string> = {
  desking: "Desking",
  negotiation: "Negotiation",
  finance: "Finance",
  committed: "Committed",
  delivered: "Delivered",
};

export default function Deals() {
  const { data: deals, isLoading } = useListDeals();
  const { data: gates } = useListGates({ status: "pending" });
  const { data: vehicles } = useListVehicles();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createDeal = useCreateDeal();
  const { density, setDensity, layout, setLayout } = useViewMode("deals");
  const compact = density === "compact";

  const search = useSearch();
  const [, navigate] = useLocation();
  const [deskOpen, setDeskOpen] = useState(false);
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

  const gatesForDeal = (dealId: number) =>
    (gates ?? []).filter((g) => g.refType === "deal" && g.refId === dealId);

  const stages = ["desking", "negotiation", "finance", "committed", "delivered"];

  return (
    <>
    <PageHero
      video="pipeline_sales_floor.mp4"
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
                name: "vehicleId",
                label: "Vehicle",
                type: "select",
                required: true,
                span: "full",
                placeholder: "Select a vehicle",
                defaultValue: prefillVehicle ? String(prefillVehicle.id) : undefined,
                options: (vehicles ?? []).map((v) => ({
                  value: String(v.id),
                  label: `${v.year} ${v.make} ${v.model} — $${v.price.toLocaleString()}`,
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
                span: "full",
                defaultValue: "desking",
                options: [
                  { value: "desking", label: "Desking" },
                  { value: "negotiation", label: "Negotiation" },
                  { value: "finance", label: "Finance" },
                  { value: "committed", label: "Committed" },
                ],
              },
            ]}
            onSubmit={async (values) => {
              const payload = { ...values };
              if (payload.vehicleId != null) payload.vehicleId = Number(payload.vehicleId);
              await createDeal.mutateAsync({ data: payload as never });
              queryClient.invalidateQueries({ queryKey: getListDealsQueryKey() });
              toast({ title: "Deal desked", description: "AURA computed the OTD structure." });
            }}
          />
      </div>

      {layout === "list" ? (
        <div className="glass-panel rounded-2xl overflow-hidden border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Customer</th>
                <th className="px-4 py-3 font-semibold">Stage</th>
                <th className="px-4 py-3 font-semibold text-right">OTD</th>
                <th className="px-4 py-3 font-semibold text-right hidden md:table-cell">Discount</th>
                <th className="px-4 py-3 font-semibold text-center hidden md:table-cell">Deposit</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Advisor</th>
              </tr>
            </thead>
            <tbody>
              {(deals ?? []).map((deal) => (
                <tr
                  key={deal.id}
                  className={`border-b border-white/5 hover:bg-foreground/[0.03] transition-colors ${
                    deal.customerId ? "cursor-pointer" : ""
                  } ${compact ? "" : "h-14"}`}
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
                  <td className="px-4 py-2 text-right tabular-nums font-semibold">
                    ${deal.otdPrice.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-primary hidden md:table-cell">
                    -${deal.discount.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-center hidden md:table-cell">
                    {deal.depositPaid ? (
                      <span className="text-emerald-400 text-xs font-semibold">Paid</span>
                    ) : (
                      <span className="text-muted-foreground text-xs">Pending</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground hidden lg:table-cell">
                    {deal.salesAdvisor ?? "—"}
                  </td>
                </tr>
              ))}
              {(deals ?? []).length === 0 && !isLoading && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground text-sm">
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
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: stageIndex * 0.06 + i * 0.04 }}
                    >
                      <Card className="border border-white/10 shadow-sm hover:shadow-xl hover:shadow-primary/10 hover:border-primary/40 transition-all duration-300 rounded-2xl bg-white/[0.04] hover:bg-white/[0.07] overflow-hidden group">
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
                            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                              <FileText className="w-4 h-4 text-primary" />
                            </div>
                          </div>

                          <div className="font-light text-3xl mb-4 tracking-tight text-primary">
                            ${deal.otdPrice.toLocaleString()}
                          </div>

                          <div className="space-y-2 text-sm font-medium text-muted-foreground pt-4 border-t border-border/50">
                            <div className="flex justify-between items-center">
                              <span className="uppercase tracking-wider text-xs">
                                MSRP
                              </span>
                              <span className="text-foreground">
                                ${deal.vehiclePrice.toLocaleString()}
                              </span>
                            </div>
                            <div className="flex justify-between items-center text-primary">
                              <span className="uppercase tracking-wider text-xs">
                                Discount
                              </span>
                              <span>-${deal.discount.toLocaleString()}</span>
                            </div>
                            {deal.monthlyPayment && (
                              <div className="flex justify-between items-center pt-2">
                                <span className="uppercase tracking-wider text-xs">
                                  Monthly
                                </span>
                                <span className="text-foreground font-bold">
                                  ${deal.monthlyPayment}/mo
                                </span>
                              </div>
                            )}
                          </div>
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
    </Page>
    </>
  );
}
