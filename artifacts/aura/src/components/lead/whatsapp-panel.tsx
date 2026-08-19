import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLeadWhatsappThread,
  useSendLeadWhatsappReply,
  getGetLeadWhatsappThreadQueryKey,
  getGetLeadTimelineQueryKey,
  useGetDealWhatsappThread,
  useSendDealWhatsappReply,
  getGetDealWhatsappThreadQueryKey,
} from "@workspace/api-client-react";
import type { WhatsappThread } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCheck,
  Clock,
  Loader2,
  MessageSquare,
  Send,
  User,
} from "lucide-react";
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

function DeliveryStatus({
  status,
  error,
}: {
  status: string;
  error?: string | null;
}) {
  let label = status;
  let icon = <Clock className="w-3 h-3" />;
  let className = "text-muted-foreground";
  switch (status) {
    case "queued":
      label = "Queued";
      break;
    case "accepted":
      label = "Accepted";
      break;
    case "delivered":
      label = "Delivered";
      icon = <Check className="w-3 h-3" />;
      break;
    case "read":
      label = "Read";
      icon = <CheckCheck className="w-3 h-3" />;
      className = "text-blue-400";
      break;
    case "failed":
      label = "Failed";
      icon = <AlertCircle className="w-3 h-3" />;
      className = "text-red-400";
      break;
    case "cancelled":
      label = "Cancelled";
      icon = <AlertCircle className="w-3 h-3" />;
      className = "text-red-400";
      break;
  }
  return (
    <span
      className={cn("inline-flex items-center gap-1", className)}
      title={error ?? label}
      data-testid={`status-${status}`}
    >
      {icon}
      <span>{label}</span>
    </span>
  );
}

function WhatsappThreadUI({
  thread,
  isLoading,
  canReply,
  onSend,
  isSending,
  noMessagesText = "No WhatsApp conversation recorded yet.",
}: {
  thread: WhatsappThread | undefined;
  isLoading: boolean;
  canReply: boolean;
  onSend: (text: string) => Promise<boolean>;
  isSending: boolean;
  noMessagesText?: string;
}) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = thread?.messages ?? [];

  useEffect(() => {
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
        <p className="text-sm text-muted-foreground mt-3">{noMessagesText}</p>
        {thread?.replyBlockedReason && (
          <p
            className="text-xs text-muted-foreground mt-2"
            data-testid="reply-blocked-reason"
          >
            {thread.replyBlockedReason}
          </p>
        )}
      </div>
    );
  }

  let lastDay = "";

  return (
    <div className="space-y-4 flex flex-col h-full min-h-[300px]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto pr-1 space-y-2">
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
                  <span className="text-[11px] text-muted-foreground">{day}</span>
                  <div className="h-px flex-1 bg-white/10" />
                </div>
              )}
              <div className={cn("flex items-end gap-2", inbound ? "justify-start" : "justify-end")}>
                {inbound && (
                  <span className="w-7 h-7 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                    <User className="w-3.5 h-3.5" />
                  </span>
                )}
                <div
                  className={cn(
                    "max-w-[78%] rounded-2xl px-4 py-2.5 flex flex-col",
                    inbound
                      ? "bg-foreground/[0.05] border border-white/10 rounded-bl-sm"
                      : "bg-primary/15 border border-primary/25 rounded-br-sm"
                  )}
                >
                  <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
                  <div className="flex items-center justify-end gap-1.5 mt-1">
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      {!inbound && (m.actor ?? "AURA")}
                      {!inbound && " · "}
                      {created.toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      {!inbound && (
                        <span className="ml-1" data-testid="delivery-status">
                          <DeliveryStatus
                            status={m.deliveryStatus}
                            error={m.deliveryError}
                          />
                        </span>
                      )}
                    </span>
                  </div>
                  {m.deliveryError && !inbound && (
                    <p className="text-[10px] text-red-400 mt-1">{m.deliveryError}</p>
                  )}
                </div>
                {!inbound && (
                  <span
                    className={cn(
                      "w-7 h-7 rounded-full flex items-center justify-center shrink-0",
                      staff ? "bg-foreground/[0.06] text-muted-foreground" : "bg-primary/15 text-primary"
                    )}
                  >
                    {staff ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {canReply && thread?.canReply ? (
        <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-4 shrink-0 mt-auto">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Reply on WhatsApp — the customer receives this on their phone…"
            className="bg-transparent border-white/10 resize-none min-h-[64px]"
            data-testid="chat-composer"
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
              disabled={!text.trim() || isSending}
              onClick={async () => {
                const sent = await onSend(text.trim());
                if (sent) setText("");
              }}
              data-testid="button-send-reply"
            >
              {isSending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              Send
            </Button>
          </div>
        </div>
      ) : thread?.replyBlockedReason ? (
        <div className="shrink-0 mt-auto pt-4">
          <p className="text-[12px] text-muted-foreground text-center" data-testid="reply-blocked-reason">
            {thread.replyBlockedReason}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function WhatsappPanel({ leadId, canReply }: { leadId: number; canReply: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: thread, isLoading } = useGetLeadWhatsappThread(leadId, {
    query: {
      queryKey: getGetLeadWhatsappThreadQueryKey(leadId),
      refetchInterval: 15000,
    },
  });

  const sendReply = useSendLeadWhatsappReply({
    mutation: {
      onSuccess: () => {
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

  return (
    <WhatsappThreadUI
      thread={thread}
      isLoading={isLoading}
      canReply={canReply}
      isSending={sendReply.isPending}
      onSend={async (text) => {
        try {
          await sendReply.mutateAsync({ id: leadId, data: { text } });
          return true;
        } catch {
          return false;
        }
      }}
      noMessagesText="No WhatsApp conversation recorded for this lead yet."
    />
  );
}

export function DealWhatsappPanel({ dealId, canReply }: { dealId: number; canReply: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: thread, isLoading } = useGetDealWhatsappThread(dealId, {
    query: {
      queryKey: getGetDealWhatsappThreadQueryKey(dealId),
      refetchInterval: 15000,
    },
  });

  const sendReply = useSendDealWhatsappReply({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: getGetDealWhatsappThreadQueryKey(dealId),
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

  return (
    <WhatsappThreadUI
      thread={thread}
      isLoading={isLoading}
      canReply={canReply}
      isSending={sendReply.isPending}
      onSend={async (text) => {
        try {
          await sendReply.mutateAsync({ id: dealId, data: { text } });
          return true;
        } catch {
          return false;
        }
      }}
      noMessagesText="No WhatsApp conversation recorded for this deal yet."
    />
  );
}
