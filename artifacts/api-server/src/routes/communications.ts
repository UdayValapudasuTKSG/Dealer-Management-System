import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  db,
  customersTable,
  emailLogsTable,
  commNotesTable,
  timelineEventsTable,
} from "@workspace/db";
import {
  GetCustomerCommunicationsParams,
  GetCustomerCommunicationsResponse,
  CreateCommNoteParams,
  CreateCommNoteBody,
  CreateCommNoteResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get(
  "/customers/:id/communications",
  async (req, res): Promise<void> => {
    const params = GetCustomerCommunicationsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const customerId = params.data.id;
    const [customer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.id, customerId));
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const [emails, notes, timeline] = await Promise.all([
      db
        .select()
        .from(emailLogsTable)
        .where(eq(emailLogsTable.customerId, customerId))
        .orderBy(desc(emailLogsTable.createdAt)),
      db
        .select()
        .from(commNotesTable)
        .where(eq(commNotesTable.customerId, customerId))
        .orderBy(desc(commNotesTable.createdAt)),
      db
        .select()
        .from(timelineEventsTable)
        .where(eq(timelineEventsTable.customerId, customerId))
        .orderBy(desc(timelineEventsTable.createdAt)),
    ]);
    res.json(
      GetCustomerCommunicationsResponse.parse({ emails, notes, timeline }),
    );
  },
);

router.post("/customers/:id/comm-notes", async (req, res): Promise<void> => {
  const user = res.locals.user;
  const params = CreateCommNoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateCommNoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const customerId = params.data.id;
  const [customer] = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const loggedBy = user?.name ?? user?.email ?? "Unknown";
  const [note] = await db
    .insert(commNotesTable)
    .values({
      customerId,
      kind: parsed.data.kind,
      subject: parsed.data.subject,
      notes: parsed.data.notes ?? null,
      outcome: parsed.data.outcome ?? null,
      loggedBy,
    })
    .returning();

  await db.insert(timelineEventsTable).values({
    customerId,
    domain: "system",
    kind: parsed.data.kind === "call" ? "call_logged" : "meeting_logged",
    title:
      parsed.data.kind === "call"
        ? `Call logged: ${parsed.data.subject}`
        : `Meeting logged: ${parsed.data.subject}`,
    detail: parsed.data.notes ?? null,
    actor: loggedBy,
    isAgent: false,
    refType: "comm_note",
    refId: note!.id,
  });

  res.status(201).json(CreateCommNoteResponse.parse(note));
});

export default router;
