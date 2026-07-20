import { useState } from "react";
import { motion } from "framer-motion";
import { useGetLeadAgentBrief } from "@workspace/api-client-react";
import {
  Bot,
  RefreshCw,
  AlertCircle,
  Copy,
  Check,
  Zap,
} from "lucide-react";
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

/** Agentic intelligence panel: AI next-best-actions + draft follow-up. */
export function AgentBriefPanel({
  leadId,
  leadPhone,
}: {
  leadId: number;
  leadPhone?: string | null;
}) {
  const brief = useGetLeadAgentBrief(leadId);
  const [copied, setCopied] = useState(false);

  const copyDraft = async () => {
    if (!brief.data) return;
    await navigator.clipboard.writeText(brief.data.draftMessage);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="rounded-2xl border border-primary/25 bg-gradient-to-b from-primary/[0.07] to-transparent p-5 relative overflow-hidden">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-[0_0_12px_rgba(229,9,20,0.45)]">
          <Bot className="w-3.5 h-3.5" />
        </span>
        <span className="text-sm font-semibold tracking-tight">
          AURA Agent
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
          </div>
          <p className="text-sm text-foreground/90 leading-relaxed -mt-2">
            {brief.data.headline}
          </p>

          <ul className="space-y-2.5">
            {brief.data.actions.map((a, i) => (
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

          <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-3.5">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
              <Zap className="w-3 h-3 text-primary" />
              Draft follow-up
            </div>
            <p className="text-xs text-foreground/85 leading-relaxed whitespace-pre-wrap">
              {brief.data.draftMessage}
            </p>
            <div className="flex items-center gap-2 mt-2.5">
              <button
                onClick={copyDraft}
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:underline"
              >
                {copied ? (
                  <Check className="w-3 h-3" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                {copied ? "Copied" : "Copy message"}
              </button>
              {leadPhone && (
                <a
                  href={`https://wa.me/${leadPhone.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(brief.data.draftMessage)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400 hover:underline"
                >
                  Send via WhatsApp
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
