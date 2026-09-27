import { Headset, PhoneForwarded } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCallCentreReport } from "@/hooks/use-call-centre";

export function CallCentreKpis() {
  const { data, isLoading, isError, refetch } = useCallCentreReport();
  const tiles = [
    {
      key: "active",
      icon: Headset,
      label: "Active call-centre follow-ups",
      sub: "Leads currently held by call-centre reps (pending or follow-up), all time",
      value: data?.activeFollowUp,
    },
    {
      key: "transferred",
      icon: PhoneForwarded,
      label: "Qualified & transferred",
      sub: "Leads the call centre has handed to a Sales Advisor, all time",
      value: data?.qualifiedTransferred,
    },
  ];
  return (
    <section className="mb-4" data-testid="section-call-centre-kpis">
      <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
        Call Centre qualification
      </h3>
      {isError ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-muted-foreground flex items-center justify-between gap-3">
          Call-centre counts are unavailable right now.
          <button
            type="button"
            onClick={() => void refetch()}
            className="text-xs font-semibold text-primary hover:underline"
            data-testid="button-retry-call-centre-kpis"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {tiles.map((t) => (
            <Card key={t.key} className="glass-panel border-none shadow-md">
              <CardContent className="px-3.5 py-3 flex items-start gap-3">
                <div className="rounded-lg bg-primary/10 p-2 text-primary shrink-0">
                  <t.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                    {t.label}
                  </p>
                  {isLoading ? (
                    <Skeleton className="mt-1.5 h-5 w-12" />
                  ) : (
                    <h2
                      className="mt-1 text-lg font-bold tracking-tight leading-none"
                      data-testid={`text-call-centre-${t.key}`}
                    >
                      {t.value ?? 0}
                    </h2>
                  )}
                  <p className="mt-1 text-[11px] text-muted-foreground">{t.sub}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
