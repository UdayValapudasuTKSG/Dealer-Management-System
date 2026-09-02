import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  collisionChecklistItemsTable,
  collisionClaimsTable,
  collisionPortalInvitationsTable,
  collisionPortalUploadsTable,
  documentsTable,
  db,
} from "@workspace/db";
import { claimCycleSeconds } from "./collision";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
const MAX_BYTES = 20 * 1024 * 1024;
const STAGE_LABELS: Record<string, string> = {
  intake: "Claim received",
  estimate_drafted: "Estimate being prepared",
  submitted: "Submitted to insurer",
  adjuster_review: "Insurer review",
  approved: "Repairs approved",
  parts_ordered: "Parts being arranged",
  in_repair: "Repairs in progress",
  quality_check: "Quality inspection",
  insurer_signoff: "Insurer sign-off",
  invoiced: "Final billing",
  closed: "Completed",
  denied: "Claim decision recorded",
  total_loss: "Total-loss decision recorded",
};

async function invitationFor(token: string) {
  const hash = createHash("sha256").update(token).digest("hex");
  const [invitation] = await db.select().from(collisionPortalInvitationsTable)
    .where(eq(collisionPortalInvitationsTable.tokenHash, hash));
  return invitation ?? null;
}
function expired(invitation: { expiresAt: Date; revokedAt: Date | null }, res: any): boolean {
  if (!invitation.revokedAt && invitation.expiresAt > new Date()) return false;
  res.status(410).json({ error: "Portal invitation is no longer available" });
  return true;
}

router.get("/collision-portal/:token", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const token = req.params.token;
  if (!token || token.length < 32 || token.length > 200) {
    res.status(404).json({ error: "Portal invitation not found" });
    return;
  }
  const invitation = await invitationFor(token);
  if (!invitation) {
    res.status(404).json({ error: "Portal invitation not found" });
    return;
  }
  if (expired(invitation, res)) return;
  const [claim] = await db
    .select()
    .from(collisionClaimsTable)
    .where(
      and(
        eq(collisionClaimsTable.id, invitation.claimId),
        eq(collisionClaimsTable.dealerId, invitation.dealerId),
      ),
    );
  if (!claim) {
    res.status(404).json({ error: "Portal invitation not found" });
    return;
  }
  const checklist = await db
    .select({
      id: collisionChecklistItemsTable.id,
      key: collisionChecklistItemsTable.key,
      label: collisionChecklistItemsTable.label,
      description: collisionChecklistItemsTable.description,
      status: collisionChecklistItemsTable.status,
    })
    .from(collisionChecklistItemsTable)
    .where(
      and(
        eq(collisionChecklistItemsTable.dealerId, invitation.dealerId),
        eq(collisionChecklistItemsTable.claimId, invitation.claimId),
        eq(collisionChecklistItemsTable.audience, "customer"),
      ),
    )
    .orderBy(collisionChecklistItemsTable.id);
  await db
    .update(collisionPortalInvitationsTable)
    .set({ lastAccessedAt: new Date() })
    .where(eq(collisionPortalInvitationsTable.id, invitation.id));

  const needed = checklist.filter((item) =>
    item.status === "missing" || item.status === "requested",
  );
  res.json({
    claim: {
      vehicle: claim.vehicleInfo,
      customerFirstName: claim.customerName?.trim().split(/\s+/)[0] ?? null,
      stage: claim.status,
      stageLabel: STAGE_LABELS[claim.status] ?? "Claim in progress",
      cycleSeconds: claimCycleSeconds(claim),
      financial: {
        currency: "GYD",
        customerDeductible: claim.deductible,
        insurerDue: claim.insurerDue,
        customerDue: claim.deductibleDue,
      },
      nextAction:
        needed.length > 0
          ? `Please upload: ${needed.map((item) => item.label).join(", ")}`
          : "No customer documents are currently requested.",
      milestones: claim.history
        .filter((entry) => entry.kind === "created" || entry.kind === "status")
        .map((entry) => ({
          stage: entry.to ?? null,
          label: entry.to ? STAGE_LABELS[entry.to] ?? "Claim updated" : "Claim received",
          at: entry.at,
        })),
    },
    checklist,
  });
});

const uploadBody = z.object({
  checklistItemId: z.number().int().positive(),
  mimeType: z.string().max(120).transform((v) => v.toLowerCase()),
  fileName: z.string().trim().min(1).max(255),
});
const uploadParams = z.object({ token: z.string().min(32).max(200), uploadId: z.coerce.number().int().positive() });

router.post("/collision-portal/:token/uploads/upload-url", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const body = uploadBody.safeParse(req.body);
  const invitation = await invitationFor(req.params.token);
  if (!invitation) { res.status(404).json({ error: "Portal invitation not found" }); return; }
  if (expired(invitation, res)) return;
  if (!body.success || !ALLOWED_MIME.has(body.data.mimeType)) {
    res.status(422).json({ error: "Unsupported collision document type" }); return;
  }
  const [item] = await db.select().from(collisionChecklistItemsTable).where(and(
    eq(collisionChecklistItemsTable.id, body.data.checklistItemId),
    eq(collisionChecklistItemsTable.claimId, invitation.claimId),
    eq(collisionChecklistItemsTable.dealerId, invitation.dealerId),
    eq(collisionChecklistItemsTable.audience, "customer"),
    sql`${collisionChecklistItemsTable.status} not in ('verified', 'waived')`,
  ));
  if (!item) { res.status(404).json({ error: "Checklist item not available" }); return; }
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(collisionPortalUploadsTable).where(and(
    eq(collisionPortalUploadsTable.invitationId, invitation.id),
    eq(collisionPortalUploadsTable.checklistItemId, item.id),
  ));
  if ((count ?? 0) >= 10) { res.status(422).json({ error: "Maximum 10 uploads per checklist item" }); return; }
  const generated = await storage.createPrivateUpload(`collision-portal/invitation-${invitation.id}/item-${item.id}`);
  const [upload] = await db.insert(collisionPortalUploadsTable).values({
    dealerId: invitation.dealerId, invitationId: invitation.id, claimId: invitation.claimId,
    checklistItemId: item.id, objectPath: generated.objectPath, mimeType: body.data.mimeType, fileName: body.data.fileName,
  }).returning();
  res.status(201).json({ uploadId: upload.id, uploadUrl: generated.uploadUrl, maxBytes: MAX_BYTES });
});

router.post("/collision-portal/:token/uploads/:uploadId/finalize", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const params = uploadParams.safeParse(req.params);
  if (!params.success) { res.status(404).json({ error: "Portal invitation not found" }); return; }
  const invitation = await invitationFor(params.data.token);
  if (!invitation) { res.status(404).json({ error: "Portal invitation not found" }); return; }
  if (expired(invitation, res)) return;
  const [upload] = await db.select().from(collisionPortalUploadsTable).where(and(
    eq(collisionPortalUploadsTable.id, params.data.uploadId), eq(collisionPortalUploadsTable.invitationId, invitation.id),
    eq(collisionPortalUploadsTable.dealerId, invitation.dealerId), isNull(collisionPortalUploadsTable.finalizedAt),
  ));
  if (!upload) { res.status(404).json({ error: "Upload not found" }); return; }
  try {
    const [metadata] = await (await storage.getObjectEntityFile(upload.objectPath)).getMetadata();
    const size = Number(metadata.size);
    const contentType = String(metadata.contentType ?? "").toLowerCase();
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES || contentType !== upload.mimeType || !ALLOWED_MIME.has(contentType)) {
      res.status(422).json({ error: "Uploaded document failed verification" }); return;
    }
    const result = await db.transaction(async (tx) => {
      const [claimed] = await tx.update(collisionPortalUploadsTable).set({ finalizedAt: new Date() }).where(and(
        eq(collisionPortalUploadsTable.id, upload.id), isNull(collisionPortalUploadsTable.finalizedAt),
      )).returning();
      if (!claimed) return null;
      const [document] = await tx.insert(documentsTable).values({
        dealerId: invitation.dealerId, entityType: "collision_claim", entityId: invitation.claimId, type: "other",
        fileName: upload.fileName, storageKey: upload.objectPath, mimeType: upload.mimeType, sizeBytes: size,
        uploadedBy: "Customer portal",
      }).returning();
      const [item] = await tx.update(collisionChecklistItemsTable).set({ documentId: document.id, status: "uploaded", updatedAt: new Date() }).where(and(
        eq(collisionChecklistItemsTable.id, upload.checklistItemId), eq(collisionChecklistItemsTable.claimId, invitation.claimId),
        eq(collisionChecklistItemsTable.audience, "customer"), sql`${collisionChecklistItemsTable.status} not in ('verified', 'waived')`,
      )).returning();
      if (!item) throw new Error("portal checklist item unavailable");
      await tx.update(collisionPortalUploadsTable).set({ documentId: document.id }).where(eq(collisionPortalUploadsTable.id, upload.id));
      return { documentId: document.id, checklistItemId: item.id, status: item.status };
    });
    if (!result) { res.status(409).json({ error: "Upload was already finalized" }); return; }
    res.json(result);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) { res.status(422).json({ error: "Upload was not found" }); return; }
    throw error;
  }
});

router.post("/collision-portal/:token/note", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const body = z.object({ note: z.string().trim().min(1).max(1000) }).safeParse(req.body);
  const invitation = await invitationFor(req.params.token);
  if (!invitation) { res.status(404).json({ error: "Portal invitation not found" }); return; }
  if (expired(invitation, res)) return;
  if (!body.success) { res.status(422).json({ error: "Note must be between 1 and 1000 characters" }); return; }
  const [claim] = await db.select().from(collisionClaimsTable).where(and(
    eq(collisionClaimsTable.id, invitation.claimId), eq(collisionClaimsTable.dealerId, invitation.dealerId),
  ));
  if (!claim) { res.status(404).json({ error: "Portal invitation not found" }); return; }
  const lastCustomerNote = [...claim.history].reverse().find(event => event.kind === "note" && event.byName === "Customer portal");
  if (lastCustomerNote && Date.now() - new Date(lastCustomerNote.at).getTime() < 60_000) {
    res.status(429).json({ error: "Please wait before sending another note" }); return;
  }
  await db.update(collisionClaimsTable).set({
    history: [...claim.history, { kind: "note", note: body.data.note, byName: "Customer portal", at: new Date().toISOString() }],
  }).where(and(eq(collisionClaimsTable.id, claim.id), eq(collisionClaimsTable.dealerId, claim.dealerId)));
  res.status(201).json({ status: "recorded" });
});

export default router;