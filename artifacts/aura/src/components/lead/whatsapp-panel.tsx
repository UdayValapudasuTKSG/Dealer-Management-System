import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLeadWhatsappThread,
  useSendLeadWhatsappReply,
  getGetLeadWhatsappThreadQueryKey,
  getGetLeadTimelineQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Bot, Loader2, MessageSquare, Send, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

export function WhatsappPanel({
  leadId,
  canReply,
}: {
  leadId: number;
  canReply: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: thread, isLoading } = useGetLeadWhatsappThread(leadId, {
    query: {
      queryKey: getGetLeadWhatsappThreadQueryKey(leadId),
      refetchInterval: 15000,
    },
  });

  const sendReply = useSendLeadWhatsappReply({
    mutation: {
      onSuccess: () => {
        setText("");
        qc.invalidateQueries({
          queryKey: getGetLeadWhatsappThreadQueryKey(leadId),
        });
        qc.invalidateQueries({
          queryKey: getGetLeadTimelineQueryKey(leadId),
        });
      },
      onError: (err: unknown) => {
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data
            ?.error ?? "The message could not be sent.";
        toast({
          title: "Reply not sent",
          description: msg,
          variant: "destructive",
        });
      },
    },
  });

  const messages = thread?.messages ?? [];

  useEffect(() => {
    // Keep the newest message in view.
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="text-center py-14">
        <MessageSquare className="w-8 h-8 mx-auto text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground mt-3">
          No WhatsApp conversation recorded for this lead yet.
        </p>
      </div>
    );
  }

  let lastDay = "";

  return (
    <div className="space-y-4">
      <div
        ref={scrollRef}
        className="max-h-[520px] overflow-y-auto pr-1 space-y-2"
      >
        {messages.map((m) => {
          const created = new Date(m.createdAt);
          const day = dayLabel(created);
          const showDay = day !== lastDay;
          lastDay = day;
          const inbound = m.direction === "in";
          const staff = !inbound && m.actor && m.actor !== "AURA WhatsApp Bot";
          return (
            <div key={m.id}>
              {showDay && (
                <div className="flex items-center gap-3 my-4">
                  <div className="h-px flex-1 bg-white/10" />
                  <span className="text-[11px] text-muted-foreground">
                    {day}
                  </span>
                  <div className="h-px flex-1 bg-white/10" />
                </div>
              )}
              <div
                className={cn(
                  "flex items-end gap-2",
                  inbound ? "justify-start" : "justify-end",
                )}
              >
                {inbound && (
                  <span className="w-7 h-7 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                    <User className="w-3.5 h-3.5" />
                  </span>
                )}
                <div
                  className={cn(
                    "max-w-[78%] rounded-2xl px-4 py-2.5",
                    inbound
                      ? "bg-foreground/[0.05] border border-white/10 rounded-bl-sm"
                      : "bg-primary/15 border border-primary/25 rounded-br-sm",
                  )}
                >
                  <p className="text-sm whitespace-pre-wrap break-words">
                    {m.body}
                  </p>
                  <div className="flex items-center justify-end gap-1.5 mt-1">
                    <span className="text-[10px] text-muted-foreground">
                      {!inbound && (m.actor ?? "AURA")}
                      {!inbound && " · "}
                      {created.toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                </div>
                {!inbound && (
                  <span
                    className={cn(
                      "w-7 h-7 rounded-full flex items-center justify-center shrink-0",
                      staff
                        ? "bg-foreground/[0.06] text-muted-foreground"
                        : "bg-primary/15 text-primary",
                    )}
                  >
                    {staff ? (
                      <User className="w-3.5 h-3.5" />
                    ) : (
                      <Bot className="w-3.5 h-3.5" />
                    )}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {canReply && thread?.canReply ? (
        <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-4">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Reply on WhatsApp — the customer receives this on their phone…"
            className="bg-transparent border-white/10 resize-none min-h-[64px]"
          />
          <div className="flex items-center justify-between mt-3">
            <span className="text-[11px] text-muted-foreground">
              {thread?.windowExpiresAt
                ? `Reply window open until ${new Date(thread.windowExpiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
                : null}
            </span>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!text.trim() || sendReply.isPending}
              onClick={() =>
                sendReply.mutate({ id: leadId, data: { text: text.trim() } })
              }
            >
              {sendReply.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              Send
            </Button>
          </div>
        </div>
      ) : thread?.replyBlockedReason ? (
        <p className="text-[12px] text-muted-foreground text-center">
          {thread.replyBlockedReason}
        </p>
      ) : null}
    </div>
  );
}
