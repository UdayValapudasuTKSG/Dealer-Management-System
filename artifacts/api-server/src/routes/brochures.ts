import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, brochuresTable } from "@workspace/db";
import {
  ListDealerBrochuresResponse, CreateDealerBrochureBody, CreateDealerBrochureResponse,
  UpdateDealerBrochureParams, UpdateDealerBrochureBody, UpdateDealerBrochureResponse,
  ArchiveDealerBrochureParams, ArchiveDealerBrochureResponse, DownloadDealerBrochureParams,
} from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";
import { brochureCatalog, brochureView, commitBrochureUpload, safeBrochureFileName } from "../lib/lead-brochures";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();

router.get("/settings/brochures", async (_req, res) => {
  const dealerId = activeDealerId(res);
  const rows = await db.select().from(brochuresTable).where(eq(brochuresTable.dealerId, dealerId));
  res.json(ListDealerBrochuresResponse.parse([
    ...(dealerId === 1 ? brochureCatalog.filter((b) => !rows.some((row) => row.id === b.id))
      .map((b) => ({ ...b, active: true })) : []),
    ...rows.map(brochureView),
  ]));
});

router.post("/settings/brochures", async (req, res): Promise<void> => {
  const parsed = CreateDealerBrochureBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.title.trim()) {
    res.status(400).json({ error: "Enter a brochure name, PDF filename, and upload a PDF." }); return;
  }
  let uploaded: Awaited<ReturnType<typeof commitBrochureUpload>> | undefined;
  try {
    const dealerId = activeDealerId(res);
    const fileName = safeBrochureFileName(parsed.data.fileName);
    uploaded = await commitBrochureUpload(dealerId, parsed.data.objectPath);
    const [row] = await db.insert(brochuresTable).values({
      id: randomUUID(), dealerId, title: parsed.data.title.trim(), fileName,
      objectPath: uploaded.objectPath, sha: uploaded.sha, sizeBytes: uploaded.sizeBytes,
    }).returning();
    res.status(201).json(CreateDealerBrochureResponse.parse(brochureView(row)));
  } catch (error) {
    if (uploaded) await uploaded.objectFile.delete().catch(() => {});
    res.status(422).json({ error: error instanceof Error ? error.message : "Could not save brochure." });
  }
});

router.patch("/settings/brochures/:brochureId", async (req, res): Promise<void> => {
  const params = UpdateDealerBrochureParams.safeParse(req.params);
  const parsed = UpdateDealerBrochureBody.safeParse(req.body);
  if (!params.success || !parsed.success || !Object.keys(parsed.data).length ||
      (parsed.data.title !== undefined && !parsed.data.title.trim())) {
    res.status(400).json({ error: "Enter valid brochure changes." }); return;
  }
  const where = and(eq(brochuresTable.id, params.data.brochureId),
    eq(brochuresTable.dealerId, activeDealerId(res)), eq(brochuresTable.active, true));
  const [existing] = await db.select().from(brochuresTable).where(where);
  if (!existing) { res.status(404).json({ error: "Active brochure not found." }); return; }
  let uploaded: Awaited<ReturnType<typeof commitBrochureUpload>> | undefined;
  try {
    const fileName = parsed.data.fileName !== undefined
      ? safeBrochureFileName(parsed.data.fileName) : existing.fileName;
    if (parsed.data.objectPath) uploaded = await commitBrochureUpload(activeDealerId(res), parsed.data.objectPath);
    const [row] = await db.update(brochuresTable).set({
      title: parsed.data.title?.trim() ?? existing.title, fileName,
      ...(uploaded ? { objectPath: uploaded.objectPath, sha: uploaded.sha, sizeBytes: uploaded.sizeBytes } : {}),
    }).where(where).returning();
    if (!row) {
      if (uploaded) await uploaded.objectFile.delete();
      res.status(404).json({ error: "Active brochure not found." }); return;
    }
    res.json(UpdateDealerBrochureResponse.parse(brochureView(row)));
  } catch (error) {
    if (uploaded) await uploaded.objectFile.delete().catch(() => {});
    res.status(422).json({ error: error instanceof Error ? error.message : "Could not update brochure." });
  }
});

router.delete("/settings/brochures/:brochureId", async (req, res): Promise<void> => {
  const params = ArchiveDealerBrochureParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid brochure ID." }); return; }
  const [row] = await db.update(brochuresTable).set({ active: false }).where(and(
    eq(brochuresTable.id, params.data.brochureId),
    eq(brochuresTable.dealerId, activeDealerId(res)),
  )).returning();
  if (!row) { res.status(404).json({ error: "Brochure not found." }); return; }
  res.json(ArchiveDealerBrochureResponse.parse(brochureView(row)));
});

router.get("/settings/brochures/:brochureId/download", async (req, res): Promise<void> => {
  const params = DownloadDealerBrochureParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid brochure ID." }); return; }
  const [row] = await db.select().from(brochuresTable).where(and(
    eq(brochuresTable.id, params.data.brochureId), eq(brochuresTable.dealerId, activeDealerId(res))));
  if (!row) { res.status(404).json({ error: "Brochure not found." }); return; }
  try {
    const file = await storage.getObjectEntityFile(row.objectPath);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeBrochureFileName(row.fileName)}"`);
    file.createReadStream().on("error", () => res.destroy()).pipe(res);
  } catch {
    res.status(503).json({ error: "Brochure file unavailable." });
  }
});

export default router;