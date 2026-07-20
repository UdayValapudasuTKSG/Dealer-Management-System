import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  useListTasks,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  useListTaskComments,
  useCreateTaskComment,
  useListAdminUsers,
  getListTasksQueryKey,
  getListTaskCommentsQueryKey,
  type Task,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  ClipboardList,
  Plus,
  Loader2,
  Trash2,
  MessageSquare,
  Send,
  CalendarDays,
  Flag,
} from "lucide-react";

const STATUS_COLUMNS = [
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In Progress" },
  { key: "done", label: "Done" },
] as const;

function todayString(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function dueState(task: Task): "overdue" | "due-soon" | null {
  if (!task.dueDate || task.status === "done") return null;
  const today = todayString();
  if (task.dueDate < today) return "overdue";
  if (task.dueDate === today) return "due-soon";
  return null;
}

const PRIORITY_STYLE: Record<string, string> = {
  urgent: "border-red-500/50 text-red-400",
  high: "border-orange-500/40 text-orange-400",
  normal: "border-white/15 text-muted-foreground",
  low: "border-white/10 text-muted-foreground/60",
};

export default function Tasks() {
  const { me } = useAuthz();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: tasks, isLoading } = useListTasks();
  const { data: users } = useListAdminUsers();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [filterMine, setFilterMine] = useState(false);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListTasksQueryKey() });

  const createTask = useCreateTask({
    mutation: {
      onSuccess: () => {
        invalidate();
        setCreateOpen(false);
        toast({ title: "Task created" });
      },
      onError: (e) =>
        toast({
          title: "Could not create task",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });
  const updateTask = useUpdateTask({
    mutation: { onSuccess: invalidate },
  });
  const deleteTask = useDeleteTask({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDetailTask(null);
        toast({ title: "Task deleted" });
      },
    },
  });

  const visible = useMemo(
    () =>
      (tasks ?? []).filter(
        (t) => !filterMine || t.assigneeUserId === me?.id,
      ),
    [tasks, filterMine, me?.id],
  );

  // Keep the detail dialog in sync with fresh list data.
  const liveDetail = detailTask
    ? ((tasks ?? []).find((t) => t.id === detailTask.id) ?? detailTask)
    : null;

  return (
    <>
    <PageHero

      eyebrow="Back Office"
      title="Tasks"
      subtitle="Team follow-ups, deliveries and internal to-dos."
    />
    <Page className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFilterMine((v) => !v)}
            className={cn(
              "rounded-full px-4 py-1.5 text-sm font-medium border transition-colors",
              filterMine
                ? "border-primary/50 bg-primary/15 text-primary"
                : "border-white/10 text-muted-foreground hover:text-foreground",
            )}
          >
            My tasks
          </button>
          <Button onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" /> New Task
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-24">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {STATUS_COLUMNS.map((col) => {
            const items = visible.filter((t) => t.status === col.key);
            return (
              <div
                key={col.key}
                className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-3 min-h-[200px]"
              >
                <div className="flex items-center justify-between px-1">
                  <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                    {col.label}
                  </span>
                  <span className="text-xs text-muted-foreground/60">
                    {items.length}
                  </span>
                </div>
                <AnimatePresence initial={false}>
                  {items.map((t) => (
                    <motion.button
                      key={t.id}
                      layout
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.97 }}
                      onClick={() => setDetailTask(t)}
                      className={cn(
                        "w-full text-left rounded-xl border p-4 transition-colors",
                        dueState(t) === "overdue"
                          ? "border-red-500/40 bg-red-500/[0.06] hover:bg-red-500/[0.1]"
                          : "border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06]",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span
                          className={cn(
                            "text-sm font-medium leading-snug",
                            t.status === "done" &&
                              "line-through text-muted-foreground",
                          )}
                        >
                          {t.title}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "shrink-0 text-[10px] uppercase tracking-wider",
                            PRIORITY_STYLE[t.priority],
                          )}
                        >
                          {t.priority}
                        </Badge>
                      </div>
                      {t.description && (
                        <p className="mt-1.5 text-xs text-muted-foreground line-clamp-2">
                          {t.description}
                        </p>
                      )}
                      <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground/70">
                        {t.assigneeName && (
                          <span className="flex items-center gap-1.5">
                            <span className="h-5 w-5 rounded-full bg-primary/15 text-primary flex items-center justify-center text-[9px] font-bold">
                              {t.assigneeName.slice(0, 1).toUpperCase()}
                            </span>
                            {t.assigneeName}
                          </span>
                        )}
                        {t.dueDate && (
                          <span
                            className={cn(
                              "flex items-center gap-1",
                              dueState(t) === "overdue" && "text-red-400 font-semibold",
                              dueState(t) === "due-soon" &&
                                "text-orange-400 font-semibold",
                            )}
                          >
                            <CalendarDays className="h-3 w-3" /> {t.dueDate}
                            {dueState(t) === "overdue" && (
                              <span className="ml-1 rounded-full border border-red-500/50 bg-red-500/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-red-400">
                                Overdue
                              </span>
                            )}
                            {dueState(t) === "due-soon" && (
                              <span className="ml-1 rounded-full border border-orange-500/40 bg-orange-500/10 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-orange-400">
                                Due today
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    </motion.button>
                  ))}
                </AnimatePresence>
                {items.length === 0 && (
                  <div className="rounded-xl border border-dashed border-white/[0.08] py-8 text-center text-xs text-muted-foreground/50">
                    Nothing here
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        users={users ?? []}
        onSubmit={(data) => createTask.mutate({ data })}
        pending={createTask.isPending}
      />

      <TaskDetailDialog
        task={liveDetail}
        users={users ?? []}
        onClose={() => setDetailTask(null)}
        onUpdate={(id, data) => updateTask.mutate({ id, data })}
        onDelete={(id) => deleteTask.mutate({ id })}
      />
    </Page>
    </>
  );
}

type UserLite = { id: number; name?: string | null; email?: string | null };

function CreateTaskDialog({
  open,
  onOpenChange,
  users,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  users: UserLite[];
  onSubmit: (data: {
    title: string;
    description?: string;
    assigneeUserId?: number;
    dueDate?: string;
    priority?: "low" | "normal" | "high" | "urgent";
  }) => void;
  pending: boolean;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState<string>("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState<"low" | "normal" | "high" | "urgent">("normal");

  const submit = () => {
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      assigneeUserId: assignee ? Number(assignee) : undefined,
      dueDate: dueDate || undefined,
      priority,
    });
    setTitle("");
    setDescription("");
    setAssignee("");
    setDueDate("");
    setPriority("normal");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Task</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
          <div className="grid grid-cols-2 gap-3">
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger>
                <SelectValue placeholder="Assignee" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.name ?? u.email ?? `User #${u.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={priority}
              onValueChange={(v) => setPriority(v as typeof priority)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="urgent">Urgent</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          <Button
            onClick={submit}
            disabled={pending || !title.trim()}
            className="w-full gap-2"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Create Task
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TaskDetailDialog({
  task,
  users,
  onClose,
  onUpdate,
  onDelete,
}: {
  task: Task | null;
  users: UserLite[];
  onClose: () => void;
  onUpdate: (
    id: number,
    data: Partial<{
      status: "open" | "in_progress" | "done";
      assigneeUserId: number;
      priority: "low" | "normal" | "high" | "urgent";
    }>,
  ) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <Dialog open={!!task} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        {task && (
          <>
            <DialogHeader>
              <DialogTitle className="pr-8">{task.title}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {task.description && (
                <p className="text-sm text-muted-foreground">{task.description}</p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Status
                  </div>
                  <Select
                    value={task.status}
                    onValueChange={(v) =>
                      onUpdate(task.id, { status: v as "open" | "in_progress" | "done" })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">Open</SelectItem>
                      <SelectItem value="in_progress">In Progress</SelectItem>
                      <SelectItem value="done">Done</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Assignee
                  </div>
                  <Select
                    value={task.assigneeUserId != null ? String(task.assigneeUserId) : ""}
                    onValueChange={(v) =>
                      onUpdate(task.id, { assigneeUserId: Number(v) })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Unassigned" />
                    </SelectTrigger>
                    <SelectContent>
                      {users.map((u) => (
                        <SelectItem key={u.id} value={String(u.id)}>
                          {u.name ?? u.email ?? `User #${u.id}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Flag className="h-3.5 w-3.5" /> {task.priority} priority
                  {task.dueDate ? ` · due ${task.dueDate}` : ""}
                </span>
                <button
                  onClick={() => onDelete(task.id)}
                  className="flex items-center gap-1 text-red-400/80 hover:text-red-400 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </div>
              <TaskComments taskId={task.id} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TaskComments({ taskId }: { taskId: number }) {
  const qc = useQueryClient();
  const { data: comments } = useListTaskComments(taskId);
  const [body, setBody] = useState("");
  const create = useCreateTaskComment({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListTaskCommentsQueryKey(taskId) });
        setBody("");
      },
    },
  });

  return (
    <div className="border-t border-white/10 pt-4 space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <MessageSquare className="h-3.5 w-3.5" /> Comments
      </div>
      <div className="space-y-2.5 max-h-48 overflow-y-auto pr-1">
        {(comments ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground/60">No comments yet.</p>
        )}
        {(comments ?? []).map((c) => (
          <div key={c.id} className="rounded-lg bg-foreground/[0.03] px-3 py-2">
            <div className="text-[11px] font-semibold text-primary/90">
              {c.authorName}
            </div>
            <div className="text-sm mt-0.5">{c.body}</div>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          placeholder="Add a comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && body.trim()) {
              create.mutate({ id: taskId, data: { body: body.trim() } });
            }
          }}
        />
        <Button
          size="icon"
          disabled={!body.trim() || create.isPending}
          onClick={() => create.mutate({ id: taskId, data: { body: body.trim() } })}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
