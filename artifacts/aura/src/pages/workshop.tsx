import { useListJobCards } from "@workspace/api-client-react";
import { Page, PageHeader } from "@/components/layout/page";
import { JobCardPanel } from "@/pages/service";
import { Wrench, ClipboardList, Clock, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export default function Workshop() {
  const { data: cards, isLoading } = useListJobCards({ mine: "1" });

  const open = cards?.filter((c) => c.status !== "completed") ?? [];
  const done = cards?.filter((c) => c.status === "completed") ?? [];
  const hours = cards?.reduce((s, c) => s + c.laborHours, 0) ?? 0;

  return (
    <Page className="space-y-8">
      <PageHeader
        title="Workshop"
        accent="Operations"
        subtitle="Your assigned job cards, checklists and hours."
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard icon={ClipboardList} label="Active jobs" value={String(open.length)} />
        <StatCard icon={CheckCircle2} label="Completed" value={String(done.length)} />
        <StatCard icon={Clock} label="Booked hours" value={`${hours.toFixed(1)}h`} />
      </div>

      {isLoading ? (
        <div className="grid gap-6">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-48 bg-white/[0.05] rounded-3xl animate-pulse" />
          ))}
        </div>
      ) : !cards?.length ? (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] py-24 flex flex-col items-center gap-3 text-center">
          <Wrench className="w-8 h-8 text-muted-foreground" />
          <p className="text-muted-foreground">
            No job cards assigned to you yet. When a service manager assigns you a job, it appears here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {[...open, ...done].map((card) => (
            <JobCardPanel key={card.id} card={card} technicianView />
          ))}
        </div>
      )}
    </Page>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
}) {
  return (
    <Card className="glass-panel border-none rounded-3xl">
      <CardContent className="p-5 flex items-center gap-4">
        <div className="w-11 h-11 rounded-2xl bg-primary/10 ring-1 ring-primary/25 flex items-center justify-center">
          <Icon className="w-5 h-5 text-primary" />
        </div>
        <div>
          <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            {label}
          </div>
          <div className="font-light text-2xl tracking-tight">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
