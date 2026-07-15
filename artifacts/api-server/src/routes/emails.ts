import { Router, type IRouter } from "express";
import { and, desc, eq, count } from "drizzle-orm";
import { db, emailLogsTable, EMAIL_TEMPLATES } from "@workspace/db";
import {
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
  TEMPLATE_DEFS,
} from "../lib/email";

const router: IRouter = Router();

router.get("/emails/settings", async (_req, res): Promise<void> => {
  const [row] = await db
    .select({ n: count() })
    .from(emailLogsTable)
    .where(eq(emailLogsTable.status, "queued"));
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
  await enqueueEmail({ template: "smtp_test", to: parsed.data.to });
  res.json(SendTestEmailResponse.parse({ ok: true, error: null }));
});

router.get("/emails/templates", (_req, res): void => {
  const list = EMAIL_TEMPLATES.filter((k) => k !== "smtp_test").map((key) => ({
    key,
    label: TEMPLATE_DEFS[key].label,
    description: TEMPLATE_DEFS[key].description,
  }));
  res.json(ListEmailTemplatesResponse.parse(list));
});

router.get("/emails/templates/:key/preview", (req, res): void => {
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
  const { subject, html } = renderEmail(key, TEMPLATE_DEFS[key].sample);
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
  const filters = [
    query.data.customerId !== undefined
      ? eq(emailLogsTable.customerId, query.data.customerId)
      : undefined,
    query.data.status !== undefined
      ? eq(emailLogsTable.status, query.data.status)
      : undefined,
  ].filter((f): f is NonNullable<typeof f> => Boolean(f));
  const rows = await db
    .select()
    .from(emailLogsTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(emailLogsTable.createdAt))
    .limit(200);
  res.json(ListEmailLogsResponse.parse(rows));
});

export default router;
