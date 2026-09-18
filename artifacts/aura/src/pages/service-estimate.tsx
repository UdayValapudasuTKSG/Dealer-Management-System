import { useState } from "react";
import { useParams, useSearch } from "wouter";
import {
  useDecidePublicServiceEstimate,
  useGetPublicServiceEstimate,
} from "@workspace/api-client-react";
import { CheckCircle2, Clock3, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

const money = (value: number) =>
  new Intl.NumberFormat("en-GY", {
    style: "currency",
    currency: "GYD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

export default function ServiceEstimate() {
  const { token = "" } = useParams<{ token: string }>();
  const search = useSearch();
  const decisionFromEmail = new URLSearchParams(search).get("decision");
  const preselectedDecision =
    decisionFromEmail === "approved" || decisionFromEmail === "declined"
      ? decisionFromEmail
      : null;
  const estimate = useGetPublicServiceEstimate(token);
  const decide = useDecidePublicServiceEstimate();
  const [result, setResult] = useState<"approved" | "declined" | null>(null);
  const data = decide.data ?? estimate.data;
  const submit = async (decision: "approved" | "declined") => {
    const next = await decide.mutateAsync({ token, data: { decision } });
    setResult(next.state === "approved" ? "approved" : "declined");
  };

  return (
    <main className="min-h-screen bg-[#f4f1ec] text-[#171717] px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-2xl overflow-hidden rounded-3xl border border-black/10 bg-white shadow-2xl shadow-black/10">
        <div className="h-1.5 bg-primary" />
        <div className="p-6 sm:p-10">
          {estimate.isLoading ? (
            <div className="flex min-h-80 items-center justify-center">
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
            </div>
          ) : estimate.isError || !data ? (
            <div className="py-20 text-center">
              <XCircle className="mx-auto mb-4 h-10 w-10 text-red-600" />
              <h1 className="text-2xl font-semibold">Quote unavailable</h1>
              <p className="mt-2 text-neutral-600">
                This secure link is invalid or has expired. Please contact your service advisor.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-primary">
                <ShieldCheck className="h-4 w-4" />
                {data.brandName}
              </div>
              <h1 className="mt-5 text-3xl font-semibold tracking-tight">
                Service quote
              </h1>
              <p className="mt-2 text-neutral-600">
                {data.vehicle} · {data.service.replace(/_/g, " ")}
              </p>
              <p className="mt-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
                Quote version {data.estimateVersion} · valid until {new Date(data.expiresAt).toLocaleString("en-GY", { dateStyle: "medium", timeStyle: "short" })}
              </p>
              <div className="mt-8 divide-y divide-black/10 rounded-2xl border border-black/10">
                {data.lines.length ? (
                  data.lines.map((line, index) => (
                    <div key={`${line.kind}-${index}`} className="flex items-start justify-between gap-4 p-4">
                      <div>
                        <div className="font-medium">{line.description}</div>
                        <div className="text-xs uppercase tracking-wider text-neutral-500">
                          {line.kind}{line.quantity != null ? ` · ${line.quantity}` : ""}
                        </div>
                      </div>
                      <div className="font-medium">{money(line.amount)}</div>
                    </div>
                  ))
                ) : (
                  <div className="p-4 text-sm text-neutral-600">
                    Your service advisor has provided the itemized cost in this quote.
                  </div>
                )}
                <div className="flex items-center justify-between bg-neutral-50 p-5 text-lg font-semibold">
                  <span>Total quote</span>
                  <span>{money(data.total)}</span>
                </div>
              </div>
              {data.state !== "open" || result ? (
                <div className={`mt-8 rounded-2xl p-5 ${data.state === "approved" || result === "approved" ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-950"}`}>
                  {data.state === "approved" || result === "approved" ? <CheckCircle2 className="mb-2 h-6 w-6" /> : <Clock3 className="mb-2 h-6 w-6" />}
                  <p className="font-medium">
                    {data.state === "approved" || result === "approved"
                      ? "Thank you — your authorization of this exact quote version has been recorded."
                      : data.state === "declined" || result === "declined"
                        ? "This quote was declined. Your decision is recorded; workshop work may continue, but the dealership cannot issue an invoice until the current quote is authorized and receipt is confirmed by staff."
                        : data.state === "expired"
                          ? "This quote has expired. Workshop work may continue, but the current quote must be authorized before the dealership can issue an invoice."
                          : "This quote is stale because a newer version is available. Workshop work may continue, but the current quote must be authorized before the dealership can issue an invoice."}
                  </p>
                  {(data.state === "approved" || result === "approved") && (
                    <p className="mt-2 text-sm opacity-80">
                      Your dealership will confirm receipt of this authorization before issuing an invoice.
                    </p>
                  )}
                  {data.decidedAt && <p className="mt-1 text-sm opacity-80">Recorded {new Date(data.decidedAt).toLocaleString("en-GY", { dateStyle: "medium", timeStyle: "short" })}.</p>}
                </div>
              ) : (
                <div className="mt-8">
                  <p className="mb-4 text-sm text-neutral-600">
                    Review the itemized cost above. Your choice applies to this complete quote, including any parts, servicing or labour, taxes, and surcharge shown.
                  </p>
                  <p className="mb-4 rounded-lg bg-neutral-100 px-3 py-2 text-xs text-neutral-700">
                    Authorization is optional for workshop work to continue. It is still required, with staff confirmation of receipt, before the dealership can issue an invoice for this customer-pay quote.
                  </p>
                  {preselectedDecision && (
                    <p className="mb-4 rounded-lg bg-neutral-100 px-3 py-2 text-xs text-neutral-700">
                      Your email highlighted {preselectedDecision === "approved" ? "Authorize quote" : "Decline quote"}.
                      Nothing is recorded until you select it below.
                    </p>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Button
                      className={`h-12 rounded-full ${preselectedDecision === "approved" ? "ring-2 ring-primary ring-offset-2" : ""}`}
                      disabled={decide.isPending}
                      onClick={() => submit("approved")}
                    >
                      Authorize quote
                    </Button>
                    <Button
                      variant="outline"
                      className={`h-12 rounded-full border-black/20 ${preselectedDecision === "declined" ? "ring-2 ring-neutral-500 ring-offset-2" : ""}`}
                      disabled={decide.isPending}
                      onClick={() => submit("declined")}
                    >
                      Decline quote
                    </Button>
                  </div>
                  {decide.isError && (
                    <p className="mt-3 text-sm text-red-700">
                      We could not record that decision. This quote may have expired, already been used, or been revised. Ask your advisor to send the current quote.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}