import { Router, type IRouter } from "express";
import { activeDealerId } from "../../middlewares/rbac";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  db,
  conversations,
  messages,
  vehiclesTable,
  leadsTable,
  dealsTable,
  serviceOrdersTable,
} from "@workspace/db";
import {
  CreateAnthropicConversationBody,
  SendAnthropicMessageBody,
} from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  isAgentEnabled,
  recordAgentRun,
  guardUntrusted,
} from "../../lib/agent-governance";

const router: IRouter = Router();

// Grounding data is ALWAYS scoped to the active dealer: the concierge must
// never see (or leak) another tenant's inventory, pipeline, or service book.
async function buildSystemPrompt(dealerId: number): Promise<string> {
  const [vehicles, leads, deals, serviceOrders] = await Promise.all([
    db.select().from(vehiclesTable).where(eq(vehiclesTable.dealerId, dealerId)),
    db.select().from(leadsTable).where(eq(leadsTable.dealerId, dealerId)),
    db.select().from(dealsTable).where(eq(dealsTable.dealerId, dealerId)),
    db
      .select()
      .from(serviceOrdersTable)
      .where(eq(serviceOrdersTable.dealerId, dealerId)),
  ]);

  const available = vehicles.filter((v) => v.status === "available").slice(0, 40);
  const inventoryLines = available
    .map(
      (v) =>
        `- ${v.year} ${v.make} ${v.model} ${v.trim} (${v.powertrain}) — $${v.price.toLocaleString()}, ${v.exteriorColor}, status ${v.status}`,
    )
    .join("\n");

  const openLeads = leads.filter((l) => l.phase !== "won").slice(0, 40);
  const leadLines = openLeads
    .map(
      (l) =>
        `- ${l.name} (${l.phase}, score ${l.aiScore}) via ${l.channel}${l.assignedTo ? `, handled by ${l.assignedTo}` : ""}`,
    )
    .join("\n");

  const activeDeals = deals.filter((d) => d.stage !== "delivered").slice(0, 40);
  const dealLines = activeDeals
    .map((d) => `- ${d.customerName}: ${d.stage} stage, OTD $${d.otdPrice.toLocaleString()}`)
    .join("\n");

  const openService = serviceOrders
    .filter((s) => s.status !== "completed" && s.status !== "delivered")
    .slice(0, 40);
  const serviceLines = openService
    .map((s) => `- ${s.customerName}: ${s.vehicleInfo}, ${s.type} (${s.status})`)
    .join("\n");

  return [
    "You are AURA, the AI concierge that runs an ultra-premium automotive dealership.",
    "You quietly orchestrate a fleet of specialist agents (Concierge, Sales, Appraisal, Finance, Inventory, Scheduler, Service, Retention) behind the scenes.",
    "You speak with the polish of a luxury brand: warm, confident, concise, and never robotic. Never mention JSON, APIs, databases, or technical implementation.",
    "When asked what to do next with a customer or lead, give a crisp, realistic sequence of next steps and name which specialist handles each.",
    "Use the live dealership data below to answer precisely. If asked about something not in the data, say so gracefully.",
    "",
    "AVAILABLE INVENTORY:",
    inventoryLines || "- (none available)",
    "",
    "OPEN LEADS IN THE PIPELINE:",
    leadLines || "- (none)",
    "",
    "ACTIVE DEALS:",
    dealLines || "- (none)",
    "",
    "OPEN SERVICE ORDERS:",
    serviceLines || "- (none)",
  ].join("\n");
}

router.get("/anthropic/conversations", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.dealerId, activeDealerId(res)))
    .orderBy(desc(conversations.createdAt));
  res.json(rows);
});

router.post("/anthropic/conversations", async (req, res): Promise<void> => {
  const parsed = CreateAnthropicConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(conversations)
    .values({ title: parsed.data.title, dealerId: activeDealerId(res) })
    .returning();
  res.status(201).json(row);
});

router.get("/anthropic/conversations/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.id, id), eq(conversations.dealerId, activeDealerId(res))),
    );
  if (!conversation) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));
  res.json({ ...conversation, messages: msgs });
});

router.delete("/anthropic/conversations/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [deleted] = await db
    .delete(conversations)
    .where(
      and(eq(conversations.id, id), eq(conversations.dealerId, activeDealerId(res))),
    )
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

router.get(
  "/anthropic/conversations/:id/messages",
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.dealerId, activeDealerId(res)),
        ),
      );
    if (!conversation) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));
    res.json(msgs);
  },
);

router.post(
  "/anthropic/conversations/:id/messages",
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const parsed = SendAnthropicMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.dealerId, activeDealerId(res)),
        ),
      );
    if (!conversation) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Concierge kill switch (R3) — this chat surface is the same governed
    // HITL concierge agent; when paused for the dealer it is unreachable.
    if (!(await isAgentEnabled(conversation.dealerId, "concierge"))) {
      await recordAgentRun({
        dealerId: conversation.dealerId,
        agentKey: "concierge",
        runType: "chat_turn",
        inputSource: "concierge_chat",
        status: "blocked",
        errorMessage: "Agent paused by kill switch",
      });
      res.status(409).json({
        error: "The Concierge assistant is paused for this dealership.",
      });
      return;
    }
    const startedAt = Date.now();

    await db.insert(messages).values({
      conversationId: id,
      dealerId: conversation.dealerId,
      role: "user",
      content: parsed.data.content,
    });

    const history = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, id)))
      .orderBy(desc(messages.createdAt))
      .limit(20);

    const chatMessages = history
      .reverse()
      .map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        // User-typed chat content is untrusted — wrap it in the shared
        // injection guard so pasted "instructions" are treated as data.
        content:
          m.role === "assistant"
            ? m.content
            : guardUntrusted("user_message", m.content, 8000),
      }));

    const systemPrompt = await buildSystemPrompt(conversation.dealerId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const controller = new AbortController();
    let clientClosed = false;
    let persisted = false;
    let fullResponse = "";

    const persist = async () => {
      if (persisted || fullResponse.length === 0) return;
      persisted = true;
      try {
        await db.insert(messages).values({
          conversationId: id,
          dealerId: conversation.dealerId,
          role: "assistant",
          content: fullResponse,
        });
      } catch (err) {
        req.log.error({ err }, "Failed to persist assistant message");
      }
    };

    // If the client disconnects mid-stream, abort the upstream call so we
    // stop consuming tokens, and persist whatever was generated so far.
    res.on("close", () => {
      if (!res.writableEnded) {
        clientClosed = true;
        controller.abort();
        void persist();
      }
    });

    try {
      const stream = anthropic.messages.stream(
        {
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          system: systemPrompt,
          messages: chatMessages,
        },
        { signal: controller.signal },
      );

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          fullResponse += event.delta.text;
          res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
        }
      }

      await persist();
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      await recordAgentRun({
        dealerId: conversation.dealerId,
        agentKey: "concierge",
        runType: "chat_turn",
        inputSource: "concierge_chat",
        inputSummary: `Conversation #${id}`,
        outputSummary: fullResponse.slice(0, 300),
        refType: "conversation",
        refId: id,
        latencyMs: Date.now() - startedAt,
      });
    } catch (err) {
      if (clientClosed) {
        // Expected abort after client disconnect — partial already persisted.
        return;
      }
      req.log.error({ err }, "Anthropic stream failed");
      await persist();
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: "The assistant is unavailable right now." })}\n\n`,
        );
        res.end();
      }
    }
  },
);

export default router;
