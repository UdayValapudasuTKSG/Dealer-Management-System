import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Lock, LockOpen, Ship, Upload, Download, Shuffle, Plus, Trash2 } from "lucide-react";
import {
  useGetShipment,
  getGetShipmentQueryKey,
  useUpdateShipment,
  useSetShipmentStatus,
  useAddShipmentLine,
  useUpdateShipmentLine,
  useDeleteShipmentLine,
  useAcquireShipmentLock,
  useReleaseShipmentLock,
  useListShipmentEvents,
  getListShipmentEventsQueryKey,
  useListShipmentAllocations,
  getListShipmentAllocationsQueryKey,
  useCreateShipmentAllocation,
  useReleaseShipmentAllocation,
  useReassignShipmentAllocation,
  useListShipmentEligibleLeads,
  useListShipmentSpecs,
  useListShipments,
  useListShipmentImports,
  getListShipmentImportsQueryKey,
  usePreviewShipmentImport,
  useCommitShipmentImport,
  listShipmentImportErrors,
  useListShipmentManifests,
  getListShipmentManifestsQueryKey,
  useGetShipmentMatching,
  getGetShipmentMatchingQueryKey,
  useRunShipmentMatching,
  useConfirmShipmentProposal,
  useRejectShipmentProposal,
  type ShipmentDetail,
  type ShipmentAllocationView,
  type ShipmentImportPreview,
  type ShipmentProposalView,
  type ShipmentLineView,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { TEMPLATE_HEADERS, downloadCsv, parseImportFile, type ParsedFile } from "@/lib/shipment-import";
import { EmptyBlock, ErrorBlock, Pill, RowsSkeleton, SpecCell, errMsg, monthLabel, specLine } from "@/components/shipments/shared";

const NEXT_STATUS: Record<string, { to: "open" | "in_transit" | "arrived" | "closed" | "cancelled"; label: string }[]> = {
  open: [{ to: "in_transit", label: "Mark in transit" }, { to: "cancelled", label: "Cancel" }],
  in_transit: [{ to: "arrived", label: "Mark arrived" }, { to: "open", label: "Back to open" }, { to: "cancelled", label: "Cancel" }],
  arrived: [{ to: "closed", label: "Close shipment" }],
  closed: [],
  cancelled: [],
};

function useShipmentInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("/api/shipments") });
}

export default function ShipmentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { data, isLoading, error, refetch } = useGetShipment(id, { query: { enabled: Number.isInteger(id) && id > 0, queryKey: getGetShipmentQueryKey(id) } });
  if (isLoading) return <Page><RowsSkeleton rows={8} /></Page>;
  if (error || !data) return <Page><ErrorBlock error={error ?? new Error("Shipment not found")} onRetry={() => refetch()} /></Page>;
  return <DetailBody detail={data} />;
}

function DetailBody({ detail }: { detail: ShipmentDetail }) {
  const s = detail.shipment;
  const { toast } = useToast();
  const { can } = useAuthz();
  const invalidate = useShipmentInvalidate();
  const acquire = useAcquireShipmentLock();
  const release = useReleaseShipmentLock();
  const setStatus = useSetShipmentStatus();
  const editing = detail.lock.viewerHolds;
  const canEditAny = can("inventory", "edit") || can("leads", "edit");
  const terminal = s.status === "closed" || s.status === "cancelled";

  // Heartbeat while holding the lease; release on leave.
  const acquireRef = useRef(acquire.mutate);
  acquireRef.current = acquire.mutate;
  const releaseRef = useRef(release.mutate);
  releaseRef.current = release.mutate;
  useEffect(() => {
    if (!editing) return;
    const t = window.setInterval(() => acquireRef.current({ shipmentId: s.id }, { onError: () => invalidate() }), 60_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, s.id]);
  useEffect(() => () => { releaseRef.current({ shipmentId: s.id }); }, [s.id]);

  const startEdit = () =>
    acquire.mutate({ shipmentId: s.id }, {
      onSuccess: () => invalidate(),
      onError: (e) => { toast({ title: "Read-only", description: errMsg(e), variant: "destructive" }); invalidate(); },
    });
  const stopEdit = () => release.mutate({ shipmentId: s.id }, { onSuccess: () => invalidate() });
  const changeStatus = (to: "open" | "in_transit" | "arrived" | "closed" | "cancelled") =>
    setStatus.mutate({ shipmentId: s.id, data: { status: to } }, {
      onSuccess: () => invalidate(),
      onError: (e) => toast({ title: "Status unchanged", description: errMsg(e), variant: "destructive" }),
    });

  const [etaOpen, setEtaOpen] = useState(false);

  return (
    <Page>
      <Link href="/shipments" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="h-4 w-4" /> Shipments
      </Link>
      <header className="flex flex-col lg:flex-row lg:items-end gap-4 justify-between mb-5">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground"><Ship className="h-3.5 w-3.5" /> Shipment</div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight mt-1 flex items-center gap-3" data-testid="text-shipment-reference">
            {s.reference} <Pill status={s.status} />
          </h1>
          <div className="mt-1 text-sm text-muted-foreground">
            ETA <span className="text-foreground font-medium">{monthLabel(s.currentEtaMonth)}</span>
            {s.currentEtaMonth !== s.baselineEtaMonth && <> · baseline {monthLabel(s.baselineEtaMonth)}</>}
            {" · "}{s.allocatedUnits}/{s.totalUnits} allocated · {s.confirmedVins}/{s.manifestVins} VINs held
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {editing && !terminal && (
            <>
              <Button variant="outline" size="sm" onClick={() => setEtaOpen(true)} data-testid="button-edit-eta">Revise ETA</Button>
              {NEXT_STATUS[s.status]?.map((n) => (
                <Button key={n.to} size="sm" variant={n.to === "cancelled" ? "ghost" : "outline"} onClick={() => changeStatus(n.to)} disabled={setStatus.isPending} data-testid={`button-status-${n.to}`}>{n.label}</Button>
              ))}
            </>
          )}
        </div>
      </header>

      <LeaseBar detail={detail} canEdit={canEditAny && !terminal} onStart={startEdit} onStop={stopEdit} busy={acquire.isPending} />

      <Tabs defaultValue="lines" className="mt-5">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="lines" data-testid="tab-lines">Lines</TabsTrigger>
          <TabsTrigger value="allocations" data-testid="tab-allocations">Allocations</TabsTrigger>
          <TabsTrigger value="manifest" data-testid="tab-manifest">Manifest & import</TabsTrigger>
          <TabsTrigger value="matching" data-testid="tab-matching">Matching</TabsTrigger>
          <TabsTrigger value="audit" data-testid="tab-audit">Audit</TabsTrigger>
        </TabsList>
        <TabsContent value="lines"><LinesTab detail={detail} editing={editing && !terminal} /></TabsContent>
        <TabsContent value="allocations"><AllocationsTab detail={detail} editing={editing && !terminal} /></TabsContent>
        <TabsContent value="manifest"><ManifestTab detail={detail} editing={editing && !terminal} /></TabsContent>
        <TabsContent value="matching"><MatchingTab detail={detail} editing={editing && !terminal} /></TabsContent>
        <TabsContent value="audit"><AuditTab shipmentId={s.id} /></TabsContent>
      </Tabs>
      {etaOpen && <EtaDialog detail={detail} onClose={() => setEtaOpen(false)} />}
    </Page>
  );
}

function LeaseBar({ detail, canEdit, onStart, onStop, busy }: { detail: ShipmentDetail; canEdit: boolean; onStart: () => void; onStop: () => void; busy: boolean }) {
  const l = detail.lock;
  if (l.viewerHolds)
    return (
      <div className="rounded-xl bg-primary/5 ring-1 ring-primary/20 px-4 py-2.5 flex items-center justify-between gap-3 text-sm" data-testid="lease-mine">
        <span className="flex items-center gap-2"><LockOpen className="h-4 w-4 text-primary" /> You are editing. Others see this shipment read-only until you finish (lease renews while open).</span>
        <Button size="sm" variant="ghost" onClick={onStop} data-testid="button-stop-editing">Done editing</Button>
      </div>
    );
  if (l.held)
    return (
      <div className="rounded-xl bg-amber-500/10 ring-1 ring-amber-500/25 px-4 py-2.5 flex items-center gap-2 text-sm" data-testid="lease-other">
        <Lock className="h-4 w-4" /> Read-only: <strong>{l.holderName}</strong> is editing{l.expiresAt ? ` (lease until ${new Date(l.expiresAt).toLocaleTimeString()})` : ""}. Changes appear here automatically.
      </div>
    );
  return (
    <div className="rounded-xl bg-muted/50 px-4 py-2.5 flex items-center justify-between gap-3 text-sm" data-testid="lease-free">
      <span className="flex items-center gap-2 text-muted-foreground"><Lock className="h-4 w-4" /> Viewing. Take the editor lease to change lines, allocations, imports or matches.</span>
      {canEdit && <Button size="sm" onClick={onStart} disabled={busy} data-testid="button-start-editing">Start editing</Button>}
    </div>
  );
}

function EtaDialog({ detail, onClose }: { detail: ShipmentDetail; onClose: () => void }) {
  const { toast } = useToast();
  const invalidate = useShipmentInvalidate();
  const update = useUpdateShipment();
  const [eta, setEta] = useState(detail.shipment.currentEtaMonth);
  const [notes, setNotes] = useState(detail.shipment.notes ?? "");
  const save = () =>
    update.mutate({ shipmentId: detail.shipment.id, data: { currentEtaMonth: eta, notes: notes.trim() || null } }, {
      onSuccess: () => { invalidate(); onClose(); toast({ title: "Shipment updated", description: "ETA change jobs recorded - see each allocation's email status." }); },
      onError: (e) => toast({ title: "Not saved", description: errMsg(e), variant: "destructive" }),
    });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revise ETA</DialogTitle>
          <DialogDescription>{detail.etaEmailRule}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="eta">ETA month</Label><Input id="eta" type="month" value={eta} onChange={(e) => setEta(e.target.value)} data-testid="input-eta" /></div>
          <div className="space-y-1.5"><Label htmlFor="notes">Notes</Label><Textarea id="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!/^\d{4}-\d{2}$/.test(eta) || update.isPending} data-testid="button-save-eta">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ lines

function LinesTab({ detail, editing }: { detail: ShipmentDetail; editing: boolean }) {
  const { toast } = useToast();
  const invalidate = useShipmentInvalidate();
  const { data: specs } = useListShipmentSpecs();
  const add = useAddShipmentLine();
  const upd = useUpdateShipmentLine();
  const del = useDeleteShipmentLine();
  const [specId, setSpecId] = useState("");
  const [qty, setQty] = useState("1");
  const usedSpecs = new Set(detail.lines.map((l) => l.specId));
  const available = (specs ?? []).filter((s) => s.status === "approved" && !usedSpecs.has(s.id));
  const canAddLines = detail.shipment.status === "open" || detail.shipment.status === "in_transit";
  const onErr = (title: string) => (e: unknown) => toast({ title, description: errMsg(e), variant: "destructive" });

  return (
    <div className="space-y-4 mt-3">
      {detail.lines.length === 0 ? (
        <EmptyBlock title="No lines" body="Add approved specs with quantities, or import a lines file from the Manifest & import tab." />
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border">
          {detail.lines.map((l) => (
            <LineRow key={l.id} line={l} editing={editing}
              onQty={(q) => upd.mutate({ shipmentId: detail.shipment.id, lineId: l.id, data: { quantity: q } }, { onSuccess: () => invalidate(), onError: onErr("Quantity unchanged") })}
              onDelete={() => del.mutate({ shipmentId: detail.shipment.id, lineId: l.id }, { onSuccess: () => invalidate(), onError: onErr("Line not removed") })} />
          ))}
        </div>
      )}
      {editing && canAddLines && (
        <div className="rounded-xl border border-border bg-card p-4 flex flex-col md:flex-row gap-3 md:items-end">
          <div className="flex-1 space-y-1.5">
            <Label>Approved spec</Label>
            <Select value={specId} onValueChange={setSpecId}>
              <SelectTrigger data-testid="select-line-spec"><SelectValue placeholder={available.length ? "Choose a spec" : "No unused approved specs"} /></SelectTrigger>
              <SelectContent>
                {available.map((s) => <SelectItem key={s.id} value={String(s.id)}>{specLine(s)} - {s.exteriorColor} / {s.interiorColor}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="w-28 space-y-1.5"><Label>Units</Label><Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} data-testid="input-line-qty" /></div>
          <Button disabled={!specId || !(Number(qty) >= 1) || add.isPending} data-testid="button-add-line"
            onClick={() => add.mutate({ shipmentId: detail.shipment.id, data: { specId: Number(specId), quantity: Number(qty) } }, { onSuccess: () => { invalidate(); setSpecId(""); setQty("1"); }, onError: onErr("Line not added") })}>
            <Plus className="h-4 w-4 mr-1" /> Add line
          </Button>
        </div>
      )}
    </div>
  );
}

function LineRow({ line, editing, onQty, onDelete }: { line: ShipmentLineView; editing: boolean; onQty: (q: number) => void; onDelete: () => void }) {
  const [q, setQ] = useState(String(line.quantity));
  useEffect(() => setQ(String(line.quantity)), [line.quantity]);
  const pct = line.quantity ? (line.allocatedUnits / line.quantity) * 100 : 0;
  return (
    <div className="grid md:grid-cols-[2fr_1.2fr_0.8fr_auto] gap-3 px-5 py-3.5 items-center" data-testid={`row-line-${line.id}`}>
      <SpecCell spec={line.spec} />
      <div className="flex items-center gap-2 text-sm">
        <span className="relative h-1.5 flex-1 rounded-full bg-muted overflow-hidden"><span className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${pct}%` }} /></span>
        <span className="tabular-nums text-muted-foreground">{line.allocatedUnits}/{line.quantity}</span>
      </div>
      <div className="text-xs text-muted-foreground">{line.remainingUnits} free · {line.manifestVins} VIN</div>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <Input className="w-20 h-8" type="number" min={1} value={q} onChange={(e) => setQ(e.target.value)} data-testid={`input-line-qty-${line.id}`} />
          <Button size="sm" variant="outline" disabled={Number(q) === line.quantity || !(Number(q) >= 1)} onClick={() => onQty(Number(q))}>Set</Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onDelete} aria-label="Remove line"><Trash2 className="h-4 w-4" /></Button>
        </div>
      ) : <span />}
    </div>
  );
}

// ------------------------------------------------------------------ allocations

function AllocationsTab({ detail, editing }: { detail: ShipmentDetail; editing: boolean }) {
  const id = detail.shipment.id;
  const { can } = useAuthz();
  const { data, isLoading, error, refetch } = useListShipmentAllocations(id, { query: { queryKey: getListShipmentAllocationsQueryKey(id) } });
  const [newOpen, setNewOpen] = useState(false);
  const [releasing, setReleasing] = useState<ShipmentAllocationView | null>(null);
  const [moving, setMoving] = useState<ShipmentAllocationView | null>(null);
  const canAlloc = can("leads", "edit");
  const accepts = ["open", "in_transit", "arrived"].includes(detail.shipment.status);
  return (
    <div className="space-y-4 mt-3">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground max-w-2xl">
          {detail.shipment.status === "arrived" ? "Arrived: new allocations are limited to reconciled manifest units still unclaimed. " : ""}
          Allocation consumes capacity once (Vehicle Allocated). Full-line only unless the customer gives explicit partial consent. Sales stage is not changed.
        </p>
        {editing && canAlloc && accepts && <Button onClick={() => setNewOpen(true)} data-testid="button-new-allocation"><Plus className="h-4 w-4 mr-1" />Allocate customer</Button>}
      </div>
      {isLoading ? <RowsSkeleton /> : error ? <ErrorBlock error={error} onRetry={() => refetch()} /> : !data?.length ? (
        <EmptyBlock title="No customers allocated" body="Allocate approved Pre-Book customers to a line once their exact spec is confirmed." />
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border">
          {data.map((a) => (
            <div key={a.id} className={cn("grid md:grid-cols-[1.1fr_1.6fr_0.9fr_1.5fr_auto] gap-3 px-5 py-3.5 items-start", (a.status === "released" || a.status === "reassigned") && "opacity-60")} data-testid={`row-allocation-${a.id}`}>
              <div className="min-w-0">
                <Link href={`/lead/${a.leadId}`} className="font-medium hover:underline">{a.leadName}</Link>
                <div className="text-xs text-muted-foreground">Priority {new Date(a.baselineAt).toLocaleString()}{a.dealId ? ` · Deal #${a.dealId}` : " · no deal linked"}</div>
              </div>
              <SpecCell spec={a.spec} />
              <div className="flex flex-col gap-1">
                <span className="flex gap-1.5 items-center"><Pill status={a.status} />{a.holdLapsedUnits > 0 && <Pill status="lapsed" label="hold lapsed" />}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{a.quantity}{a.quantity !== a.requestedQuantity ? ` of ${a.requestedQuantity} (partial)` : ""} unit · {a.confirmedUnits} held · {a.matchedUnits} proposed</span>
                {a.releasedReason && <span className="text-xs text-muted-foreground">{a.releasedReason}</span>}
              </div>
              <div className="space-y-1 min-w-0">
                {a.emails.slice(0, 2).map((e) => (
                  <div key={e.id} className="text-xs" data-testid={`email-job-${e.id}`}>
                    <Pill status={e.status} /> <span className="text-muted-foreground">{e.kind === "initial" ? "Initial" : `ETA ${monthLabel(e.etaMonth)}`}</span>
                    <div className="text-muted-foreground truncate" title={e.reason}>{e.reason}</div>
                  </div>
                ))}
              </div>
              {editing && canAlloc && a.status === "active" ? (
                <div className="flex gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => setMoving(a)} data-testid={`button-reassign-${a.id}`}>Reassign</Button>
                  <Button size="sm" variant="ghost" onClick={() => setReleasing(a)} data-testid={`button-release-${a.id}`}>Release</Button>
                </div>
              ) : <span />}
            </div>
          ))}
        </div>
      )}
      {newOpen && <NewAllocationDialog detail={detail} onClose={() => setNewOpen(false)} />}
      {releasing && <ReleaseDialog alloc={releasing} onClose={() => setReleasing(null)} />}
      {moving && <ReassignDialog alloc={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}

function NewAllocationDialog({ detail, onClose }: { detail: ShipmentDetail; onClose: () => void }) {
  const { toast } = useToast();
  const invalidate = useShipmentInvalidate();
  const { data: leads, isLoading } = useListShipmentEligibleLeads();
  const create = useCreateShipmentAllocation();
  const [lineId, setLineId] = useState("");
  const [leadId, setLeadId] = useState("");
  const [dealId, setDealId] = useState("none");
  const [qty, setQty] = useState("1");
  const [partial, setPartial] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const line = detail.lines.find((l) => String(l.id) === lineId);
  const lead = leads?.find((l) => String(l.id) === leadId);
  const submit = () =>
    create.mutate({
      shipmentId: detail.shipment.id,
      data: { lineId: Number(lineId), leadId: Number(leadId), dealId: dealId === "none" ? null : Number(dealId), requestedQuantity: Number(qty), partialConsent: partial, specsConfirmed: confirmed },
    }, {
      onSuccess: (a) => { invalidate(); onClose(); toast({ title: `${a.leadName} allocated`, description: "Initial email recorded as withheld - templates await approval; nothing was sent." }); },
      onError: (e) => toast({ title: "Not allocated", description: errMsg(e), variant: "destructive" }),
    });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Allocate a customer</DialogTitle>
          <DialogDescription>Only leads at an approved Pre-Book stage are listed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Line</Label>
            <Select value={lineId} onValueChange={setLineId}>
              <SelectTrigger data-testid="select-allocation-line"><SelectValue placeholder="Choose a line" /></SelectTrigger>
              <SelectContent>
                {detail.lines.map((l) => <SelectItem key={l.id} value={String(l.id)} disabled={l.remainingUnits === 0}>{specLine(l.spec)} {l.spec.exteriorColor}/{l.spec.interiorColor} - {l.remainingUnits} free</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Customer (Pre-Book)</Label>
            <Select value={leadId} onValueChange={(v) => { setLeadId(v); setDealId("none"); }}>
              <SelectTrigger data-testid="select-allocation-lead"><SelectValue placeholder={isLoading ? "Loading..." : leads?.length ? "Choose a customer" : "No Pre-Book customers"} /></SelectTrigger>
              <SelectContent>
                {(leads ?? []).map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}{l.email ? ` - ${l.email}` : ""}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {lead && (
            <div className="space-y-1.5">
              <Label>Linked deal</Label>
              <Select value={dealId} onValueChange={setDealId}>
                <SelectTrigger data-testid="select-allocation-deal"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No deal yet (required before a VIN can be held)</SelectItem>
                  {lead.deals.map((d) => <SelectItem key={d.id} value={String(d.id)}>Deal #{d.id} ({d.stage})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-[110px_1fr] gap-3 items-end">
            <div className="space-y-1.5"><Label>Units</Label><Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} data-testid="input-allocation-qty" /></div>
            <label className="flex items-start gap-2 text-sm pb-2"><Checkbox checked={partial} onCheckedChange={(v) => setPartial(v === true)} data-testid="checkbox-partial-consent" /> Customer explicitly consents to partial fulfilment</label>
          </div>
          <label className="flex items-start gap-2 text-sm rounded-lg bg-muted/50 p-3">
            <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} data-testid="checkbox-specs-confirmed" />
            <span>I confirmed the exact spec with the customer{line ? `: ${specLine(line.spec)}, exterior ${line.spec.exteriorColor}, interior ${line.spec.interiorColor}` : ""}.</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!lineId || !leadId || !confirmed || !(Number(qty) >= 1) || create.isPending} data-testid="button-submit-allocation">Allocate</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseDialog({ alloc, onClose }: { alloc: ShipmentAllocationView; onClose: () => void }) {
  const { toast } = useToast();
  const invalidate = useShipmentInvalidate();
  const rel = useReleaseShipmentAllocation();
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Release {alloc.leadName}</DialogTitle><DialogDescription>Capacity returns to the line. Held VINs must be released on the deal first.</DialogDescription></DialogHeader>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" data-testid="input-release-reason" />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={reason.trim().length < 3 || rel.isPending} data-testid="button-confirm-release"
            onClick={() => rel.mutate({ allocationId: alloc.id, data: { reason: reason.trim() } }, { onSuccess: () => { invalidate(); onClose(); }, onError: (e) => toast({ title: "Not released", description: errMsg(e), variant: "destructive" }) })}>Release</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReassignDialog({ alloc, onClose }: { alloc: ShipmentAllocationView; onClose: () => void }) {
  const { toast } = useToast();
  const invalidate = useShipmentInvalidate();
  const re = useReassignShipmentAllocation();
  const { data: ships } = useListShipments();
  const [targetShip, setTargetShip] = useState("");
  const tid = Number(targetShip);
  const { data: target } = useGetShipment(tid, { query: { enabled: tid > 0, queryKey: getGetShipmentQueryKey(tid) } });
  const targetLine = target?.lines.find((l) => l.specId === alloc.spec.id && l.id !== alloc.lineId);
  const candidates = (ships ?? []).filter((s) => ["open", "in_transit", "arrived"].includes(s.status));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reassign {alloc.leadName}</DialogTitle><DialogDescription>All-or-nothing: the target line is claimed and this allocation released in one step. Original priority is kept; if the target cannot take it, nothing changes.</DialogDescription></DialogHeader>
        <Select value={targetShip} onValueChange={setTargetShip}>
          <SelectTrigger data-testid="select-reassign-shipment"><SelectValue placeholder="Target shipment" /></SelectTrigger>
          <SelectContent>{candidates.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.reference} - ETA {monthLabel(s.currentEtaMonth)}</SelectItem>)}</SelectContent>
        </Select>
        {target && (targetLine
          ? <p className="text-sm">Line #{targetLine.id}: {targetLine.remainingUnits} free of {targetLine.quantity}. Needs {alloc.quantity}.</p>
          : <p className="text-sm text-rose-600">That shipment has no other line with this exact spec.</p>)}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!targetLine || re.isPending} data-testid="button-confirm-reassign"
            onClick={() => targetLine && re.mutate({ allocationId: alloc.id, data: { targetLineId: targetLine.id } }, { onSuccess: () => { invalidate(); onClose(); }, onError: (e) => toast({ title: "Not reassigned - original kept", description: errMsg(e), variant: "destructive" }) })}>Reassign</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ manifest / import

function ManifestTab({ detail, editing }: { detail: ShipmentDetail; editing: boolean }) {
  const id = detail.shipment.id;
  const { toast } = useToast();
  const invalidate = useShipmentInvalidate();
  const manifests = useListShipmentManifests(id, { query: { queryKey: getListShipmentManifestsQueryKey(id) } });
  const imports = useListShipmentImports(id, { query: { queryKey: getListShipmentImportsQueryKey(id) } });
  const preview = usePreviewShipmentImport();
  const commit = useCommitShipmentImport();
  const [kind, setKind] = useState<"lines" | "manifest">("manifest");
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [result, setResult] = useState<ShipmentImportPreview | null>(null);
  const [parsing, setParsing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setParsing(true); setParsed(null); setResult(null);
    try {
      const p = await parseImportFile(f);
      setParsed(p);
      preview.mutate({ shipmentId: id, data: { kind, fileName: p.fileName, fileHash: p.fileHash, rows: p.rows } }, {
        onSuccess: setResult,
        onError: (e) => toast({ title: "Preview failed", description: errMsg(e), variant: "destructive" }),
      });
    } catch (e) {
      toast({ title: "Could not read file", description: errMsg(e), variant: "destructive" });
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const confirm = () => parsed &&
    commit.mutate({ shipmentId: id, data: { kind, fileName: parsed.fileName, fileHash: parsed.fileHash, rows: parsed.rows } }, {
      onSuccess: (b) => {
        invalidate(); setParsed(null); setResult(null);
        toast({ title: b.replayed ? "Already imported - no duplicates created" : "Import complete", description: `${b.acceptedRows} accepted, ${b.rejectedRows} rejected.` });
      },
      onError: (e) => toast({ title: "Import failed", description: errMsg(e), variant: "destructive" }),
    });
  const downloadErrors = async (batchId: number, fileName: string) => {
    try {
      const errs = await listShipmentImportErrors(batchId);
      downloadCsv(`${fileName.replace(/\.[^.]+$/, "")}-errors.csv`, ["Row", "Error", "Raw row"], errs.map((e) => [String(e.rowNumber), e.message, e.rawRow]));
    } catch (e) {
      toast({ title: "Download failed", description: errMsg(e), variant: "destructive" });
    }
  };
  const downloadTemplate = () => downloadCsv(`shipment-${kind}-template.csv`, [...TEMPLATE_HEADERS[kind]], []);

  return (
    <div className="space-y-5 mt-3">
      {editing && (
        <section className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {(["manifest", "lines"] as const).map((k) => (
              <button key={k} type="button" onClick={() => { setKind(k); setParsed(null); setResult(null); }} data-testid={`import-kind-${k}`}
                className={`text-xs rounded-full px-3 py-1 ring-1 ring-inset ${kind === k ? "bg-foreground text-background ring-foreground" : "ring-border text-muted-foreground"}`}>
                {k === "manifest" ? "Manifest VINs" : "Shipment lines"}
              </button>
            ))}
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={downloadTemplate}><Download className="h-4 w-4 mr-1" />Template</Button>
            <input ref={fileRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} data-testid="input-import-file" />
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={parsing || preview.isPending}><Upload className="h-4 w-4 mr-1" />{parsing || preview.isPending ? "Reading..." : "Choose CSV/XLSX"}</Button>
          </div>
          <p className="text-xs text-muted-foreground">Parsed in your browser; the file itself is not stored. Exact catalogue match required (including interior). Preview changes nothing.</p>
          {parsed?.unknownHeaders.length ? <p className="text-xs text-amber-700">Ignored columns: {parsed.unknownHeaders.join(", ")}</p> : null}
          {result && parsed && (
            <div className="space-y-3" data-testid="import-preview">
              <div className="text-sm"><strong>{parsed.fileName}</strong>: <span className="text-emerald-700">{result.validRows} valid</span>, <span className="text-rose-700">{result.invalidRows} invalid</span></div>
              <div className="max-h-64 overflow-auto rounded-lg border border-border divide-y divide-border text-xs">
                {result.rows.map((r) => (
                  <div key={r.rowNumber} className={cn("px-3 py-1.5 flex gap-3", !r.ok && "bg-rose-500/5")}>
                    <span className="w-12 tabular-nums text-muted-foreground">Row {r.rowNumber}</span>
                    <span className={r.ok ? "text-emerald-700" : "text-rose-700"}>{r.ok ? "OK" : "Rejected"}</span>
                    <span className="flex-1">{r.message}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" onClick={() => { setParsed(null); setResult(null); }}>Discard</Button>
                <Button onClick={confirm} disabled={result.validRows === 0 || commit.isPending} data-testid="button-confirm-import">Import {result.validRows} valid row(s)</Button>
              </div>
            </div>
          )}
        </section>
      )}
      <section>
        <h3 className="text-sm font-semibold mb-2">Import history</h3>
        {imports.isLoading ? <RowsSkeleton rows={2} /> : !imports.data?.length ? <p className="text-sm text-muted-foreground">No imports yet.</p> : (
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            {imports.data.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm" data-testid={`row-import-${b.id}`}>
                <Pill status={b.kind === "manifest" ? "proposed" : "open"} label={b.kind} />
                <span className="flex-1 min-w-0 truncate">{b.fileName}</span>
                <span className="text-xs text-muted-foreground">{b.acceptedRows} ok · {b.rejectedRows} rejected · {b.createdBy} · {new Date(b.createdAt).toLocaleString()}</span>
                {b.rejectedRows > 0 && <Button size="sm" variant="ghost" onClick={() => downloadErrors(b.id, b.fileName)} data-testid={`button-download-errors-${b.id}`}><Download className="h-4 w-4 mr-1" />Error report</Button>}
              </div>
            ))}
          </div>
        )}
      </section>
      <section>
        <h3 className="text-sm font-semibold mb-2">Manifest VINs</h3>
        {manifests.isLoading ? <RowsSkeleton /> : manifests.error ? <ErrorBlock error={manifests.error} onRetry={() => manifests.refetch()} /> : !manifests.data?.length ? (
          <EmptyBlock title="No VINs yet" body="Import the factory manifest once VINs are known. VINs are never invented." />
        ) : (
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            {manifests.data.map((m) => (
              <div key={m.id} className="grid md:grid-cols-[1fr_1.6fr_0.8fr_1.2fr] gap-3 px-5 py-2.5 items-center text-sm" data-testid={`row-manifest-${m.id}`}>
                <span className="font-mono text-xs">{m.vin}</span>
                <SpecCell spec={m.spec} />
                <Pill status={m.status} />
                <span className="text-xs text-muted-foreground">
                  {m.inventoryVehicleId ? <Link href={`/vehicle/${m.inventoryVehicleId}`} className="hover:underline">Inventory: {m.inventoryStatus}</Link> : "Not in inventory yet"}
                  {m.leadName ? ` · ${m.leadName}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ matching

function MatchingTab({ detail, editing }: { detail: ShipmentDetail; editing: boolean }) {
  const id = detail.shipment.id;
  const { toast } = useToast();
  const { can } = useAuthz();
  const invalidate = useShipmentInvalidate();
  const { data, isLoading, error, refetch } = useGetShipmentMatching(id, { query: { queryKey: getGetShipmentMatchingQueryKey(id) } });
  const run = useRunShipmentMatching();
  const [confirming, setConfirming] = useState<ShipmentProposalView | null>(null);
  const [rejecting, setRejecting] = useState<ShipmentProposalView | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const live = useMemo(() => (data?.proposals ?? []).filter((p) => showHistory || p.status === "pending" || p.status === "confirmed"), [data, showHistory]);
  return (
    <div className="space-y-5 mt-3">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground max-w-2xl">Exact spec only. Oldest allocation first; which identical VIN each customer gets is random. A proposal is not a hold - confirmation binds the VIN through the reservation claim ledger and needs a fully paid reservation.</p>
        {editing && <Button onClick={() => run.mutate({ shipmentId: id }, { onSuccess: () => invalidate(), onError: (e) => toast({ title: "Matching failed", description: errMsg(e), variant: "destructive" }) })} disabled={run.isPending} data-testid="button-run-matching"><Shuffle className="h-4 w-4 mr-1" />{run.isPending ? "Matching..." : "Run matching"}</Button>}
      </div>
      {isLoading ? <RowsSkeleton /> : error ? <ErrorBlock error={error} onRetry={() => refetch()} /> : data && (
        <>
          {data.shortages.length > 0 && (
            <section className="rounded-xl border border-rose-500/25 bg-rose-500/5 p-4">
              <h3 className="text-sm font-semibold mb-2">Pending shortages</h3>
              <div className="space-y-1.5">
                {data.shortages.map((s) => (
                  <div key={s.allocationId} className="text-sm flex flex-wrap gap-2" data-testid={`shortage-${s.allocationId}`}>
                    <strong>{s.leadName}</strong><span className="text-muted-foreground">{specLine(s.spec)}</span><span>{s.unitsShort} short</span><span className="text-xs text-muted-foreground">- {s.reason}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Proposals</h3>
            <label className="text-xs text-muted-foreground flex items-center gap-1.5"><input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} /> Show superseded/rejected</label>
          </div>
          {live.length === 0 ? <EmptyBlock title="No proposals" body="Import manifest VINs, then run matching." /> : (
            <div className="rounded-xl border border-border bg-card divide-y divide-border">
              {live.map((p) => {
                const lapsed = p.status === "confirmed" && p.holdStatus !== "active" && p.holdStatus !== "finalized";
                return (
                  <div key={p.id} className="grid md:grid-cols-[1fr_1fr_1.5fr_1.4fr_auto] gap-3 px-5 py-3 items-center text-sm" data-testid={`row-proposal-${p.id}`}>
                    <span className="font-mono text-xs">{p.vin}</span>
                    <span><Link href={`/lead/${p.leadId}`} className="hover:underline font-medium">{p.leadName}</Link><span className="block text-xs text-muted-foreground">{p.dealId ? `Deal #${p.dealId}` : "No deal linked"}</span></span>
                    <SpecCell spec={p.spec} />
                    <span className="space-y-1">
                      <span className="flex gap-1.5 flex-wrap">
                        <Pill status={lapsed ? "lapsed" : p.status} label={lapsed ? `hold ${p.holdStatus}` : p.status === "confirmed" ? `held (${p.holdStatus})` : undefined} />
                      </span>
                      {p.lastBlockedReason && <span className="block text-xs text-amber-700 dark:text-amber-300">{p.lastBlockedReason}</span>}
                    </span>
                    {editing && p.status === "pending" ? (
                      <span className="flex gap-1.5">
                        {can("deals", "approve") && <Button size="sm" onClick={() => setConfirming(p)} data-testid={`button-confirm-proposal-${p.id}`}>Confirm</Button>}
                        <Button size="sm" variant="ghost" onClick={() => setRejecting(p)} data-testid={`button-reject-proposal-${p.id}`}>Reject</Button>
                      </span>
                    ) : <span />}
                  </div>
                );
              })}
            </div>
          )}
          {data.runs.length > 0 && (
            <p className="text-xs text-muted-foreground">Last run #{data.runs[0]!.id} by {data.runs[0]!.createdBy}: {data.runs[0]!.proposedCount} proposed, {data.runs[0]!.shortageUnits} short, {data.runs[0]!.unmatchedVins} VIN unmatched.</p>
          )}
        </>
      )}
      {confirming && <ConfirmDialog p={confirming} onClose={() => setConfirming(null)} />}
      {rejecting && <RejectDialog p={rejecting} onClose={() => setRejecting(null)} />}
    </div>
  );
}

const HANDOFF: Record<string, { label: string; href: (p: ShipmentProposalView) => string }> = {
  inventory_onboarding: { label: "Open inventory", href: () => "/inventory" },
  reservation_payment: { label: "Open deal", href: (p) => (p.dealId ? `/deals/${p.dealId}` : "/deals") },
  deal_link: { label: "Open lead", href: (p) => `/lead/${p.leadId}` },
};

function ConfirmDialog({ p, onClose }: { p: ShipmentProposalView; onClose: () => void }) {
  const invalidate = useShipmentInvalidate();
  const { toast } = useToast();
  const confirm = useConfirmShipmentProposal();
  const [interior, setInterior] = useState(false);
  const [blocked, setBlocked] = useState<{ reason: string; handoff: string | null } | null>(null);
  const needsInterior = p.spec.interiorColor !== "N/A";
  const submit = () => confirm.mutate({ proposalId: p.id, data: { interiorVerified: interior } }, {
    onSuccess: (r) => {
      invalidate();
      if (r.outcome === "confirmed") { toast({ title: "VIN held", description: `${r.confirmedProposalIds.length} VIN(s) held for deal #${p.dealId}.` }); onClose(); }
      else setBlocked({ reason: r.reason ?? "Blocked", handoff: r.handoff ?? null });
    },
    onError: (e) => toast({ title: "Not confirmed", description: errMsg(e), variant: "destructive" }),
  });
  const h = blocked?.handoff ? HANDOFF[blocked.handoff] : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Confirm {p.vin} for {p.leadName}</DialogTitle><DialogDescription>All units of the linked deal are held together, or none. Existing held, sold or committed vehicles stay with their claimant.</DialogDescription></DialogHeader>
        {needsInterior && (
          <label className="flex items-start gap-2 text-sm rounded-lg bg-muted/50 p-3">
            <Checkbox checked={interior} onCheckedChange={(v) => setInterior(v === true)} data-testid="checkbox-interior-verified" />
            <span>I physically verified the interior is <strong>{p.spec.interiorColor}</strong> (inventory records have no interior field).</span>
          </label>
        )}
        {blocked && (
          <div className="rounded-lg bg-amber-500/10 ring-1 ring-amber-500/25 p-3 text-sm space-y-2" data-testid="confirm-blocked">
            <div>{blocked.reason}</div>
            {h && <Link href={h.href(p)} className="text-sm font-medium underline underline-offset-4">{h.label}</Link>}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={submit} disabled={confirm.isPending || (needsInterior && !interior)} data-testid="button-submit-confirm">{blocked ? "Try again" : "Confirm and hold"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ p, onClose }: { p: ShipmentProposalView; onClose: () => void }) {
  const invalidate = useShipmentInvalidate();
  const { toast } = useToast();
  const rej = useRejectShipmentProposal();
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reject {p.vin}</DialogTitle><DialogDescription>The VIN returns to the unmatched pool for the next run.</DialogDescription></DialogHeader>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" data-testid="input-reject-reason" />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={reason.trim().length < 3 || rej.isPending} onClick={() => rej.mutate({ proposalId: p.id, data: { reason: reason.trim() } }, { onSuccess: () => { invalidate(); onClose(); }, onError: (e) => toast({ title: "Not rejected", description: errMsg(e), variant: "destructive" }) })} data-testid="button-submit-reject">Reject</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ audit

function AuditTab({ shipmentId }: { shipmentId: number }) {
  const { data, isLoading, error, refetch } = useListShipmentEvents(shipmentId, { query: { queryKey: getListShipmentEventsQueryKey(shipmentId) } });
  if (isLoading) return <div className="mt-3"><RowsSkeleton /></div>;
  if (error) return <div className="mt-3"><ErrorBlock error={error} onRetry={() => refetch()} /></div>;
  if (!data?.length) return <div className="mt-3"><EmptyBlock title="No events" body="Every change to this shipment is recorded here." /></div>;
  return (
    <ol className="mt-3 relative border-l border-border ml-2 space-y-4">
      {data.map((e) => (
        <li key={e.id} className="pl-5 relative" data-testid={`event-${e.id}`}>
          <span className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary/70 ring-4 ring-background" />
          <div className="text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString()} · {e.actor} · <span className="font-mono">{e.kind}</span></div>
          <div className="text-sm">{e.detail}</div>
        </li>
      ))}
    </ol>
  );
}
