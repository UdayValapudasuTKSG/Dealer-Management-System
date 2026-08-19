import assert from "node:assert/strict";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  agentRunsTable,
  db,
  dealersTable,
  emailLogsTable,
  leadsTable,
  timelineEventsTable,
  whatsappConversationsTable,
  whatsappMessagesTable,
} from "@workspace/db";
import {
  captureTransport,
  WhatsappProviderSendError,
  whatsappDocumentMessagePayload,
  whatsappSendFailureDisposition,
} from "../lib/whatsapp";
import {
  claimWhatsappOutboxItem,
  enqueueWhatsapp,
  whatsappOutboxDisposition,
} from "../lib/email";
import { handleWhatsappMessage } from "../lib/whatsapp-flow";
import {
  allowedWhatsappDeliverySources,
  canApplyWhatsappDeliveryStatus,
  listWhatsappMessagesForLead,
  updateWhatsappDeliveryStatus,
} from "../lib/whatsapp-log";
import { normalizeWhatsappPhone } from "../lib/whatsapp-phone";
import {
  authorize,
  hasPermission,
  isImpersonationHardBlocked,
  routePermission,
  type AuthedUser,
} from "../middlewares/rbac";

function checkWhatsappReplyAuthorization(user: AuthedUser): {
  nextCalled: boolean;
  statusCode: number | null;
} {
  let nextCalled = false;
  let statusCode: number | null = null;
  const req = {
    method: "POST",
    path: "/deals/42/whatsapp",
  } as unknown as ExpressRequest;
  const res = {
    locals: {
      user,
      dealerId: 1,
      dealerLifecycleStatus: "active",
      dealerEntitlements: {},
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as ExpressResponse;
  authorize(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode };
}

const suffix = String(Date.now()).slice(-6);
const phone = `5926${suffix}`;
const dealerName = `WhatsApp repeat flow ${Date.now()}`;
let dealerId: number | null = null;

async function conversationStep(): Promise<string | null> {
  const [row] = await db
    .select({ step: whatsappConversationsTable.step })
    .from(whatsappConversationsTable)
    .where(
      and(
        eq(whatsappConversationsTable.dealerId, dealerId!),
        eq(whatsappConversationsTable.phone, phone),
      ),
    );
  return row?.step ?? null;
}

async function reply(text: string): Promise<string[]> {
  const { transport, messages } = captureTransport();
  await handleWhatsappMessage(
    transport,
    {
      from: phone,
      profileName: "Repeat Flow Test",
      text,
      replyId: null,
      replyTitle: null,
    },
    dealerId!,
  );
  return messages;
}

try {
  assert.equal(normalizeWhatsappPhone("6001234"), "5926001234");
  assert.equal(normalizeWhatsappPhone("whatsapp:+592-600-1234"), "5926001234");
  assert.equal(normalizeWhatsappPhone("06001234"), null);
  assert.equal(normalizeWhatsappPhone("+1 592 600 1234"), "15926001234");
  assert.equal(canApplyWhatsappDeliveryStatus("accepted", "delivered"), true);
  assert.equal(canApplyWhatsappDeliveryStatus("delivered", "failed"), false);
  assert.equal(canApplyWhatsappDeliveryStatus("read", "delivered"), false);
  assert.equal(canApplyWhatsappDeliveryStatus("failed", "delivered"), true);
  assert.equal(
    whatsappSendFailureDisposition(
      new WhatsappProviderSendError("timeout", "uncertain"),
    ),
    "uncertain",
  );
  assert.equal(
    whatsappSendFailureDisposition(
      new WhatsappProviderSendError("rate limited", "retryable_rejection"),
    ),
    "retryable_rejection",
  );
  assert.equal(whatsappSendFailureDisposition(new Error("local")), null);
  const documentPayload = whatsappDocumentMessagePayload({
    mediaId: "media-quote-123",
    filename: `${"Q".repeat(300)}.pdf`,
    caption: "C".repeat(1100),
  }) as {
    type: string;
    document: { id: string; filename: string; caption: string };
  };
  assert.equal(documentPayload.type, "document");
  assert.equal(documentPayload.document.id, "media-quote-123");
  assert.equal(documentPayload.document.filename.length, 240);
  assert.equal(documentPayload.document.caption.length, 1024);
  assert.equal(
    whatsappOutboxDisposition({
      status: "queued",
      attempts: 0,
      nextAttemptAt: null,
    }),
    "queued",
  );
  assert.equal(
    whatsappOutboxDisposition({
      status: "failed",
      attempts: 1,
      nextAttemptAt: new Date(),
    }),
    "queued",
  );
  assert.equal(
    whatsappOutboxDisposition({
      status: "failed",
      attempts: 3,
      nextAttemptAt: null,
    }),
    "blocked",
  );
  assert.equal(
    whatsappOutboxDisposition({
      status: "cancelled",
      attempts: 0,
      nextAttemptAt: null,
    }),
    "blocked",
  );
  assert.equal(
    whatsappOutboxDisposition({
      status: "sent",
      attempts: 1,
      nextAttemptAt: null,
    }),
    "already_sent",
  );
  const dealReplyPermission = routePermission({
    method: "POST",
    path: "/deals/42/whatsapp",
  } as unknown as ExpressRequest);
  assert.deepEqual(dealReplyPermission, { module: "deals", category: "edit" });
  const editOnlyUser = {
    dealerId: 1,
    isSuperAdmin: false,
    dealers: [],
    permissions: [{ module: "deals", category: "edit" }],
  } as unknown as AuthedUser;
  const createOnlyUser = {
    dealerId: 1,
    isSuperAdmin: false,
    dealers: [],
    permissions: [{ module: "deals", category: "create" }],
  } as unknown as AuthedUser;
  assert.equal(
    hasPermission(
      editOnlyUser,
      dealReplyPermission!.module,
      dealReplyPermission!.category,
    ),
    true,
  );
  assert.equal(
    hasPermission(
      createOnlyUser,
      dealReplyPermission!.module,
      dealReplyPermission!.category,
    ),
    false,
  );
  assert.equal(
    isImpersonationHardBlocked({
      method: "POST",
      path: "/deals/42/whatsapp",
    } as unknown as ExpressRequest),
    true,
  );
  assert.deepEqual(checkWhatsappReplyAuthorization(editOnlyUser), {
    nextCalled: true,
    statusCode: null,
  });
  assert.deepEqual(checkWhatsappReplyAuthorization(createOnlyUser), {
    nextCalled: false,
    statusCode: 403,
  });

  const [dealer] = await db
    .insert(dealersTable)
    .values({ name: dealerName })
    .returning({ id: dealersTable.id });
  dealerId = dealer!.id;

  const documentDedupeKey = `quote-document-${suffix}`;
  const blockedDocument = await enqueueWhatsapp({
    kind: "whatsapp_message",
    to: phone,
    body: "Your quote PDF is attached.",
    dealerId,
    document: {
      kind: "quote_pdf",
      filename: "Quote-Q-TEST.pdf",
      data: { quoteRef: "Q-TEST" },
    },
    dedupeKey: documentDedupeKey,
  });
  assert.equal(blockedDocument.status, "cancelled");
  assert.match(blockedDocument.lastError ?? "", /24-hour WhatsApp reply window/);
  assert.equal(blockedDocument.dedupeKey, `${documentDedupeKey}:blocked`);

  const [outbox] = await db
    .insert(emailLogsTable)
    .values({
      dealerId,
      recipient: phone,
      subject: "claim test",
      template: "whatsapp_message",
      channel: "whatsapp",
      status: "queued",
      deliveryStatus: "queued",
      payload: { body: "claim test" },
    })
    .returning({ id: emailLogsTable.id });
  const claims = await Promise.all([
    claimWhatsappOutboxItem(outbox!.id),
    claimWhatsappOutboxItem(outbox!.id),
  ]);
  assert.equal(
    claims.filter(Boolean).length,
    1,
    "only one independent worker may claim an outbox row",
  );
  await db
    .update(emailLogsTable)
    .set({ status: "cancelled", nextAttemptAt: null })
    .where(eq(emailLogsTable.id, outbox!.id));

  const [receiptRace] = await db
    .insert(emailLogsTable)
    .values({
      dealerId,
      recipient: phone,
      subject: "receipt race test",
      template: "whatsapp_message",
      channel: "whatsapp",
      status: "sent",
      deliveryStatus: "accepted",
      payload: { body: "receipt race test" },
    })
    .returning({ id: emailLogsTable.id });
  await db.insert(whatsappMessagesTable).values({
    dealerId,
    phone,
    direction: "out",
    body: "receipt race test",
    outboxId: receiptRace!.id,
    deliveryStatus: "accepted",
  });
  const advanceOutbox = (status: "delivered" | "failed") =>
    db
      .update(emailLogsTable)
      .set({ deliveryStatus: status })
      .where(
        and(
          eq(emailLogsTable.id, receiptRace!.id),
          inArray(
            emailLogsTable.deliveryStatus,
            allowedWhatsappDeliverySources(status),
          ),
        ),
      );
  await Promise.all([advanceOutbox("delivered"), advanceOutbox("failed")]);
  const [outboxAfterRace] = await db
    .select({ status: emailLogsTable.deliveryStatus })
    .from(emailLogsTable)
    .where(eq(emailLogsTable.id, receiptRace!.id));
  assert.equal(outboxAfterRace!.status, "delivered");

  await Promise.all([
    updateWhatsappDeliveryStatus({
      dealerId,
      outboxId: receiptRace!.id,
      status: "delivered",
    }),
    updateWhatsappDeliveryStatus({
      dealerId,
      outboxId: receiptRace!.id,
      status: "failed",
    }),
  ]);
  const [transcriptAfterRace] = await db
    .select({ status: whatsappMessagesTable.deliveryStatus })
    .from(whatsappMessagesTable)
    .where(eq(whatsappMessagesTable.outboxId, receiptRace!.id));
  assert.equal(transcriptAfterRace!.status, "delivered");

  const [origin] = await db
    .insert(leadsTable)
    .values({
      dealerId,
      name: "Repeat Customer",
      phone: `+${phone}`,
      channel: "social",
      source: "whatsapp",
    })
    .returning({ id: leadsTable.id });

  await db.insert(whatsappMessagesTable).values({
    dealerId,
    leadId: origin!.id,
    phone,
    direction: "in",
    body: "Earlier enquiry question",
    deliveryStatus: "received",
  });
  const reopenedDocument = await enqueueWhatsapp({
    kind: "whatsapp_message",
    to: phone,
    body: "Your quote PDF is attached.",
    dealerId,
    document: {
      kind: "quote_pdf",
      filename: "Quote-Q-TEST.pdf",
      data: { quoteRef: "Q-TEST" },
    },
    dedupeKey: documentDedupeKey,
    // Keep this regression row away from the live worker while still proving
    // that it is eligible inside the customer's 24-hour service window.
    sendAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  assert.equal(reopenedDocument.status, "queued");
  assert.equal(reopenedDocument.dedupeKey, documentDedupeKey);

  await db.insert(whatsappConversationsTable).values({
    dealerId,
    phone,
    step: "ni_confirm",
    name: "Repeat Customer",
    expiresAt: new Date(Date.now() + 60_000),
  });

  await reply("YES");
  assert.equal(await conversationStep(), "ni_name");

  await reply("YES");
  assert.equal(await conversationStep(), "ni_email");

  await reply("SKIP");
  assert.equal(await conversationStep(), "ni_address");

  await reply("SKIP");
  assert.equal(
    await conversationStep(),
    "ni_model",
    "new-enquiry namespace must survive the inventory prompts",
  );

  const confirmation = await reply("Toyota Corolla Cross");
  assert.equal(await conversationStep(), "ni_confirm_details");
  assert.ok(
    confirmation.some((message) => message.includes("Reply *YES* to submit")),
  );

  const [{ messages: first }, { messages: second }] = await Promise.all([
    (async () => {
      const { transport, messages } = captureTransport();
      await handleWhatsappMessage(
        transport,
        {
          from: phone,
          profileName: "Repeat Flow Test",
          text: "YES",
          replyId: null,
          replyTitle: null,
        },
        dealerId!,
      );
      return { messages };
    })(),
    (async () => {
      const { transport, messages } = captureTransport();
      await handleWhatsappMessage(
        transport,
        {
          from: phone,
          profileName: "Repeat Flow Test",
          text: "YES",
          replyId: null,
          replyTitle: null,
        },
        dealerId!,
      );
      return { messages };
    })(),
  ]);

  const leads = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.dealerId, dealerId));
  assert.equal(leads.length, 2, "confirmation must create exactly one new lead");
  const created = leads.find((lead) => lead.id !== origin!.id);
  assert.ok(created, "the confirmed enquiry must be a distinct lead");
  assert.match(created.notes ?? "", /Toyota Corolla Cross/);
  const fullCustomerThread = await listWhatsappMessagesForLead(created);
  assert.ok(
    fullCustomerThread.some((message) => message.leadId === origin!.id),
    "a repeat customer's earlier-enquiry messages must remain in the thread",
  );
  assert.ok(
    fullCustomerThread.some((message) => message.leadId === created.id),
    "a repeat customer's new-enquiry messages must appear in the same thread",
  );
  assert.ok(
    [...first, ...second].some(
      (message) =>
        message.includes("opened a new enquiry") ||
        message.includes("already being processed"),
    ),
  );

  console.log("WhatsApp repeat-customer flow: 43 assertions passed");
} finally {
  if (dealerId != null) {
    await db
      .delete(emailLogsTable)
      .where(eq(emailLogsTable.dealerId, dealerId));
    await db
      .delete(whatsappMessagesTable)
      .where(eq(whatsappMessagesTable.dealerId, dealerId));
    await db
      .delete(whatsappConversationsTable)
      .where(eq(whatsappConversationsTable.dealerId, dealerId));
    await db
      .delete(agentRunsTable)
      .where(eq(agentRunsTable.dealerId, dealerId));
    await db
      .delete(timelineEventsTable)
      .where(eq(timelineEventsTable.dealerId, dealerId));
    await db.delete(leadsTable).where(eq(leadsTable.dealerId, dealerId));
    await db.delete(dealersTable).where(eq(dealersTable.id, dealerId));
  }
}