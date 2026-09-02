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
import { collisionClaimsTable } from "./collisionClaims";
import { documentsTable } from "./documents";

export const COLLISION_CHECKLIST_AUDIENCES = ["customer", "insurer", "workshop"] as const;
export const COLLISION_CHECKLIST_STATUSES = [
  "missing",
  "requested",
  "uploaded",
  "verified",
  "waived",
] as const;

/** Instantiated rows are deliberate: labels and stage requirements remain an
 * auditable snapshot even if the default template changes later. */
export const collisionChecklistItemsTable = pgTable(
  "collision_checklist_items",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    claimId: integer("claim_id")
      .notNull()
      .references(() => collisionClaimsTable.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    audience: text("audience").notNull(),
    requiredForStatus: text("required_for_status"),
    status: text("status").notNull().default("missing"),
    documentId: integer("document_id").references(() => documentsTable.id, {
      onDelete: "set null",
    }),
    requestedByUserId: integer("requested_by_user_id"),
    requestedByName: text("requested_by_name"),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    verifiedByUserId: integer("verified_by_user_id"),
    verifiedByName: text("verified_by_name"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    waivedByUserId: integer("waived_by_user_id"),
    waivedByName: text("waived_by_name"),
    waivedAt: timestamp("waived_at", { withTimezone: true }),
    waiverReason: text("waiver_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("collision_checklist_claim_key_unique").on(t.claimId, t.key),
    index("collision_checklist_dealer_claim_idx").on(t.dealerId, t.claimId),
    index("collision_checklist_gate_idx").on(t.dealerId, t.claimId, t.requiredForStatus),
  ],
);

export const collisionClaimCommunicationsTable = pgTable(
  "collision_claim_communications",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    claimId: integer("claim_id")
      .notNull()
      .references(() => collisionClaimsTable.id, { onDelete: "cascade" }),
    audience: text("audience").notNull(),
    kind: text("kind").notNull(),
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("draft"),
    generatedByAgent: boolean("generated_by_agent").notNull().default(false),
    model: text("model"),
    promptVersion: text("prompt_version"),
    createdByUserId: integer("created_by_user_id"),
    createdByName: text("created_by_name").notNull(),
    editedByUserId: integer("edited_by_user_id"),
    editedByName: text("edited_by_name"),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    sentByUserId: integer("sent_by_user_id"),
    sentByName: text("sent_by_name"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    outboxId: integer("outbox_id"),
    errorCode: text("error_code"),
    generationIdempotencyKey: text("generation_idempotency_key"),
    sendIdempotencyKey: text("send_idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("collision_comms_dealer_claim_idx").on(t.dealerId, t.claimId),
    uniqueIndex("collision_comms_generation_idempotency_unique")
      .on(t.dealerId, t.claimId, t.generationIdempotencyKey),
    uniqueIndex("collision_comms_send_idempotency_unique")
      .on(t.dealerId, t.claimId, t.sendIdempotencyKey),
  ],
);

export const collisionPortalInvitationsTable = pgTable(
  "collision_portal_invitations",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    claimId: integer("claim_id")
      .notNull()
      .references(() => collisionClaimsTable.id, { onDelete: "cascade" }),
    customerId: integer("customer_id"),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    createdByUserId: integer("created_by_user_id"),
    createdByName: text("created_by_name").notNull(),
    revokedByUserId: integer("revoked_by_user_id"),
    revokedByName: text("revoked_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("collision_portal_token_hash_unique").on(t.tokenHash),
    uniqueIndex("collision_portal_invite_idempotency_unique").on(
      t.dealerId,
      t.claimId,
      t.idempotencyKey,
    ),
    index("collision_portal_dealer_claim_idx").on(t.dealerId, t.claimId),
  ],
);

/** One-time private object upload reservations; raw portal tokens are never
 * represented here, only the invitation primary key. */
export const collisionPortalUploadsTable = pgTable(
  "collision_portal_uploads",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    invitationId: integer("invitation_id").notNull().references(() => collisionPortalInvitationsTable.id, { onDelete: "cascade" }),
    claimId: integer("claim_id").notNull().references(() => collisionClaimsTable.id, { onDelete: "cascade" }),
    checklistItemId: integer("checklist_item_id").notNull().references(() => collisionChecklistItemsTable.id, { onDelete: "cascade" }),
    objectPath: text("object_path").notNull(),
    mimeType: text("mime_type").notNull(),
    fileName: text("file_name").notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    documentId: integer("document_id").references(() => documentsTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("collision_portal_uploads_invite_idx").on(t.invitationId),
    index("collision_portal_uploads_item_idx").on(t.dealerId, t.checklistItemId),
  ],
);

export type CollisionChecklistItem = typeof collisionChecklistItemsTable.$inferSelect;
export type CollisionClaimCommunication =
  typeof collisionClaimCommunicationsTable.$inferSelect;
export type CollisionPortalInvitation =
  typeof collisionPortalInvitationsTable.$inferSelect;