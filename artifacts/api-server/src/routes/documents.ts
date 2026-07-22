import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { and, eq, desc, sql } from "drizzle-orm";
import {
  db,
  documentsTable,
  leadsTable,
  vehiclesTable,
  auditLogsTable,
  timelineEventsTable,
} from "@workspace/db";
import {
  ListDocumentsQueryParams,
  ListDocumentsResponse,
  CreateDocumentBody,
  CreateDocumentResponse,
  DownloadDocumentParams,
  ReviewDocumentExtractionParams,
  ReviewDocumentExtractionBody,
  ReviewDocumentExtractionResponse,
} from "@workspace/api-zod";
import {
  activeDealerId,
  hasPermission,
  type AuthedUser,
} from "../middlewares/rbac";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage";
import {
  isDocumentAgentActive,
  isExtractable,
  runDocumentExtraction,
  PREFILL_FIELDS,
} from "../lib/document-extract";

const router: IRouter = Router();

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024; // 20MB per spec
export const ALLOWED_DOCUMENT_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
]);

/**
 * Documents attach to either a lead or a vehicle, so the middleware leaves
 * this segment auth-only and permissions are enforced here per entity:
 * lead documents require the `leads` module, vehicle documents `inventory`.
 */
function moduleFor(entityType: string): string {
  return entityType === "lead" ? "leads" : "inventory";
}

function requirePermission(
  res: Response,
  entityType: string,
  category: string,
): boolean {
  const user = res.locals.user as AuthedUser | undefined;
  const module = moduleFor(entityType);
  if (!user || !hasPermission(user, module, category)) {
    res
      .status(403)
      .json({ error: `Missing permission: ${category} on ${module}` });
    return false;
  }
  return true;
}

/** 404 unless the parent lead/vehicle exists in the active dealer. */
async function parentExists(
  dealerId: number,
  entityType: "lead" | "vehicle",
  entityId: number,
): Promise<boolean> {
  if (entityType === "lead") {
    const [row] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, entityId), eq(leadsTable.dealerId, dealerId)));
    return !!row;
  }
  const [row] = await db
    .select({ id: vehiclesTable.id })
    .from(vehiclesTable)
    .where(
      and(eq(vehiclesTable.id, entityId), eq(vehiclesTable.dealerId, dealerId)),
    );
  return !!row;
}

router.get("/documents", async (req: Request, res: Response): Promise<void> => {
  const parsed = ListDocumentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const { entityType, entityId } = parsed.data;
  if (!requirePermission(res, entityType, "view")) return;
  if (!(await parentExists(dealerId, entityType, entityId))) {
    res.status(404).json({ error: "Record not found" });
    return;
  }
  const rows = await db
    .select()
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.dealerId, dealerId),
        eq(documentsTable.entityType, entityType),
        eq(documentsTable.entityId, entityId),
      ),
    )
    .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id));
  res.json(ListDocumentsResponse.parse(rows));
});

router.post("/documents", async (req: Request, res: Response): Promise<void> => {
  const parsed = CreateDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const body = parsed.data;

  if (!requirePermission(res, body.entityType, "create")) return;
  if (!(await parentExists(dealerId, body.entityType, body.entityId))) {
    res.status(404).json({ error: "Record not found" });
    return;
  }
  if (!ALLOWED_DOCUMENT_MIME.has(body.mimeType)) {
    res
      .status(422)
      .json({ error: "Only PDF, JPG, PNG or DOCX documents are allowed" });
    return;
  }
  if (body.sizeBytes > MAX_DOCUMENT_BYTES) {
    res.status(422).json({ error: "File is too large (max 20MB)" });
    return;
  }

  // Normalize the storage path returned by the presign step.
  const storage = new ObjectStorageService();
  const storageKey = storage.normalizeObjectEntityPath(body.storageKey);
  if (!storageKey.startsWith("/objects/")) {
    res.status(422).json({ error: "Invalid storage path" });
    return;
  }
  // Presigned uploads are stamped with the active dealer's prefix server-side;
  // a document may only reference a key owned by this dealer.
  if (!storageKey.startsWith(`/objects/uploads/dealer-${dealerId}/`)) {
    res.status(422).json({ error: "Invalid storage path" });
    return;
  }

  const user = res.locals.user as
    | { name?: string | null; email?: string | null }
    | undefined;
  const uploadedBy = user?.name ?? user?.email ?? null;

  // New upload of the same type = next version, history retained.
  const [{ maxVersion }] = await db
    .select({
      maxVersion: sql<number>`coalesce(max(${documentsTable.version}), 0)`,
    })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.dealerId, dealerId),
        eq(documentsTable.entityType, body.entityType),
        eq(documentsTable.entityId, body.entityId),
        eq(documentsTable.type, body.type),
      ),
    );

  const [doc] = await db
    .insert(documentsTable)
    .values({
      dealerId,
      entityType: body.entityType,
      entityId: body.entityId,
      type: body.type,
      version: Number(maxVersion) + 1,
      fileName: body.fileName,
      storageKey,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      comments: body.comments?.trim() || null,
      uploadedBy,
      extractionStatus: "none",
    })
    .returning();

  // Agent A5 pre-fill: lead PDFs/images only, kill-switch respected, async —
  // the proposal lands as extractionStatus=proposed for advisor review.
  let launched = doc!;
  if (isExtractable(doc!) && (await isDocumentAgentActive(dealerId))) {
    const [pending] = await db
      .update(documentsTable)
      .set({ extractionStatus: "pending" })
      .where(eq(documentsTable.id, doc!.id))
      .returning();
    launched = pending!;
    void runDocumentExtraction(launched);
  }

  res.status(201).json(CreateDocumentResponse.parse(launched));
});

router.get(
  "/documents/:id/download",
  async (req: Request, res: Response): Promise<void> => {
    const params = DownloadDocumentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const dealerId = activeDealerId(res);
    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, params.data.id),
          eq(documentsTable.dealerId, dealerId),
        ),
      );
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    if (!requirePermission(res, doc.entityType, "view")) return;
    if (!doc.storageKey) {
      if (doc.externalUrl) {
        res.redirect(doc.externalUrl);
        return;
      }
      res.status(404).json({ error: "Document has no stored file" });
      return;
    }
    try {
      const storage = new ObjectStorageService();
      const file = await storage.getObjectEntityFile(doc.storageKey);
      const response = await storage.downloadObject(file);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.setHeader("Content-Type", doc.mimeType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${doc.fileName.replace(/[^\w.\- ]/g, "_")}"`,
      );
      if (response.body) {
        Readable.fromWeb(
          response.body as unknown as import("stream/web").ReadableStream,
        ).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "File not found in storage" });
        return;
      }
      req.log.error({ err }, "Error serving document");
      res.status(500).json({ error: "Failed to serve document" });
    }
  },
);

// ---------------------------------------------------------------------------
// A5 proposal review — accept (with optional edits) or dismiss. Values are
// ONLY applied here, by a human, and only for allowlisted fields.
// ---------------------------------------------------------------------------

function coerceLeadValue(
  field: string,
  value: string,
): Partial<Record<string, unknown>> | null {
  const v = value.trim();
  switch (field) {
    case "financingQualified": {
      const lowered = v.toLowerCase();
      if (["true", "yes", "1"].includes(lowered))
        return { financingQualified: true };
      if (["false", "no", "0"].includes(lowered))
        return { financingQualified: false };
      return null;
    }
    case "purchaseType": {
      const lowered = v.toLowerCase();
      return lowered === "cash" || lowered === "finance"
        ? { purchaseType: lowered }
        : null;
    }
    case "testDriveAt": {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : { testDriveAt: d };
    }
    case "budgetFinancing":
      return v ? { budgetFinancing: v } : null;
    case "phone":
      return v ? { phone: v } : null;
    case "email":
      return v ? { email: v } : null;
    case "address":
      return v ? { address: v } : null;
    case "company":
      return v ? { company: v } : null;
    default:
      return null;
  }
}

router.post(
  "/documents/:id/extraction/review",
  async (req: Request, res: Response): Promise<void> => {
    const params = ReviewDocumentExtractionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = ReviewDocumentExtractionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const dealerId = activeDealerId(res);
    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, params.data.id),
          eq(documentsTable.dealerId, dealerId),
        ),
      );
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    if (!requirePermission(res, doc.entityType, "edit")) return;
    if (doc.extractionStatus !== "proposed" || !doc.extraction) {
      res.status(409).json({ error: "No pending proposal on this document" });
      return;
    }

    const user = res.locals.user as
      | {
          id?: number;
          clerkId?: string;
          name?: string | null;
          email?: string | null;
        }
      | undefined;
    const actorName = user?.name ?? user?.email ?? "Unknown user";

    if (parsed.data.action === "dismiss") {
      const [updated] = await db
        .update(documentsTable)
        .set({ extractionStatus: "dismissed" })
        .where(eq(documentsTable.id, doc.id))
        .returning();
      await db.insert(auditLogsTable).values({
        dealerId,
        actorUserId: user?.id ?? null,
        actorClerkId: user?.clerkId ?? null,
        actorName: user?.name ?? null,
        actorEmail: user?.email ?? null,
        action: "reject",
        module: "leads",
        entityType: "document",
        entityId: String(doc.id),
        summary: `${actorName} dismissed the A5 pre-fill proposal from ${doc.fileName}`,
      });
      res.json(ReviewDocumentExtractionResponse.parse(updated));
      return;
    }

    // Accept: apply the (possibly edited) allowlisted values to the lead.
    if (doc.entityType !== "lead") {
      res.status(409).json({ error: "Proposal is not linked to a lead" });
      return;
    }
    const proposedFields = new Set(doc.extraction.fields.map((f) => f.field));
    const edits = parsed.data.fields ?? doc.extraction.fields;
    // A5 guardrail: reviewers may only confirm fields inside the pre-fill
    // allowlist — anything else is a hard 403, never silently applied.
    const outOfList = edits.find((f) => !PREFILL_FIELDS[f.field]);
    if (outOfList) {
      res.status(403).json({
        error: `Field "${outOfList.field}" is not in the pre-fill allowlist`,
      });
      return;
    }
    const applied: { field: string; value: string }[] = [];
    let patch: Record<string, unknown> = {};
    for (const f of edits) {
      if (!PREFILL_FIELDS[f.field] || !proposedFields.has(f.field)) continue;
      const piece = coerceLeadValue(f.field, f.value);
      if (piece) {
        patch = { ...patch, ...piece };
        applied.push({ field: f.field, value: f.value });
      }
    }
    if (applied.length === 0) {
      res.status(409).json({ error: "No valid field values to apply" });
      return;
    }

    const [lead] = await db
      .update(leadsTable)
      .set(patch)
      .where(
        and(
          eq(leadsTable.id, doc.entityId),
          eq(leadsTable.dealerId, dealerId),
        ),
      )
      .returning();
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    const appliedSummary = applied
      .map((f) => `${PREFILL_FIELDS[f.field]!.label} = ${f.value}`)
      .join("; ");

    const [updated] = await db
      .update(documentsTable)
      .set({
        extractionStatus: "accepted",
        extraction: {
          summary: doc.extraction.summary,
          fields: doc.extraction.fields.map((f) => {
            const edit = applied.find((a) => a.field === f.field);
            return edit ? { ...f, value: edit.value } : f;
          }),
        },
      })
      .where(eq(documentsTable.id, doc.id))
      .returning();

    await db.insert(auditLogsTable).values({
      dealerId,
      actorUserId: user?.id ?? null,
      actorClerkId: user?.clerkId ?? null,
      actorName: user?.name ?? null,
      actorEmail: user?.email ?? null,
      action: "approve",
      module: "leads",
      entityType: "lead",
      entityId: String(lead.id),
      summary: `${actorName} accepted A5 pre-fill from ${doc.fileName}: ${appliedSummary}`,
      details: { documentId: doc.id, applied },
    });
    await db.insert(timelineEventsTable).values({
      dealerId,
      customerId: lead.customerId,
      domain: "leads",
      kind: "document_prefill_applied",
      title: `Pre-fill applied from ${doc.fileName}`,
      detail: `${actorName} reviewed and confirmed: ${appliedSummary}`,
      actor: actorName,
      isAgent: false,
      refType: "lead",
      refId: lead.id,
    });

    res.json(ReviewDocumentExtractionResponse.parse(updated));
  },
);

export default router;
