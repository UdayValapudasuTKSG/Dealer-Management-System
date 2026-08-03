import { useState } from "react";
import { motion } from "framer-motion";
import {
  useGetLeadAgentBrief,
  useSendLeadWhatsappReply,
  useSendLeadOutreach,
  useNotifyLeadOwner,
} from "@workspace/api-client-react";
import {
  Bot,
  RefreshCw,
  AlertCircle,
  Copy,
  Check,
  Zap,
  Send,
  Mail,
  BellRing,
  Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const RISK_STYLE: Record<string, string> = {
  low: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
  medium: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  high: "bg-primary/15 text-primary ring-primary/40",
};

const PRIORITY_DOT: Record<string, string> = {
  high: "bg-primary",
  medium: "bg-amber-400",
  low: "bg-muted-foreground/50",
};

/** Agentic intelligence panel: AI next-best-actions + draft follow-up with one-click sends. */
export function AgentBriefPanel({
  leadId,
  leadPhone,
  leadEmail,
  leadSource,
  hasOwner,
  compact,
}: {
  leadId: number;
  leadPhone?: string | null;
  leadEmail?: string | null;
  leadSource?: string;
  hasOwner?: boolean;
  compact?: boolean;
}) {
  const brief = useGetLeadAgentBrief(leadId);
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const sendWhatsapp = useSendLeadWhatsappReply({
    mutation: {
      onSuccess: () =>
        toast({ title: "WhatsApp message sent to the customer" }),
      onError: () =>
        toast({
          title: "Could not send via WhatsApp",
          description:
            "The 24-hour reply window may be closed. Use the wa.me link instead.",
          variant: "destructive",
        }),
    },
  });
  const outreach = useSendLeadOutreach({
    mutation: {
      onSuccess: (res) =>
        toast({
          title: `Outreach queued via ${res.channel === "whatsapp" ? "WhatsApp" : "email"}`,
          description:
            "The message is in the outbox and will be delivered automatically.",
        }),
      onError: (e) =>
        toast({
          title: "Could not queue the outreach",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });
  const sendEmail = useSendLeadOutreach({
    mutation: {
      onSuccess: () =>
        toast({
          title: "Email queued",
          description:
            "The follow-up email is in the outbox and will be delivered automatically.",
        }),
      onError: (e) =>
        toast({
          title: "Could not send the email",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });
  const notifyOwner = useNotifyLeadOwner({
    mutation: {
      onSuccess: () =>
        toast({ title: "Owner notified", description: "The recommended action was pushed to the lead owner's notifications." }),
      onError: () =>
        toast({ title: "Could not notify the owner", variant: "destructive" }),
    },
  });

  const copyDraft = async () => {
    if (!brief.data) return;
    await navigator.clipboard.writeText(brief.data.draftMessage);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const draft = brief.data?.draftMessage ?? "";
  const inAppWhatsapp = leadSource === "whatsapp";
  const waHref = leadPhone
    ? `https://wa.me/${leadPhone.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(draft)}`
    : null;

  return (
    <div className="rounded-2xl border border-primary/25 bg-gradient-to-b from-primary/[0.07] to-transparent p-5 relative overflow-hidden">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-[0_0_12px_rgba(229,9,20,0.45)]">
          <Bot className="w-3.5 h-3.5" />
        </span>
        <span className="text-sm font-semibold tracking-tight">
          AURA Recommends
        </span>
        <button
          onClick={() => brief.refetch()}
          disabled={brief.isFetching}
          className="ml-auto w-7 h-7 rounded-full bg-foreground/[0.05] hover:bg-foreground/[0.1] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          aria-label="Refresh agent brief"
        >
          <RefreshCw
            className={cn("w-3.5 h-3.5", brief.isFetching && "animate-spin")}
          />
        </button>
      </div>

      {brief.isLoading ? (
        <div className="space-y-2.5 py-1">
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              className="h-3.5 rounded bg-foreground/[0.06]"
              style={{ width: `${85 - i * 18}%` }}
              animate={{ opacity: [0.4, 0.9, 0.4] }}
              transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.2 }}
            />
          ))}
          <p className="text-xs text-muted-foreground pt-1">
            Analysing this lead…
          </p>
        </div>
      ) : brief.isError || !brief.data ? (
        <div className="text-sm text-muted-foreground flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            The agent is unavailable right now.{" "}
            <button
              onClick={() => brief.refetch()}
              className="text-primary hover:underline"
            >
              Retry
            </button>
          </span>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-2">
            <span
              className={cn(
                "text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full ring-1 shrink-0",
                RISK_STYLE[brief.data.riskLevel] ?? RISK_STYLE.medium,
              )}
            >
              {brief.data.riskLevel} risk
            </span>
            {!brief.data.agentDisabled && (
              <span
                className={cn(
                  "text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full ring-1 shrink-0",
                  brief.data.routedToHuman
                    ? "bg-amber-500/15 text-amber-400 ring-amber-500/30"
                    : "bg-foreground/[0.05] text-muted-foreground ring-white/10",
                )}
              >
                {Math.round(brief.data.confidence * 100)}% confidence
              </span>
            )}
            {brief.data.agentDisabled && (
              <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full ring-1 shrink-0 bg-foreground/[0.05] text-muted-foreground ring-white/10">
                AI paused
              </span>
            )}
          </div>
          <p className="text-sm text-foreground/90 leading-relaxed -mt-2">
            {brief.data.headline}
          </p>

          <ul className="space-y-2.5">
            {brief.data.actions
              .slice(0, compact ? 2 : undefined)
              .map((a, i) => (
                <motion.li
                  key={a.title}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.08 }}
                  className="flex items-start gap-2.5"
                >
                  <span
                    className={cn(
                      "mt-1.5 w-1.5 h-1.5 rounded-full shrink-0",
                      PRIORITY_DOT[a.priority] ?? PRIORITY_DOT.low,
                    )}
                  />
                  <div>
                    <div className="text-sm font-medium leading-tight">
                      {a.title}
                    </div>
                    <div className="text-xs text-muted-foreground leading-relaxed mt-0.5">
                      {a.detail}
                    </div>
                  </div>
                </motion.li>
              ))}
          </ul>

          {brief.data.agentDisabled || brief.data.routedToHuman ? (
            <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-3.5">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
                <AlertCircle className="w-3 h-3 text-amber-400" />
                {brief.data.agentDisabled
                  ? "AI drafting is paused"
                  : "Routed to you"}
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {brief.data.agentDisabled
                  ? "The Sales agent is paused for this dealership — write the follow-up yourself from the Correspondence tab."
                  : "The agent doesn't have enough verified context to draft a message it trusts — please write this follow-up personally."}
              </p>
            </div>
          ) : (
          <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-3.5">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
              <Zap className="w-3 h-3 text-primary" />
              Draft follow-up
            </div>
            <p className="text-xs text-foreground/85 leading-relaxed whitespace-pre-wrap">
              {draft}
            </p>
            <div className="flex items-center flex-wrap gap-2 mt-3">
              {(leadPhone || leadEmail) && (
                <button
                  onClick={() =>
                    outreach.mutate({ id: leadId, data: { message: draft } })
                  }
                  disabled={outreach.isPending || !draft}
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {outreach.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Zap className="w-3 h-3" />
                  )}
                  Approve &amp; Send
                </button>
              )}
              {inAppWhatsapp ? (
                <button
                  onClick={() =>
                    sendWhatsapp.mutate({ id: leadId, data: { text: draft } })
                  }
                  disabled={sendWhatsapp.isPending || !draft}
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-full bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
                >
                  {sendWhatsapp.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Send className="w-3 h-3" />
                  )}
                  Send via WhatsApp
                </button>
              ) : waHref ? (
                <a
                  href={waHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-full bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                >
                  <Send className="w-3 h-3" />
                  Send via WhatsApp
                </a>
              ) : null}
              {leadEmail && (
                <button
                  onClick={() =>
                    sendEmail.mutate({
                      id: leadId,
                      data: {
                        message: draft,
                        channel: "email",
                        subject: "Following up on your enquiry",
                      },
                    })
                  }
                  disabled={sendEmail.isPending || !draft}
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-full bg-foreground/[0.06] text-foreground/80 ring-1 ring-white/10 hover:bg-foreground/[0.1] transition-colors disabled:opacity-50"
                >
                  {sendEmail.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Mail className="w-3 h-3" />
                  )}
                  Send email
                </button>
              )}
              {hasOwner && (
                <button
                  onClick={() =>
                    notifyOwner.mutate({ id: leadId, data: { message: draft } })
                  }
                  disabled={notifyOwner.isPending || !draft}
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-full bg-foreground/[0.06] text-foreground/80 ring-1 ring-white/10 hover:bg-foreground/[0.1] transition-colors disabled:opacity-50"
                >
                  {notifyOwner.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <BellRing className="w-3 h-3" />
                  )}
                  Push to owner
                </button>
              )}
              <button
                onClick={copyDraft}
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:underline"
              >
                {copied ? (
                  <Check className="w-3 h-3" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          )}
        </div>
      )}
    </div>
  );
}
