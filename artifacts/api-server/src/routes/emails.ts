import { Router, type IRouter } from "express";
import { and, desc, eq, count } from "drizzle-orm";
import { db, emailLogsTable, EMAIL_TEMPLATES } from "@workspace/db";
import {
  RetryEmailLogParams,
  RetryEmailLogResponse,
  GetEmailSettingsResponse,
  SendTestEmailBody,
  SendTestEmailResponse,
  ListEmailTemplatesResponse,
  PreviewEmailTemplateParams,
  PreviewEmailTemplateResponse,
  EnqueueEmailBody,
  EnqueueEmailResponse,
  ListEmailLogsQueryParams,
  ListEmailLogsResponse,
} from "@workspace/api-zod";
import {
  smtpConfigured,
  fromAddress,
  renderEmail,
  enqueueEmail,
  isKnownTemplate,
  processQueue,
  TEMPLATE_DEFS,
  sniffImageMime,
} from "../lib/email";
import { getDealerPdfBranding } from "../lib/dealer-branding";
import { activeDealerId } from "../middlewares/rbac";

const router: IRouter = Router();

router.get("/emails/settings", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const [row] = await db
    .select({ n: count() })
    .from(emailLogsTable)
    .where(
      and(
        eq(emailLogsTable.status, "queued"),
        eq(emailLogsTable.dealerId, dealerId),
      ),
    );
  res.json(
    GetEmailSettingsResponse.parse({
      configured: smtpConfigured(),
      fromAddress: fromAddress(),
      queueDepth: row?.n ?? 0,
    }),
  );
});

router.post("/emails/test-send", async (req, res): Promise<void> => {
  const parsed = SendTestEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!smtpConfigured()) {
    res.json(
      SendTestEmailResponse.parse({
        ok: false,
        error: "SMTP is not configured. Add GMAIL_USER and GMAIL_APP_PASSWORD secrets.",
      }),
    );
    return;
  }
  await enqueueEmail({
    template: "smtp_test",
    to: parsed.data.to,
    dealerId: activeDealerId(res),
  });
  res.json(SendTestEmailResponse.parse({ ok: true, error: null }));
});

// Send a test render of ANY template (using its sample data) to an address.
router.post(
  "/emails/templates/:key/test-send",
  async (req, res): Promise<void> => {
    const key = String(req.params.key ?? "");
    if (!isKnownTemplate(key)) {
      res.status(404).json({ error: "Unknown template" });
      return;
    }
    const parsed = SendTestEmailBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!smtpConfigured()) {
      res.json(
        SendTestEmailResponse.parse({
          ok: false,
          error:
            "SMTP is not configured. Add GMAIL_USER and GMAIL_APP_PASSWORD secrets.",
        }),
      );
      return;
    }
    await enqueueEmail({
      template: key,
      to: parsed.data.to,
      dealerId: activeDealerId(res),
      data: TEMPLATE_DEFS[key].sample,
    });
    res.json(SendTestEmailResponse.parse({ ok: true, error: null }));
  },
);

router.get("/emails/templates", (_req, res): void => {
  const list = EMAIL_TEMPLATES.filter((k) => k !== "smtp_test").map((key) => ({
    key,
    label: TEMPLATE_DEFS[key].label,
    description: TEMPLATE_DEFS[key].description,
  }));
  res.json(ListEmailTemplatesResponse.parse(list));
});

router.get("/emails/templates/:key/preview", async (req, res): Promise<void> => {
  const params = PreviewEmailTemplateParams.safeParse(req.params);
  if (!params.success || !isKnownTemplate(params.data.key)) {
    res.status(404).json({ error: "Unknown template" });
    return;
  }
  const key = params.data.key;
  if (!isKnownTemplate(key)) {
    res.status(404).json({ error: "Unknown template" });
    return;
  }
  // Preview with the active dealer's white-label branding (logo inlined as
  // a data URI since a browser preview cannot resolve email CID references).
  const branding = await getDealerPdfBranding(activeDealerId(res));
  const logoSrc = branding.logo
    ? `data:${sniffImageMime(branding.logo).mime};base64,${branding.logo.toString("base64")}`
    : null;
  const { subject, html } = renderEmail(key, TEMPLATE_DEFS[key].sample, {
    name: branding.displayName,
    logoSrc,
  });
  res.json(PreviewEmailTemplateResponse.parse({ key, subject, html }));
});

router.post("/emails/send", async (req, res): Promise<void> => {
  const parsed = EnqueueEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!isKnownTemplate(parsed.data.template)) {
    res.status(400).json({ error: "Unknown template" });
    return;
  }
  const row = await enqueueEmail({
    template: parsed.data.template,
    to: parsed.data.to,
    dealerId: activeDealerId(res),
    customerId: parsed.data.customerId ?? null,
    data: parsed.data.data ?? {},
  });
  res.status(201).json(EnqueueEmailResponse.parse(row));
});

router.get("/emails/logs", async (req, res): Promise<void> => {
  const query = ListEmailLogsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const filters = [
    eq(emailLogsTable.dealerId, dealerId),
    query.data.customerId !== undefined
      ? eq(emailLogsTable.customerId, query.data.customerId)
      : undefined,
    query.data.status !== undefined
      ? eq(emailLogsTable.status, query.data.status)
      : undefined,
    query.data.channel !== undefined
      ? eq(emailLogsTable.channel, query.data.channel)
      : undefined,
  ].filter((f): f is NonNullable<typeof f> => Boolean(f));
  const rows = await db
    .select()
    .from(emailLogsTable)
    .where(and(...filters))
    .orderBy(desc(emailLogsTable.createdAt))
    .limit(200);
  res.json(ListEmailLogsResponse.parse(rows));
});

// Admin: re-queue a failed outbox item for an immediate retry.
router.post("/emails/logs/:id/retry", async (req, res): Promise<void> => {
  const params = RetryEmailLogParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(emailLogsTable)
    .where(
      and(
        eq(emailLogsTable.id, params.data.id),
        eq(emailLogsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Outbox item not found" });
    return;
  }
  if (row.status === "sent") {
    res.status(422).json({ error: "This message was already delivered." });
    return;
  }
  const [updated] = await db
    .update(emailLogsTable)
    .set({ status: "queued", attempts: 0, nextAttemptAt: null, lastError: null })
    .where(eq(emailLogsTable.id, row.id))
    .returning();
  setTimeout(() => void processQueue(), 50);
  res.json(RetryEmailLogResponse.parse(updated));
});

export default router;
