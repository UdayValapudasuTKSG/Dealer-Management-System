import { useRef, useState } from "react";
import {
  useGetFinanceApplication,
  useSubmitFinanceApplication,
  useSyncFinanceApplication,
  useDeleteFinanceDocument,
  getGetFinanceApplicationQueryKey,
  getListFinanceApplicationsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useMoney, formatGuyanaDateTime } from "@/lib/format";
import {
  Send,
  RefreshCw,
  FileUp,
  Trash2,
  FileText,
  Download,
  Check,
  X,
  Loader2,
  Landmark,
  Briefcase,
} from "lucide-react";

const apiBase = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export const FINANCE_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  submitted: "Submitted",
  under_review: "Under Review",
  approved: "Approved",
  declined: "Rejected",
  disbursed: "Disbursed",
};

const STEPS = ["pending", "submitted", "under_review", "approved", "disbursed"];

const DOC_TYPES = [
  { value: "id_document", label: "ID Document" },
  { value: "payslip", label: "Payslip" },
  { value: "bank_statement", label: "Bank Statement" },
  { value: "proof_of_address", label: "Proof of Address" },
  { value: "employment_letter", label: "Employment Letter" },
  { value: "other", label: "Other" },
];

export function statusBadgeClass(status: string): string {
  switch (status) {
    case "approved":
      return "bg-emerald-500/15 text-emerald-400";
    case "disbursed":
      return "bg-primary/15 text-primary";
    case "declined":
      return "bg-red-500/15 text-red-400";
    case "under_review":
      return "bg-amber-500/15 text-amber-400";
    case "submitted":
      return "bg-sky-500/15 text-sky-400";
    default:
      return "bg-foreground/10 text-muted-foreground";
  }
}

function StatusStepper({ status }: { status: string }) {
  const declined = status === "declined";
  const activeIdx = declined ? 2 : STEPS.indexOf(status);
  return (
    <div className="flex items-center gap-1">
      {STEPS.map((s, i) => {
        const reached = i <= activeIdx;
        const isDeclineBranch = declined && i > 2;
        return (
          <div key={s} className="flex items-center gap-1 flex-1 min-w-0">
            <div className="flex flex-col items-center gap-1.5 flex-1 min-w-0">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold border ${
                  isDeclineBranch
                    ? "border-white/10 text-muted-foreground/40"
                    : reached
                      ? i === activeIdx && !declined
                        ? "bg-primary text-white border-primary glow-red"
                        : "bg-primary/20 text-primary border-primary/40"
                      : "border-white/10 text-muted-foreground/50"
                }`}
              >
                {declined && i === 2 ? (
                  <X className="w-3.5 h-3.5 text-red-400" />
                ) : reached && i < activeIdx ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={`text-[9px] uppercase tracking-widest font-semibold truncate max-w-full ${
                  reached && !isDeclineBranch ? "text-foreground" : "text-muted-foreground/50"
                }`}
              >
                {FINANCE_STATUS_LABEL[s]}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`h-px flex-1 mb-4 ${i < activeIdx && !isDeclineBranch ? "bg-primary/50" : "bg-white/10"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ApplicationDetailDialog({
  appId,
  onClose,
}: {
  appId: number | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const rawMoney = useMoney();
  const money = (n: number | null | undefined) =>
    n == null ? "—" : rawMoney.gyd(n);
  const { data, isLoading } = useGetFinanceApplication(appId ?? 0, {
    query: {
      queryKey: getGetFinanceApplicationQueryKey(appId ?? 0),
      enabled: appId != null,
    },
  });
  const submit = useSubmitFinanceApplication();
  const sync = useSyncFinanceApplication();
  const deleteDoc = useDeleteFinanceDocument();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState("other");
  const [uploading, setUploading] = useState(false);

  const invalidate = () => {
    if (appId == null) return;
    queryClient.invalidateQueries({ queryKey: getGetFinanceApplicationQueryKey(appId) });
    queryClient.invalidateQueries({ queryKey: getListFinanceApplicationsQueryKey() });
  };

  const app = data?.application;

  const onUpload = async (file: File) => {
    if (appId == null) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("type", docType);
      const res = await fetch(`${apiBase()}/finance-applications/${appId}/documents`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Upload failed");
      invalidate();
      toast({ title: "Document uploaded", description: file.name });
    } catch (e) {
      toast({
        title: "Upload failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Dialog open={appId != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto glass-panel border-white/10">
        {isLoading || !app ? (
          <div className="py-20 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center justify-between gap-4 pr-8">
                <DialogTitle className="text-2xl font-bold tracking-tight">
                  {app.customerName}
                </DialogTitle>
                <Badge className={`border-none rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-widest ${statusBadgeClass(app.status)}`}>
                  {FINANCE_STATUS_LABEL[app.status] ?? app.status}
                </Badge>
              </div>
              <DialogDescription className="flex items-center gap-2 text-sm">
                <Landmark className="w-4 h-4" />
                {app.lender ?? "No lender assigned yet"}
                {app.losReference && (
                  <span className="text-xs font-mono text-muted-foreground">· Ref {app.losReference}</span>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="py-2">
              <StatusStepper status={app.status} />
            </div>

            <div className="flex gap-3">
              {app.status === "pending" && (
                <Button
                  className="bg-primary hover:bg-primary/90 text-white rounded-full gap-2 flex-1"
                  disabled={submit.isPending}
                  onClick={() =>
                    submit.mutate(
                      { id: app.id },
                      {
                        onSuccess: () => {
                          invalidate();
                          toast({ title: "Submitted to lender", description: "The application is now in the lender's intake queue." });
                        },
                        onError: (e) =>
                          toast({ title: "Submission failed", description: (e as { error?: string })?.error ?? "LOS error", variant: "destructive" }),
                      },
                    )
                  }
                >
                  {submit.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Submit to Lender
                </Button>
              )}
              {["submitted", "under_review", "approved"].includes(app.status) && (
                <Button
                  variant="outline"
                  className="rounded-full gap-2 flex-1 border-white/15"
                  disabled={sync.isPending}
                  onClick={() =>
                    sync.mutate(
                      { id: app.id },
                      {
                        onSuccess: (updated) => {
                          invalidate();
                          toast({
                            title: updated.status === app.status ? "No change from lender" : `Now ${FINANCE_STATUS_LABEL[updated.status]}`,
                            description: updated.statusHistory.at(-1)?.note,
                          });
                        },
                        onError: () =>
                          toast({ title: "Sync failed", description: "Could not reach the lender's system.", variant: "destructive" }),
                      },
                    )
                  }
                >
                  {sync.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  Check Lender Status
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-4 border-y border-white/10">
              <div>
                <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">Amount</div>
                <div className="font-light text-xl">{money(app.amount)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">Down Payment</div>
                <div className="font-light text-xl">{money(app.downPayment)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">Term</div>
                <div className="font-light text-xl">{app.termMonths} mo</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1">APR</div>
                <div className="font-light text-xl text-primary">{app.apr}%</div>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-3 flex items-center gap-2">
                <Briefcase className="w-4 h-4" /> Employment & Income
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-sm">
                <div><span className="text-muted-foreground">Employer:</span> {app.employerName ?? "—"}</div>
                <div><span className="text-muted-foreground">Role:</span> {app.jobTitle ?? "—"}</div>
                <div><span className="text-muted-foreground">Type:</span> {app.employmentType?.replace("_", " ") ?? "—"}</div>
                <div><span className="text-muted-foreground">Years:</span> {app.employmentYears ?? "—"}</div>
                <div><span className="text-muted-foreground">Monthly income:</span> {money(app.monthlyIncome)}</div>
                <div><span className="text-muted-foreground">Other income:</span> {money(app.otherIncome)}</div>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase flex items-center gap-2">
                  <FileText className="w-4 h-4" /> Supporting Documents
                </div>
                <div className="flex items-center gap-2">
                  <Select value={docType} onValueChange={setDocType}>
                    <SelectTrigger className="h-8 w-40 text-xs rounded-full bg-white/[0.04] border-white/10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DOC_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.txt"
                    onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-full gap-1.5 h-8 border-white/15"
                    disabled={uploading}
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileUp className="w-3.5 h-3.5" />}
                    Upload
                  </Button>
                </div>
              </div>
              {data.documents.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No documents yet — upload payslips, ID and bank statements before submitting.</p>
              ) : (
                <div className="space-y-2">
                  {data.documents.map((doc) => (
                    <div key={doc.id} className="flex items-center gap-3 bg-white/[0.03] border border-white/10 rounded-xl px-4 py-2.5">
                      <FileText className="w-4 h-4 text-primary shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{doc.fileName}</div>
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                          {DOC_TYPES.find((t) => t.value === doc.type)?.label ?? doc.type} · {(doc.sizeBytes / 1024).toFixed(0)} KB
                        </div>
                      </div>
                      <a
                        href={`${apiBase()}/finance-applications/${app.id}/documents/${doc.id}/download`}
                        target="_blank"
                        rel="noreferrer"
                        className="p-2 rounded-full hover:bg-foreground/10 transition-colors"
                      >
                        <Download className="w-4 h-4 text-muted-foreground" />
                      </a>
                      <button
                        className="p-2 rounded-full hover:bg-red-500/10 transition-colors"
                        onClick={() =>
                          deleteDoc.mutate(
                            { id: app.id, docId: doc.id },
                            { onSuccess: invalidate },
                          )
                        }
                      >
                        <Trash2 className="w-4 h-4 text-muted-foreground hover:text-red-400" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-3">Status Timeline</div>
              <div className="space-y-0">
                {[...app.statusHistory].reverse().map((ev, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className={`w-2.5 h-2.5 rounded-full mt-1.5 ${i === 0 ? "bg-primary glow-red" : "bg-white/20"}`} />
                      {i < app.statusHistory.length - 1 && <div className="w-px flex-1 bg-white/10" />}
                    </div>
                    <div className="pb-4 min-w-0">
                      <div className="text-sm font-semibold">{FINANCE_STATUS_LABEL[ev.status] ?? ev.status}</div>
                      <div className="text-sm text-muted-foreground">{ev.note}</div>
                      <div className="text-[10px] text-muted-foreground/60 uppercase tracking-widest mt-0.5">
                        {formatGuyanaDateTime(ev.at)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {data.submissions.length > 0 && (
              <div>
                <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-3">Lender System Log</div>
                <div className="space-y-1.5">
                  {data.submissions.map((s) => (
                    <div key={s.id} className="flex items-start gap-3 text-xs bg-white/[0.02] border border-white/5 rounded-lg px-3 py-2">
                      <span className={`shrink-0 uppercase tracking-widest font-bold ${s.status === "error" ? "text-red-400" : "text-primary/80"}`}>
                        {s.event}
                      </span>
                      <span className="text-muted-foreground min-w-0">{s.message}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground/50 font-mono">{s.mode}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
