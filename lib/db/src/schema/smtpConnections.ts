import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Per-dealer SMTP connection. One row per dealer. The SMTP password is
// stored encrypted (AES-256-GCM, purpose-keyed); it is NEVER returned to
// clients — only hasPassword is exposed. A dealer with no row (or a
// disabled row) sends NO email: there is no shared/global fallback sender.
// ---------------------------------------------------------------------------

export const SMTP_SECURITY_MODES = ["ssl", "starttls", "none"] as const;
export type SmtpSecurityMode = (typeof SMTP_SECURITY_MODES)[number];

export const smtpConnectionsTable = pgTable(
  "smtp_connections",
  {
    id: serial("id").primaryKey(),
    /** The owning dealership. One connection per dealer. */
    dealerId: integer("dealer_id").notNull(),
    /** SMTP server hostname, e.g. smtp.gmail.com. */
    host: text("host").notNull(),
    /** SMTP server port, e.g. 465 (SSL) or 587 (STARTTLS). */
    port: integer("port").notNull(),
    /** Connection security: "ssl" (implicit TLS), "starttls", or "none". */
    security: text("security").notNull().default("ssl"),
    /** SMTP AUTH username (often the mailbox address). */
    username: text("username").notNull(),
    /**
     * AES-256-GCM ciphertext of the SMTP password.
     * Format: <iv_b64>:<tag_b64>:<ciphertext_b64>
     * Never returned to the client; only hasPassword is exposed.
     */
    passwordCiphertext: text("password_ciphertext"),
    /** Envelope/sender address shown to recipients. */
    fromEmail: text("from_email").notNull(),
    /** Optional display name override; falls back to dealer branding. */
    fromName: text("from_name"),
    /** Optional Reply-To address. */
    replyTo: text("reply_to"),
    /** Master switch: false pauses all sends without losing config. */
    enabled: boolean("enabled").notNull().default(true),
    /** Last health check result: "connected" | "error" | null (never tested). */
    lastStatus: text("last_status"),
    /** Human-readable error from the last test, if any (never raw creds). */
    lastError: text("last_error"),
    /** When the last test/health check was performed. */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("smtp_connections_dealer_uq").on(t.dealerId),
    index("smtp_connections_dealer_idx").on(t.dealerId),
  ],
);

export type SmtpConnection = typeof smtpConnectionsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Per-dealer email template overrides. Dealers may customize subject,
// heading, body and CTA label of any supported template. Merge fields use
// {{field}} tokens validated against the template's approved field list.
// A missing row (or disabled override) falls back to the built-in default.
// ---------------------------------------------------------------------------

export const emailTemplateOverridesTable = pgTable(
  "email_template_overrides",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    /** Template key from EMAIL_TEMPLATES. */
    templateKey: text("template_key").notNull(),
    /** Overridden subject line ({{field}} tokens allowed). Null = default. */
    subject: text("subject"),
    /** Overridden heading ({{field}} tokens allowed). Null = default. */
    heading: text("heading"),
    /** Overridden body copy ({{field}} tokens allowed). Null = default. */
    body: text("body"),
    /** Overridden CTA button label. Null = default. */
    ctaLabel: text("cta_label"),
    /** False temporarily disables the override without deleting it. */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("email_template_overrides_dealer_key_uq").on(
      t.dealerId,
      t.templateKey,
    ),
    index("email_template_overrides_dealer_idx").on(t.dealerId),
  ],
);

export type EmailTemplateOverride =
  typeof emailTemplateOverridesTable.$inferSelect;
