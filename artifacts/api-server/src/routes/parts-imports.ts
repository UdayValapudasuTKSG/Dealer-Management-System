import { Router, type RequestHandler } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, partImportJobsTable as jobs, partPricingPoliciesTable as policies } from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import { importFields, mapImportRows, parseCsv } from "../lib/parts-import-validation";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1 } }).single("file");
const optionsSchema = z.object({
  mode: z.enum(["upsert", "reject"]).default("reject"),
  mapping: z.partialRecord(z.enum(importFields), z.string().min(1)).optional(),
  applyStock: z.boolean().default(false),
}).strict();
const policySchema = z.object({ category: z.string().trim().min(1).nullable(), markupFactor: z.number().finite().nonnegative().max(1000) }).strict();
function publicJob(job: typeof jobs.$inferSelect) {
  const { rows: _rows, columnMapping: _mapping, ...summary } = job;
  return { ...summary, errorCount: job.errors.length };
}
function idValue(value: unknown) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; }

export const createPartsImport: RequestHandler = async (req, res, next) => {
  try {
    const uploaded = await new Promise<boolean>(resolve => upload(req, res, err => {
      if (err) { res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.message }); resolve(false); }
      else resolve(true);
    }));
    if (!uploaded) return;
    if (!req.file) { res.status(400).json({ error: "Attach a CSV or XLSX file as file" }); return; }
    let options;
    try { options = optionsSchema.parse(JSON.parse(req.body.options || "{}")); }
    catch { res.status(400).json({ error: "Invalid options JSON; specify mode, mapping and applyStock" }); return; }
    let matrix: string[][] = [];
    try {
      if (/\.csv$/i.test(req.file.originalname)) matrix = parseCsv(req.file.buffer.toString("utf8"));
      else if (/\.xlsx$/i.test(req.file.originalname)) {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer as any);
        const sheet = workbook.worksheets[0];
        if (!sheet || sheet.rowCount > 10001 || sheet.columnCount > 100) throw new Error("Maximum 10,000 rows and 100 columns");
        sheet.eachRow({ includeEmpty: true }, row => {
          const cells: string[] = [];
          for (let i = 1; i <= sheet.columnCount; i++) {
            const cell = row.getCell(i);
            if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error) throw new Error("Formula/error cells are not accepted; upload values only");
            cells.push(cell.text);
          }
          matrix.push(cells);
        });
      } else throw new Error("Only CSV and XLSX files are supported");
      if (matrix.length < 2 || matrix.length > 10001 || (matrix[0]?.length ?? 0) > 100) throw new Error("File must contain 1–10,000 data rows and at most 100 columns");
      const rows = mapImportRows(matrix, options);
      const [job] = await db.insert(jobs).values({
        dealerId: activeDealerId(res), fileName: req.file.originalname, mode: options.mode, status: "pending",
        rows, columnMapping: options, totalRows: rows.length, createdBy: res.locals.user?.id ?? null,
      }).returning();
      res.status(202).json(publicJob(job));
    } catch (err) {
      if (err instanceof Error && !("code" in err)) { res.status(400).json({ error: err.message }); return; }
      throw err;
    }
  } catch (err) { next(err); }
};
router.post("/parts/imports", createPartsImport);
router.get("/parts/imports/:id", async (req, res) => {
  const id = idValue(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid import id" }); return; }
  const [job] = await db.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.dealerId, activeDealerId(res))));
  if (!job) { res.status(404).json({ error: "Import not found" }); return; }
  res.json(publicJob(job));
});
for (const action of ["validate", "commit"] as const) {
  router.post(`/parts/imports/:id/${action}`, async (req, res) => {
    const id = idValue(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid import id" }); return; }
    const result = await db.transaction(async tx => {
      const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.dealerId, activeDealerId(res)))).for("update");
      if (!job) return { status: 404, body: { error: "Import not found" } };
      const allowed = action === "commit" ? ["validated"] : ["invalid", "failed", "validated"];
      if (!allowed.includes(job.status)) return { status: 409, body: { error: `Cannot ${action} import in ${job.status} state` } };
      const [updated] = await tx.update(jobs).set({ status: action === "commit" ? "queued" : "pending", processedRows: 0, errors: [], errorMessage: null, completedAt: null }).where(eq(jobs.id, id)).returning();
      return { status: 202, body: publicJob(updated) };
    });
    res.status(result.status).json(result.body);
  });
}
router.get("/parts/pricing-policies", async (_req, res) => {
  res.json(await db.select().from(policies).where(eq(policies.dealerId, activeDealerId(res))));
});
router.put("/parts/pricing-policies", async (req, res) => {
  const parsed = policySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const dealerId = activeDealerId(res), data = parsed.data;
  const result = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${dealerId}, 13013)`);
    const condition = and(eq(policies.dealerId, dealerId), data.category === null ? isNull(policies.category) : eq(policies.category, data.category));
    const [old] = await tx.select().from(policies).where(condition);
    const [policy] = old
      ? await tx.update(policies).set({ ...data, updatedAt: new Date() }).where(condition).returning()
      : await tx.insert(policies).values({ ...data, dealerId }).returning();
    return policy;
  });
  res.json(result);
});
router.delete("/parts/pricing-policies/:id", async (req, res) => {
  const id = idValue(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid policy id" }); return; }
  const deleted = await db.delete(policies).where(and(eq(policies.id, id), eq(policies.dealerId, activeDealerId(res)))).returning({ id: policies.id });
  if (!deleted.length) { res.status(404).json({ error: "Policy not found" }); return; }
  res.status(204).end();
});
export default router;