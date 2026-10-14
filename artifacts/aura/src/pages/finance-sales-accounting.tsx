import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSalesAccountingConfig,
  useListSalesAccountingDeals,
  useGetSalesAccountingWorkflow,
  useStartSalesAccountingWorkflow,
  getGetSalesAccountingWorkflowQueryKey,
  getListSalesAccountingDealsQueryKey,
  type GetSalesAccountingWorkflow200,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, FileStack, Loader2, Settings2, RotateCcw, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { useMoney } from "@/lib/format";
import { EntryForm } from "@/components/sales-accounting/entry-form";
import { EntryLedger } from "@/components/sales-accounting/entry-ledger";
import {
  EntryStateChip, PreparationBanner, Unavailable, STAGE_ORDER, apiErrorMessage,
} from "@/components/sales-accounting/shared";

export default function FinanceSalesAccounting() {
  const { can, activeDealer } = useAuthz();
  const dealerId = activeDealer?.dealerId ?? 0;
  if (!can("finance", "view")) {
    return <Page className="pt-10"><Unavailable title="Finance view required" body="Your role cannot read sales accounting workpapers." /></Page>;
  }
  // Remount on dealer switch so every unsaved draft is discarded.
  return <Workspace key={dealerId} />;
}

function Workspace() {
  const { can } = useAuthz();
  const canEdit = can("finance", "edit");
  const canApprove = can("finance", "approve");
  const money = useMoney();
  const config = useGetSalesAccountingConfig();
  const deals = useListSalesAccountingDeals({ query: { queryKey: getListSalesAccountingDealsQueryKey(), enabled: !!config.data?.eligible } });
  const [dealId, setDealId] = useState<number | null>(null);

  const hero = (
    <PageHero
      eyebrow="Finance Desk · Pilot"
      title="Sales Accounting Workpapers"
      subtitle="Document each vehicle sale, its funding sources and balanced GL lines — reviewed, never posted."
      className="pb-3"
      action={
        <div className="flex gap-2">
          <Link href="/finance/sales-accounting/config" data-testid="link-sa-config">
            <Button variant="outline" className="rounded-full h-9 gap-1.5 text-sm"><Settings2 className="h-4 w-4" /> Mappings</Button>
          </Link>
          <Link href="/finance" data-testid="link-back-finance">
            <Button variant="outline" className="rounded-full h-9 gap-1.5 text-sm"><ArrowLeft className="h-4 w-4" /> Finance</Button>
          </Link>
        </div>
      }
    />
  );

  if (config.isLoading) {
    return <>{hero}<Page className="pt-0 space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-20 rounded-2xl bg-white/[0.05] animate-pulse" />)}</Page></>;
  }
  if (config.isError) {
    return <>{hero}<Page className="pt-0"><ErrorRetry msg={apiErrorMessage(config.error)} onRetry={() => config.refetch()} /></Page></>;
  }
  if (!config.data?.eligible) {
    return <>{hero}<Page className="pt-0 space-y-4"><PreparationBanner /><Unavailable title="Not available for this dealership" body="Sales accounting preparation is enabled for CAM Motors Dummy only. All other dealers are read-only unavailable during this release." /></Page></>;
  }

  const list = deals.data ?? [];
  return (
    <>
      {hero}
      <Page className="pt-0 space-y-4">
        <PreparationBanner>
          <p className="text-xs text-amber-400">Advance VAT policy: {config.data.vatPolicy}. Mapping validation: {config.data.validation.state}.</p>
        </PreparationBanner>
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <aside className="glass-panel rounded-2xl p-2 h-fit lg:sticky lg:top-4">
            <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Deals</div>
            {deals.isLoading && [0, 1, 2, 3].map((i) => <div key={i} className="m-2 h-12 rounded-xl bg-white/[0.05] animate-pulse" />)}
            {deals.isError && <ErrorRetry msg={apiErrorMessage(deals.error)} onRetry={() => deals.refetch()} />}
            {!deals.isLoading && list.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No eligible deals yet.</p>}
            {list.map((d) => (
              <button key={d.id} data-testid={`button-deal-${d.id}`} onClick={() => setDealId(d.id)}
                className={`w-full rounded-xl px-3 py-2.5 text-left transition-colors ${dealId === d.id ? "bg-primary/15 ring-1 ring-primary/40" : "hover:bg-white/[0.05]"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">#{d.id} {d.customerName}</span>
                  {d.enrolled && <span className="rounded-full bg-primary/15 px-1.5 text-[9px] font-bold uppercase tracking-widest text-primary">Enrolled</span>}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">{d.vehicle ?? "Vehicle TBC"} · {money.gyd(d.amount)} · {d.stage}</div>
              </button>
            ))}
          </aside>
          <section>
            {dealId == null ? (
              <div className="glass-panel rounded-2xl p-12 text-center">
                <FileStack className="mx-auto mb-3 h-8 w-8 text-primary/70" />
                <p className="text-sm text-muted-foreground">Pick a deal to open its ten-stage workpaper binder.</p>
              </div>
            ) : (
              <DealWorkpaper key={dealId} dealId={dealId} canEdit={canEdit} canApprove={canApprove} />
            )}
          </section>
        </div>
      </Page>
    </>
  );
}

function ErrorRetry({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <div className="glass-panel rounded-2xl p-6 text-center space-y-3">
      <p className="text-sm text-red-400">{msg}</p>
      <Button data-testid="button-retry" size="sm" variant="outline" className="rounded-full gap-1.5" onClick={onRetry}><RotateCcw className="h-3.5 w-3.5" /> Retry</Button>
    </div>
  );
}

function DealWorkpaper({ dealId, canEdit, canApprove }: { dealId: number; canEdit: boolean; canApprove: boolean }) {
  const wf = useGetSalesAccountingWorkflow(dealId, { query: { queryKey: getGetSalesAccountingWorkflowQueryKey(dealId), enabled: !!dealId } });
  if (wf.isLoading) return <div className="h-96 rounded-2xl bg-white/[0.05] animate-pulse" />;
  if (wf.isError || !wf.data) return <ErrorRetry msg={apiErrorMessage(wf.error)} onRetry={() => wf.refetch()} />;
  return <Binder wf={wf.data} canEdit={canEdit} canApprove={canApprove} />;
}

function Binder({ wf, canEdit, canApprove }: { wf: GetSalesAccountingWorkflow200; canEdit: boolean; canApprove: boolean }) {
  const money = useMoney();
  const [stage, setStage] = useState<string>("VS-01");
  useEffect(() => setStage("VS-01"), [wf.deal.id]);
  const stageMeta = (id: string) => wf.stages.find((s) => s.id === id);
  const entryFor = (id: string) => wf.entries.find((e) => e.stage === id);
  const meta = stageMeta(stage);
  const entry = entryFor(stage);

  return (
    <div className="space-y-4">
      <div className="glass-panel rounded-2xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Deal #{wf.deal.id} · {wf.deal.stage}</div>
            <h2 className="text-xl font-semibold tracking-tight" data-testid="text-deal-customer">{wf.deal.customerName}</h2>
            <div className="text-xs text-muted-foreground">{wf.deal.vehicle ?? "Vehicle TBC"}{wf.deal.vin && <span className="font-mono"> · {wf.deal.vin}</span>} · {money.gyd(wf.deal.amount)}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/deals" data-testid="link-deal-ui"><Button size="sm" variant="outline" className="h-8 rounded-full gap-1.5 text-xs"><ExternalLink className="h-3 w-3" /> Deal desk</Button></Link>
            <Link href="/finance" data-testid="link-invoices"><Button size="sm" variant="outline" className="h-8 rounded-full gap-1.5 text-xs"><ExternalLink className="h-3 w-3" /> Invoices & payments</Button></Link>
          </div>
        </div>
        {wf.notice && <p className="mt-3 border-t border-white/10 pt-3 text-xs text-muted-foreground">{wf.notice}</p>}
      </div>

      {!wf.deal.enrolled ? (
        <EnrolCard dealId={wf.deal.id} canEdit={canEdit} />
      ) : (
        <>
          <div className="glass-panel rounded-2xl p-2 overflow-x-auto">
            <div className="flex min-w-max gap-1">
              {STAGE_ORDER.map((id) => {
                const e = entryFor(id);
                const m = stageMeta(id);
                const active = id === stage;
                return (
                  <button key={id} data-testid={`button-stage-${id}`} onClick={() => setStage(id)}
                    className={`relative rounded-xl px-3 py-2 text-left transition-colors ${active ? "bg-primary text-white" : "hover:bg-white/[0.05]"} ${id === "VS-10" ? "ml-3 border-l border-dashed border-white/15 pl-4" : ""}`}>
                    <div className="font-mono text-[11px] font-semibold">{id}</div>
                    <div className={`max-w-[110px] truncate text-[10px] ${active ? "text-white/80" : "text-muted-foreground"}`}>{id === "VS-10" ? "Cancel / refund alt." : m?.title ?? ""}</div>
                    <span className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${!e ? "bg-white/20" : e.blockers.length ? "bg-red-400" : e.state === "reviewed" || e.state === "complete" ? "bg-emerald-400" : "bg-amber-400"}`} />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="glass-panel rounded-2xl p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-primary">{stage}</span>
                  <h3 className="font-semibold tracking-tight">{meta?.title}</h3>
                </div>
                <p className="text-xs text-muted-foreground">{meta?.requirements}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">{meta?.posts ? "GL workpaper" : "No GL"}</span>
                {entry && <EntryStateChip state={entry.state} posts={!!meta?.posts} />}
              </div>
            </div>
            <EntryForm key={`${stage}-${entry?.revision ?? 0}`} workflow={wf} stage={stage} entry={entry} canEdit={canEdit} />
            {entry && <div className="border-t border-white/10 pt-4"><EntryLedger dealId={wf.deal.id} entry={entry} posts={!!meta?.posts} canApprove={canApprove} /></div>}
          </div>
        </>
      )}
    </div>
  );
}

function EnrolCard({ dealId, canEdit }: { dealId: number; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();
  const start = useStartSalesAccountingWorkflow();
  const go = () =>
    start.mutate({ dealId }, {
      onSuccess: () => {
        setOpen(false);
        qc.invalidateQueries({ queryKey: getGetSalesAccountingWorkflowQueryKey(dealId) });
        qc.invalidateQueries({ queryKey: getListSalesAccountingDealsQueryKey() });
        toast({ title: "Deal enrolled for preparation", description: "Legacy ERP financial sync is now held for this deal." });
      },
      onError: (err) => {
        setOpen(false);
        toast({ title: "Enrollment blocked", description: apiErrorMessage(err), variant: "destructive" });
      },
    });
  return (
    <div className="glass-panel rounded-2xl p-6 space-y-3">
      <h3 className="font-semibold tracking-tight">Not enrolled</h3>
      <p className="text-sm text-muted-foreground">Enrol this deal to start its preparation workpapers. Only this deal is affected.</p>
      <Button data-testid="button-enrol" className="rounded-full" disabled={!canEdit || start.isPending} onClick={() => setOpen(true)}>Enrol deal #{dealId}</Button>
      {!canEdit && <p className="text-[11px] text-muted-foreground">Requires finance:edit.</p>}
      <AlertDialog open={open} onOpenChange={(o) => !start.isPending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enrol deal #{dealId} in preparation mode?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>This affects the selected deal only. Its legacy ERP financial sync will be held while enrolled.</p>
                <p>Nothing will post to the books, and no invoices, payments or VIN holds will be created.</p>
                <p>The server will refuse enrollment if this deal already has past payments or ERP sync activity.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={start.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-enrol" disabled={start.isPending} onClick={(e) => { e.preventDefault(); go(); }}>
              {start.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Enrol deal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
