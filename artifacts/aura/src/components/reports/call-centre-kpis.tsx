import { useState } from "react";
import { FileDown, Headset, Loader2, PhoneForwarded } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCallCentreReport } from "@/hooks/use-call-centre";
import { useToast } from "@/hooks/use-toast";

export function CallCentreKpis() {
  const { data, isLoading, isError, refetch } = useCallCentreReport();
  const counts = data instanceof Blob ? undefined : data;
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();
  const download = async () => {
    setExporting(true);
    try {
      const headers: Record<string, string> = {};
      const dealerId = localStorage.getItem("aura-dealer-id");
      const testEmail = localStorage.getItem("aura-test-user-email");
      if (dealerId) headers["x-dealer-id"] = dealerId;
      if (testEmail) headers["x-test-user-email"] = testEmail;
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/api/reports/call-centre?format=pdf&_export=${Date.now()}`, {
        credentials: "include", cache: "no-store", headers,
      });
      if (!res.ok) throw new Error(`Call-centre PDF failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "call-centre-qualification.pdf";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      toast({ title: "PDF download failed", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };
  const tiles = [
    {
      key: "active",
      icon: Headset,
      label: "Active call-centre follow-ups",
      sub: "Leads currently held by call-centre reps (pending or follow-up), all time",
      value: counts?.activeFollowUp,
    },
    {
      key: "transferred",
      icon: PhoneForwarded,
      label: "Qualified & transferred",
      sub: "Leads the call centre has handed to a Sales Advisor, all time",
      value: counts?.qualifiedTransferred,
    },
  ];
  return (
    <section className="mb-4" data-testid="section-call-centre-kpis">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Call Centre qualification</h3>
        <button type="button" onClick={() => void download()} disabled={isLoading || isError || exporting}
          className="text-xs font-semibold text-primary hover:underline disabled:opacity-50 flex items-center gap-1">
          {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileDown className="h-3 w-3" />}
          Download PDF
        </button>
      </div>
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
