import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetErpnextSettings,
  useUpdateErpnextSettings,
  useTestErpnextConnection,
  useRotateErpnextWebhookSecret,
  useListErpnextSyncJobs,
  useRetryErpnextSyncJob,
  useBackfillErpnext,
  getGetErpnextSettingsQueryKey,
  getListErpnextSyncJobsQueryKey,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { formatGuyanaDateTime } from "@/lib/format";
import {
  Plug,
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Copy,
  KeyRound,
  Globe,
  BookOpen,
  DatabaseBackup,
  Warehouse,
} from "lucide-react";

const STATUS_STYLE: Record<string, string> = {
  succeeded: "border-emerald-500/40 text-emerald-400",
  queued: "border-amber-500/40 text-amber-400",
  processing: "border-violet-500/40 text-violet-400",
  failed: "border-red-500/50 text-red-400",
  dead: "border-red-500/50 text-red-400",
};

export default function SettingsErpnext() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { activeDealer, me } = useAuthz();
  const isGm =
    !!activeDealer?.isGeneralManager ||
    activeDealer?.roleName === "General Manager" ||
    !!me?.isSuperAdmin;

  const { data: settings, isLoading } = useGetErpnextSettings();
  const { data: jobs, isLoading: jobsLoading } = useListErpnextSyncJobs();

  const [siteUrl, setSiteUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [warehouse, setWarehouse] = useState<string | null>(null);
  const [incomeAccount, setIncomeAccount] = useState<string | null>(null);
  const [taxAccount, setTaxAccount] = useState<string | null>(null);
  const [receivableAccount, setReceivableAccount] = useState<string | null>(null);
  const [settlementAccount, setSettlementAccount] = useState<string | null>(null);
  const [modes, setModes] = useState<Record<string, string> | null>(null);

  const refreshSettings = () =>
    qc.invalidateQueries({ queryKey: getGetErpnextSettingsQueryKey() });

  const save = useUpdateErpnextSettings({
    mutation: {
      onSuccess: () => {
        toast({ title: "ERPNext connection saved" });
        setApiKey("");
        setApiSecret("");
        refreshSettings();
      },
      onError: (e) =>
        toast({
          title: "Could not save",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const test = useTestErpnextConnection({
    mutation: {
      onSuccess: (res) => {
        if (res.ok) {
          toast({
            title: "Connected to ERPNext",
            description: res.companyName
              ? `Company: ${res.companyName}${res.version ? ` · v${res.version}` : ""}`
              : "Credentials verified.",
          });
        } else {
          toast({
            title: "Connection failed",
            description: res.error ?? undefined,
            variant: "destructive",
          });
        }
        refreshSettings();
      },
      onError: (e) =>
        toast({
          title: "Test failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });

  const rotate = useRotateErpnextWebhookSecret({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Webhook secret rotated",
          description: "Update the secret in your ERPNext webhook config.",
        });
        refreshSettings();
      },
      onError: (e) =>
        toast({
          title: "Could not rotate secret",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const saveMapping = useUpdateErpnextSettings({
    mutation: {
      onSuccess: () => {
        toast({ title: "Accounting mapping saved" });
        setIncomeAccount(null);
        setTaxAccount(null);
        setReceivableAccount(null);
        setSettlementAccount(null);
        setModes(null);
        refreshSettings();
      },
      onError: (e) =>
        toast({
          title: "Could not save mapping",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const backfill = useBackfillErpnext({
    mutation: {
      onSuccess: (r) => {
        toast({
          title: "Backfill queued",
          description: `${r.customers} customer(s), ${r.invoices} invoice(s), ${r.payments} payment(s), ${r.parts} part(s), ${r.suppliers} supplier(s) and ${r.purchaseOrders} open PO(s) queued for sync. Records already queued or synced are skipped.`,
        });
        qc.invalidateQueries({ queryKey: getListErpnextSyncJobsQueryKey() });
      },
      onError: (e) =>
        toast({
          title: "Backfill failed",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const retryJob = useRetryErpnextSyncJob({
    mutation: {
      onSuccess: () => {
        toast({ title: "Sync job re-queued" });
        qc.invalidateQueries({ queryKey: getListErpnextSyncJobsQueryKey() });
      },
      onError: (e) =>
        toast({
          title: "Could not retry",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const configured = settings?.configured ?? false;
  const connected = settings?.lastStatus === "connected";
  const effectiveSiteUrl = siteUrl ?? settings?.siteUrl ?? "";
  const canSave =
    effectiveSiteUrl.trim().length >= 8 &&
    (configured || (apiKey.trim() && apiSecret.trim()));

  const webhookUrl = settings?.webhookPath
    ? `${window.location.origin}${settings.webhookPath}`
    : null;

  const copy = (value: string, label: string) => {
    void navigator.clipboard.writeText(value);
    toast({ title: `${label} copied` });
  };

  return (
    <>
      <PageHero
        eyebrow="Settings"
        icon={Plug}
        title="ERPNext"
        accent="Integration"
        subtitle="Connect this dealership to an ERPNext instance for accounting and inventory sync."
      />
      <SettingsTabs />
      <Page className="space-y-5 pt-0">
        {/* Status + connection form */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Connection status
            </div>
            {isLoading ? (
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            ) : (
              <div className="flex items-center gap-3">
                {connected ? (
                  <CheckCircle2 className="h-8 w-8 text-emerald-400" />
                ) : (
                  <XCircle className={cn("h-8 w-8", configured ? "text-amber-400" : "text-red-400")} />
                )}
                <div>
                  <div className="font-semibold">
                    {connected
                      ? `Connected${settings?.companyName ? ` — ${settings.companyName}` : ""}`
                      : configured
                        ? settings?.lastStatus === "error"
                          ? "Connection error"
                          : "Configured — not yet verified"
                        : "Not connected"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {connected
                      ? `${settings?.erpnextVersion ? `ERPNext v${settings.erpnextVersion} · ` : ""}last checked ${settings?.lastCheckedAt ? formatGuyanaDateTime(settings.lastCheckedAt) : "—"}`
                      : configured
                        ? settings?.lastError ?? "Run “Test connection” to verify the credentials."
                        : "Enter your ERPNext site URL and API credentials to connect."}
                  </div>
                </div>
              </div>
            )}
            {configured && (
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  onClick={() => test.mutate()}
                  disabled={test.isPending || !isGm}
                  className="gap-2"
                >
                  {test.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plug className="h-4 w-4" />
                  )}
                  Test connection
                </Button>
                <button
                  onClick={() =>
                    save.mutate({ data: { enabled: !settings?.enabled } })
                  }
                  disabled={save.isPending || !isGm}
                  className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  {settings?.enabled ? "Pause sync" : "Resume sync"}
                </button>
                {!settings?.enabled && (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-400 text-[10px] uppercase">
                    Sync paused
                  </Badge>
                )}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-3">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Credentials
            </div>
            {!isGm && (
              <p className="text-xs text-amber-400/90">
                Only the general manager can change the ERPNext connection.
              </p>
            )}
            <div className="space-y-2">
              <Input
                placeholder="https://yourcompany.frappe.cloud"
                value={effectiveSiteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                disabled={!isGm}
              />
              <Input
                placeholder={
                  configured
                    ? `API key (${settings?.apiKeyMasked ?? "saved"} — leave blank to keep)`
                    : "API key"
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={!isGm}
              />
              <Input
                type="password"
                placeholder={
                  configured
                    ? "API secret (saved — leave blank to keep)"
                    : "API secret"
                }
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                disabled={!isGm}
              />
            </div>
            <Button
              onClick={() =>
                save.mutate({
                  data: {
                    siteUrl: effectiveSiteUrl.trim(),
                    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                    ...(apiSecret.trim() ? { apiSecret: apiSecret.trim() } : {}),
                  },
                })
              }
              disabled={!isGm || save.isPending || !canSave}
              className="gap-2"
            >
              {save.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              {configured ? "Update connection" : "Connect"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Credentials are stored server-side only; the API secret is never
              shown again after saving.
            </p>
          </div>
        </div>

        {/* Webhook setup */}
        {configured && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Inbound webhook (ERPNext → AURA)
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-muted-foreground">Request URL</div>
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-black/30 border border-white/10 rounded-lg px-3 py-2 truncate flex-1">
                    {webhookUrl ?? "—"}
                  </code>
                  {webhookUrl && (
                    <Button variant="outline" size="icon" onClick={() => copy(webhookUrl, "Webhook URL")}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-muted-foreground">
                  Shared secret (header <code>X-AURA-Webhook-Secret</code>)
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-black/30 border border-white/10 rounded-lg px-3 py-2 truncate flex-1">
                    {settings?.webhookSecret ?? "Visible to the general manager only"}
                  </code>
                  {settings?.webhookSecret && (
                    <>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => copy(settings.webhookSecret!, "Webhook secret")}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        title="Rotate secret"
                        onClick={() => rotate.mutate()}
                        disabled={rotate.isPending}
                      >
                        <RefreshCw className={cn("h-3.5 w-3.5", rotate.isPending && "animate-spin")} />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal pl-4">
              <li>In ERPNext, open <span className="text-foreground">Integrations → Webhook → New</span>.</li>
              <li>Pick the DocType and event (e.g. Sales Invoice · On Update), set Request URL to the URL above, method POST, request structure JSON.</li>
              <li>Add a header <code className="text-foreground">X-AURA-Webhook-Secret</code> with the shared secret.</li>
              <li>In the JSON body template include <code className="text-foreground">{'"doctype"'}</code>, <code className="text-foreground">{'"name"'}</code> and <code className="text-foreground">{'"event"'}</code> fields so AURA can route the event.</li>
            </ol>
          </div>
        )}

        {/* Inventory sync: default warehouse */}
        {configured && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Parts inventory sync
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                <Warehouse className="h-3.5 w-3.5" /> Default ERPNext warehouse
              </div>
              <div className="flex items-center gap-2">
                <Input
                  placeholder='e.g. "Stores - AC" (blank = first warehouse in ERPNext)'
                  value={warehouse ?? settings?.defaultWarehouse ?? ""}
                  onChange={(e) => setWarehouse(e.target.value)}
                  disabled={!isGm}
                />
                <Button
                  variant="outline"
                  onClick={() =>
                    save.mutate({
                      data: {
                        defaultWarehouse:
                          (warehouse ?? settings?.defaultWarehouse ?? "").trim() ||
                          null,
                      },
                    })
                  }
                  disabled={!isGm || save.isPending || warehouse === null}
                >
                  Save
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Stock Entries and Purchase Receipts post to this warehouse.
                Use the exact ERPNext warehouse name, including the company
                suffix.
              </p>
            </div>
          </div>
        )}

        {/* Accounting mapping */}
        {configured && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Accounting mapping
            </div>
            <p className="text-xs text-muted-foreground">
              Where AURA posts money in ERPNext: invoice line items go to the
              income account, tax snapshot lines to the tax account, and each
              AURA payment method maps to an ERPNext Mode of Payment. Accounts
              must already exist in ERPNext (validated on save).
            </p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-muted-foreground">
                  Income account (e.g. <code>Sales - GD</code>)
                </div>
                <Input
                  placeholder="Sales - GD"
                  value={incomeAccount ?? settings?.incomeAccount ?? ""}
                  onChange={(e) => setIncomeAccount(e.target.value)}
                  disabled={!isGm}
                />
              </div>
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-muted-foreground">
                  Tax account (e.g. <code>VAT - GD</code>)
                </div>
                <Input
                  placeholder="VAT - GD"
                  value={taxAccount ?? settings?.taxAccount ?? ""}
                  onChange={(e) => setTaxAccount(e.target.value)}
                  disabled={!isGm}
                />
              </div>
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-muted-foreground">
                  Receivable account (e.g. <code>Debtors - GD</code>)
                </div>
                <Input
                  placeholder="Debtors - GD"
                  value={receivableAccount ?? settings?.receivableAccount ?? ""}
                  onChange={(e) => setReceivableAccount(e.target.value)}
                  disabled={!isGm}
                />
              </div>
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-muted-foreground">
                  Settlement account payments land in (e.g. <code>Cash - GD</code>)
                </div>
                <Input
                  placeholder="Cash - GD"
                  value={settlementAccount ?? settings?.settlementAccount ?? ""}
                  onChange={(e) => setSettlementAccount(e.target.value)}
                  disabled={!isGm}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-muted-foreground">
                Payment method → ERPNext Mode of Payment (blank = ERPNext default)
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {(["cash", "card", "bank_transfer", "cheque", "mobile_money", "financing"] as const).map(
                  (method) => (
                    <div key={method} className="space-y-1">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {method.replace(/_/g, " ")}
                      </div>
                      <Input
                        placeholder={
                          method === "cash" ? "Cash" : method === "card" ? "Credit Card" : "Bank Draft"
                        }
                        value={
                          (modes ?? settings?.paymentModes ?? {})[method] ?? ""
                        }
                        onChange={(e) =>
                          setModes({
                            ...(modes ?? settings?.paymentModes ?? {}),
                            [method]: e.target.value,
                          })
                        }
                        disabled={!isGm}
                      />
                    </div>
                  ),
                )}
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                const cleanedModes = Object.fromEntries(
                  Object.entries(modes ?? settings?.paymentModes ?? {}).filter(
                    ([, v]) => v.trim(),
                  ),
                );
                saveMapping.mutate({
                  data: {
                    incomeAccount: (incomeAccount ?? settings?.incomeAccount ?? "").trim() || null,
                    taxAccount: (taxAccount ?? settings?.taxAccount ?? "").trim() || null,
                    receivableAccount: (receivableAccount ?? settings?.receivableAccount ?? "").trim() || null,
                    settlementAccount: (settlementAccount ?? settings?.settlementAccount ?? "").trim() || null,
                    paymentModes: cleanedModes,
                  },
                });
              }}
              disabled={!isGm || saveMapping.isPending}
              className="gap-2"
            >
              {saveMapping.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Save mapping
            </Button>
          </div>
        )}

        {/* Setup guidance */}
        {!connected && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              <BookOpen className="h-3.5 w-3.5" /> Don't have an ERPNext instance yet?
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-muted-foreground">
              <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-4 space-y-1.5">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <Globe className="h-4 w-4 text-primary" /> 1 · Get an instance
                </div>
                <p>
                  Easiest: a hosted site on{" "}
                  <a href="https://frappecloud.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    Frappe Cloud
                  </a>{" "}
                  (free trial, managed updates & backups). Self-hosting via
                  Docker/bench also works — AURA only needs the site to be
                  reachable over HTTPS.
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-4 space-y-1.5">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <KeyRound className="h-4 w-4 text-primary" /> 2 · Generate API keys
                </div>
                <p>
                  In ERPNext open <span className="text-foreground">Settings → My Settings → API Access</span>{" "}
                  and click <span className="text-foreground">Generate Keys</span>. Use a dedicated
                  integration user with System Manager (or scoped) roles. The API
                  secret is shown once — paste both here.
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-4 space-y-1.5">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <Plug className="h-4 w-4 text-primary" /> 3 · Enable modules
                </div>
                <p>
                  Enable the <span className="text-foreground">Accounting</span> and{" "}
                  <span className="text-foreground">Stock</span> modules and create your Company
                  with <span className="text-foreground">GYD</span> as the currency — AURA is
                  GYD-only and syncs invoices, payments and parts inventory in
                  the follow-on phases.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Sync activity */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Sync activity
            </div>
            <div className="flex items-center gap-4">
              {configured && isGm && (
                <button
                  onClick={() => backfill.mutate()}
                  disabled={backfill.isPending}
                  className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline disabled:opacity-50"
                  title="Queue every existing customer, invoice and payment for sync (safe to re-run — records are matched by email/phone to avoid duplicates)"
                >
                  {backfill.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <DatabaseBackup className="h-3.5 w-3.5" />
                  )}
                  Sync existing records
                </button>
              )}
              <button
                onClick={() =>
                  qc.invalidateQueries({ queryKey: getListErpnextSyncJobsQueryKey() })
                }
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </button>
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
            {jobsLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : (jobs ?? []).length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No sync activity yet. Jobs will appear here once entity sync
                (customers, invoices, inventory) starts pushing records.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-3">Entity</th>
                    <th className="px-5 py-3">DocType</th>
                    <th className="px-5 py-3">Direction</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Attempts</th>
                    <th className="px-5 py-3">Time</th>
                    <th className="px-5 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {(jobs ?? []).map((j) => (
                    <tr key={j.id} className="border-b border-white/[0.04] hover:bg-foreground/[0.02]">
                      <td className="px-5 py-3 font-medium">
                        {j.entityType} #{j.entityId}
                        {j.erpnextDocName && (
                          <div className="text-[11px] text-muted-foreground">→ {j.erpnextDocName}</div>
                        )}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">{j.doctype}</td>
                      <td className="px-5 py-3 text-xs text-muted-foreground capitalize">{j.direction}</td>
                      <td className="px-5 py-3">
                        <Badge
                          variant="outline"
                          className={cn("text-[10px] uppercase", STATUS_STYLE[j.status])}
                          title={j.lastError ?? undefined}
                        >
                          {j.status === "dead" ? "dead letter" : j.status}
                        </Badge>
                        {j.lastError && (j.status === "failed" || j.status === "dead") && (
                          <div className="mt-1 text-[11px] text-red-400/80 max-w-[260px] truncate" title={j.lastError}>
                            {j.lastError}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">{j.attempts}</td>
                      <td className="px-5 py-3 text-xs text-muted-foreground">
                        {formatGuyanaDateTime(j.createdAt)}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {(j.status === "failed" || j.status === "dead") && (
                          <button
                            onClick={() => retryJob.mutate({ id: j.id })}
                            disabled={retryJob.isPending}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline disabled:opacity-50"
                          >
                            <RefreshCw className={cn("h-3 w-3", retryJob.isPending && "animate-spin")} />
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Page>
    </>
  );
}
