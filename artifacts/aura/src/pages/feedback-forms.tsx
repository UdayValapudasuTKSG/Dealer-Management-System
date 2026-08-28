import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFeedbackForms,
  useCreateFeedbackForm,
  useUpdateFeedbackForm,
  useSetFeedbackFormStatus,
  useDuplicateFeedbackForm,
  useListFeedbackFormInvitations,
  getListFeedbackFormsQueryKey,
  type FeedbackForm,
  type FeedbackQuestion,
  type FeedbackQuestionType,
} from "@workspace/api-client-react";
import {
  Plus,
  Star,
  Trash2,
  ArrowUp,
  ArrowDown,
  Copy,
  Archive,
  RotateCcw,
  Eye,
  Send,
  Pencil,
  ClipboardList,
  Loader2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useAuthz } from "@/lib/auth";
import { formatGuyanaDate } from "@/lib/format";

const TYPE_LABEL: Record<FeedbackQuestionType, string> = {
  text: "Short text",
  long_text: "Long text",
  single_choice: "Single choice",
  multi_choice: "Multiple choice",
  star_rating: "Star rating",
};

const newQuestion = (type: FeedbackQuestionType): FeedbackQuestion => ({
  id: `q_${Math.random().toString(36).slice(2, 10)}`,
  type,
  label: "",
  required: true,
  ...(type === "single_choice" || type === "multi_choice"
    ? { options: ["", ""] }
    : {}),
  ...(type === "star_rating" ? { maxStars: 5 } : {}),
});

const STATUS_STYLE: Record<string, string> = {
  draft: "text-amber-400 bg-amber-500/10",
  published: "text-emerald-400 bg-emerald-500/10",
  archived: "text-muted-foreground bg-foreground/[0.06]",
};

/** GM-only feedback form catalog + builder. */
export default function FeedbackForms() {
  const { me } = useAuthz();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: forms, isLoading, error } = useListFeedbackForms();
  const createForm = useCreateFeedbackForm();
  const updateForm = useUpdateFeedbackForm();
  const setStatus = useSetFeedbackFormStatus();
  const duplicate = useDuplicateFeedbackForm();

  const [editing, setEditing] = useState<FeedbackForm | "new" | null>(null);
  const [previewForm, setPreviewForm] = useState<FeedbackForm | null>(null);
  const [responsesForm, setResponsesForm] = useState<FeedbackForm | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListFeedbackFormsQueryKey() });

  const isGM =
    !!me &&
    (me.isSuperAdmin ||
      me.roleName === "General Manager");

  if (me && !isGM) {
    return (
      <Page>
        <div className="flex items-center justify-center h-60 rounded-2xl border-2 border-dashed border-border/60 text-muted-foreground text-sm">
          Feedback forms are managed by the General Manager.
        </div>
      </Page>
    );
  }

  const act = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      await invalidate();
      toast({ title: success });
    } catch (e) {
      toast({
        title: "Something went wrong",
        description: e instanceof Error ? e.message : "Unexpected error",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <PageHero
        eyebrow="Sales"
        title="Feedback Forms"
        subtitle="Build reusable feedback forms and send them to leads from the Pipeline."
        className="pb-3"
        action={
          <Button
            onClick={() => setEditing("new")}
            className="bg-primary hover:bg-primary/90 text-white rounded-full px-4 h-9 text-sm gap-1.5"
          >
            <Plus className="w-4 h-4" /> New Form
          </Button>
        }
      />
      <Page className="pt-0">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-20 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading forms…
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-40 rounded-2xl border border-red-500/30 bg-red-500/5 text-red-400 text-sm">
            {error instanceof Error ? error.message : "Could not load forms"}
          </div>
        ) : !forms?.length ? (
          <div className="flex flex-col items-center justify-center h-60 rounded-2xl border-2 border-dashed border-border/60 text-muted-foreground gap-3">
            <ClipboardList className="w-8 h-8 opacity-40" />
            <div className="text-sm">
              No feedback forms yet — create your first one.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {forms.map((f) => (
              <div
                key={f.id}
                className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-4 flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{f.name}</div>
                    {f.description && (
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {f.description}
                      </div>
                    )}
                  </div>
                  <span
                    className={cn(
                      "shrink-0 inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full",
                      STATUS_STYLE[f.status],
                    )}
                  >
                    {f.status}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-4">
                  <span>{f.questions.length} question{f.questions.length === 1 ? "" : "s"}</span>
                  <span className="inline-flex items-center gap-1">
                    <Send className="w-3 h-3" /> {f.sentCount} sent
                  </span>
                  <span>{f.responseCount} responses</span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mt-auto pt-2 border-t border-white/5">
                  {f.status !== "archived" && (
                    <IconBtn title="Edit" onClick={() => setEditing(f)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </IconBtn>
                  )}
                  <IconBtn title="Preview" onClick={() => setPreviewForm(f)}>
                    <Eye className="w-3.5 h-3.5" />
                  </IconBtn>
                  <IconBtn
                    title="Duplicate"
                    onClick={() =>
                      act(
                        () => duplicate.mutateAsync({ id: f.id }),
                        "Form duplicated as a draft",
                      )
                    }
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </IconBtn>
                  {(f.sentCount > 0 || f.responseCount > 0) && (
                    <IconBtn title="Deliveries & responses" onClick={() => setResponsesForm(f)}>
                      <ClipboardList className="w-3.5 h-3.5" />
                    </IconBtn>
                  )}
                  <div className="flex-1" />
                  {f.status === "draft" && (
                    <Button
                      size="sm"
                      className="h-7 rounded-full text-xs bg-emerald-600 hover:bg-emerald-500"
                      onClick={() =>
                        act(
                          () =>
                            setStatus.mutateAsync({
                              id: f.id,
                              data: { action: "publish" },
                            }),
                          "Form published — send it from the Pipeline",
                        )
                      }
                    >
                      Publish
                    </Button>
                  )}
                  {f.status === "published" && (
                    <IconBtn
                      title="Archive"
                      onClick={() =>
                        act(
                          () =>
                            setStatus.mutateAsync({
                              id: f.id,
                              data: { action: "archive" },
                            }),
                          "Form archived",
                        )
                      }
                    >
                      <Archive className="w-3.5 h-3.5" />
                    </IconBtn>
                  )}
                  {f.status === "archived" && (
                    <IconBtn
                      title="Reactivate"
                      onClick={() =>
                        act(
                          () =>
                            setStatus.mutateAsync({
                              id: f.id,
                              data: { action: "reactivate" },
                            }),
                          "Form reactivated",
                        )
                      }
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </IconBtn>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Page>

      {editing && (
        <FormEditorDialog
          form={editing === "new" ? null : editing}
          pending={createForm.isPending || updateForm.isPending}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            try {
              if (editing === "new") {
                await createForm.mutateAsync({ data: payload });
                toast({ title: "Form created as a draft" });
              } else {
                await updateForm.mutateAsync({ id: editing.id, data: payload });
                toast({ title: "Form updated" });
              }
              await invalidate();
              setEditing(null);
            } catch (e) {
              toast({
                title: "Could not save form",
                description: e instanceof Error ? e.message : "Unexpected error",
                variant: "destructive",
              });
            }
          }}
        />
      )}

      {previewForm && (
        <Dialog open onOpenChange={() => setPreviewForm(null)}>
          <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{previewForm.name}</DialogTitle>
              <DialogDescription>
                Customer preview — exactly what the lead will see.
              </DialogDescription>
            </DialogHeader>
            <QuestionPreview questions={previewForm.questions} />
          </DialogContent>
        </Dialog>
      )}

      {responsesForm && (
        <ResponsesDialog form={responsesForm} onClose={() => setResponsesForm(null)} />
      )}
    </>
  );
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="h-7 w-7 rounded-full border border-white/10 bg-white/[0.04] hover:bg-white/[0.1] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
    >
      {children}
    </button>
  );
}

export function QuestionPreview({ questions }: { questions: FeedbackQuestion[] }) {
  return (
    <div className="space-y-5">
      {questions.map((q, i) => (
        <div key={q.id}>
          <div className="text-sm font-medium mb-1.5">
            <span className="text-muted-foreground mr-1">{i + 1}.</span>
            {q.label || <em className="text-muted-foreground">Untitled question</em>}
            {q.required && <span className="text-red-400 ml-1">*</span>}
          </div>
          {q.type === "text" && (
            <div className="h-9 rounded-lg bg-foreground/[0.05] border border-white/10" />
          )}
          {q.type === "long_text" && (
            <div className="h-20 rounded-lg bg-foreground/[0.05] border border-white/10" />
          )}
          {(q.type === "single_choice" || q.type === "multi_choice") && (
            <div className="space-y-1.5">
              {(q.options ?? []).map((o, oi) => (
                <div
                  key={oi}
                  className="flex items-center gap-2 rounded-lg bg-foreground/[0.04] border border-white/10 px-3 py-2 text-sm text-muted-foreground"
                >
                  <span
                    className={cn(
                      "inline-block w-3.5 h-3.5 border border-white/30",
                      q.type === "single_choice" ? "rounded-full" : "rounded",
                    )}
                  />
                  {o || `Option ${oi + 1}`}
                </div>
              ))}
            </div>
          )}
          {q.type === "star_rating" && (
            <div className="flex gap-1">
              {Array.from({ length: q.maxStars ?? 5 }).map((_, si) => (
                <Star key={si} className="w-5 h-5 text-amber-400/50" />
              ))}
            </div>
          )}
        </div>
      ))}
      {!questions.length && (
        <div className="text-sm text-muted-foreground">No questions yet.</div>
      )}
    </div>
  );
}

function FormEditorDialog({
  form,
  pending,
  onClose,
  onSave,
}: {
  form: FeedbackForm | null;
  pending: boolean;
  onClose: () => void;
  onSave: (payload: {
    name: string;
    description?: string | null;
    questions: FeedbackQuestion[];
  }) => void;
}) {
  const [name, setName] = useState(form?.name ?? "");
  const [description, setDescription] = useState(form?.description ?? "");
  const [questions, setQuestions] = useState<FeedbackQuestion[]>(
    form?.questions ?? [],
  );
  const [error, setError] = useState<string | null>(null);

  const patchQ = (id: string, patch: Partial<FeedbackQuestion>) =>
    setQuestions((qs) => qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const move = (idx: number, dir: -1 | 1) =>
    setQuestions((qs) => {
      const next = [...qs];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return qs;
      [next[idx], next[target]] = [next[target]!, next[idx]!];
      return next;
    });

  const save = () => {
    setError(null);
    if (!name.trim()) return setError("Give the form a name");
    for (const q of questions) {
      if (!q.label.trim()) return setError("Every question needs a label");
      if (
        (q.type === "single_choice" || q.type === "multi_choice") &&
        (q.options ?? []).filter((o) => o.trim()).length < 2
      )
        return setError(`"${q.label}" needs at least two choices`);
    }
    onSave({
      name: name.trim(),
      description: description.trim() || null,
      questions: questions.map((q) => ({
        ...q,
        options: q.options?.filter((o) => o.trim()),
      })),
    });
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{form ? "Edit form" : "New feedback form"}</DialogTitle>
          <DialogDescription>
            Reusable form — leads answer a snapshot taken at send time.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Form name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Post test-drive feedback"
              className="mt-1 w-full h-10 rounded-lg bg-foreground/[0.05] border border-white/10 px-3 text-sm focus:outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Description (internal)
            </label>
            <input
              value={description ?? ""}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              className="mt-1 w-full h-10 rounded-lg bg-foreground/[0.05] border border-white/10 px-3 text-sm focus:outline-none focus:border-primary/50"
            />
          </div>

          <div className="space-y-3">
            {questions.map((q, i) => (
              <div
                key={q.id}
                className="rounded-xl border border-white/10 bg-foreground/[0.03] p-3 space-y-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground w-5">
                    {i + 1}.
                  </span>
                  <select
                    value={q.type}
                    onChange={(e) => {
                      const type = e.target.value as FeedbackQuestionType;
                      patchQ(q.id, {
                        type,
                        options:
                          type === "single_choice" || type === "multi_choice"
                            ? q.options?.length
                              ? q.options
                              : ["", ""]
                            : undefined,
                        maxStars: type === "star_rating" ? (q.maxStars ?? 5) : undefined,
                      });
                    }}
                    className="h-8 rounded-lg bg-foreground/[0.05] border border-white/10 text-xs px-2 focus:outline-none"
                  >
                    {(Object.keys(TYPE_LABEL) as FeedbackQuestionType[]).map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={q.required}
                      onChange={(e) => patchQ(q.id, { required: e.target.checked })}
                      className="w-3.5 h-3.5 accent-[var(--primary)]"
                    />
                    Required
                  </label>
                  <div className="flex-1" />
                  <IconBtn title="Move up" onClick={() => move(i, -1)}>
                    <ArrowUp className="w-3.5 h-3.5" />
                  </IconBtn>
                  <IconBtn title="Move down" onClick={() => move(i, 1)}>
                    <ArrowDown className="w-3.5 h-3.5" />
                  </IconBtn>
                  <IconBtn
                    title="Remove question"
                    onClick={() =>
                      setQuestions((qs) => qs.filter((x) => x.id !== q.id))
                    }
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  </IconBtn>
                </div>
                <input
                  value={q.label}
                  onChange={(e) => patchQ(q.id, { label: e.target.value })}
                  placeholder="Question label — e.g. How was your showroom visit?"
                  className="w-full h-9 rounded-lg bg-foreground/[0.05] border border-white/10 px-3 text-sm focus:outline-none focus:border-primary/50"
                />
                {(q.type === "single_choice" || q.type === "multi_choice") && (
                  <div className="space-y-1.5 pl-6">
                    {(q.options ?? []).map((opt, oi) => (
                      <div key={oi} className="flex items-center gap-2">
                        <input
                          value={opt}
                          onChange={(e) =>
                            patchQ(q.id, {
                              options: (q.options ?? []).map((o, j) =>
                                j === oi ? e.target.value : o,
                              ),
                            })
                          }
                          placeholder={`Choice ${oi + 1}`}
                          className="flex-1 h-8 rounded-lg bg-foreground/[0.05] border border-white/10 px-3 text-xs focus:outline-none focus:border-primary/50"
                        />
                        <button
                          type="button"
                          aria-label="Remove choice"
                          onClick={() =>
                            patchQ(q.id, {
                              options: (q.options ?? []).filter((_, j) => j !== oi),
                            })
                          }
                          className="text-muted-foreground hover:text-red-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        patchQ(q.id, { options: [...(q.options ?? []), ""] })
                      }
                      className="text-xs text-primary hover:underline"
                    >
                      + Add choice
                    </button>
                  </div>
                )}
                {q.type === "star_rating" && (
                  <div className="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
                    Scale:
                    <select
                      value={q.maxStars ?? 5}
                      onChange={(e) =>
                        patchQ(q.id, { maxStars: Number(e.target.value) })
                      }
                      className="h-7 rounded-lg bg-foreground/[0.05] border border-white/10 px-2 focus:outline-none"
                    >
                      {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                        <option key={n} value={n}>
                          1–{n} stars
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(TYPE_LABEL) as FeedbackQuestionType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setQuestions((qs) => [...qs, newQuestion(t)])}
                className="rounded-full border border-white/10 bg-foreground/[0.04] hover:bg-foreground/[0.08] px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                + {TYPE_LABEL[t]}
              </button>
            ))}
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-sm px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} className="rounded-full">
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={pending}
              className="rounded-full bg-primary hover:bg-primary/90"
            >
              {pending ? "Saving…" : form ? "Save changes" : "Create draft"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResponsesDialog({
  form,
  onClose,
}: {
  form: FeedbackForm;
  onClose: () => void;
}) {
  const { data: invitations, isLoading } = useListFeedbackFormInvitations(form.id);
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{form.name} — deliveries & responses</DialogTitle>
          <DialogDescription>
            Every invitation keeps the question snapshot it was sent with.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-10 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : !invitations?.length ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            Nothing sent yet.
          </div>
        ) : (
          <div className="space-y-2.5">
            {invitations.map((inv) => (
              <InvitationRow key={inv.id} inv={inv} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function InvitationRow({
  inv,
}: {
  inv: {
    id: number;
    leadName?: string | null;
    formName: string;
    status: string;
    channels: string[];
    delivery: Array<{ channel: string; status: string }>;
    questionsSnapshot?: FeedbackQuestion[];
    answers?: Record<string, unknown> | null;
    submittedAt?: string | null;
    createdAt: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const answered = inv.status === "completed";
  return (
    <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {inv.leadName ?? `Lead #${inv.id}`}
            <span className="text-muted-foreground font-normal"> · {inv.formName}</span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
            <span>Sent {formatGuyanaDate(inv.createdAt)}</span>
            {inv.delivery.map((d) => (
              <span
                key={d.channel}
                className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 uppercase tracking-wider text-[9px] font-semibold"
              >
                {d.channel}: {d.status}
              </span>
            ))}
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full",
            answered
              ? "text-emerald-400 bg-emerald-500/10"
              : "text-amber-400 bg-amber-500/10",
          )}
        >
          {answered
            ? `Answered ${inv.submittedAt ? formatGuyanaDate(inv.submittedAt) : ""}`
            : "Awaiting reply"}
        </span>
      </button>
      {open && answered && inv.questionsSnapshot && (
        <div className="mt-3 pt-3 border-t border-white/5 space-y-2.5">
          {inv.questionsSnapshot.map((q) => {
            const a = inv.answers?.[q.id];
            return (
              <div key={q.id}>
                <div className="text-xs text-muted-foreground">{q.label}</div>
                <div className="text-sm mt-0.5">
                  {a == null || (Array.isArray(a) && !a.length) ? (
                    <span className="text-muted-foreground/60">No answer</span>
                  ) : q.type === "star_rating" ? (
                    <span className="inline-flex items-center gap-1 text-amber-400">
                      {String(a)} <Star className="w-3.5 h-3.5 fill-amber-400" />
                      <span className="text-muted-foreground">
                        / {q.maxStars ?? 5}
                      </span>
                    </span>
                  ) : Array.isArray(a) ? (
                    a.join(", ")
                  ) : (
                    String(a)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {open && !answered && (
        <div className="mt-3 pt-3 border-t border-white/5 text-xs text-muted-foreground">
          No response yet — the link stays valid until it expires.
        </div>
      )}
    </div>
  );
}
