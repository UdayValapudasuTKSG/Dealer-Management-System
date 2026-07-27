import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Download,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { getGetCustomerOverviewQueryKey } from "@workspace/api-client-react";

const apiBase = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

interface ConsentEntry {
  granted: boolean;
  basis: string;
  capturedAt: string;
  sourceEvent: string;
}

interface DsarStatus {
  id: number;
  status: string;
  bundle?: Record<string, unknown> | null;
  steps?: { step: string; completedAt: string; detail?: string }[];
  error?: string | null;
}

export function PrivacyTab({
  customerId,
  customerName,
  marketingConsent,
  erasedAt,
}: {
  customerId: number;
  customerName: string;
  marketingConsent?: Record<string, ConsentEntry> | null;
  erasedAt?: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [exporting, setExporting] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [holds, setHolds] = useState<string[]>([]);
  const [eraseSteps, setEraseSteps] = useState<DsarStatus["steps"]>();

  const poll = async (path: string, tries = 20): Promise<DsarStatus> => {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const res = await fetch(path, { credentials: "include" });
      if (!res.ok) throw new Error(`poll failed (${res.status})`);
      const body = (await res.json()) as DsarStatus;
      if (body.status !== "processing") return body;
    }
    throw new Error("timed out waiting for the request to complete");
  };

  const runExport = async () => {
    setExporting(true);
    try {
      const res = await fetch(
        `${apiBase()}/customers/${customerId}/export`,
        { credentials: "include" },
      );
      if (res.status !== 202) throw new Error(`export failed (${res.status})`);
      const accepted = (await res.json()) as DsarStatus;
      const done = await poll(
        `${apiBase()}/customers/${customerId}/export/${accepted.id}`,
      );
      if (done.status !== "completed" || !done.bundle) {
        throw new Error(done.error ?? "export did not complete");
      }
      const blob = new Blob([JSON.stringify(done.bundle, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `customer-${customerId}-data-export.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({
        title: "Data export ready",
        description: "The complete data bundle was downloaded as JSON.",
      });
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Unexpected error",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const runErase = async () => {
    setErasing(true);
    setHolds([]);
    try {
      const res = await fetch(`${apiBase()}/customers/${customerId}/erase`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({}),
      });
      if (res.status === 422) {
        const body = (await res.json()) as { unmet?: string[] };
        setHolds(body.unmet ?? []);
        toast({
          title: "Erasure deferred — legal hold",
          description:
            "Open financial obligations block erasure. It is queued until they close.",
          variant: "destructive",
        });
        return;
      }
      if (res.status === 403) {
        toast({
          title: "Not permitted",
          description: "Erasure requires customers admin permission.",
          variant: "destructive",
        });
        return;
      }
      if (res.status !== 202) throw new Error(`erase failed (${res.status})`);
      const accepted = (await res.json()) as DsarStatus;
      // The erase saga has no dedicated poll route; reuse the DSAR fetch.
      const done = await poll(
        `${apiBase()}/customers/${customerId}/export/${accepted.id}`,
      );
      setEraseSteps(done.steps);
      if (done.status !== "completed") {
        throw new Error(done.error ?? "erasure did not complete");
      }
      toast({
        title: "Personal data erased",
        description:
          "Identity anonymized, communications purged, financial ledger retained de-linked.",
      });
      await queryClient.invalidateQueries({
        queryKey: getGetCustomerOverviewQueryKey(customerId),
      });
    } catch (err) {
      toast({
        title: "Erasure failed",
        description: err instanceof Error ? err.message : "Unexpected error",
        variant: "destructive",
      });
    } finally {
      setErasing(false);
    }
  };

  const consents = Object.entries(marketingConsent ?? {});

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <Card className="glass-panel border-none shadow-lg">
        <CardContent className="p-6 space-y-4">
          <h3 className="text-lg font-semibold tracking-wide">
            Marketing Consent
          </h3>
          {consents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No consent decisions on record. Under the opt-in model this
              customer receives transactional messages only — no marketing.
            </p>
          ) : (
            <div className="space-y-3">
              {consents.map(([channel, entry]) => (
                <div
                  key={channel}
                  className="flex items-center justify-between rounded-lg border border-border/40 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    {entry.granted ? (
                      <ShieldCheck className="h-5 w-5 text-emerald-500" />
                    ) : (
                      <ShieldOff className="h-5 w-5 text-muted-foreground" />
                    )}
                    <div>
                      <p className="text-sm font-medium capitalize">{channel}</p>
                      <p className="text-xs text-muted-foreground">
                        {entry.basis.replace(/_/g, " ")} ·{" "}
                        {new Date(entry.capturedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <Badge variant={entry.granted ? "default" : "secondary"}>
                    {entry.granted ? "Opted in" : "Not granted"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass-panel border-none shadow-lg">
        <CardContent className="p-6 space-y-5">
          <h3 className="text-lg font-semibold tracking-wide">
            Data Subject Rights
          </h3>
          {erasedAt && (
            <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-4 py-3 text-sm">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              Personal data erased on{" "}
              {new Date(erasedAt).toLocaleDateString()} — this is an anonymized
              shell record retained for the financial ledger.
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Export assembles every record we hold on {customerName} —
              identity, communications, documents and financial history — into
              a portable JSON bundle.
            </p>
            <Button onClick={runExport} disabled={exporting} className="gap-2">
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {exporting ? "Assembling bundle…" : "Export customer data"}
            </Button>
          </div>
          <div className="space-y-2 pt-2 border-t border-border/40">
            <p className="text-sm text-muted-foreground">
              Erasure permanently anonymizes identity, purges message bodies,
              transcripts and notes, and deletes uploaded documents. Invoices
              and payments are retained de-linked for statutory audit. This
              cannot be undone.
            </p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  disabled={erasing || !!erasedAt}
                  className="gap-2"
                >
                  {erasing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  {erasing ? "Erasing…" : "Erase personal data"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Erase {customerName}&apos;s personal data?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Their identity becomes an anonymized token, all message
                    content is purged and uploaded documents are deleted.
                    Financial records survive without any personal link. This
                    action is irreversible.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={runErase}>
                    Erase permanently
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          {holds.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 space-y-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Legal holds blocking erasure
              </p>
              <ul className="text-xs text-muted-foreground list-disc pl-5">
                {holds.map((h) => (
                  <li key={h}>{h.replace(/_/g, " ")}</li>
                ))}
              </ul>
            </div>
          )}
          {eraseSteps && eraseSteps.length > 0 && (
            <div className="rounded-lg border border-border/40 px-4 py-3 space-y-1">
              <p className="text-sm font-medium">Erasure steps</p>
              <ul className="text-xs text-muted-foreground space-y-0.5">
                {eraseSteps.map((s) => (
                  <li key={s.step} className="flex items-center gap-2">
                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                    {s.step.replace(/_/g, " ")}
                    {s.detail ? ` — ${s.detail}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
