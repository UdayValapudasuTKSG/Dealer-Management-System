import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEmailSettings,
  useSendTestEmail,
  useSendTemplateTestEmail,
  useListEmailTemplates,
  usePreviewEmailTemplate,
  useListEmailLogs,
  useRetryEmailLog,
  getListEmailLogsQueryKey,
  getGetEmailSettingsQueryKey,
  getListEmailTemplatesQueryKey,
  useGetServiceSettings,
  useUpdateServiceSettings,
  getGetServiceSettingsQueryKey,
  useUpdateSmtpConnection,
  useDeleteSmtpConnection,
  useTestSmtpConnection,
  useUpdateEmailTemplateOverride,
  useDeleteEmailTemplateOverride,
  type EmailSettings,
  type EmailTemplateInfo,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { formatGuyanaDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Mail,
  Send,
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  RefreshCw,
  Pencil,
  Trash2,
  Plug,
} from "lucide-react";

const STATUS_STYLE: Record<string, string> = {
  sent: "border-emerald-500/40 text-emerald-400",
  queued: "border-amber-500/40 text-amber-400",
  sending: "border-violet-500/40 text-violet-400",
  failed: "border-red-500/50 text-red-400",
};

export default function SettingsEmail() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings } = useGetEmailSettings();
  const { data: templates } = useListEmailTemplates();
  const [channel, setChannel] = useState<"all" | "email" | "whatsapp">("all");
  const { data: logs, isLoading: logsLoading } = useListEmailLogs(
    channel === "all" ? {} : { channel },
  );
  const [testTo, setTestTo] = useState("");
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [editTemplate, setEditTemplate] = useState<EmailTemplateInfo | null>(
    null,
  );
  const canManage = settings?.canManage ?? false;

  const retryLog = useRetryEmailLog({
    mutation: {
      onSuccess: () => {
        toast({ title: "Message re-queued", description: "It will retry on the next queue pass." });
        qc.invalidateQueries({ queryKey: getListEmailLogsQueryKey() });
      },
      onError: (e) =>
        toast({
          title: "Could not retry",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const testSend = useSendTestEmail({
    mutation: {
      onSuccess: (res) => {
        if (res.ok) {
          toast({ title: "Test email queued", description: "Check the inbox shortly." });
          qc.invalidateQueries({ queryKey: getListEmailLogsQueryKey() });
        } else {
          toast({
            title: "Cannot send",
            description: res.error ?? "SMTP not configured.",
            variant: "destructive",
          });
        }
      },
      onError: (e) =>
        toast({
          title: "Test failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });

  const templateTest = useSendTemplateTestEmail({
    mutation: {
      onSuccess: (res, vars) => {
        if (res.ok) {
          toast({
            title: "Test email queued",
            description: `"${vars.key}" sent to ${testTo.trim()} with sample data.`,
          });
          qc.invalidateQueries({ queryKey: getListEmailLogsQueryKey() });
        } else {
          toast({
            title: "Cannot send",
            description: res.error ?? "SMTP not configured.",
            variant: "destructive",
          });
        }
      },
      onError: (e) =>
        toast({
          title: "Test failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });

  const refreshLogs = () => {
    qc.invalidateQueries({ queryKey: getListEmailLogsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetEmailSettingsQueryKey() });
  };

  return (
    <>
    <PageHero
      eyebrow="Settings"
      icon={Mail}
      title="Email"
      accent="Engine"
      subtitle="Gmail SMTP delivery, branded templates and the outbound queue."
    />
    <SettingsTabs />
    <Page className="space-y-5 pt-0">

      {/* Connection + test send */}
      <SmtpConnectionCard settings={settings} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Delivery status
          </div>
          <div className="flex items-center gap-3">
            {settings?.configured && settings.enabled ? (
              <CheckCircle2 className="h-8 w-8 text-emerald-400" />
            ) : (
              <XCircle className="h-8 w-8 text-red-400" />
            )}
            <div>
              <div className="font-semibold">
                {!settings?.configured
                  ? "No email connection"
                  : !settings.enabled
                    ? "Sending paused"
                    : "Ready to send"}
              </div>
              <div className="text-xs text-muted-foreground">
                {settings?.configured && settings.fromAddress
                  ? `Sending as ${settings.fromAddress}`
                  : "This dealership sends no email until its own connection is set up."}
              </div>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            Queue depth:{" "}
            <span className="text-foreground font-medium">
              {settings?.queueDepth ?? 0}
            </span>{" "}
            pending
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Send a test email
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="recipient@example.com"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
            />
            <Button
              onClick={() => testSend.mutate({ data: { to: testTo.trim() } })}
              disabled={testSend.isPending || testTo.trim().length < 3}
              className="gap-2 shrink-0"
            >
              {testSend.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send test
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Delivers the branded SMTP test template through the live queue.
          </p>
        </div>
      </div>

      <ServiceSummaryCadenceCard />

      <LeadSourceReportCard />

      {/* Templates */}
      <div className="space-y-3">
        <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
          Templates
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {(templates ?? []).map((t) => (
            <div
              key={t.key}
              role="button"
              tabIndex={0}
              onClick={() => setPreviewKey(t.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setPreviewKey(t.key);
              }}
              className="cursor-pointer text-left rounded-xl border border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06] p-4 transition-colors group"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold flex items-center gap-2">
                  {t.label}
                  {t.hasOverride && t.overrideEnabled && (
                    <Badge
                      variant="outline"
                      className="text-[9px] uppercase border-primary/40 text-primary"
                    >
                      Customized
                    </Badge>
                  )}
                </span>
                <Eye className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary transition-colors" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
              <div className="mt-3 flex items-center gap-4">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    templateTest.mutate({
                      key: t.key,
                      data: { to: testTo.trim() },
                    });
                  }}
                  disabled={templateTest.isPending || testTo.trim().length < 3}
                  title={
                    testTo.trim().length < 3
                      ? "Enter a recipient in the “Send a test email” box above first"
                      : `Send a "${t.label}" test to ${testTo.trim()}`
                  }
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
                >
                  {templateTest.isPending &&
                  templateTest.variables?.key === t.key ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Send className="h-3 w-3" />
                  )}
                  Send test
                </button>
                {canManage && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditTemplate(t);
                    }}
                    className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:underline"
                  >
                    <Pencil className="h-3 w-3" />
                    Customize
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Logs */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Outbox
            </div>
            <div className="flex items-center gap-1">
              {(["all", "email", "whatsapp"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setChannel(c)}
                  className={cn(
                    "text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors",
                    channel === c
                      ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c === "all" ? "All" : c === "email" ? "Email" : "WhatsApp"}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={refreshLogs}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
          {logsLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (logs ?? []).length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Nothing in the outbox yet.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3">Recipient</th>
                  <th className="px-5 py-3">Subject</th>
                  <th className="px-5 py-3">Template</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Attempts</th>
                  <th className="px-5 py-3">Time</th>
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {(logs ?? []).map((l) => (
                  <tr
                    key={l.id}
                    className="border-b border-white/[0.04] hover:bg-foreground/[0.02]"
                  >
                    <td className="px-5 py-3 font-medium">{l.recipient}</td>
                    <td className="px-5 py-3 text-muted-foreground max-w-[280px] truncate">
                      {l.subject}
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-xs text-muted-foreground">{l.template}</span>
                    </td>
                    <td className="px-5 py-3">
                      <Badge
                        variant="outline"
                        className={cn("text-[10px] uppercase", STATUS_STYLE[l.status])}
                        title={l.lastError ?? undefined}
                      >
                        {l.status}
                      </Badge>
                      {l.status === "failed" && l.lastError && (
                        <div className="mt-1 text-[11px] text-red-400/80 max-w-[220px] truncate" title={l.lastError}>
                          {l.lastError}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{l.attempts}</td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {formatGuyanaDateTime(l.createdAt)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {(l.status === "failed" || l.status === "queued") && (
                        <button
                          onClick={() => retryLog.mutate({ id: l.id })}
                          disabled={retryLog.isPending}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline disabled:opacity-50"
                        >
                          <RefreshCw className={cn("h-3 w-3", retryLog.isPending && "animate-spin")} />
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

      <TemplatePreviewDialog
        templateKey={previewKey}
        onClose={() => setPreviewKey(null)}
      />
      <TemplateEditDialog
        template={editTemplate}
        onClose={() => setEditTemplate(null)}
      />
    </Page>
    </>
  );
}

function SmtpConnectionCard({
  settings,
}: {
  settings: EmailSettings | undefined;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const canManage = settings?.canManage ?? false;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    host: "",
    port: "587",
    security: "starttls",
    username: "",
    password: "",
    fromEmail: "",
    fromName: "",
    replyTo: "",
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetEmailSettingsQueryKey() });
  };

  const openEditor = () => {
    setForm({
      host: settings?.host ?? "",
      port: String(settings?.port ?? 587),
      security: settings?.security ?? "starttls",
      username: settings?.username ?? "",
      password: "",
      fromEmail: settings?.fromAddress ?? "",
      fromName: settings?.fromName ?? "",
      replyTo: settings?.replyTo ?? "",
    });
    setEditing(true);
  };

  const save = useUpdateSmtpConnection({
    mutation: {
      onSuccess: () => {
        toast({ title: "Email connection saved" });
        setEditing(false);
        invalidate();
      },
      onError: (e) =>
        toast({
          title: "Could not save",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });
  const remove = useDeleteSmtpConnection({
    mutation: {
      onSuccess: () => {
        toast({ title: "Email connection removed", description: "This dealership will send no email until a new connection is configured." });
        invalidate();
      },
      onError: (e) =>
        toast({
          title: "Could not remove",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });
  const test = useTestSmtpConnection({
    mutation: {
      onSuccess: (res) => {
        if (res.ok) {
          toast({ title: "Connection verified", description: "The SMTP server accepted the login." });
        } else {
          toast({
            title: "Connection failed",
            description: res.error ?? undefined,
            variant: "destructive",
          });
        }
        invalidate();
      },
      onError: (e) =>
        toast({
          title: "Test failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });
  const toggleEnabled = useUpdateSmtpConnection({
    mutation: {
      onSuccess: invalidate,
      onError: (e) =>
        toast({
          title: "Could not update",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const submit = () => {
    const port = Number(form.port);
    if (!form.host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
      toast({ title: "Enter a valid host and port", variant: "destructive" });
      return;
    }
    if (!form.username.trim() || !form.fromEmail.trim()) {
      toast({ title: "Username and sender address are required", variant: "destructive" });
      return;
    }
    if (!settings?.configured && !form.password) {
      toast({ title: "A password is required for the initial setup", variant: "destructive" });
      return;
    }
    save.mutate({
      data: {
        host: form.host.trim(),
        port,
        security: form.security as "ssl" | "starttls" | "none",
        username: form.username.trim(),
        ...(form.password ? { password: form.password } : {}),
        fromEmail: form.fromEmail.trim(),
        fromName: form.fromName.trim() || null,
        replyTo: form.replyTo.trim() || null,
      },
    });
  };

  if (!canManage) {
    return null; // Non-managers see the read-only delivery status card below.
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Dealership email connection
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Every email this dealership sends goes through its own SMTP
            server. Nothing is sent until this is configured.
          </p>
        </div>
        {settings?.configured && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {settings.enabled ? "Sending on" : "Paused"}
            </span>
            <Switch
              checked={settings.enabled}
              disabled={toggleEnabled.isPending}
              onCheckedChange={(v) =>
                toggleEnabled.mutate({ data: { enabled: v } })
              }
            />
          </div>
        )}
      </div>

      {settings?.configured && !editing ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Server</div>
              <div className="font-medium">{settings.host}:{settings.port}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Security</div>
              <div className="font-medium uppercase">{settings.security}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Sender</div>
              <div className="font-medium truncate">{settings.fromAddress}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Health</div>
              <div className={cn("font-medium", settings.lastStatus === "connected" ? "text-emerald-400" : settings.lastStatus === "error" ? "text-red-400" : "text-muted-foreground")}>
                {settings.lastStatus === "connected"
                  ? "Connected"
                  : settings.lastStatus === "error"
                    ? "Error"
                    : "Not tested"}
              </div>
            </div>
          </div>
          {settings.lastStatus === "error" && settings.lastError && (
            <div className="text-xs text-red-400/90">{settings.lastError}</div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={openEditor}>
              <Pencil className="h-3.5 w-3.5" /> Edit connection
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={test.isPending}
              onClick={() => test.mutate()}
            >
              {test.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plug className="h-3.5 w-3.5" />
              )}
              Test connection
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-red-400 hover:text-red-300"
              disabled={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "Remove this email connection? The dealership will send no email until a new one is configured.",
                  )
                ) {
                  remove.mutate();
                }
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          </div>
        </div>
      ) : (
        <>
          {!editing ? (
            <Button size="sm" className="gap-1.5" onClick={openEditor}>
              <Plug className="h-3.5 w-3.5" /> Set up email connection
            </Button>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="space-y-1.5 md:col-span-1">
                  <Label className="text-xs">SMTP host</Label>
                  <Input
                    placeholder="smtp.example.com"
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Port</Label>
                  <Input
                    placeholder="587"
                    inputMode="numeric"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Security</Label>
                  <Select
                    value={form.security}
                    onValueChange={(v) => setForm({ ...form, security: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ssl">SSL/TLS (465)</SelectItem>
                      <SelectItem value="starttls">STARTTLS (587)</SelectItem>
                      <SelectItem value="none">None (not recommended)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Username</Label>
                  <Input
                    placeholder="mailbox@example.com"
                    autoComplete="off"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Password{" "}
                    {settings?.hasPassword && (
                      <span className="text-muted-foreground">(leave blank to keep current)</span>
                    )}
                  </Label>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder={settings?.hasPassword ? "••••••••" : "App password"}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Sender address (From)</Label>
                  <Input
                    placeholder="sales@yourdealership.com"
                    value={form.fromEmail}
                    onChange={(e) => setForm({ ...form, fromEmail: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Sender name (optional)</Label>
                  <Input
                    placeholder="Your Dealership"
                    value={form.fromName}
                    onChange={(e) => setForm({ ...form, fromName: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Reply-To (optional)</Label>
                  <Input
                    placeholder="replies@yourdealership.com"
                    value={form.replyTo}
                    onChange={(e) => setForm({ ...form, replyTo: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={submit} disabled={save.isPending} className="gap-1.5">
                  {save.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  Save connection
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The password is stored encrypted and never shown again. After
                saving, run “Test connection” to verify the login.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TemplateEditDialog({
  template,
  onClose,
}: {
  template: EmailTemplateInfo | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    subject: "",
    heading: "",
    body: "",
    ctaLabel: "",
  });
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (template && loadedKey !== template.key) {
    setForm({
      subject: template.overrideSubject ?? "",
      heading: template.overrideHeading ?? "",
      body: template.overrideBody ?? "",
      ctaLabel: template.overrideCtaLabel ?? "",
    });
    setLoadedKey(template.key);
  }

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListEmailTemplatesQueryKey() });
  };

  const save = useUpdateEmailTemplateOverride({
    mutation: {
      onSuccess: () => {
        toast({ title: "Template customized" });
        invalidate();
        onClose();
      },
      onError: (e) =>
        toast({
          title: "Could not save",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });
  const reset = useDeleteEmailTemplateOverride({
    mutation: {
      onSuccess: () => {
        toast({ title: "Template reset to default" });
        invalidate();
        onClose();
      },
      onError: (e) =>
        toast({
          title: "Could not reset",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  if (!template) return null;
  return (
    <Dialog open={!!template} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Customize “{template.label}”</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border border-white/10 bg-foreground/[0.03] p-3 text-xs text-muted-foreground">
            Leave a field blank to keep the default. You can insert these
            merge fields:{" "}
            {template.mergeFields.map((f) => (
              <code key={f} className="mx-0.5 rounded bg-foreground/10 px-1 py-0.5 text-[11px] text-foreground">
                {`{{${f}}}`}
              </code>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Subject</Label>
            <Input
              placeholder={template.defaultSubject}
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Heading</Label>
            <Input
              placeholder={template.defaultHeading}
              value={form.heading}
              onChange={(e) => setForm({ ...form, heading: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Body</Label>
            <Textarea
              rows={6}
              placeholder={template.defaultBody.replace(/<[^>]+>/g, "")}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          </div>
          {template.defaultCtaLabel && (
            <div className="space-y-1.5">
              <Label className="text-xs">Button label</Label>
              <Input
                placeholder={template.defaultCtaLabel}
                value={form.ctaLabel}
                onChange={(e) => setForm({ ...form, ctaLabel: e.target.value })}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              disabled={save.isPending}
              className="gap-1.5"
              onClick={() =>
                save.mutate({
                  key: template.key,
                  data: {
                    subject: form.subject.trim() || null,
                    heading: form.heading.trim() || null,
                    body: form.body.trim() || null,
                    ctaLabel: form.ctaLabel.trim() || null,
                    enabled: true,
                  },
                })
              }
            >
              {save.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
              Save
            </Button>
            {template.hasOverride && (
              <Button
                size="sm"
                variant="outline"
                disabled={reset.isPending}
                className="gap-1.5"
                onClick={() => reset.mutate({ key: template.key })}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Reset to default
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const CADENCES = [
  { value: "daily", label: "Daily", hint: "Every morning, next 3 days" },
  { value: "weekly", label: "Weekly", hint: "Mondays, next 7 days" },
  { value: "off", label: "Off", hint: "No summary emails" },
] as const;

function ServiceSummaryCadenceCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings } = useGetServiceSettings();
  const update = useUpdateServiceSettings({
    mutation: {
      onSuccess: () => {
        toast({ title: "Summary cadence saved" });
        qc.invalidateQueries({ queryKey: getGetServiceSettingsQueryKey() });
      },
      onError: (e) =>
        toast({
          title: "Could not save",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });
  const current = settings?.summaryCadence ?? "daily";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
      <div>
        <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
          Scheduled services summary
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Emails service management a digest of the upcoming days' booked
          services.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {CADENCES.map((c) => (
          <button
            key={c.value}
            onClick={() =>
              c.value !== current &&
              update.mutate({ data: { summaryCadence: c.value } })
            }
            disabled={update.isPending}
            className={cn(
              "rounded-xl border px-4 py-2.5 text-left transition-colors disabled:opacity-60",
              current === c.value
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06]",
            )}
          >
            <div className="text-sm font-semibold">{c.label}</div>
            <div className="text-[11px] text-muted-foreground">{c.hint}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function LeadSourceReportCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings } = useGetServiceSettings();
  const update = useUpdateServiceSettings({
    mutation: {
      onSuccess: (next) => {
        toast({
          title: next.leadSourceReportEnabled
            ? "Daily lead source report enabled"
            : "Daily lead source report disabled",
        });
        qc.invalidateQueries({ queryKey: getGetServiceSettingsQueryKey() });
      },
      onError: (e) =>
        toast({
          title: "Could not save",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });
  const enabled = settings?.leadSourceReportEnabled ?? false;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Daily lead source report
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Emails General Managers a breakdown of yesterday's new leads by
            source every morning around 6:00 AM dealership time.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={!settings || update.isPending}
          onCheckedChange={(v) =>
            update.mutate({ data: { leadSourceReportEnabled: v } })
          }
          aria-label="Toggle daily lead source report"
        />
      </div>
    </div>
  );
}

function TemplatePreviewDialog({
  templateKey,
  onClose,
}: {
  templateKey: string | null;
  onClose: () => void;
}) {
  const { data, isLoading } = usePreviewEmailTemplate(templateKey ?? "", {
    query: {
      queryKey: ["emailTemplatePreview", templateKey],
      enabled: !!templateKey,
    },
  });

  return (
    <Dialog open={!!templateKey} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{data?.subject ?? "Template preview"}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : data ? (
          <iframe
            title="Email preview"
            srcDoc={data.html}
            className="w-full h-[520px] rounded-xl border border-white/10 bg-black"
            sandbox=""
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
