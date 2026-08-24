import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMetaSettings,
  useUpdateMetaSettings,
  useTestMetaConnection,
  useSubscribeMetaPage,
  getGetMetaSettingsQueryKey,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import {
  Facebook,
  Loader2,
  CheckCircle2,
  XCircle,
  Copy,
  Globe,
  BookOpen,
  Megaphone,
  KeyRound,
  Zap,
} from "lucide-react";

function StatusRow({ ok, label }: { ok: boolean; label: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 text-amber-500 shrink-0" />
      )}
      <span className="text-sm">{label}</span>
    </div>
  );
}

export default function SettingsMeta() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { activeDealer, me } = useAuthz();
  const isGm =
    !!activeDealer?.isGeneralManager ||
    activeDealer?.roleName === "General Manager" ||
    !!me?.isSuperAdmin;

  const { data: settings, isLoading } = useGetMetaSettings();

  // null = untouched (keep saved value); string = user is editing.
  const [pageIdDraft, setPageIdDraft] = useState<string | null>(null);
  const [pageToken, setPageToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyDraft, setVerifyDraft] = useState<string | null>(null);

  const refresh = () =>
    qc.invalidateQueries({ queryKey: getGetMetaSettingsQueryKey() });

  const save = useUpdateMetaSettings({
    mutation: {
      onSuccess: () => {
        toast({ title: "Meta connection saved" });
        setPageIdDraft(null);
        setPageToken("");
        setAppSecret("");
        setVerifyDraft(null);
        refresh();
      },
      onError: (e) =>
        toast({
          title: "Could not save",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const test = useTestMetaConnection({
    mutation: {
      onSuccess: (r) => {
        if (r.ok) {
          toast({
            title: "Connection OK",
            description: `Page token verified for ${r.pageName ?? "your Page"}.`,
          });
        } else {
          toast({
            title: "Connection problem",
            description: r.error ?? undefined,
            variant: "destructive",
          });
        }
        refresh();
      },
      onError: (e) =>
        toast({
          title: "Test failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });

  const subscribe = useSubscribeMetaPage({
    mutation: {
      onSuccess: (r) => {
        if (r.ok) {
          toast({
            title: "Page subscribed",
            description: "Your Page now sends lead forms to AURA.",
          });
        } else {
          toast({
            title: "Could not subscribe",
            description: r.error ?? undefined,
            variant: "destructive",
          });
        }
        refresh();
      },
      onError: (e) =>
        toast({
          title: "Subscribe failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });

  const pageId = pageIdDraft ?? settings?.metaPageId ?? "";
  const verifyToken = verifyDraft ?? settings?.verifyToken ?? "";
  const linked = !!settings?.metaPageId;
  const dirty =
    (pageIdDraft !== null && pageIdDraft !== (settings?.metaPageId ?? "")) ||
    pageToken.trim() !== "" ||
    appSecret.trim() !== "" ||
    (verifyDraft !== null && verifyDraft !== (settings?.verifyToken ?? ""));

  const doSave = () => {
    const data: Record<string, string | null> = {};
    if (pageIdDraft !== null && pageIdDraft !== (settings?.metaPageId ?? ""))
      data["metaPageId"] = pageIdDraft || null;
    if (pageToken.trim()) data["pageAccessToken"] = pageToken.trim();
    if (appSecret.trim()) data["appSecret"] = appSecret.trim();
    if (verifyDraft !== null && verifyDraft !== (settings?.verifyToken ?? ""))
      data["verifyToken"] = verifyDraft || null;
    save.mutate({ data });
  };

  const copy = (value: string, label: string) => {
    void navigator.clipboard.writeText(value);
    toast({ title: `${label} copied` });
  };

  return (
    <>
      <PageHero
        eyebrow="Settings"
        icon={Facebook}
        title="Meta Lead Ads"
        accent="Integration"
        subtitle="Connect this dealership's Facebook Page so leads from Facebook and Instagram ad campaigns land on your pipeline automatically."
      />
      <SettingsTabs />
      <Page className="space-y-5 pt-0">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Connection form */}
          <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Connection
            </div>
            {isLoading ? (
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            ) : (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">
                    Facebook Page ID
                  </label>
                  <Input
                    value={pageId}
                    onChange={(e) => setPageIdDraft(e.target.value)}
                    placeholder="e.g. 521319681027727"
                    disabled={!isGm || save.isPending}
                    inputMode="numeric"
                    data-testid="input-meta-page-id"
                  />
                  <p className="text-xs text-muted-foreground">
                    Business Suite → Settings → Business assets → Pages.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">
                    Page access token{" "}
                    {settings?.hasPageAccessToken && (
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        saved
                      </Badge>
                    )}
                  </label>
                  <Input
                    type="password"
                    value={pageToken}
                    onChange={(e) => setPageToken(e.target.value)}
                    placeholder={
                      settings?.hasPageAccessToken
                        ? "•••••••• (enter a new token to replace)"
                        : "Paste the PAGE token from Graph API Explorer"
                    }
                    disabled={!isGm || save.isPending}
                    autoComplete="off"
                    data-testid="input-meta-page-token"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">
                    App secret{" "}
                    {settings?.hasAppSecret && (
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        saved
                      </Badge>
                    )}
                  </label>
                  <Input
                    type="password"
                    value={appSecret}
                    onChange={(e) => setAppSecret(e.target.value)}
                    placeholder={
                      settings?.hasAppSecret
                        ? "•••••••• (enter a new secret to replace)"
                        : "Meta App dashboard → Settings → Basic → App Secret"
                    }
                    disabled={!isGm || save.isPending}
                    autoComplete="off"
                    data-testid="input-meta-app-secret"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">
                    Webhook verify token
                  </label>
                  <div className="flex gap-2">
                    <Input
                      value={verifyToken}
                      onChange={(e) => setVerifyDraft(e.target.value)}
                      placeholder="Any phrase you'll paste into the Meta webhook form"
                      disabled={!isGm || save.isPending}
                      autoComplete="off"
                      data-testid="input-meta-verify-token"
                    />
                    {verifyToken && (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => copy(verifyToken, "Verify token")}
                        data-testid="button-copy-verify-token"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                {isGm ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      size="sm"
                      disabled={!dirty || save.isPending}
                      onClick={doSave}
                      data-testid="button-save-meta"
                    >
                      {save.isPending && (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      )}
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={test.isPending || save.isPending}
                      onClick={() => test.mutate()}
                      data-testid="button-test-meta"
                    >
                      {test.isPending ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <KeyRound className="h-4 w-4 mr-1" />
                      )}
                      Test connection
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={subscribe.isPending || save.isPending || !linked}
                      onClick={() => subscribe.mutate()}
                      data-testid="button-subscribe-meta"
                    >
                      {subscribe.isPending ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <Zap className="h-4 w-4 mr-1" />
                      )}
                      Subscribe page
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-amber-600">
                    Only the general manager can change the Meta connection.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Status */}
          <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Status
            </div>
            {isLoading ? (
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            ) : (
              <div className="space-y-3">
                <StatusRow
                  ok={linked}
                  label={
                    linked ? (
                      <>
                        Facebook Page connected{" "}
                        <Badge
                          variant="outline"
                          className="ml-1 font-mono text-[11px]"
                        >
                          {settings?.metaPageId}
                        </Badge>
                      </>
                    ) : (
                      "Facebook Page not connected"
                    )
                  }
                />
                <StatusRow
                  ok={!!settings?.configured}
                  label={
                    settings?.configured
                      ? settings.usingPlatformCredentials
                        ? "Credentials configured (platform defaults)"
                        : "Credentials configured (this dealership's own)"
                      : "Credentials incomplete — save a page token, app secret and verify token"
                  }
                />
                {settings?.lastStatus && (
                  <StatusRow
                    ok={settings.lastStatus === "connected"}
                    label={
                      settings.lastStatus === "connected"
                        ? `Last test passed${settings.lastCheckedAt ? ` · ${new Date(settings.lastCheckedAt).toLocaleString()}` : ""}`
                        : `Last test failed: ${settings.lastError ?? "unknown error"}`
                    }
                  />
                )}
                <div className="pt-3 border-t border-border space-y-2">
                  <div className="text-xs font-semibold text-muted-foreground">
                    Last campaign lead received
                  </div>
                  {settings?.lastEvent ? (
                    <div
                      className="space-y-1 text-sm"
                      data-testid="text-meta-last-event"
                    >
                      <div className="flex items-center gap-2">
                        <Megaphone className="h-4 w-4 text-primary" />
                        <span className="font-medium">
                          {settings.lastEvent.leadName ?? "Lead"}
                        </span>
                        {settings.lastEvent.leadSource && (
                          <Badge variant="outline" className="capitalize">
                            {settings.lastEvent.leadSource}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(settings.lastEvent.createdAt).toLocaleString()}{" "}
                        · Meta lead ID{" "}
                        <span className="font-mono">
                          {settings.lastEvent.externalId}
                        </span>
                      </div>
                      {settings.lastEvent.leadId && (
                        <a
                          href={`/leads/${settings.lastEvent.leadId}`}
                          className="text-xs text-primary underline underline-offset-2"
                        >
                          Open lead
                        </a>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      None yet — once connected and subscribed, new Facebook /
                      Instagram Lead Ads submissions appear here and on the
                      pipeline within seconds.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Setup guide */}
        <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            <BookOpen className="h-4 w-4" />
            Setup guide
          </div>
          <ol className="list-decimal ml-5 space-y-2 text-sm text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">Page ID</span> —
              enter your Facebook Page ID above (Business Suite → Settings →
              Business assets → Pages) and save.
            </li>
            <li>
              <span className="font-medium text-foreground">App secret</span> —
              in your Meta app: Settings → Basic → App Secret → Show → paste it
              above.
            </li>
            <li>
              <span className="font-medium text-foreground">Verify token</span>{" "}
              — pick any phrase, save it above, and enter the same phrase in
              the Meta webhook form.
            </li>
            <li>
              <span className="font-medium text-foreground">Webhook</span> — in
              the Meta app add the Webhooks product, object{" "}
              <code>Page</code>, the callback URL below and your verify token,
              then subscribe the <code>leadgen</code> field.
            </li>
            <li>
              <span className="font-medium text-foreground">Page token</span> —
              Graph API Explorer: generate a token as an account that manages
              your Page (tick the Page in the popup), grant{" "}
              <code>leads_retrieval</code>, <code>pages_show_list</code>,{" "}
              <code>pages_manage_metadata</code>,{" "}
              <code>pages_read_engagement</code>, then switch the dropdown to
              the <em>Page</em> token and paste it above.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Test &amp; subscribe
              </span>{" "}
              — click "Test connection" (confirms it's a real Page token), then
              "Subscribe page" to start receiving leads.
            </li>
          </ol>
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
            <code className="text-xs bg-muted rounded px-2 py-1 break-all">
              {settings?.callbackUrl ?? "…"}
            </code>
            {settings?.callbackUrl && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copy(settings.callbackUrl, "Callback URL")}
                data-testid="button-copy-callback"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </Page>
    </>
  );
}
