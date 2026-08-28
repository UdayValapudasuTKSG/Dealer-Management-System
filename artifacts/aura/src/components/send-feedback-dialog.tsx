import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListFeedbackForms,
  usePreviewFeedbackRecipients,
  useSendFeedbackForm,
  LeadFilterConditionField,
  LeadFilterConditionOperator,
  type LeadFilterCondition,
  type FeedbackRecipientsPreview,
} from "@workspace/api-client-react";
import { Loader2, Plus, Trash2, Users, Filter } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Channel = "email" | "whatsapp";
type Mode = "selected" | "all_matching";

const FIELD_LABEL: Record<string, string> = {
  phase: "Pipeline stage",
  status: "Status",
  source: "Source",
  owner: "Owner / advisor",
  division: "Division",
  created: "Created date",
  vehicleInterest: "Vehicle interest",
};

/** Operators that make sense per field (server enforces the same rules). */
const FIELD_OPERATORS: Record<string, string[]> = {
  phase: ["is", "is_not", "is_any_of"],
  status: ["is", "is_not", "is_any_of"],
  source: ["is", "is_not", "is_any_of"],
  owner: ["is", "is_not", "contains"],
  division: ["is", "is_not", "is_any_of"],
  created: ["on_or_after", "on_or_before"],
  vehicleInterest: ["contains"],
};

const OPERATOR_LABEL: Record<string, string> = {
  is: "is",
  is_not: "is not",
  is_any_of: "is any of",
  contains: "contains",
  on_or_after: "on or after",
  on_or_before: "on or before",
};

const EXCLUSION_LABEL: Record<string, string> = {
  no_contact: "No usable contact channel",
  email_opt_out: "Opted out of email",
  whatsapp_opt_out: "Opted out of WhatsApp",
  already_sent: "Already received this form",
};

const PHASE_VALUES = ["new", "contacted", "engaged", "qualified", "won", "lost"];

type FilterRow = { field: string; operator: string; value: string };

/**
 * GM bulk "Send Feedback Form" dialog — pick a published form, choose the
 * audience (explicit Pipeline selection or a Jira-style filter expression that
 * matches ALL pages of results), preview inclusions/exclusions, and queue the
 * secure links via email/WhatsApp.
 */
export function SendFeedbackDialog({
  open,
  onClose,
  selectedLeadIds,
}: {
  open: boolean;
  onClose: () => void;
  selectedLeadIds: number[];
}) {
  const { toast } = useToast();
  const { data: forms } = useListFeedbackForms();
  const preview = usePreviewFeedbackRecipients();
  const send = useSendFeedbackForm();

  const published = useMemo(
    () => (forms ?? []).filter((f) => f.status === "published"),
    [forms],
  );

  const [formId, setFormId] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>(
    selectedLeadIds.length ? "selected" : "all_matching",
  );
  const [channels, setChannels] = useState<Channel[]>(["email", "whatsapp"]);
  const [filters, setFilters] = useState<FilterRow[]>([
    { field: "phase", operator: "is", value: "" },
  ]);
  const [previewData, setPreviewData] = useState<FeedbackRecipientsPreview | null>(
    null,
  );
  const [result, setResult] = useState<{ queued: number; skipped: number } | null>(
    null,
  );

  const apiFilters = (): LeadFilterCondition[] =>
    filters
      .filter((f) => f.value.trim())
      .map((f) => ({
        field: f.field as (typeof LeadFilterConditionField)[keyof typeof LeadFilterConditionField],
        operator:
          f.operator as (typeof LeadFilterConditionOperator)[keyof typeof LeadFilterConditionOperator],
        values:
          f.operator === "is_any_of"
            ? f.value.split(",").map((v) => v.trim()).filter(Boolean)
            : [f.value.trim()],
      }));

  const runPreview = async () => {
    setResult(null);
    try {
      const data = await preview.mutateAsync({
        data: {
          formId,
          channels,
          ...(mode === "selected"
            ? { leadIds: selectedLeadIds }
            : { filters: apiFilters() }),
        },
      });
      setPreviewData(data);
    } catch (e) {
      toast({
        title: "Preview failed",
        description: e instanceof Error ? e.message : "Unexpected error",
        variant: "destructive",
      });
    }
  };

  const doSend = async () => {
    if (!formId) return;
    try {
      const res = await send.mutateAsync({
        id: formId,
        data: {
          mode,
          channels,
          ...(mode === "selected"
            ? { leadIds: selectedLeadIds }
            : { filters: apiFilters() }),
        },
      });
      setResult({ queued: res.queued, skipped: res.skipped.length });
      toast({
        title: `Feedback form queued to ${res.queued} lead${res.queued === 1 ? "" : "s"}`,
        description: res.skipped.length
          ? `${res.skipped.length} excluded (opt-outs, missing contacts or already sent).`
          : undefined,
      });
    } catch (e) {
      toast({
        title: "Send failed",
        description: e instanceof Error ? e.message : "Unexpected error",
        variant: "destructive",
      });
    }
  };

  const toggleChannel = (c: Channel) => {
    setPreviewData(null);
    setChannels((cur) =>
      cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c],
    );
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send Feedback Form</DialogTitle>
          <DialogDescription>
            Each lead gets a unique secure link — duplicates and opt-outs are
            excluded automatically.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-4 text-center">
            <div className="text-3xl font-bold text-emerald-400">{result.queued}</div>
            <div className="text-sm text-muted-foreground">
              feedback link{result.queued === 1 ? "" : "s"} queued
              {result.skipped > 0 && ` · ${result.skipped} excluded`}
            </div>
            <Button onClick={onClose} className="rounded-full">
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Form picker */}
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Published form
              </label>
              {published.length === 0 ? (
                <div className="mt-1 text-sm text-muted-foreground rounded-lg border border-dashed border-white/15 px-3 py-3">
                  No published forms yet — create one on the{" "}
                  <Link href="/feedback-forms" className="text-primary underline">
                    Feedback Forms
                  </Link>{" "}
                  page.
                </div>
              ) : (
                <select
                  value={formId ?? ""}
                  onChange={(e) => {
                    setFormId(e.target.value ? Number(e.target.value) : null);
                    setPreviewData(null);
                  }}
                  className="mt-1 w-full h-10 rounded-lg bg-foreground/[0.05] border border-white/10 px-3 text-sm focus:outline-none focus:border-primary/50"
                >
                  <option value="">Choose a form…</option>
                  {published.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} ({f.questions.length} questions)
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Audience mode */}
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={!selectedLeadIds.length}
                onClick={() => {
                  setMode("selected");
                  setPreviewData(null);
                }}
                className={cn(
                  "flex-1 rounded-xl border px-3 py-2.5 text-sm text-left transition-colors",
                  mode === "selected"
                    ? "border-primary/60 bg-primary/10"
                    : "border-white/10 bg-foreground/[0.03] hover:border-white/25",
                  !selectedLeadIds.length && "opacity-40 cursor-not-allowed",
                )}
              >
                <Users className="w-4 h-4 mb-1 text-primary" />
                <div className="font-medium">Selected leads</div>
                <div className="text-xs text-muted-foreground">
                  {selectedLeadIds.length} checked in the Pipeline
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("all_matching");
                  setPreviewData(null);
                }}
                className={cn(
                  "flex-1 rounded-xl border px-3 py-2.5 text-sm text-left transition-colors",
                  mode === "all_matching"
                    ? "border-primary/60 bg-primary/10"
                    : "border-white/10 bg-foreground/[0.03] hover:border-white/25",
                )}
              >
                <Filter className="w-4 h-4 mb-1 text-primary" />
                <div className="font-medium">All leads matching filters</div>
                <div className="text-xs text-muted-foreground">
                  Across every result page
                </div>
              </button>
            </div>

            {/* Jira-style filter builder */}
            {mode === "all_matching" && (
              <div className="space-y-2">
                {filters.map((f, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <select
                      value={f.field}
                      onChange={(e) => {
                        const field = e.target.value;
                        setFilters((fs) =>
                          fs.map((x, j) =>
                            j === i
                              ? {
                                  field,
                                  operator: FIELD_OPERATORS[field]![0]!,
                                  value: "",
                                }
                              : x,
                          ),
                        );
                        setPreviewData(null);
                      }}
                      className="h-9 rounded-lg bg-foreground/[0.05] border border-white/10 px-2 text-xs focus:outline-none"
                    >
                      {Object.keys(FIELD_LABEL).map((k) => (
                        <option key={k} value={k}>
                          {FIELD_LABEL[k]}
                        </option>
                      ))}
                    </select>
                    <select
                      value={f.operator}
                      onChange={(e) => {
                        setFilters((fs) =>
                          fs.map((x, j) =>
                            j === i ? { ...x, operator: e.target.value } : x,
                          ),
                        );
                        setPreviewData(null);
                      }}
                      className="h-9 rounded-lg bg-foreground/[0.05] border border-white/10 px-2 text-xs focus:outline-none"
                    >
                      {(FIELD_OPERATORS[f.field] ?? ["is"]).map((op) => (
                        <option key={op} value={op}>
                          {OPERATOR_LABEL[op]}
                        </option>
                      ))}
                    </select>
                    {f.field === "created" ? (
                      <input
                        type="date"
                        value={f.value}
                        onChange={(e) => {
                          setFilters((fs) =>
                            fs.map((x, j) =>
                              j === i ? { ...x, value: e.target.value } : x,
                            ),
                          );
                          setPreviewData(null);
                        }}
                        className="flex-1 h-9 rounded-lg bg-foreground/[0.05] border border-white/10 px-2 text-xs focus:outline-none"
                      />
                    ) : f.field === "phase" && f.operator !== "is_any_of" ? (
                      <select
                        value={f.value}
                        onChange={(e) => {
                          setFilters((fs) =>
                            fs.map((x, j) =>
                              j === i ? { ...x, value: e.target.value } : x,
                            ),
                          );
                          setPreviewData(null);
                        }}
                        className="flex-1 h-9 rounded-lg bg-foreground/[0.05] border border-white/10 px-2 text-xs focus:outline-none"
                      >
                        <option value="">Choose…</option>
                        {PHASE_VALUES.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={f.value}
                        placeholder={
                          f.operator === "is_any_of"
                            ? "value1, value2, …"
                            : "value"
                        }
                        onChange={(e) => {
                          setFilters((fs) =>
                            fs.map((x, j) =>
                              j === i ? { ...x, value: e.target.value } : x,
                            ),
                          );
                          setPreviewData(null);
                        }}
                        className="flex-1 h-9 rounded-lg bg-foreground/[0.05] border border-white/10 px-2 text-xs focus:outline-none focus:border-primary/50"
                      />
                    )}
                    <button
                      type="button"
                      aria-label="Remove filter"
                      onClick={() => {
                        setFilters((fs) => fs.filter((_, j) => j !== i));
                        setPreviewData(null);
                      }}
                      className="text-muted-foreground hover:text-red-400 shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setFilters((fs) => [
                      ...fs,
                      { field: "source", operator: "is", value: "" },
                    ])
                  }
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Plus className="w-3.5 h-3.5" /> Add filter (AND)
                </button>
              </div>
            )}

            {/* Channels */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Send via
              </span>
              {(["email", "whatsapp"] as Channel[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleChannel(c)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider border transition-colors",
                    channels.includes(c)
                      ? "border-primary/60 bg-primary/15 text-primary"
                      : "border-white/10 bg-foreground/[0.04] text-muted-foreground",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>

            {/* Preview */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={runPreview}
                disabled={
                  preview.isPending ||
                  !channels.length ||
                  (mode === "selected" && !selectedLeadIds.length)
                }
                className="rounded-full h-8 text-xs"
              >
                {preview.isPending && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                )}
                Preview recipients
              </Button>
              {previewData && (
                <span className="text-sm text-muted-foreground">
                  <strong className="text-foreground">
                    {previewData.matchingCount}
                  </strong>{" "}
                  matching · {previewData.included.length} will receive ·{" "}
                  {previewData.excluded.length} excluded
                </span>
              )}
            </div>

            {previewData && previewData.excluded.length > 0 && (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 max-h-36 overflow-y-auto space-y-1">
                {previewData.excluded.map((x) => (
                  <div
                    key={x.leadId}
                    className="text-xs flex items-center justify-between gap-2"
                  >
                    <span className="truncate">{x.name}</span>
                    <span className="text-amber-400/80 shrink-0">
                      {EXCLUSION_LABEL[x.reason] ?? x.reason}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose} className="rounded-full">
                Cancel
              </Button>
              <Button
                onClick={doSend}
                disabled={
                  send.isPending ||
                  !formId ||
                  !channels.length ||
                  (mode === "selected" && !selectedLeadIds.length)
                }
                className="rounded-full bg-primary hover:bg-primary/90"
              >
                {send.isPending ? "Queuing…" : "Send feedback form"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
