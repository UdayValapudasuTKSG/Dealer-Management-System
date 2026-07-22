import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { and, eq, or, sql } from "drizzle-orm";
import { db, documentsTable, vehiclesTable } from "@workspace/db";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { activeDealerId } from "../middlewares/rbac";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/** Matches an upload key carrying a dealer-tenancy prefix, e.g. uploads/dealer-3/uuid */
const DEALER_PREFIX_RE = /^uploads\/dealer-(\d+)\//;

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;

    // Consumers: vehicle gallery photos (images) and the Documents module
    // (PDF/JPG/PNG/DOCX up to 20MB). Reject everything else at presign time.
    const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB
    const DOCUMENT_MIME = new Set([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]);
    const isImage = contentType.startsWith("image/");
    if (!isImage && !DOCUMENT_MIME.has(contentType)) {
      res
        .status(422)
        .json({ error: "Only image, PDF or DOCX uploads are allowed" });
      return;
    }
    if (size > MAX_UPLOAD_BYTES) {
      res.status(422).json({ error: "File is too large (max 20MB)" });
      return;
    }

    // The dealer prefix is stamped server-side (never client-supplied) so the
    // object key itself encodes ownership; reads enforce it below.
    const uploadURL = await objectStorageService.getObjectEntityUploadURL(
      `dealer-${activeDealerId(res)}`,
    );
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as unknown as import("stream/web").ReadableStream);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 *
 * Tenancy enforcement (behind requireAuth):
 * - New uploads carry a server-stamped `uploads/dealer-{id}/` prefix: only the
 *   owning dealer can read them; any other dealer gets an indistinguishable 404.
 * - Legacy unprefixed keys FAIL CLOSED: readable only when the key is
 *   referenced by the active dealer's own documents or vehicle photos.
 *   Anything unreferenced (or referenced by another dealer) is a 404.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;

    const dealerId = activeDealerId(res);
    const prefixMatch = DEALER_PREFIX_RE.exec(wildcardPath);
    if (prefixMatch) {
      if (Number(prefixMatch[1]) !== dealerId) {
        // Cross-dealer read — 404, indistinguishable from a missing object.
        res.status(404).json({ error: "Object not found" });
        return;
      }
    } else {
      // Legacy unprefixed key: only serve it when the ACTIVE dealer's own
      // records reference it (documents storageKey or vehicle photos).
      const [owningDoc] = await db
        .select({ id: documentsTable.id })
        .from(documentsTable)
        .where(
          and(
            eq(documentsTable.storageKey, objectPath),
            eq(documentsTable.dealerId, dealerId),
          ),
        )
        .limit(1);
      let referenced = !!owningDoc;
      if (!referenced) {
        const [owningVehicle] = await db
          .select({ id: vehiclesTable.id })
          .from(vehiclesTable)
          .where(
            and(
              eq(vehiclesTable.dealerId, dealerId),
              or(
                eq(vehiclesTable.imageUrl, objectPath),
                // Exact JSON element containment — no LIKE, so `%`/`_` in a
                // user-supplied key can never widen the match (fail closed).
                sql`${vehiclesTable.images} @> ${JSON.stringify([objectPath])}::jsonb`,
              ),
            ),
          )
          .limit(1);
        referenced = !!owningVehicle;
      }
      if (!referenced) {
        res.status(404).json({ error: "Object not found" });
        return;
      }
    }

    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as unknown as import("stream/web").ReadableStream);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
