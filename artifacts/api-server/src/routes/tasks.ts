import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, tasksTable, taskCommentsTable, usersTable } from "@workspace/db";
import {
  ListTasksQueryParams,
  ListTasksResponse,
  CreateTaskBody,
  CreateTaskResponse,
  UpdateTaskParams,
  UpdateTaskBody,
  UpdateTaskResponse,
  DeleteTaskParams,
  ListTaskCommentsParams,
  ListTaskCommentsResponse,
  CreateTaskCommentParams,
  CreateTaskCommentBody,
  CreateTaskCommentResponse,
} from "@workspace/api-zod";
import { notifyUser } from "../lib/email";

const router: IRouter = Router();

// The test-harness bypass user (and any stale session) may carry an id that
// doesn't exist in the users table — never write those into FK columns.
async function existingUserId(id: number | undefined | null): Promise<number | null> {
  if (id == null) return null;
  const [row] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, id));
  return row ? row.id : null;
}

async function userNames(): Promise<Map<number, string>> {
  const rows = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable);
  return new Map(rows.map((u) => [u.id, u.name ?? u.email ?? `User #${u.id}`]));
}

function withNames(
  task: typeof tasksTable.$inferSelect,
  names: Map<number, string>,
) {
  return {
    ...task,
    assigneeName:
      task.assigneeUserId != null ? (names.get(task.assigneeUserId) ?? null) : null,
    createdByName:
      task.createdByUserId != null
        ? (names.get(task.createdByUserId) ?? null)
        : null,
  };
}

router.get("/tasks", async (req, res): Promise<void> => {
  const query = ListTasksQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const filters = [
    query.data.status !== undefined
      ? eq(tasksTable.status, query.data.status)
      : undefined,
    query.data.assigneeUserId !== undefined
      ? eq(tasksTable.assigneeUserId, query.data.assigneeUserId)
      : undefined,
  ].filter((f): f is NonNullable<typeof f> => Boolean(f));
  const [rows, names] = await Promise.all([
    db
      .select()
      .from(tasksTable)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(tasksTable.createdAt)),
    userNames(),
  ]);
  res.json(ListTasksResponse.parse(rows.map((t) => withNames(t, names))));
});

router.post("/tasks", async (req, res): Promise<void> => {
  const user = res.locals.user;
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dueDate = parsed.data.dueDate
    ? new Date(parsed.data.dueDate).toISOString().slice(0, 10)
    : null;
  const [creatorId, assigneeId] = await Promise.all([
    existingUserId(user?.id),
    existingUserId(parsed.data.assigneeUserId),
  ]);
  const [task] = await db
    .insert(tasksTable)
    .values({
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      assigneeUserId: assigneeId,
      createdByUserId: creatorId,
      dueDate,
      priority: parsed.data.priority ?? "normal",
      attachments: parsed.data.attachments ?? [],
    })
    .returning();

  if (task?.assigneeUserId && task.assigneeUserId !== user?.id) {
    await notifyUser({
      userId: task.assigneeUserId,
      type: "task",
      title: `New task assigned: ${task.title}`,
      body: `${user?.name ?? user?.email ?? "A teammate"} assigned you a ${task.priority}-priority task${task.dueDate ? ` due ${task.dueDate}` : ""}.`,
      link: "/tasks",
    });
  }

  const names = await userNames();
  res.status(201).json(CreateTaskResponse.parse(withNames(task!, names)));
});

router.patch("/tasks/:id", async (req, res): Promise<void> => {
  const user = res.locals.user;
  const params = UpdateTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const { dueDate: rawDueDate, ...rest } = parsed.data;
  const patch: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (rawDueDate !== undefined) {
    const nextDueDate = new Date(rawDueDate).toISOString().slice(0, 10);
    patch.dueDate = nextDueDate;
    // A changed due date restarts the reminder cycle.
    if (nextDueDate !== existing.dueDate) {
      patch.dueSoonNotifiedAt = null;
      patch.overdueNotifiedAt = null;
    }
  }
  if (parsed.data.status === "done" && existing.status !== "done") {
    patch.completedAt = new Date();
  }
  if (parsed.data.status && parsed.data.status !== "done") {
    patch.completedAt = null;
  }

  const [task] = await db
    .update(tasksTable)
    .set(patch)
    .where(eq(tasksTable.id, params.data.id))
    .returning();

  if (
    parsed.data.assigneeUserId !== undefined &&
    parsed.data.assigneeUserId !== existing.assigneeUserId &&
    parsed.data.assigneeUserId !== user?.id
  ) {
    await notifyUser({
      userId: parsed.data.assigneeUserId,
      type: "task",
      title: `Task reassigned to you: ${task!.title}`,
      body: `${user?.name ?? user?.email ?? "A teammate"} assigned this task to you.`,
      link: "/tasks",
    });
  }
  if (
    parsed.data.status === "done" &&
    existing.status !== "done" &&
    existing.createdByUserId &&
    existing.createdByUserId !== user?.id
  ) {
    await notifyUser({
      userId: existing.createdByUserId,
      type: "task",
      title: `Task completed: ${task!.title}`,
      body: `${user?.name ?? user?.email ?? "A teammate"} marked this task as done.`,
      link: "/tasks",
    });
  }

  const names = await userNames();
  res.json(UpdateTaskResponse.parse(withNames(task!, names)));
});

router.delete("/tasks/:id", async (req, res): Promise<void> => {
  const params = DeleteTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db.delete(tasksTable).where(eq(tasksTable.id, params.data.id));
  res.status(204).end();
});

router.get("/tasks/:id/comments", async (req, res): Promise<void> => {
  const params = ListTaskCommentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(taskCommentsTable)
    .where(eq(taskCommentsTable.taskId, params.data.id))
    .orderBy(taskCommentsTable.createdAt);
  res.json(ListTaskCommentsResponse.parse(rows));
});

router.post("/tasks/:id/comments", async (req, res): Promise<void> => {
  const user = res.locals.user;
  const params = CreateTaskCommentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateTaskCommentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, params.data.id));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const [comment] = await db
    .insert(taskCommentsTable)
    .values({
      taskId: task.id,
      authorUserId: await existingUserId(user?.id),
      authorName: user?.name ?? user?.email ?? "Unknown",
      body: parsed.data.body,
    })
    .returning();

  const commenter = user?.id;
  const toNotify = [task.assigneeUserId, task.createdByUserId].filter(
    (id): id is number => id != null && id !== commenter,
  );
  for (const userId of Array.from(new Set(toNotify))) {
    await notifyUser({
      userId,
      type: "task",
      title: `New comment on: ${task.title}`,
      body: `${user?.name ?? user?.email ?? "A teammate"}: ${parsed.data.body.slice(0, 120)}`,
      link: "/tasks",
    });
  }

  res.status(201).json(CreateTaskCommentResponse.parse(comment));
});

export default router;
