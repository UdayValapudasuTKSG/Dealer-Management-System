import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { leadsTable } from "./leads";
import { customersTable } from "./customers";
import { serviceOrdersTable } from "./serviceOrders";

/** Supported question kinds — no branching/scoring/file upload (out of scope). */
export const FEEDBACK_QUESTION_TYPES = [
  "text",
  "long_text",
  "single_choice",
  "multi_choice",
  "star_rating",
] as const;
export type FeedbackQuestionType = (typeof FEEDBACK_QUESTION_TYPES)[number];

export type FeedbackQuestion = {
  id: string;
  type: FeedbackQuestionType;
  label: string;
  required: boolean;
  /** choice questions only — ordered options */
  options?: string[];
  /** star_rating only — 3..10, default 5 */
  maxStars?: number;
};

export const FEEDBACK_FORM_STATUSES = ["draft", "published", "archived"] as const;
export type FeedbackFormStatus = (typeof FEEDBACK_FORM_STATUSES)[number];

/** Reusable GM-authored feedback form definitions (dealer-scoped). */
export const feedbackFormsTable = pgTable(
  "feedback_forms",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    /** Ordered question list (FeedbackQuestion[]). */
    questions: jsonb("questions").notNull().default(sql`'[]'::jsonb`),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("feedback_forms_dealer_idx").on(t.dealerId, t.status)],
);

export type FeedbackForm = typeof feedbackFormsTable.$inferSelect;

export const FEEDBACK_INVITATION_STATUSES = ["sent", "completed"] as const;

/**
 * One invitation per (form, lead): immutable snapshot of the published
 * questions at send time, a unique secure token with expiry, delivery
 * channel linkage into the email_logs outbox, and the submitted answers.
 * The unique (dealer_id, form_id, lead_id) index is the duplicate-send guard.
 */
export const feedbackInvitationsTable = pgTable(
  "feedback_invitations",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    formId: integer("form_id").notNull(),
    leadId: integer("lead_id")
      .references(() => leadsTable.id, { onDelete: "cascade" }),
    /** Service invitations are customer/order-bound and intentionally leadless. */
    serviceOrderId: integer("service_order_id").references(() => serviceOrdersTable.id),
    customerId: integer("customer_id").references(() => customersTable.id),
    vehicleLabel: text("vehicle_label"),
    /** Snapshot: survives later edits/archive of the reusable form. */
    formName: text("form_name").notNull(),
    questionsSnapshot: jsonb("questions_snapshot").notNull(),
    token: text("token")
      .unique()
      .default(sql`gen_random_uuid()`),
    /** New public links persist only this digest; legacy plaintext tokens remain readable. */
    tokenHash: text("token_hash").unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("sent"),
    /** Channels actually queued, e.g. ["email","whatsapp"]. */
    channels: jsonb("channels").notNull().default(sql`'[]'::jsonb`),
    emailLogId: integer("email_log_id"),
    whatsappLogId: integer("whatsapp_log_id"),
    /** Answers keyed by question id: string | string[] | number. */
    answers: jsonb("answers"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("feedback_invitations_form_lead_uq").on(
      t.dealerId,
      t.formId,
      t.leadId,
    ),
    index("feedback_invitations_lead_idx").on(t.dealerId, t.leadId),
    index("feedback_invitations_form_idx").on(t.dealerId, t.formId),
  ],
);

export type FeedbackInvitation = typeof feedbackInvitationsTable.$inferSelect;
