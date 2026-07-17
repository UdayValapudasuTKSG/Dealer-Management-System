import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
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
import { activeDealerId } from "../middlewares/rbac";

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
    const dealerId = activeDealerId(res);
    const [customer] = await db
      .select()
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, customerId),
          eq(customersTable.dealerId, dealerId),
        ),
      );
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const [emails, notes, timeline] = await Promise.all([
      db
        .select()
        .from(emailLogsTable)
        .where(
          and(
            eq(emailLogsTable.customerId, customerId),
            eq(emailLogsTable.dealerId, dealerId),
          ),
        )
        .orderBy(desc(emailLogsTable.createdAt)),
      db
        .select()
        .from(commNotesTable)
        .where(
          and(
            eq(commNotesTable.customerId, customerId),
            eq(commNotesTable.dealerId, dealerId),
          ),
        )
        .orderBy(desc(commNotesTable.createdAt)),
      db
        .select()
        .from(timelineEventsTable)
        .where(
          and(
            eq(timelineEventsTable.customerId, customerId),
            eq(timelineEventsTable.dealerId, dealerId),
          ),
        )
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
  const dealerId = activeDealerId(res);
  const [customer] = await db
    .select()
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, customerId),
        eq(customersTable.dealerId, dealerId),
      ),
    );
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const loggedBy = user?.name ?? user?.email ?? "Unknown";
  const [note] = await db
    .insert(commNotesTable)
    .values({
      dealerId,
      customerId,
      kind: parsed.data.kind,
      subject: parsed.data.subject,
      notes: parsed.data.notes ?? null,
      outcome: parsed.data.outcome ?? null,
      loggedBy,
    })
    .returning();

  await db.insert(timelineEventsTable).values({
    dealerId,
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
