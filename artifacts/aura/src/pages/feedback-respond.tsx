import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import {
  useGetPublicFeedbackForm,
  useSubmitPublicFeedbackForm,
  type FeedbackQuestion,
  type PublicFeedbackAnswer,
} from "@workspace/api-client-react";
import { Star, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * PUBLIC customer feedback page — reached from the unique tokenized link sent
 * by email/WhatsApp. No sign-in; mobile-first; renders the immutable question
 * snapshot and submits once.
 */
export default function FeedbackRespond() {
  const [, params] = useRoute("/feedback/:token");
  const token = params?.token ?? "";
  const { data, isLoading, error } = useGetPublicFeedbackForm(token, {
    query: {
      queryKey: ["public-feedback", token],
      retry: false,
      refetchInterval: false,
      refetchOnWindowFocus: false,
    },
  });
  const submit = useSubmitPublicFeedbackForm();
  const [answers, setAnswers] = useState<Record<string, PublicFeedbackAnswer>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const questions = useMemo(
    () => (data?.questions ?? []) as FeedbackQuestion[],
    [data],
  );

  const setAnswer = (q: FeedbackQuestion, patch: Partial<PublicFeedbackAnswer>) => {
    setValidationError(null);
    setAnswers((prev) => ({
      ...prev,
      [q.id]: { ...prev[q.id], ...patch, questionId: q.id },
    }));
  };

  const handleSubmit = async () => {
    for (const q of questions) {
      const a = answers[q.id];
      const empty =
        !a ||
        ((q.type === "text" || q.type === "long_text") && !a.text?.trim()) ||
        ((q.type === "single_choice" || q.type === "multi_choice") &&
          !(a.choices ?? []).length) ||
        (q.type === "star_rating" && a.rating == null);
      if (q.required && empty) {
        setValidationError(`Please answer "${q.label}"`);
        return;
      }
    }
    try {
      await submit.mutateAsync({
        token,
        data: { answers: Object.values(answers) },
      });
      setDone(true);
    } catch (e) {
      setValidationError(
        e instanceof Error ? e.message : "Something went wrong — please try again",
      );
    }
  };

  const shell = (content: React.ReactNode) => (
    <div className="min-h-screen bg-[hsl(216,22%,6%)] text-white flex items-start sm:items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl">{content}</div>
    </div>
  );

  if (isLoading) {
    return shell(
      <div className="flex items-center justify-center gap-2 text-white/60 py-24">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading…
      </div>,
    );
  }

  if (error || !data) {
    const status = (error as { status?: number } | null)?.status;
    const message =
      (error as { message?: string } | null)?.message ??
      "This feedback link is not valid";
    return shell(
      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-10 text-center">
        <AlertTriangle className="w-10 h-10 mx-auto text-amber-400 mb-4" />
        <h1 className="text-xl font-semibold mb-2">
          {status === 410 ? "This link has expired" : "Link not valid"}
        </h1>
        <p className="text-white/60 text-sm">{message}</p>
      </div>,
    );
  }

  if (done || data.state === "submitted") {
    return shell(
      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-10 text-center">
        <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-400 mb-4" />
        <h1 className="text-xl font-semibold mb-2">
          {done ? "Thank you for your feedback!" : "Already submitted"}
        </h1>
        <p className="text-white/60 text-sm">
          {done
            ? `Your answers went straight to the team at ${data.brandName}.`
            : "This form was already completed — thank you all the same!"}
        </p>
      </div>,
    );
  }

  return shell(
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 sm:p-10">
      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/40 mb-2">
          {data.brandName}
        </div>
        <h1 className="text-2xl font-semibold leading-tight">{data.formName}</h1>
        {data.leadName && (
          <p className="text-white/50 text-sm mt-1">
            Hi {data.leadName.split(" ")[0]} — this takes about two minutes.
          </p>
        )}
      </div>
      <div className="space-y-7">
        {questions.map((q, i) => (
          <div key={q.id}>
            <label className="block text-sm font-medium mb-2">
              <span className="text-white/40 mr-1.5">{i + 1}.</span>
              {q.label}
              {q.required && <span className="text-red-400 ml-1">*</span>}
            </label>
            {q.type === "text" && (
              <input
                type="text"
                value={answers[q.id]?.text ?? ""}
                onChange={(e) => setAnswer(q, { text: e.target.value })}
                className="w-full h-11 rounded-xl bg-white/[0.05] border border-white/10 px-4 text-sm focus:outline-none focus:border-emerald-400/60"
                placeholder="Type your answer…"
              />
            )}
            {q.type === "long_text" && (
              <textarea
                value={answers[q.id]?.text ?? ""}
                onChange={(e) => setAnswer(q, { text: e.target.value })}
                rows={4}
                className="w-full rounded-xl bg-white/[0.05] border border-white/10 px-4 py-3 text-sm focus:outline-none focus:border-emerald-400/60 resize-y"
                placeholder="Tell us more…"
              />
            )}
            {(q.type === "single_choice" || q.type === "multi_choice") && (
              <div className="space-y-2">
                {(q.options ?? []).map((opt) => {
                  const selected = (answers[q.id]?.choices ?? []).includes(opt);
                  return (
                    <button
                      key={opt}
                      type="button"
                      onClick={() =>
                        setAnswer(q, {
                          choices:
                            q.type === "single_choice"
                              ? selected
                                ? []
                                : [opt]
                              : selected
                                ? (answers[q.id]?.choices ?? []).filter(
                                    (c) => c !== opt,
                                  )
                                : [...(answers[q.id]?.choices ?? []), opt],
                        })
                      }
                      className={cn(
                        "w-full text-left rounded-xl border px-4 py-3 text-sm transition-colors",
                        selected
                          ? "border-emerald-400/70 bg-emerald-400/10 text-white"
                          : "border-white/10 bg-white/[0.04] text-white/70 hover:border-white/25",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-block w-4 h-4 mr-3 align-middle border",
                          q.type === "single_choice" ? "rounded-full" : "rounded",
                          selected
                            ? "bg-emerald-400 border-emerald-400"
                            : "border-white/30",
                        )}
                      />
                      {opt}
                    </button>
                  );
                })}
              </div>
            )}
            {q.type === "star_rating" && (
              <div className="flex items-center gap-1.5">
                {Array.from({ length: q.maxStars ?? 5 }, (_, idx) => idx + 1).map(
                  (n) => {
                    const active = (answers[q.id]?.rating ?? 0) >= n;
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-label={`${n} star${n > 1 ? "s" : ""}`}
                        onClick={() => setAnswer(q, { rating: n })}
                        className="p-1"
                      >
                        <Star
                          className={cn(
                            "w-8 h-8 transition-colors",
                            active
                              ? "fill-amber-400 text-amber-400"
                              : "text-white/25",
                          )}
                        />
                      </button>
                    );
                  },
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {validationError && (
        <div className="mt-6 rounded-xl border border-red-400/40 bg-red-400/10 text-red-300 text-sm px-4 py-3">
          {validationError}
        </div>
      )}
      <button
        onClick={handleSubmit}
        disabled={submit.isPending}
        className="mt-8 w-full h-12 rounded-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-black font-bold uppercase tracking-widest text-sm transition-colors"
      >
        {submit.isPending ? "Sending…" : "Submit feedback"}
      </button>
      <p className="mt-4 text-center text-[11px] text-white/35">
        Your answers go directly to the {data.brandName} management team.
      </p>
    </div>,
  );
}
