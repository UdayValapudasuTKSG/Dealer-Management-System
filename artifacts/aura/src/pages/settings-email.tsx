import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEmailSettings,
  useSendTestEmail,
  useListEmailTemplates,
  usePreviewEmailTemplate,
  useListEmailLogs,
  getListEmailLogsQueryKey,
  getGetEmailSettingsQueryKey,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
} from "lucide-react";

const STATUS_STYLE: Record<string, string> = {
  sent: "border-emerald-500/40 text-emerald-400",
  queued: "border-amber-500/40 text-amber-400",
  sending: "border-sky-500/40 text-sky-400",
  failed: "border-red-500/50 text-red-400",
};

export default function SettingsEmail() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings } = useGetEmailSettings();
  const { data: templates } = useListEmailTemplates();
  const { data: logs, isLoading: logsLoading } = useListEmailLogs();
  const [testTo, setTestTo] = useState("");
  const [previewKey, setPreviewKey] = useState<string | null>(null);

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

  const refreshLogs = () => {
    qc.invalidateQueries({ queryKey: getListEmailLogsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetEmailSettingsQueryKey() });
  };

  return (
    <Page className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Mail className="h-6 w-6 text-primary" /> Email Engine
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Gmail SMTP delivery, branded templates and the outbound queue.
        </p>
      </div>

      {/* Status + test send */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Configuration
          </div>
          <div className="flex items-center gap-3">
            {settings?.configured ? (
              <CheckCircle2 className="h-8 w-8 text-emerald-400" />
            ) : (
              <XCircle className="h-8 w-8 text-red-400" />
            )}
            <div>
              <div className="font-semibold">
                {settings?.configured ? "SMTP connected" : "SMTP not configured"}
              </div>
              <div className="text-xs text-muted-foreground">
                {settings?.configured
                  ? `Sending as ${settings.fromAddress}`
                  : "Add GMAIL_USER and GMAIL_APP_PASSWORD secrets to enable delivery."}
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

      {/* Templates */}
      <div className="space-y-3">
        <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
          Templates
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {(templates ?? []).map((t) => (
            <button
              key={t.key}
              onClick={() => setPreviewKey(t.key)}
              className="text-left rounded-xl border border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06] p-4 transition-colors group"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{t.label}</span>
                <Eye className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary transition-colors" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Logs */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Delivery Log
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
              No emails sent yet.
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
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{l.attempts}</td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {new Date(l.createdAt).toLocaleString()}
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
    </Page>
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
