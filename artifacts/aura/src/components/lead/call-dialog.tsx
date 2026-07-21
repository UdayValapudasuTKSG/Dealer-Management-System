import { useState } from "react";
import {
  useCreateLeadCall,
  useSuggestCallSentiment,
  getGetLeadTimelineQueryKey,
  getListLeadCallsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Phone, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Direction = "outbound" | "inbound";
type CallStatus = "completed" | "no_answer" | "busy" | "voicemail";
type Sentiment = "positive" | "neutral" | "negative";

const STATUS_OPTIONS: { value: CallStatus; label: string }[] = [
  { value: "completed", label: "Completed" },
  { value: "no_answer", label: "No answer" },
  { value: "busy", label: "Busy" },
  { value: "voicemail", label: "Voicemail" },
];

const SENTIMENT_STYLE: Record<Sentiment, string> = {
  positive: "bg-emerald-500/15 text-emerald-500 ring-emerald-500/30",
  neutral: "bg-foreground/[0.06] text-foreground/70 ring-white/15",
  negative: "bg-primary/15 text-primary ring-primary/30",
};

export function CallDialog({
  leadId,
  leadName,
  leadPhone,
  open,
  onOpenChange,
}: {
  leadId: number;
  leadName: string;
  leadPhone: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createCall = useCreateLeadCall();
  const suggest = useSuggestCallSentiment();

  const [direction, setDirection] = useState<Direction>("outbound");
  const [status, setStatus] = useState<CallStatus>("completed");
  const [minutes, setMinutes] = useState("");
  const [sentiment, setSentiment] = useState<Sentiment>("neutral");
  const [notes, setNotes] = useState("");
  const [rationale, setRationale] = useState<string | null>(null);

  const reset = () => {
    setDirection("outbound");
    setStatus("completed");
    setMinutes("");
    setSentiment("neutral");
    setNotes("");
    setRationale(null);
  };

  const suggestSentiment = async () => {
    try {
      const result = await suggest.mutateAsync({
        id: leadId,
        data: { notes: notes.trim() },
      });
      setSentiment(result.sentiment);
      setRationale(result.rationale ?? null);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      toast({
        title: "Suggestion unavailable",
        description:
          status === 409
            ? "The Sales agent is paused — pick the sentiment manually or resume it in AI Agents."
            : "The AI service could not read these notes. Pick the sentiment manually.",
        variant: "destructive",
      });
    }
  };

  const logCall = async () => {
    const mins = minutes.trim() === "" ? null : Number(minutes);
    try {
      await createCall.mutateAsync({
        id: leadId,
        data: {
          direction,
          status,
          sentiment,
          ...(mins != null && Number.isFinite(mins) && mins >= 0
            ? { durationSeconds: Math.round(mins * 60) }
            : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
      queryClient.invalidateQueries({
        queryKey: getGetLeadTimelineQueryKey(leadId),
      });
      queryClient.invalidateQueries({
        queryKey: getListLeadCallsQueryKey(leadId),
      });
      toast({
        title: "Call logged",
        description: `Outcome and sentiment saved to ${leadName}'s record.`,
      });
      reset();
      onOpenChange(false);
    } catch {
      toast({
        title: "Could not log the call",
        description: "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="w-4 h-4 text-primary" />
            Call {leadName}
          </DialogTitle>
          <DialogDescription>
            {leadPhone ? (
              <>
                Dial{" "}
                <a href={`tel:${leadPhone}`} className="text-primary hover:underline">
                  {leadPhone}
                </a>{" "}
                and log the outcome here. One record is saved per call.
              </>
            ) : (
              "No phone number on file — log the call outcome here."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Direction
              </div>
              <div className="flex gap-1.5">
                {(["outbound", "inbound"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirection(d)}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-xs font-semibold capitalize ring-1 transition-colors",
                      direction === d
                        ? "bg-primary text-white ring-primary"
                        : "bg-foreground/[0.04] text-muted-foreground ring-white/10 hover:text-foreground",
                    )}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Duration (min)
              </div>
              <Input
                type="number"
                min={0}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                placeholder="e.g. 6"
              />
            </div>
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Outcome
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setStatus(o.value)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors",
                    status === o.value
                      ? "bg-primary text-white ring-primary"
                      : "bg-foreground/[0.04] text-muted-foreground ring-white/10 hover:text-foreground",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Notes
            </div>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What was discussed? Objections, next steps…"
              rows={3}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Customer sentiment
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-primary hover:text-primary"
                disabled={notes.trim().length < 5 || suggest.isPending}
                onClick={suggestSentiment}
              >
                {suggest.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                AI suggest
              </Button>
            </div>
            <div className="flex gap-1.5">
              {(["positive", "neutral", "negative"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setSentiment(s);
                    setRationale(null);
                  }}
                  className={cn(
                    "rounded-full px-3.5 py-1.5 text-xs font-semibold capitalize ring-1 transition-colors",
                    sentiment === s
                      ? SENTIMENT_STYLE[s]
                      : "bg-transparent text-muted-foreground ring-white/10 hover:text-foreground",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            {rationale && (
              <p className="text-xs text-muted-foreground mt-2">
                AI: {rationale}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createCall.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={logCall}
            disabled={createCall.isPending}
            className="gap-1.5"
          >
            {createCall.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Phone className="w-4 h-4" />
            )}
            Log call
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
