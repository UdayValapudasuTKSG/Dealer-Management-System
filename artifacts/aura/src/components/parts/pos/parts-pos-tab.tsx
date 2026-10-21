import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePartsPos } from "./pos-api";
import { PosConfigPanel } from "./pos-config-panel";
import { PosSaleForm } from "./pos-sale-form";
import { PosReturnForm } from "./pos-return-form";
import { PosPaymentForm, PosShiftCloseForm } from "./pos-payment-close-forms";
import { PosRequestsList } from "./pos-requests-list";
import { useAuthz } from "@/lib/auth";

const VIEWS = [
  { key: "sale", label: "New sale" },
  { key: "return", label: "Return" },
  { key: "payment", label: "Account payment" },
  { key: "close", label: "Shift close" },
  { key: "queue", label: "Approval queue" },
  { key: "config", label: "Configuration" },
] as const;
type View = (typeof VIEWS)[number]["key"];

export function PartsPosTab() {
  const { activeDealer } = useAuthz();
  const { data, isLoading, isError, refetch } = usePartsPos();
  const [view, setView] = useState<View>("sale");

  if (isLoading) return <div className="space-y-3"><div className="h-10 rounded-2xl bg-white/[0.05] animate-pulse" /><div className="h-72 rounded-3xl bg-white/[0.05] animate-pulse" /></div>;
  if (isError || !data)
    return (
      <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive flex items-center justify-between">
        Could not load the parts counter. <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  const pending = data.requests.filter((r) => r.status === "pending").length;

  return (
    <div className="space-y-4">
      {!data.config.enabled && <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs">Parts POS is disabled. Finance must complete and enable the configuration before submissions are accepted.</div>}
      <div className="flex flex-wrap gap-1">
        {VIEWS.map((v) => (
          <button key={v.key} onClick={() => setView(v.key)} data-testid={`tab-pos-${v.key}`} className={cn("rounded-full px-3 py-1.5 text-xs font-medium transition-colors", view === v.key ? "bg-primary text-primary-foreground" : "bg-white/[0.04] text-muted-foreground hover:text-foreground")}>
            {v.label}{v.key === "queue" && pending ? ` (${pending})` : ""}
          </button>
        ))}
      </div>
      {view === "sale" && <PosSaleForm key={activeDealer?.dealerId} state={data} />}
      {view === "return" && <PosReturnForm state={data} />}
      {view === "payment" && <PosPaymentForm state={data} />}
      {view === "close" && <PosShiftCloseForm state={data} />}
      {view === "queue" && <PosRequestsList state={data} />}
      {view === "config" && <PosConfigPanel state={data} />}
      {view !== "queue" && view !== "config" && (
        <div><h3 className="text-sm font-semibold mb-2">Recent requests</h3><PosRequestsList state={data} /></div>
      )}
    </div>
  );
}
