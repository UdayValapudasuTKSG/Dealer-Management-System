import { useState } from "react";
import { useParams } from "wouter";
import {
  useDecidePublicServiceEstimate,
  useGetPublicServiceEstimate,
} from "@workspace/api-client-react";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

const money = (value: number) =>
  new Intl.NumberFormat("en-GY", {
    style: "currency",
    currency: "GYD",
    maximumFractionDigits: 0,
  }).format(value);

export default function ServiceEstimate() {
  const { token = "" } = useParams<{ token: string }>();
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
              <h1 className="text-2xl font-semibold">Estimate unavailable</h1>
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
                Service estimate
              </h1>
              <p className="mt-2 text-neutral-600">
                {data.vehicle} · {data.service.replace(/_/g, " ")}
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
                    Your advisor has provided a whole-estimate total.
                  </div>
                )}
                <div className="flex items-center justify-between bg-neutral-50 p-5 text-lg font-semibold">
                  <span>Total estimate</span>
                  <span>{money(data.total)}</span>
                </div>
              </div>
              {data.state !== "open" || result ? (
                <div className="mt-8 rounded-2xl bg-emerald-50 p-5 text-emerald-900">
                  <CheckCircle2 className="mb-2 h-6 w-6" />
                  Your decision to {data.state === "approved" || result === "approved" ? "approve" : "decline"} the whole estimate has been recorded.
                </div>
              ) : (
                <div className="mt-8">
                  <p className="mb-4 text-sm text-neutral-600">
                    Choose once below. Parts and labour are shown read-only; your choice applies to the whole estimate.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Button
                      className="h-12 rounded-full"
                      disabled={decide.isPending}
                      onClick={() => submit("approved")}
                    >
                      Approve whole estimate
                    </Button>
                    <Button
                      variant="outline"
                      className="h-12 rounded-full border-black/20"
                      disabled={decide.isPending}
                      onClick={() => submit("declined")}
                    >
                      Decline estimate
                    </Button>
                  </div>
                  {decide.isError && (
                    <p className="mt-3 text-sm text-red-700">
                      We could not record that decision. The link may have expired or already been used.
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