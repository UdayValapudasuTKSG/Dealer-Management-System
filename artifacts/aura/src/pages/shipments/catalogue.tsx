import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Ship, Plus } from "lucide-react";
import {
  useListShipmentSpecs,
  useCreateShipmentSpec,
  useUpdateShipmentSpec,
  useSetShipmentSpecStatus,
  getListShipmentSpecsQueryKey,
  type ShipmentSpec,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { EmptyBlock, ErrorBlock, Pill, RowsSkeleton, ShipmentsNav, errMsg } from "@/components/shipments/shared";

type Form = { make: string; model: string; year: string; variant: string; exteriorColor: string; interiorColor: string };
const EMPTY: Form = { make: "", model: "", year: "", variant: "", exteriorColor: "", interiorColor: "" };
const FIELDS: [keyof Form, string, boolean][] = [
  ["make", "Make", false],
  ["model", "Model", false],
  ["year", "Model year", false],
  ["variant", "Variant", true],
  ["exteriorColor", "Exterior colour", true],
  ["interiorColor", "Interior colour", true],
];

export default function ShipmentCataloguePage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = useAuthz();
  const { data, isLoading, error, refetch } = useListShipmentSpecs();
  const setStatus = useSetShipmentSpecStatus();
  const [editing, setEditing] = useState<ShipmentSpec | "new" | null>(null);
  const canEdit = can("inventory", "edit");
  const canApprove = can("deals", "approve") || can("inventory", "approve");
  const [q, setQ] = useState("");
  const rows = (data ?? []).filter((s) => `${s.year} ${s.make} ${s.model} ${s.variant} ${s.exteriorColor} ${s.interiorColor}`.toLowerCase().includes(q.toLowerCase()));

  const changeStatus = (s: ShipmentSpec, status: "approved" | "retired") =>
    setStatus.mutate(
      { specId: s.id, data: { status } },
      {
        onSuccess: () => qc.invalidateQueries({ queryKey: getListShipmentSpecsQueryKey() }),
        onError: (e) => toast({ title: "Status not changed", description: errMsg(e), variant: "destructive" }),
      },
    );

  return (
    <Page>
      <PageHero
        icon={Ship}
        eyebrow="Shipments"
        title="Spec catalogue"
        subtitle="Exact specifications a shipment line can carry. Only manager-approved specs can be shipped or allocated."
        action={canEdit ? <Button onClick={() => setEditing("new")} data-testid="button-new-spec"><Plus className="h-4 w-4 mr-1.5" />New spec</Button> : undefined}
      />
      <ShipmentsNav />
      <div className="mb-4 flex flex-col md:flex-row md:items-center gap-3 justify-between">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter specs" className="md:max-w-xs" data-testid="input-spec-filter" />
        <p className="text-xs text-muted-foreground">Blank is never a wildcard. Use <span className="font-mono">N/A</span> explicitly when an attribute does not apply.</p>
      </div>
      {isLoading ? <RowsSkeleton /> : error ? <ErrorBlock error={error} onRetry={() => refetch()} /> : rows.length === 0 ? (
        <EmptyBlock title="Catalogue is empty" body="Add a draft spec; a manager approves it before it can be used on a shipment." />
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border">
          {rows.map((s) => (
            <div key={s.id} className="flex flex-col md:flex-row md:items-center gap-3 px-5 py-3.5" data-testid={`row-spec-${s.id}`}>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{s.year} {s.make} {s.model} <span className="text-muted-foreground">{s.variant}</span></div>
                <div className="text-xs text-muted-foreground">Exterior {s.exteriorColor} · Interior {s.interiorColor}{s.approvedBy ? ` · approved by ${s.approvedBy}` : ""}</div>
              </div>
              <Pill status={s.status} />
              <div className="flex gap-2">
                {s.status === "draft" && canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>Edit</Button>}
                {s.status !== "approved" && canApprove && (
                  <Button size="sm" variant="outline" onClick={() => changeStatus(s, "approved")} disabled={setStatus.isPending} data-testid={`button-approve-spec-${s.id}`}>Approve</Button>
                )}
                {s.status !== "retired" && canApprove && (
                  <Button size="sm" variant="ghost" onClick={() => changeStatus(s, "retired")} disabled={setStatus.isPending}>Retire</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <SpecDialog spec={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function SpecDialog({ spec, onClose }: { spec: ShipmentSpec | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const create = useCreateShipmentSpec();
  const update = useUpdateShipmentSpec();
  const [f, setF] = useState<Form>(spec ? { ...spec, year: String(spec.year) } : EMPTY);
  const blank = FIELDS.some(([k]) => !f[k].trim());
  const yearOk = /^\d{4}$/.test(f.year);
  const save = () => {
    const data = { ...f, year: Number(f.year) };
    const opts = {
      onSuccess: () => { qc.invalidateQueries({ queryKey: getListShipmentSpecsQueryKey() }); onClose(); },
      onError: (e: unknown) => toast({ title: "Spec not saved", description: errMsg(e), variant: "destructive" }),
    };
    if (spec) update.mutate({ specId: spec.id, data }, opts);
    else create.mutate({ data }, opts);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{spec ? "Edit draft spec" : "New draft spec"}</DialogTitle>
          <DialogDescription>Every field is required. Type N/A where an attribute genuinely does not apply.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {FIELDS.map(([k, label, naHint]) => (
            <div key={k} className="space-y-1.5">
              <Label htmlFor={`spec-${k}`}>{label}</Label>
              <div className="flex gap-1">
                <Input id={`spec-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} data-testid={`input-spec-${k}`} />
                {naHint && (
                  <Button type="button" size="sm" variant="ghost" className="px-2 text-xs" onClick={() => setF({ ...f, [k]: "N/A" })}>N/A</Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={blank || !yearOk || create.isPending || update.isPending} data-testid="button-save-spec">Save draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
