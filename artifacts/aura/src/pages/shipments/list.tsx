import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Ship, Plus } from "lucide-react";
import { useListShipments, useCreateShipment, getListShipmentsQueryKey } from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { EmptyBlock, ErrorBlock, Pill, RowsSkeleton, ShipmentsNav, errMsg, monthLabel } from "@/components/shipments/shared";

export default function ShipmentsListPage() {
  const { data, isLoading, error, refetch } = useListShipments();
  const { can } = useAuthz();
  const [open, setOpen] = useState(false);
  const canEdit = can("inventory", "edit");
  const [filter, setFilter] = useState<"live" | "all">("live");
  const rows = (data ?? []).filter((s) => filter === "all" || !["closed", "cancelled"].includes(s.status));

  return (
    <Page>
      <PageHero
        icon={Ship}
        eyebrow="Operations"
        title="Shipments"
        subtitle="Factory capacity by exact specification, allocated to approved Pre-Book customers."
        action={canEdit ? (
          <Button onClick={() => setOpen(true)} data-testid="button-new-shipment">
            <Plus className="h-4 w-4 mr-1.5" /> New shipment
          </Button>
        ) : undefined}
      />
      <ShipmentsNav />
      <div className="flex items-center gap-2 mb-4">
        {(["live", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`text-xs rounded-full px-3 py-1 ring-1 ring-inset ${filter === f ? "bg-foreground text-background ring-foreground" : "ring-border text-muted-foreground"}`}
            data-testid={`filter-${f}`}
          >
            {f === "live" ? "Open, in transit, arrived" : "All incl. closed"}
          </button>
        ))}
      </div>
      {isLoading ? (
        <RowsSkeleton />
      ) : error ? (
        <ErrorBlock error={error} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyBlock
          title="No shipments yet"
          body="Create a shipment with its ETA month, then add lines from the approved spec catalogue or import them from CSV/XLSX."
          action={canEdit ? <Button onClick={() => setOpen(true)}>New shipment</Button> : undefined}
        />
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="hidden md:grid grid-cols-[1.4fr_0.8fr_0.9fr_1.6fr_0.8fr] gap-4 px-5 py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
            <span>Reference</span><span>Status</span><span>ETA</span><span>Allocated</span><span>VINs</span>
          </div>
          {rows.map((s) => {
            const pct = s.totalUnits ? Math.round((s.allocatedUnits / s.totalUnits) * 100) : 0;
            return (
              <Link
                key={s.id}
                href={`/shipments/${s.id}`}
                className="grid grid-cols-2 md:grid-cols-[1.4fr_0.8fr_0.9fr_1.6fr_0.8fr] gap-x-4 gap-y-1 px-5 py-3.5 border-b border-border last:border-0 hover:bg-muted/40 transition-colors items-center"
                data-testid={`row-shipment-${s.id}`}
              >
                <span className="font-medium text-foreground truncate">{s.reference}</span>
                <span><Pill status={s.status} /></span>
                <span className="text-sm">
                  {monthLabel(s.currentEtaMonth)}
                  {s.currentEtaMonth !== s.baselineEtaMonth && (
                    <span className="block text-[11px] text-muted-foreground">was {monthLabel(s.baselineEtaMonth)}</span>
                  )}
                </span>
                <span className="flex items-center gap-3 text-sm">
                  <span className="relative h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                    <span className="absolute inset-y-0 left-0 bg-primary rounded-full" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="tabular-nums text-muted-foreground w-16 text-right">{s.allocatedUnits}/{s.totalUnits}</span>
                </span>
                <span className="text-sm tabular-nums text-muted-foreground">{s.confirmedVins}/{s.manifestVins} held</span>
              </Link>
            );
          })}
        </div>
      )}
      <CreateShipmentDialog open={open} onOpenChange={setOpen} />
    </Page>
  );
}

function CreateShipmentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const create = useCreateShipment();
  const [reference, setReference] = useState("");
  const [eta, setEta] = useState("");
  const [notes, setNotes] = useState("");
  const submit = () => {
    create.mutate(
      { data: { reference: reference.trim(), etaMonth: eta, notes: notes.trim() || null } },
      {
        onSuccess: (s) => {
          qc.invalidateQueries({ queryKey: getListShipmentsQueryKey() });
          onOpenChange(false);
          setReference(""); setEta(""); setNotes("");
          navigate(`/shipments/${s.id}`);
        },
        onError: (e) => toast({ title: "Could not create shipment", description: errMsg(e), variant: "destructive" }),
      },
    );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New shipment</DialogTitle>
          <DialogDescription>The first ETA month becomes the baseline shown to customers.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ship-ref">Reference</Label>
            <Input id="ship-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. TYO-GT-2611" data-testid="input-shipment-reference" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ship-eta">ETA month</Label>
            <Input id="ship-eta" type="month" value={eta} onChange={(e) => setEta(e.target.value)} data-testid="input-shipment-eta" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ship-notes">Notes</Label>
            <Textarea id="ship-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!reference.trim() || !/^\d{4}-\d{2}$/.test(eta) || create.isPending} data-testid="button-create-shipment">
            {create.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
