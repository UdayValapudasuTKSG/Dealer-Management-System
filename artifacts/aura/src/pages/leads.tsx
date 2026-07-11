import { Link } from "wouter";
import {
  useListLeads,
  useListVehicles,
  useCreateLead,
  getListLeadsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Phone, Mail, ArrowUpRight, Car } from "lucide-react";
import { motion } from "framer-motion";
import { Page, PageHeader } from "@/components/layout/page";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";

const PHASE_LABEL: Record<string, string> = {
  aware: "New Lead",
  consider: "Working",
  engage: "Appointment",
  negotiate: "Desking",
  won: "Delivered",
  lost: "Lost",
};

export default function Leads() {
  const { data: leads, isLoading } = useListLeads();
  const { data: vehicles } = useListVehicles();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createLead = useCreateLead();

  const phases = ["aware", "consider", "engage", "negotiate", "won"];

  const withBase = (url: string) =>
    `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`;

  return (
    <Page width="full" fill>
      <PageHeader
        title="Pipeline"
        accent="Orchestration"
        subtitle="Every client journey, in motion."
        className="mb-8 shrink-0"
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
                type: "select",
                span: "half",
                placeholder: "Optional",
                options: (vehicles ?? []).map((v) => ({
                  value: String(v.id),
                  label: `${v.make} ${v.model}`,
                })),
              },
              { name: "email", label: "Email", type: "text", span: "half", placeholder: "kojo@email.com" },
              { name: "phone", label: "Phone", type: "text", span: "half", placeholder: "+233 …" },
              { name: "notes", label: "Notes", type: "textarea", span: "full", placeholder: "What are they looking for?" },
            ]}
            onSubmit={async (values) => {
              const payload = { ...values };
              if (payload.interestedVehicleId != null)
                payload.interestedVehicleId = Number(payload.interestedVehicleId);
              await createLead.mutateAsync({ data: payload as never });
              queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
              toast({ title: "Lead captured", description: "AURA is scoring and routing this prospect." });
            }}
          />
        }
      />

      <div className="flex gap-6 overflow-x-auto pb-4 flex-1 hide-scrollbar -mx-1 px-1">
        {phases.map((phase, phaseIndex) => {
          const phaseLeads = leads?.filter((l) => l.phase === phase) ?? [];
          return (
            <div
              key={phase}
              className="w-[340px] shrink-0 flex flex-col rounded-3xl bg-white/[0.03] backdrop-blur-2xl border border-white/10 shadow-[0_4px_24px_rgba(0,0,0,0.35)] p-5"
            >
              <div className="flex items-center justify-between mb-5 px-1">
                <div className="flex items-center gap-2.5">
                  <span className="w-2 h-2 rounded-full bg-primary" />
                  <h3 className="font-semibold text-sm uppercase tracking-widest text-foreground">
                    {PHASE_LABEL[phase] ?? phase}
                  </h3>
                </div>
                <span className="bg-primary/10 text-primary min-w-7 h-7 px-2 rounded-full text-xs font-bold flex items-center justify-center">
                  {phaseLeads.length}
                </span>
              </div>

              <div className="space-y-3.5 flex-1 overflow-y-auto pr-1.5 -mr-1.5 hide-scrollbar">
                {isLoading ? (
                  [1, 2].map((i) => (
                    <div
                      key={i}
                      className="h-28 bg-white/[0.03] rounded-2xl animate-pulse"
                    />
                  ))
                ) : phaseLeads.length === 0 ? (
                  <div className="flex items-center justify-center h-24 text-muted-foreground/50 text-xs border-2 border-dashed border-border/60 rounded-2xl uppercase tracking-widest font-semibold">
                    Empty
                  </div>
                ) : (
                  phaseLeads.map((lead, i) => {
                    const vehicle = vehicles?.find(
                      (v) => v.id === lead.interestedVehicleId,
                    );
                    return (
                      <motion.div
                        key={lead.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: phaseIndex * 0.06 + i * 0.04 }}
                      >
                        <Card className="cursor-pointer border border-white/10 shadow-sm hover:shadow-xl hover:shadow-primary/10 hover:border-primary/40 transition-all duration-300 rounded-2xl bg-white/[0.04] hover:bg-white/[0.07] overflow-hidden group">
                          <CardContent className="p-0">
                            <div className="flex items-stretch">
                              <div className="w-20 shrink-0 bg-white/[0.03] flex items-center justify-center overflow-hidden">
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
                              <div className="flex-1 min-w-0 p-4">
                                <div className="font-semibold text-base leading-tight truncate group-hover:text-primary transition-colors">
                                  {lead.name}
                                </div>
                                {vehicle && (
                                  <div className="text-xs text-muted-foreground truncate mt-0.5">
                                    {vehicle.make} {vehicle.model}
                                  </div>
                                )}
                                <div className="flex items-center gap-2 mt-3">
                                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                                    {lead.channel}
                                  </span>
                                  {lead.email && (
                                    <Mail className="w-3.5 h-3.5 text-muted-foreground/70" />
                                  )}
                                  {lead.phone && (
                                    <Phone className="w-3.5 h-3.5 text-muted-foreground/70" />
                                  )}
                                  {lead.customerId && (
                                    <Link
                                      href={`/customers/${lead.customerId}`}
                                      className="ml-auto text-[10px] font-bold uppercase tracking-wider text-primary inline-flex items-center gap-0.5 hover:underline"
                                    >
                                      Client
                                      <ArrowUpRight className="w-3 h-3" />
                                    </Link>
                                  )}
                                </div>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      </motion.div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Page>
  );
}
