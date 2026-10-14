import { useQueryClient } from "@tanstack/react-query";
import {
  useReviewSalesAccountingEntry,
  getGetSalesAccountingWorkflowQueryKey,
  getListSalesAccountingDealsQueryKey,
  type GetSalesAccountingWorkflow200EntriesItem,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCheck, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatGuyanaDateTime } from "@/lib/format";
import { apiErrorMessage } from "./shared";

/** Persisted DR/CR lines, blockers and the approve-only review action. */
export function EntryLedger({
  dealId,
  entry,
  posts,
  canApprove,
}: {
  dealId: number;
  entry: GetSalesAccountingWorkflow200EntriesItem;
  posts: boolean;
  canApprove: boolean;
}) {
  // GL workpapers must preserve cents even where summary KPIs round GYD.
  const money = { gyd: (value: number) => `GYD ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` };
  const qc = useQueryClient();
  const { toast } = useToast();
  const review = useReviewSalesAccountingEntry();
  const dr = entry.lines.reduce((s, l) => s + l.debit, 0);
  const cr = entry.lines.reduce((s, l) => s + l.credit, 0);
  const balanced = Math.abs(dr - cr) < 0.005;
  const done = entry.state === "reviewed" || entry.state === "complete";
  const reviewBlockers = entry.blockers.filter(b => !b.startsWith("ERPNext posting is held:"));

  const doReview = () =>
    review.mutate(
      { dealId, data: { stage: entry.stage, revision: entry.revision } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetSalesAccountingWorkflowQueryKey(dealId) });
          qc.invalidateQueries({ queryKey: getListSalesAccountingDealsQueryKey() });
          toast({ title: posts ? "Workpaper reviewed — not posted" : "Step confirmed (no GL)" });
        },
        onError: (err) => {
          qc.invalidateQueries({ queryKey: getGetSalesAccountingWorkflowQueryKey(dealId) });
          toast({ title: "Review refused", description: apiErrorMessage(err), variant: "destructive" });
        },
      },
    );

  return (
    <div className="space-y-3">
      {posts && (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="border-b border-white/10 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-sans">Account</th>
                <th className="px-3 py-2 font-sans hidden md:table-cell">Purpose</th>
                <th className="px-3 py-2 text-right font-sans">DR</th>
                <th className="px-3 py-2 text-right font-sans">CR</th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-4 text-center font-sans text-muted-foreground">No lines prepared — resolve blockers.</td></tr>
              )}
              {entry.lines.map((l, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className={`px-3 py-1.5 ${l.credit ? "pl-8" : ""}`}>{l.account}</td>
                  <td className="px-3 py-1.5 font-sans text-muted-foreground hidden md:table-cell">{l.purpose}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{l.debit ? money.gyd(l.debit) : ""}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{l.credit ? money.gyd(l.credit) : ""}</td>
                </tr>
              ))}
            </tbody>
            {entry.lines.length > 0 && (
              <tfoot>
                <tr className="text-[11px]">
                  <td className="px-3 py-2 font-sans font-semibold" colSpan={2}>
                    <span className={balanced ? "text-emerald-400" : "text-red-400"}>{balanced ? "Balanced" : "Out of balance"}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{money.gyd(dr)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{money.gyd(cr)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {entry.blockers.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3 text-xs" data-testid="list-blockers">
          {entry.blockers.map((b, i) => (
            <li key={i} className="flex gap-2 text-red-400"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{b}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          Rev {entry.revision} · saved {formatGuyanaDateTime(entry.updatedAt)}
          {entry.reviewedAt && ` · reviewed ${formatGuyanaDateTime(entry.reviewedAt)}`}
        </span>
        {!done && (
          <Button data-testid="button-review-entry" size="sm" variant="outline" className="h-8 rounded-full gap-1.5"
            disabled={!canApprove || review.isPending || reviewBlockers.length > 0}
            title={!canApprove ? "Requires finance:approve" : undefined}
            onClick={doReview}>
            {review.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
            {posts ? "Mark reviewed (no posting)" : "Confirm step"}
          </Button>
        )}
      </div>
      {!posts && !done && <p className="text-[11px] text-muted-foreground">Non-GL confirmation is subject to server prerequisites.</p>}
    </div>
  );
}
