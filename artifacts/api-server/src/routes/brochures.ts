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
import { BrochureUploadValidationError, brochureCatalog, brochureView, commitBrochureUpload, safeBrochureFileName, GT_BROCHURES, financeFor, type BrochureFinance } from "../lib/lead-brochures";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();
function financeChanges(input: Partial<BrochureFinance>, existing: BrochureFinance): BrochureFinance {
  const value = { ...existing, ...input };
  if (value.downPaymentType === null ? value.downPaymentValue !== null : value.downPaymentValue === null)
    throw new BrochureUploadValidationError("Specify both the down payment type and value, or clear both.");
  if (value.downPaymentType === "percent" && value.downPaymentValue! > 100)
    throw new BrochureUploadValidationError("Down payment percentage cannot exceed 100.");
  if (value.financeModel !== null && !value.financeModel.trim())
    throw new BrochureUploadValidationError("Enter a finance model or clear it.");
  for (const field of ["downPaymentValue", "monthlyEmi", "priceDp", "priceDf"] as const) {
    const number = value[field];
    if (number !== null && (!Number.isFinite(number) || number < 0 || number > 999999999999.99))
      throw new BrochureUploadValidationError("Finance amounts must be non-negative GYD values.");
  }
  return value;
}

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
    const finance = financeChanges(parsed.data, {
      financeModel: null, downPaymentType: null, downPaymentValue: null,
      monthlyEmi: null, priceDp: null, priceDf: null,
    });
    const fileName = safeBrochureFileName(parsed.data.fileName);
    uploaded = await commitBrochureUpload(dealerId, parsed.data.objectPath);
    const [row] = await db.insert(brochuresTable).values({
      id: randomUUID(), dealerId, title: parsed.data.title.trim(), fileName,
      objectPath: uploaded.objectPath, sha: uploaded.sha, sizeBytes: uploaded.sizeBytes, ...finance, financeCustomized: true,
    }).returning();
    res.status(201).json(CreateDealerBrochureResponse.parse(brochureView(row)));
  } catch (error) {
    if (uploaded) await uploaded.objectFile.delete().catch(() => {});
    if (error instanceof BrochureUploadValidationError) {
      res.status(422).json({ error: error.message }); return;
    }
    console.error("Could not save brochure:", error);
    res.status(500).json({ error: "Could not save brochure." });
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
  let [existing] = await db.select().from(brochuresTable).where(where);
  const builtin = activeDealerId(res) === 1 ? GT_BROCHURES.find((b) => b.id === params.data.brochureId) : undefined;
  if (!existing && !builtin) { res.status(404).json({ error: "Active brochure not found." }); return; }
  let uploaded: Awaited<ReturnType<typeof commitBrochureUpload>> | undefined;
  try {
    const finance = financeChanges(parsed.data, existing ? {
      ...existing, downPaymentType: existing.downPaymentType === "amount" || existing.downPaymentType === "percent"
        ? existing.downPaymentType : null,
      ...(existing.dealerId === 1 && !existing.financeCustomized && existing.financeModel === null && existing.downPaymentType === null &&
        existing.downPaymentValue === null && existing.monthlyEmi === null && existing.priceDp === null && existing.priceDf === null
        ? financeFor(existing.id) : {}),
    } : financeFor(builtin!.id));
    const fileName = parsed.data.fileName !== undefined
      ? safeBrochureFileName(parsed.data.fileName) : (existing?.fileName ?? builtin!.fileName);
    if (parsed.data.objectPath) uploaded = await commitBrochureUpload(activeDealerId(res), parsed.data.objectPath);
    const [row] = existing ? await db.update(brochuresTable).set({
      title: parsed.data.title?.trim() ?? existing.title, fileName, ...finance, financeCustomized: true,
      ...(uploaded ? { objectPath: uploaded.objectPath, sha: uploaded.sha, sizeBytes: uploaded.sizeBytes } : {}),
    }).where(where).returning() : await db.insert(brochuresTable).values({
      id: builtin!.id, dealerId: activeDealerId(res), title: parsed.data.title?.trim() ?? builtin!.title,
      fileName, objectPath: uploaded?.objectPath ?? `/objects/brochures/dealer-1/${builtin!.sha}.pdf`,
      sha: uploaded?.sha ?? builtin!.sha, sizeBytes: uploaded?.sizeBytes ?? builtin!.sizeBytes, ...finance, financeCustomized: true,
    }).onConflictDoNothing().returning();
    if (!row) {
      if (uploaded) await uploaded.objectFile.delete();
      res.status(404).json({ error: "Active brochure not found." }); return;
    }
    res.json(UpdateDealerBrochureResponse.parse(brochureView(row)));
  } catch (error) {
    if (uploaded) await uploaded.objectFile.delete().catch(() => {});
    if (error instanceof BrochureUploadValidationError) {
      res.status(422).json({ error: error.message }); return;
    }
    console.error("Could not update brochure:", error);
    res.status(500).json({ error: "Could not update brochure." });
  }
});

router.delete("/settings/brochures/:brochureId", async (req, res): Promise<void> => {
  const params = ArchiveDealerBrochureParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid brochure ID." }); return; }
  let [row] = await db.update(brochuresTable).set({ active: false }).where(and(
    eq(brochuresTable.id, params.data.brochureId),
    eq(brochuresTable.dealerId, activeDealerId(res)),
  )).returning();
  if (!row && activeDealerId(res) === 1) {
    const builtin = GT_BROCHURES.find((b) => b.id === params.data.brochureId);
    if (builtin) [row] = await db.insert(brochuresTable).values({
      id: builtin.id, dealerId: 1, title: builtin.title, fileName: builtin.fileName,
      objectPath: `/objects/brochures/dealer-1/${builtin.sha}.pdf`,
      sha: builtin.sha, sizeBytes: builtin.sizeBytes, active: false, ...financeFor(builtin.id),
    }).onConflictDoNothing().returning();
  }
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