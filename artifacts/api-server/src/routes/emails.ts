import { Router, type IRouter } from "express";
import { and, desc, eq, count } from "drizzle-orm";
import {
  db,
  emailLogsTable,
  emailTemplateOverridesTable,
  smtpConnectionsTable,
  EMAIL_TEMPLATES,
  type EmailTemplate,
} from "@workspace/db";
import {
  RetryEmailLogParams,
  RetryEmailLogResponse,
  GetEmailSettingsResponse,
  UpdateSmtpConnectionBody,
  UpdateSmtpConnectionResponse,
  DeleteSmtpConnectionResponse,
  TestSmtpConnectionResponse,
  UpdateEmailTemplateOverrideParams,
  UpdateEmailTemplateOverrideBody,
  UpdateEmailTemplateOverrideResponse,
  DeleteEmailTemplateOverrideParams,
  DeleteEmailTemplateOverrideResponse,
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
  renderEmail,
  enqueueEmail,
  isKnownTemplate,
  processQueue,
  TEMPLATE_DEFS,
  sniffImageMime,
  templateMergeFields,
  invalidMergeTokens,
  getTemplateOverride,
} from "../lib/email";
import {
  getSmtpConnectionRow,
  buildSmtpTransport,
  invalidateSmtpTransport,
  resolveDealerSmtp,
  smtpSkipMessage,
  sanitizeSmtpError,
} from "../lib/smtp-connection";
import { encryptSmtpPassword } from "../lib/smtp-crypto";
import { getDealerPdfBranding } from "../lib/dealer-branding";
import { activeDealerId } from "../middlewares/rbac";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Per-dealer SMTP connection — GM/super-admin writes only (same rule as
// WhatsApp / branding / ERPNext). Reads return safe metadata only: the
// password is NEVER returned, only hasPassword.
// ---------------------------------------------------------------------------

function canManageEmail(res: Parameters<typeof activeDealerId>[0]): boolean {
  const user = res.locals.user;
  const dealerId = activeDealerId(res);
  const membership = user?.dealers.find(
    (d: { dealerId: number }) => d.dealerId === dealerId,
  );
  return (
    user?.isSuperAdmin === true ||
    membership?.isGeneralManager === true ||
    membership?.roleName === "General Manager"
  );
}

async function settingsPayload(
  dealerId: number,
  canManage: boolean,
): Promise<Record<string, unknown>> {
  const [queueRow] = await db
    .select({ n: count() })
    .from(emailLogsTable)
    .where(
      and(
        eq(emailLogsTable.status, "queued"),
        eq(emailLogsTable.dealerId, dealerId),
      ),
    );
  const row = await getSmtpConnectionRow(dealerId);
  const base = {
    queueDepth: queueRow?.n ?? 0,
    canManage,
  };
  if (!row) {
    return {
      ...base,
      configured: false,
      enabled: false,
      fromAddress: null,
      host: null,
      port: null,
      security: null,
      username: null,
      fromName: null,
      replyTo: null,
      hasPassword: false,
      lastStatus: null,
      lastError: null,
      lastCheckedAt: null,
    };
  }
  return {
    ...base,
    configured: true,
    enabled: row.enabled,
    fromAddress: row.fromEmail,
    // Connection details are management-only; other roles just see status.
    host: canManage ? row.host : null,
    port: canManage ? row.port : null,
    security: canManage ? row.security : null,
    username: canManage ? row.username : null,
    fromName: row.fromName ?? null,
    replyTo: canManage ? (row.replyTo ?? null) : null,
    hasPassword: Boolean(row.passwordCiphertext),
    lastStatus: row.lastStatus ?? null,
    lastError: canManage ? (row.lastError ?? null) : null,
    lastCheckedAt: row.lastCheckedAt ?? null,
  };
}

router.get("/emails/settings", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  res.json(
    GetEmailSettingsResponse.parse(
      await settingsPayload(dealerId, canManageEmail(res)),
    ),
  );
});

router.put("/emails/connection", async (req, res): Promise<void> => {
  if (!canManageEmail(res)) {
    res
      .status(403)
      .json({ error: "Only the general manager can manage email settings" });
    return;
  }
  const body = UpdateSmtpConnectionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const existing = await getSmtpConnectionRow(dealerId);

  // Initial configuration requires the full connection.
  if (!existing) {
    const missing = (
      ["host", "port", "security", "username", "password", "fromEmail"] as const
    ).filter((k) => body.data[k] === undefined || body.data[k] === "");
    if (missing.length > 0) {
      res.status(400).json({
        error: `Required for the initial configuration: ${missing.join(", ")}`,
      });
      return;
    }
  }

  const now = new Date();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (body.data.host !== undefined) updates["host"] = body.data.host;
  if (body.data.port !== undefined) updates["port"] = body.data.port;
  if (body.data.security !== undefined) updates["security"] = body.data.security;
  if (body.data.username !== undefined) updates["username"] = body.data.username;
  if (body.data.fromEmail !== undefined) updates["fromEmail"] = body.data.fromEmail;
  if (body.data.fromName !== undefined) updates["fromName"] = body.data.fromName;
  if (body.data.replyTo !== undefined) updates["replyTo"] = body.data.replyTo;
  if (body.data.enabled !== undefined) updates["enabled"] = body.data.enabled;

  // Encrypt the password when provided; preserve existing ciphertext when omitted.
  if (body.data.password) {
    try {
      updates["passwordCiphertext"] = encryptSmtpPassword(
        body.data.password,
        dealerId,
      );
    } catch (err) {
      logger.error(
        { dealerId, err: (err as Error).message },
        "Failed to encrypt SMTP password",
      );
      res.status(500).json({ error: "Failed to secure the password" });
      return;
    }
  }

  // Any credential/server change invalidates prior health status.
  if (
    body.data.host !== undefined ||
    body.data.port !== undefined ||
    body.data.security !== undefined ||
    body.data.username !== undefined ||
    body.data.password !== undefined
  ) {
    updates["lastStatus"] = null;
    updates["lastError"] = null;
    updates["lastCheckedAt"] = null;
  }

  if (!existing) {
    await db.insert(smtpConnectionsTable).values({
      dealerId,
      host: body.data.host!,
      port: body.data.port!,
      security: body.data.security!,
      username: body.data.username!,
      passwordCiphertext: updates["passwordCiphertext"] as string,
      fromEmail: body.data.fromEmail!,
      fromName: body.data.fromName ?? null,
      replyTo: body.data.replyTo ?? null,
      enabled: body.data.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await db
      .update(smtpConnectionsTable)
      .set(updates)
      .where(eq(smtpConnectionsTable.dealerId, dealerId));
  }
  invalidateSmtpTransport(dealerId);
  res.json(
    UpdateSmtpConnectionResponse.parse(await settingsPayload(dealerId, true)),
  );
});

router.delete("/emails/connection", async (_req, res): Promise<void> => {
  if (!canManageEmail(res)) {
    res
      .status(403)
      .json({ error: "Only the general manager can manage email settings" });
    return;
  }
  const dealerId = activeDealerId(res);
  await db
    .delete(smtpConnectionsTable)
    .where(eq(smtpConnectionsTable.dealerId, dealerId));
  invalidateSmtpTransport(dealerId);
  res.json(
    DeleteSmtpConnectionResponse.parse(await settingsPayload(dealerId, true)),
  );
});

router.post("/emails/connection/test", async (_req, res): Promise<void> => {
  if (!canManageEmail(res)) {
    res
      .status(403)
      .json({ error: "Only the general manager can test the email connection" });
    return;
  }
  const dealerId = activeDealerId(res);
  const row = await getSmtpConnectionRow(dealerId);
  if (!row || !row.passwordCiphertext) {
    res.json(
      TestSmtpConnectionResponse.parse({
        ok: false,
        error: "The email connection is not fully configured yet.",
      }),
    );
    return;
  }
  let ok = false;
  let message: string | null = null;
  let transport: ReturnType<typeof buildSmtpTransport> | null = null;
  try {
    transport = buildSmtpTransport(row);
    await transport.verify();
    ok = true;
  } catch (err) {
    // SMTP error text can echo credential material (server banners, auth
    // responses) — never return or persist the raw message, only a fixed
    // classified diagnostic.
    const safe = sanitizeSmtpError(err);
    message = safe.message;
    logger.warn(
      { dealerId, smtpErrorCode: safe.code },
      "SMTP connection test failed",
    );
  } finally {
    try {
      transport?.close();
    } catch {
      // ignore
    }
  }
  await db
    .update(smtpConnectionsTable)
    .set({
      lastStatus: ok ? "connected" : "error",
      lastError: ok ? null : message,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(smtpConnectionsTable.dealerId, dealerId));
  invalidateSmtpTransport(dealerId);
  res.json(TestSmtpConnectionResponse.parse({ ok, error: ok ? null : message }));
});

router.post("/emails/test-send", async (req, res): Promise<void> => {
  const parsed = SendTestEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const smtp = await resolveDealerSmtp(dealerId);
  if (!smtp.ok) {
    res.json(
      SendTestEmailResponse.parse({
        ok: false,
        error: smtpSkipMessage(smtp.reason),
      }),
    );
    return;
  }
  await enqueueEmail({
    template: "smtp_test",
    to: parsed.data.to,
    dealerId,
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
    const dealerId = activeDealerId(res);
    const smtp = await resolveDealerSmtp(dealerId);
    if (!smtp.ok) {
      res.json(
        SendTestEmailResponse.parse({
          ok: false,
          error: smtpSkipMessage(smtp.reason),
        }),
      );
      return;
    }
    await enqueueEmail({
      template: key,
      to: parsed.data.to,
      dealerId,
      data: TEMPLATE_DEFS[key].sample,
    });
    res.json(SendTestEmailResponse.parse({ ok: true, error: null }));
  },
);

/** Build the template-info payload (defaults + this dealer's override). */
function templateInfo(
  key: EmailTemplate,
  override: {
    subject: string | null;
    heading: string | null;
    body: string | null;
    ctaLabel: string | null;
    enabled: boolean;
  } | null,
): Record<string, unknown> {
  const def = TEMPLATE_DEFS[key];
  const sample = { ...def.sample, __brand: "{{brand}}" };
  return {
    key,
    label: def.label,
    description: def.description,
    mergeFields: templateMergeFields(key),
    hasOverride: Boolean(override),
    overrideEnabled: override?.enabled ?? false,
    overrideSubject: override?.subject ?? null,
    overrideHeading: override?.heading ?? null,
    overrideBody: override?.body ?? null,
    overrideCtaLabel: override?.ctaLabel ?? null,
    // Defaults rendered against sample data so editors see realistic copy.
    defaultSubject: def.subject(sample),
    defaultHeading: def.heading(sample),
    defaultBody: def.body(sample),
    defaultCtaLabel: def.cta?.(sample)?.label ?? null,
  };
}

router.get("/emails/templates", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const overrides = await db
    .select()
    .from(emailTemplateOverridesTable)
    .where(eq(emailTemplateOverridesTable.dealerId, dealerId));
  const byKey = new Map(overrides.map((o) => [o.templateKey, o]));
  const list = EMAIL_TEMPLATES.filter((k) => k !== "smtp_test").map((key) =>
    templateInfo(key, byKey.get(key) ?? null),
  );
  res.json(ListEmailTemplatesResponse.parse(list));
});

// Save (upsert) this dealer's custom copy for a template.
router.put(
  "/emails/templates/:key/override",
  async (req, res): Promise<void> => {
    if (!canManageEmail(res)) {
      res
        .status(403)
        .json({ error: "Only the general manager can customize templates" });
      return;
    }
    const params = UpdateEmailTemplateOverrideParams.safeParse(req.params);
    if (!params.success || !isKnownTemplate(params.data.key)) {
      res.status(404).json({ error: "Unknown template" });
      return;
    }
    const key = params.data.key as EmailTemplate;
    const body = UpdateEmailTemplateOverrideBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    // Validate merge tokens against the approved field list.
    const bad = new Set<string>();
    for (const text of [
      body.data.subject,
      body.data.heading,
      body.data.body,
      body.data.ctaLabel,
    ]) {
      if (text) for (const t of invalidMergeTokens(key, text)) bad.add(t);
    }
    if (bad.size > 0) {
      res.status(400).json({
        error: `Unknown merge fields: ${[...bad].join(", ")}. Allowed: ${templateMergeFields(key).join(", ")}`,
      });
      return;
    }
    const dealerId = activeDealerId(res);
    const now = new Date();
    const values = {
      dealerId,
      templateKey: key,
      subject: body.data.subject?.trim() || null,
      heading: body.data.heading?.trim() || null,
      body: body.data.body?.trim() || null,
      ctaLabel: body.data.ctaLabel?.trim() || null,
      enabled: body.data.enabled ?? true,
      updatedAt: now,
    };
    const [row] = await db
      .insert(emailTemplateOverridesTable)
      .values({ ...values, createdAt: now })
      .onConflictDoUpdate({
        target: [
          emailTemplateOverridesTable.dealerId,
          emailTemplateOverridesTable.templateKey,
        ],
        set: values,
      })
      .returning();
    res.json(
      UpdateEmailTemplateOverrideResponse.parse(templateInfo(key, row ?? null)),
    );
  },
);

// Reset a template back to the built-in default copy.
router.delete(
  "/emails/templates/:key/override",
  async (req, res): Promise<void> => {
    if (!canManageEmail(res)) {
      res
        .status(403)
        .json({ error: "Only the general manager can customize templates" });
      return;
    }
    const params = DeleteEmailTemplateOverrideParams.safeParse(req.params);
    if (!params.success || !isKnownTemplate(params.data.key)) {
      res.status(404).json({ error: "Unknown template" });
      return;
    }
    const key = params.data.key as EmailTemplate;
    await db
      .delete(emailTemplateOverridesTable)
      .where(
        and(
          eq(emailTemplateOverridesTable.dealerId, activeDealerId(res)),
          eq(emailTemplateOverridesTable.templateKey, key),
        ),
      );
    res.json(
      DeleteEmailTemplateOverrideResponse.parse(templateInfo(key, null)),
    );
  },
);

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
  const { subject, html } = renderEmail(
    key,
    TEMPLATE_DEFS[key].sample,
    { name: branding.displayName, logoSrc },
    await getTemplateOverride(activeDealerId(res), key),
  );
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
  if (row.template === "parts.purchase_order") {
    res.status(409).json({ error: "Use the PO Preview & send action to retry or resend. Uncertain deliveries must be investigated before another send." });
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
