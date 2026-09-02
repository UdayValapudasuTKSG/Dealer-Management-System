import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  garageVehiclesTable,
  timelineEventsTable,
  vehicleOnboardingMediaTable,
  vehicleOnboardingRequestsTable,
  type VehicleOnboardingRequest,
} from "@workspace/db";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const INVALID = { error: "This vehicle onboarding link is not valid" };
const imageMimes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
const videoMimes = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const limits = { image: { count: 12, bytes: 15 * 1024 * 1024 }, video: { count: 3, bytes: 150 * 1024 * 1024 } };
const tokenParams = z.object({ token: z.string().min(32).max(128) });
const mediaParams = tokenParams.extend({ mediaId: z.coerce.number().int().positive() });

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function requestFor(token: string): Promise<VehicleOnboardingRequest | null> {
  const [row] = await db.select().from(vehicleOnboardingRequestsTable)
    .where(eq(vehicleOnboardingRequestsTable.tokenHash, digest(token)));
  return row ?? null;
}

function active(row: VehicleOnboardingRequest, res: any): boolean {
  if (row.submittedAt) {
    res.status(409).json({ error: "This vehicle onboarding form was already submitted" });
    return false;
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    res.status(410).json({ error: "This vehicle onboarding link has expired" });
    return false;
  }
  return true;
}

router.get("/vehicle-onboarding/:token", async (req, res): Promise<void> => {
  const parsed = tokenParams.safeParse(req.params);
  const request = parsed.success ? await requestFor(parsed.data.token) : null;
  if (!request) { res.status(404).json(INVALID); return; }
  const [customer] = await db.select({ name: customersTable.name }).from(customersTable).where(and(
    eq(customersTable.id, request.customerId), eq(customersTable.dealerId, request.dealerId),
  ));
  if (!customer) { res.status(404).json(INVALID); return; }
  const media = await db.select({
    id: vehicleOnboardingMediaTable.id, kind: vehicleOnboardingMediaTable.kind,
    mimeType: vehicleOnboardingMediaTable.mimeType, sizeBytes: vehicleOnboardingMediaTable.sizeBytes,
    originalName: vehicleOnboardingMediaTable.originalName,
  }).from(vehicleOnboardingMediaTable).where(and(
    eq(vehicleOnboardingMediaTable.requestId, request.id),
    eq(vehicleOnboardingMediaTable.dealerId, request.dealerId),
    eq(vehicleOnboardingMediaTable.customerId, request.customerId),
    sql`${vehicleOnboardingMediaTable.finalizedAt} is not null`,
  ));
  res.json({
    state: request.submittedAt ? "submitted" : request.expiresAt.getTime() <= Date.now() ? "expired" : "open",
    customerName: customer.name, expiresAt: request.expiresAt.toISOString(), media,
  });
});

const uploadBody = z.object({
  kind: z.enum(["image", "video"]),
  mimeType: z.string().max(100),
  originalName: z.string().trim().min(1).max(255).optional(),
});

router.post("/vehicle-onboarding/:token/media/upload-url", async (req, res): Promise<void> => {
  const params = tokenParams.safeParse(req.params);
  const body = uploadBody.safeParse(req.body);
  const request = params.success ? await requestFor(params.data.token) : null;
  if (!request) { res.status(404).json(INVALID); return; }
  if (!body.success) { res.status(422).json({ error: "Invalid media request" }); return; }
  if (!active(request, res)) return;
  const allowed = body.data.kind === "image" ? imageMimes : videoMimes;
  if (!allowed.has(body.data.mimeType.toLowerCase())) {
    res.status(422).json({ error: "Unsupported media type" }); return;
  }
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(vehicleOnboardingMediaTable).where(and(
      eq(vehicleOnboardingMediaTable.requestId, request.id),
      eq(vehicleOnboardingMediaTable.dealerId, request.dealerId),
      eq(vehicleOnboardingMediaTable.customerId, request.customerId),
      eq(vehicleOnboardingMediaTable.kind, body.data.kind),
    ));
  if ((count ?? 0) >= limits[body.data.kind].count) {
    res.status(422).json({ error: `Maximum ${limits[body.data.kind].count} ${body.data.kind} uploads` }); return;
  }
  const generated = await storage.createPrivateUpload(`vehicle-onboarding/request-${request.id}`);
  const [media] = await db.insert(vehicleOnboardingMediaTable).values({
    requestId: request.id, dealerId: request.dealerId, customerId: request.customerId,
    objectPath: generated.objectPath, kind: body.data.kind, mimeType: body.data.mimeType.toLowerCase(),
    sizeBytes: 0, originalName: body.data.originalName ?? null, finalizedAt: null,
  }).returning({ id: vehicleOnboardingMediaTable.id });
  res.status(201).json({ mediaId: media!.id, uploadUrl: generated.uploadUrl, maxBytes: limits[body.data.kind].bytes });
});

router.post("/vehicle-onboarding/:token/media/:mediaId/finalize", async (req, res): Promise<void> => {
  const params = mediaParams.safeParse(req.params);
  const request = params.success ? await requestFor(params.data.token) : null;
  if (!request) { res.status(404).json(INVALID); return; }
  const mediaId = params.data!.mediaId;
  if (request.expiresAt.getTime() <= Date.now()) {
    res.status(410).json({ error: "This vehicle onboarding link has expired" }); return;
  }
  if (!active(request, res)) return;
  const [media] = await db.select().from(vehicleOnboardingMediaTable).where(and(
    eq(vehicleOnboardingMediaTable.id, mediaId),
    eq(vehicleOnboardingMediaTable.requestId, request.id),
    eq(vehicleOnboardingMediaTable.dealerId, request.dealerId),
    eq(vehicleOnboardingMediaTable.customerId, request.customerId),
    isNull(vehicleOnboardingMediaTable.finalizedAt),
  ));
  if (!media) { res.status(404).json(INVALID); return; }
  try {
    const file = await storage.getObjectEntityFile(media.objectPath);
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size);
    const actualMime = String(metadata.contentType ?? "").toLowerCase();
    const allowed = media.kind === "image" ? imageMimes : videoMimes;
    if (!Number.isSafeInteger(size) || size <= 0 || size > limits[media.kind as "image" | "video"].bytes ||
        actualMime !== media.mimeType || !allowed.has(actualMime)) {
      res.status(422).json({ error: "Uploaded media failed verification" }); return;
    }
    const [finalized] = await db.update(vehicleOnboardingMediaTable)
      .set({ sizeBytes: size, finalizedAt: new Date() }).where(and(
        eq(vehicleOnboardingMediaTable.id, media.id),
        eq(vehicleOnboardingMediaTable.requestId, request.id),
        eq(vehicleOnboardingMediaTable.dealerId, request.dealerId),
        isNull(vehicleOnboardingMediaTable.finalizedAt),
      )).returning({ id: vehicleOnboardingMediaTable.id });
    if (!finalized) { res.status(409).json({ error: "Media was already finalized" }); return; }
    res.json({ id: finalized.id, status: "ready" });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) { res.status(422).json({ error: "Upload was not found" }); return; }
    throw error;
  }
});

router.get("/vehicle-onboarding/:token/media/:mediaId", async (req, res): Promise<void> => {
  const params = mediaParams.safeParse(req.params);
  const request = params.success ? await requestFor(params.data.token) : null;
  if (!request) { res.status(404).json(INVALID); return; }
  const mediaId = params.data!.mediaId;
  // A submitted form can render its finalized media during the completion
  // screen, but the bearer capability is never valid after its expiry.
  if (request.expiresAt.getTime() <= Date.now()) {
    res.status(410).json({ error: "This vehicle onboarding link has expired" }); return;
  }
  const [media] = await db.select().from(vehicleOnboardingMediaTable).where(and(
    eq(vehicleOnboardingMediaTable.id, mediaId),
    eq(vehicleOnboardingMediaTable.requestId, request.id),
    eq(vehicleOnboardingMediaTable.dealerId, request.dealerId),
    eq(vehicleOnboardingMediaTable.customerId, request.customerId),
    sql`${vehicleOnboardingMediaTable.finalizedAt} is not null`,
  ));
  if (!media) { res.status(404).json(INVALID); return; }
  try {
    const file = await storage.getObjectEntityFile(media.objectPath);
    res.setHeader("Content-Type", media.mimeType);
    res.setHeader("Content-Length", String(media.sizeBytes));
    res.setHeader("Cache-Control", "private, no-store");
    file.createReadStream().on("error", () => res.destroy()).pipe(res);
  } catch { res.status(404).json(INVALID); }
});

const submitBody = z.object({
  registration: z.string().trim().min(1).max(40),
  vinChassis: z.string().trim().max(80).optional(),
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  year: z.number().int().min(1900).max(new Date().getFullYear() + 1).optional(),
  colour: z.string().trim().max(50).optional(),
  mileage: z.number().int().min(0).max(10_000_000).optional(),
  notes: z.string().trim().max(4000).optional(),
});

router.post("/vehicle-onboarding/:token/submit", async (req, res): Promise<void> => {
  const params = tokenParams.safeParse(req.params);
  const body = submitBody.safeParse(req.body);
  const request = params.success ? await requestFor(params.data.token) : null;
  if (!request) { res.status(404).json(INVALID); return; }
  if (!body.success) { res.status(422).json({ error: "Invalid vehicle details" }); return; }
  if (!active(request, res)) return;
  const vehicle = await db.transaction(async (tx) => {
    const [claimed] = await tx.update(vehicleOnboardingRequestsTable).set({ submittedAt: new Date() }).where(and(
      eq(vehicleOnboardingRequestsTable.id, request.id),
      eq(vehicleOnboardingRequestsTable.dealerId, request.dealerId),
      eq(vehicleOnboardingRequestsTable.customerId, request.customerId),
      isNull(vehicleOnboardingRequestsTable.submittedAt),
      sql`${vehicleOnboardingRequestsTable.expiresAt} > now()`,
    )).returning({ id: vehicleOnboardingRequestsTable.id });
    if (!claimed) return null;
    const values = { ...body.data, vinChassis: body.data.vinChassis || null, colour: body.data.colour || null,
      notes: body.data.notes || null, dealerId: request.dealerId, customerId: request.customerId, updatedAt: new Date() };
    const [saved] = await tx.insert(garageVehiclesTable).values(values).onConflictDoUpdate({
      target: [garageVehiclesTable.dealerId, garageVehiclesTable.customerId, garageVehiclesTable.registration],
      set: values,
    }).returning();
    await tx.update(vehicleOnboardingRequestsTable).set({ garageVehicleId: saved!.id }).where(and(
      eq(vehicleOnboardingRequestsTable.id, request.id), eq(vehicleOnboardingRequestsTable.dealerId, request.dealerId),
    ));
    await tx.update(vehicleOnboardingMediaTable).set({ garageVehicleId: saved!.id }).where(and(
      eq(vehicleOnboardingMediaTable.requestId, request.id), eq(vehicleOnboardingMediaTable.dealerId, request.dealerId),
      eq(vehicleOnboardingMediaTable.customerId, request.customerId), sql`${vehicleOnboardingMediaTable.finalizedAt} is not null`,
    ));
    await tx.insert(timelineEventsTable).values({
      dealerId: request.dealerId, customerId: request.customerId, domain: "customers",
      kind: "vehicle_self_onboarded", title: `${saved!.make} ${saved!.model} added to customer garage`,
      detail: `Registration ${saved!.registration}`, actor: "Customer", isAgent: false,
      refType: "garage_vehicle", refId: saved!.id,
    });
    return saved;
  });
  if (!vehicle) { res.status(409).json({ error: "This vehicle onboarding form was already submitted" }); return; }
  res.status(201).json({ state: "submitted", vehicle });
});

export default router;