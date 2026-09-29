import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListJobAvailableOils, useListJobOilRequests, useRequestJobOil, useProcessJobOilRequest,
  getListJobAvailableOilsQueryKey, getListJobOilRequestsQueryKey,
} from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function JobOils({ cardId, technicianId, status, invoiced, onChanged }: {
  cardId: number; technicianId: number | null | undefined; status: string;
  invoiced: boolean; onChanged: () => Promise<void>;
}) {
  const { can, me } = useAuthz();
  const client = useQueryClient();
  const { toast } = useToast();
  const { data: oils } = useListJobAvailableOils(cardId);
  const { data: requests, isLoading, error } = useListJobOilRequests(cardId);
  const request = useRequestJobOil();
  const process = useProcessJobOilRequest();
  const [oilId, setOilId] = useState("");
  const [litres, setLitres] = useState("");
  const [issueAmounts, setIssueAmounts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const active = !invoiced && ["open", "in_progress", "on_hold"].includes(status);
  const requestAllowed = active && can("service", "edit") &&
    (me?.id === technicianId || /service manager|general manager|management|owner.?admin|admin/i.test(me?.roleName ?? ""));
  const canIssue = can("parts", "edit") && can("service", "edit") &&
    /parts|service manager|general manager|leadership|management|owner.?admin|admin/i.test(me?.roleName ?? "");
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: getListJobOilRequestsQueryKey(cardId) }),
      client.invalidateQueries({ queryKey: getListJobAvailableOilsQueryKey(cardId) }),
      onChanged(),
    ]);
  };
  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try { await fn(); await refresh(); toast({ title: success }); }
    catch (e) { toast({ title: "Oil action failed", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" }); }
    finally { setBusy(false); }
  };
  return <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
    <h3 className="text-xs font-semibold uppercase tracking-widest">Workshop oils · litres</h3>
    <p className="text-xs text-muted-foreground">Requests reserve litres. Parts staff approve and issue physically; only issued litres are billed at the request-time GYD price. Returns restore stock.</p>
    {requestAllowed && <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs space-y-1 min-w-48"><span>Oil</span>
        <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={oilId}
          onChange={e => setOilId(e.target.value)}>
          <option value="">Select oil</option>
          {oils?.map(o => <option value={o.id} key={o.id}>{o.name} · {o.grade} ({o.availableLitres.toFixed(3)} L available)</option>)}
        </select></label>
      <label className="text-xs space-y-1 w-28"><span>Litres</span>
        <Input type="number" min="0.001" step="0.001" value={litres} onChange={e => setLitres(e.target.value)} /></label>
      <Button disabled={busy || !oilId || !(Number(litres) > 0)} onClick={() => run(async () => {
        await request.mutateAsync({ id: cardId, data: { oilId: Number(oilId), litres: Number(litres) } });
        setLitres(""); setOilId("");
      }, "Oil requested")}>Request oil</Button>
    </div>}
    {isLoading && <p className="text-xs text-muted-foreground">Loading oil requests…</p>}
    {error && <p className="text-xs text-destructive">Could not load oil requests.</p>}
    {requests?.map(r => {
      const remaining = Math.round((r.requestedLitres - r.issuedLitres) * 1000) / 1000;
      const returnable = Math.round((r.issuedLitres - r.returnedLitres) * 1000) / 1000;
      const entered = issueAmounts[r.id] ? Number(issueAmounts[r.id]) : undefined;
      return <div key={r.id} className="rounded-lg border border-white/10 p-3 text-xs space-y-2">
        <p className="font-medium">{r.name} · {r.status}</p>
        <p className="text-muted-foreground">Requested {r.requestedLitres.toFixed(3)} L · Issued {r.issuedLitres.toFixed(3)} L · Returned {r.returnedLitres.toFixed(3)} L · GYD {r.unitPricePerLitre.toFixed(2)}/L</p>
        {canIssue && r.status !== "cancelled" && <div className="flex flex-wrap items-center gap-2">
          {(remaining > 0 || returnable > 0) && <Input className="w-28" aria-label="Litres to issue or return"
            placeholder="Litres" type="number" min="0.001" step="0.001" value={issueAmounts[r.id] ?? ""}
            onChange={e => setIssueAmounts(a => ({ ...a, [r.id]: e.target.value }))} />}
          {active && r.status === "requested" && <Button size="sm" variant="outline" disabled={busy}
            onClick={() => run(() => process.mutateAsync({ id: cardId, requestId: r.id, action: "approve", data: {} }), "Oil request approved")}>Approve</Button>}
          {active && r.status !== "requested" && remaining > 0 && <Button size="sm" disabled={busy || (entered !== undefined && (entered <= 0 || entered > remaining))}
            onClick={() => run(() => process.mutateAsync({ id: cardId, requestId: r.id, action: "issue", data: entered ? { litres: entered } : {} }), "Oil issued")}>Issue {entered || remaining} L</Button>}
          {returnable > 0 && <Button size="sm" variant="outline" disabled={busy || (entered !== undefined && (entered <= 0 || entered > returnable))}
            onClick={() => run(() => process.mutateAsync({ id: cardId, requestId: r.id, action: "return", data: entered ? { litres: entered } : {} }), "Oil returned")}>Return {entered || returnable} L</Button>}
          {active && returnable === 0 && <Button size="sm" variant="outline" disabled={busy}
            onClick={() => run(() => process.mutateAsync({ id: cardId, requestId: r.id, action: "cancel", data: {} }), "Oil request cancelled")}>Cancel</Button>}
        </div>}
        {invoiced && returnable > 0 && <p className="text-xs text-amber-500">Physical returns restore stock only. Issue an authorized invoice credit separately; no automatic refund.</p>}
      </div>;
    })}
  </div>;
}