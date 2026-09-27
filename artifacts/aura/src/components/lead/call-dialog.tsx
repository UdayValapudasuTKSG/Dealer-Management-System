import { useEffect, useRef, useState } from "react";
import {
  useCreateLeadCall,
  useUpdateLeadCall,
  useSuggestCallSentiment,
  useGetTelephonyConfig,
  useCreateTelephonyToken,
  getGetLeadQueryKey,
  getGetLeadReviewQueryKey,
  getGetLeadTimelineQueryKey,
  getListLeadsQueryKey,
  getListLeadCallsQueryKey,
  listLeadCalls,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Device, type Call } from "@twilio/voice-sdk";
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
import { Loader2, Phone, PhoneCall, PhoneOff, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  useCallCentreDisposition,
  dispositionErrorMessage,
  type CallCentreOutcome,
} from "@/hooks/use-call-centre";
import { cn } from "@/lib/utils";

type Direction = "outbound" | "inbound";
type CallStatus =
  | "completed"
  | "no_answer"
  | "busy"
  | "voicemail"
  | "wrong_number"
  | "callback";
type Sentiment = "positive" | "neutral" | "negative";
type SentimentChoice = Sentiment | "auto";
type LiveState = "idle" | "connecting" | "ringing" | "in_call" | "ended";

const STATUS_OPTIONS: { value: CallStatus; label: string }[] = [
  { value: "completed", label: "Connected" },
  { value: "no_answer", label: "No answer" },
  { value: "busy", label: "Busy" },
  { value: "voicemail", label: "Voicemail" },
  { value: "wrong_number", label: "Wrong number" },
  { value: "callback", label: "Callback requested" },
];

const CC_OUTCOMES: { value: CallCentreOutcome; label: string; hint: string }[] = [
  {
    value: "interested",
    label: "Interested",
    hint: "Transferred automatically to the next Sales Advisor in the round-robin.",
  },
  {
    value: "follow_up",
    label: "Follow up",
    hint: "Stays with you. Pick the follow-up date and note what was agreed.",
  },
  {
    value: "not_interested",
    label: "Not interested",
    hint: "The lead is closed as lost.",
  },
];

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SENTIMENT_STYLE: Record<Sentiment, string> = {
  positive: "bg-emerald-500/15 text-emerald-500 ring-emerald-500/30",
  neutral: "bg-foreground/[0.06] text-foreground/70 ring-white/15",
  negative: "bg-primary/15 text-primary ring-primary/30",
};

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function CallDialog({
  leadId,
  leadName,
  leadPhone,
  open,
  onOpenChange,
  callCentre = false,
}: {
  leadId: number;
  leadName: string;
  leadPhone: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** First-call qualification mode for leads held by the call centre. */
  callCentre?: boolean;
}) {
  const disposition = useCallCentreDisposition(leadId);
  const [ccOutcome, setCcOutcome] = useState<CallCentreOutcome | null>(null);
  const [ccFollowUp, setCcFollowUp] = useState("");
  const submittingRef = useRef(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createCall = useCreateLeadCall();
  const updateCall = useUpdateLeadCall();
  const suggest = useSuggestCallSentiment();
  const mintToken = useCreateTelephonyToken();
  const telephony = useGetTelephonyConfig();
  const browserCalling =
    telephony.data?.browserCallingEnabled === true && !!leadPhone;

  const [direction, setDirection] = useState<Direction>("outbound");
  const [status, setStatus] = useState<CallStatus>("completed");
  const [minutes, setMinutes] = useState("");
  const [sentiment, setSentiment] = useState<SentimentChoice>("auto");
  const [callbackAt, setCallbackAt] = useState("");
  const [notes, setNotes] = useState("");
  const [rationale, setRationale] = useState<string | null>(null);

  // Live browser-call state (Twilio Voice SDK).
  const [liveState, setLiveState] = useState<LiveState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [liveCallLogId, setLiveCallLogId] = useState<number | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const teardownDevice = () => {
    stopTimer();
    callRef.current?.disconnect();
    callRef.current = null;
    deviceRef.current?.destroy();
    deviceRef.current = null;
  };

  useEffect(() => {
    // Kill the audio session when the dialog closes or unmounts.
    if (!open) teardownDevice();
    return teardownDevice;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const reset = () => {
    setDirection("outbound");
    setStatus("completed");
    setMinutes("");
    setSentiment("auto");
    setCallbackAt("");
    setNotes("");
    setRationale(null);
    setCcOutcome(null);
    setCcFollowUp("");
    setLiveState("idle");
    setElapsed(0);
    setLiveCallLogId(null);
  };

  const refreshCallData = () => {
    queryClient.invalidateQueries({
      queryKey: getGetLeadQueryKey(leadId),
    });
    queryClient.invalidateQueries({
      queryKey: getGetLeadReviewQueryKey(leadId),
    });
    queryClient.invalidateQueries({
      queryKey: getListLeadsQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getGetLeadTimelineQueryKey(leadId),
    });
    queryClient.invalidateQueries({
      queryKey: getListLeadCallsQueryKey(leadId),
    });
  };

  const resolveLiveCallLogId = async (callSid: string | undefined) => {
    if (!callSid) return;
    // The server created the call log in the voice webhook; find it by the
    // Twilio CallSid so notes + sentiment can be attached afterwards.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const calls = await listLeadCalls(leadId);
        const match = calls.find((c) => c.providerCallId === callSid);
        if (match) {
          setLiveCallLogId(match.id);
          return;
        }
      } catch {
        // retry below
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  };

  const startBrowserCall = async () => {
    if (!leadPhone) return;
    setLiveState("connecting");
    try {
      const { token } = await mintToken.mutateAsync();
      const device = new Device(token, {
        // Prefer Opus, fall back to PCMU.
        codecPreferences: ["opus", "pcmu"] as never,
      });
      deviceRef.current = device;
      await device.register();
      const call = await device.connect({
        params: { To: leadPhone, LeadId: String(leadId) },
      });
      callRef.current = call;
      setLiveState("ringing");

      call.on("accept", () => {
        setLiveState("in_call");
        setElapsed(0);
        stopTimer();
        timerRef.current = setInterval(
          () => setElapsed((s) => s + 1),
          1000,
        );
        void resolveLiveCallLogId(call.parameters["CallSid"]);
      });
      call.on("disconnect", () => {
        stopTimer();
        setLiveState("ended");
        callRef.current = null;
        deviceRef.current?.destroy();
        deviceRef.current = null;
        // Give the completion webhook a beat, then pull the fresh outcome.
        setTimeout(refreshCallData, 1500);
        void resolveLiveCallLogId(call.parameters["CallSid"]);
      });
      call.on("error", () => {
        stopTimer();
        setLiveState("ended");
        toast({
          title: "Call problem",
          description: "The call ended unexpectedly.",
          variant: "destructive",
        });
      });
    } catch {
      teardownDevice();
      setLiveState("idle");
      toast({
        title: "Could not start the call",
        description:
          "Check your microphone permission and try again, or dial manually.",
        variant: "destructive",
      });
    }
  };

  const hangUp = () => {
    callRef.current?.disconnect();
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

  // After a live browser call, the server already captured duration/outcome,
  // and the AI transcribes the recording, scores sentiment, and posts a
  // summary automatically — only OPTIONAL extra notes are saved here (never
  // sentiment, so the manual default can't overwrite the AI score).
  const saveLiveAnnotation = async () => {
    if (!notes.trim()) {
      // Nothing extra to add — the automated pipeline handles the rest.
      reset();
      onOpenChange(false);
      return;
    }
    if (liveCallLogId == null) {
      toast({
        title: "Call record still syncing",
        description: "Give it a moment and try saving again.",
      });
      return;
    }
    try {
      await updateCall.mutateAsync({
        id: leadId,
        callId: liveCallLogId,
        data: {
          notes: notes.trim(),
        },
      });
      refreshCallData();
      toast({
        title: "Note added",
        description: `Your note was attached to ${leadName}'s call record.`,
      });
      reset();
      onOpenChange(false);
    } catch {
      toast({
        title: "Could not save the call notes",
        description: "Please try again.",
        variant: "destructive",
      });
    }
  };

  const logCall = async () => {
    const mins = minutes.trim() === "" ? null : Number(minutes);
    if (status === "callback") {
      if (!callbackAt) {
        toast({
          title: "Pick a callback time",
          description: "A callback outcome needs the time the customer asked for.",
          variant: "destructive",
        });
        return;
      }
      if (new Date(callbackAt).getTime() <= Date.now()) {
        toast({
          title: "Callback time must be in the future",
          variant: "destructive",
        });
        return;
      }
    }
    try {
      await createCall.mutateAsync({
        id: leadId,
        data: {
          direction,
          status,
          ...(sentiment !== "auto" ? { sentiment } : {}),
          ...(status === "callback" && callbackAt
            ? { callbackAt: new Date(callbackAt).toISOString() }
            : {}),
          ...(mins != null && Number.isFinite(mins) && mins >= 0
            ? { durationSeconds: Math.round(mins * 60) }
            : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
      refreshCallData();
      toast({
        title: "Call logged",
        description:
          sentiment === "auto" && notes.trim()
            ? `Saved to ${leadName}'s record — AURA is scoring the sentiment.`
            : `Outcome saved to ${leadName}'s record.`,
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

  // Call-centre decision: one atomic request. After a live browser call the
  // server-created call log is referenced via existingCallId (no duplicate).
  const saveDisposition = async (fromLiveCall: boolean) => {
    if (submittingRef.current || disposition.isPending) return;
    if (!ccOutcome) {
      toast({ title: "Choose a call outcome", variant: "destructive" });
      return;
    }
    if (ccOutcome === "follow_up") {
      if (!ccFollowUp) {
        toast({ title: "Pick a follow-up date", variant: "destructive" });
        return;
      }
      if (ccFollowUp < todayKey()) {
        toast({ title: "Follow-up date cannot be in the past", variant: "destructive" });
        return;
      }
    }
    if (!notes.trim()) {
      toast({
        title: "Add call notes",
        description: "Note what was said so the next person picks up from here.",
        variant: "destructive",
      });
      return;
    }
    if (fromLiveCall && liveCallLogId == null) {
      toast({
        title: "Call record still syncing",
        description: "Give it a moment and try saving again.",
      });
      return;
    }
    const mins = minutes.trim() === "" ? null : Number(minutes);
    submittingRef.current = true;
    try {
      await disposition.mutateAsync({ id: leadId, data: {
        outcome: ccOutcome,
        notes: notes.trim(),
        ...(ccOutcome === "follow_up" ? { followUpDate: ccFollowUp } : {}),
        ...(fromLiveCall && liveCallLogId != null
          ? { existingCallId: liveCallLogId }
          : mins != null && Number.isFinite(mins) && mins >= 0
            ? { durationSeconds: Math.round(mins * 60) }
            : {}),
      } });
      toast({
        title:
          ccOutcome === "interested"
            ? "Transferred to a Sales Advisor"
            : ccOutcome === "follow_up"
              ? "Follow-up scheduled"
              : "Marked not interested",
        description:
          ccOutcome === "interested"
            ? `${leadName} was assigned to the next Sales Advisor in rotation.`
            : ccOutcome === "follow_up"
              ? `${leadName} stays in your queue for ${ccFollowUp}.`
              : `${leadName} was closed as lost.`,
      });
      reset();
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Could not save the call decision",
        description: dispositionErrorMessage(err),
        variant: "destructive",
      });
    } finally {
      submittingRef.current = false;
    }
  };

  const liveActive = liveState === "connecting" || liveState === "ringing" || liveState === "in_call";
  const afterLiveCall = liveState === "ended";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && liveActive) hangUp();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="w-4 h-4 text-primary" />
            Call {leadName}
          </DialogTitle>
          <DialogDescription>
            {afterLiveCall ? (
              <>Call complete — add an optional note below, then hit Done.</>
            ) : browserCalling ? (
              <>Call {leadPhone} straight from your browser — duration and outcome are captured automatically.</>
            ) : leadPhone ? (
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

        {browserCalling && (
          <div className="min-w-0 rounded-xl ring-1 ring-white/10 bg-foreground/[0.03] p-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">
                {liveState === "idle" && "Ready to dial"}
                {liveState === "connecting" && "Starting call…"}
                {liveState === "ringing" && "Ringing…"}
                {liveState === "in_call" && `On call — ${formatElapsed(elapsed)}`}
                {liveState === "ended" && "Call ended"}
              </div>
              <div className="text-xs text-muted-foreground break-words">
                {liveState === "ended"
                  ? "Recorded automatically — AI is transcribing the call, scoring sentiment, and posting a summary to the lead. Add anything extra below."
                  : leadPhone}
              </div>
            </div>
            {liveActive ? (
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5 shrink-0"
                onClick={hangUp}
              >
                <PhoneOff className="w-4 h-4" />
                Hang up
              </Button>
            ) : (
              <Button
                size="sm"
                className="gap-1.5 shrink-0"
                onClick={startBrowserCall}
                disabled={mintToken.isPending}
              >
                {mintToken.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <PhoneCall className="w-4 h-4" />
                )}
                {afterLiveCall ? "Call again" : "Call now"}
              </Button>
            )}
          </div>
        )}

        <div className="space-y-4">
          {!afterLiveCall && (
            <div className="grid grid-cols-2 gap-3">
              {!callCentre && (
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
              )}
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
          )}

          {callCentre && (
            <div data-testid="section-call-centre-decision">
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Call centre decision
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CC_OUTCOMES.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setCcOutcome(o.value)}
                    data-testid={`button-cc-outcome-${o.value}`}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors",
                      ccOutcome === o.value
                        ? "bg-primary text-white ring-primary"
                        : "bg-foreground/[0.04] text-muted-foreground ring-white/10 hover:text-foreground",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {ccOutcome && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  {CC_OUTCOMES.find((o) => o.value === ccOutcome)?.hint}
                </p>
              )}
              {ccOutcome === "follow_up" && (
                <div className="mt-3">
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                    Follow-up date <span className="text-primary">*</span>
                  </div>
                  <Input
                    type="date"
                    min={todayKey()}
                    value={ccFollowUp}
                    onChange={(e) => setCcFollowUp(e.target.value)}
                    data-testid="input-cc-follow-up-date"
                  />
                </div>
              )}
            </div>
          )}

          {!afterLiveCall && !callCentre && (
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
          )}

          {!afterLiveCall && !callCentre && status === "callback" && (
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Callback time
              </div>
              <Input
                type="datetime-local"
                value={callbackAt}
                onChange={(e) => setCallbackAt(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1.5">
                A follow-up task is created for the owner at this time.
              </p>
            </div>
          )}

          <div>
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Notes
              {callCentre && (
                <span className="text-primary"> *</span>
              )}
            </div>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                afterLiveCall
                  ? "Optional — anything the transcript won't capture (context, promises, follow-ups)…"
                  : "What was discussed? Objections, next steps…"
              }
              rows={3}
            />
          </div>

          {!afterLiveCall && !callCentre && (
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
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setSentiment("auto");
                  setRationale(null);
                }}
                className={cn(
                  "rounded-full px-3.5 py-1.5 text-xs font-semibold ring-1 transition-colors inline-flex items-center gap-1",
                  sentiment === "auto"
                    ? "bg-primary/15 text-primary ring-primary/30"
                    : "bg-transparent text-muted-foreground ring-white/10 hover:text-foreground",
                )}
              >
                <Sparkles className="w-3 h-3" />
                Let AURA score
              </button>
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
            {sentiment === "auto" && (
              <p className="text-xs text-muted-foreground mt-2">
                AURA scores the sentiment from your notes after saving; without
                notes it stays neutral.
              </p>
            )}
            {rationale && (
              <p className="text-xs text-muted-foreground mt-2">
                AI: {rationale}
              </p>
            )}
          </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createCall.isPending || updateCall.isPending || disposition.isPending}
          >
            Cancel
          </Button>
          {callCentre ? (
            <Button
              onClick={() => void saveDisposition(afterLiveCall)}
              disabled={disposition.isPending || liveActive || !ccOutcome}
              className="gap-1.5"
              data-testid="button-save-cc-decision"
            >
              {disposition.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Phone className="w-4 h-4" />
              )}
              {afterLiveCall ? "Save decision" : "Log call & save decision"}
            </Button>
          ) : afterLiveCall ? (
            <Button
              onClick={saveLiveAnnotation}
              disabled={updateCall.isPending}
              className="gap-1.5"
            >
              {updateCall.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Phone className="w-4 h-4" />
              )}
              {notes.trim() ? "Add note" : "Done"}
            </Button>
          ) : (
            <Button
              onClick={logCall}
              disabled={createCall.isPending || liveActive}
              className="gap-1.5"
            >
              {createCall.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Phone className="w-4 h-4" />
              )}
              Log call
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
