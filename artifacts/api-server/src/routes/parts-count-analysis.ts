import { Router, type RequestHandler } from "express";
import { z } from "zod/v4";
import { and, eq, inArray } from "drizzle-orm";
import { db, partsTable } from "@workspace/db";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import { agingReport, valuationReport } from "../lib/parts-operations-reports";
import { getDealerPdfBranding } from "../lib/dealer-branding";
import { buildPartsAnalysisPdf } from "../lib/parts-count-analysis-pdf";
import { countWithPartNames, countExportRows, agingExportRows, reportCsv } from "../lib/parts-count-analysis";

const router = Router();
const view: RequestHandler = (req, res, next) => {
  if (!res.locals.user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!hasPermission(res.locals.user, "parts", "view")) { res.status(403).json({ error: "Parts view permission required" }); return; }
  const dealerId = activeDealerId(res);
  if (!Number.isSafeInteger(dealerId) || dealerId <= 0) { res.status(400).json({ error: "Select a dealer" }); return; }
  next();
};
const handler = (fn: (req: any, res: any, dealerId: number) => Promise<void>): RequestHandler => async (req, res) => {
  try { await fn(req, res, activeDealerId(res)); }
  catch (error) {
    if (res.headersSent) return;
    if (error instanceof z.ZodError) { res.status(400).json({ error: "Invalid request", details: error.issues }); return; }
    res.status(500).json({ error: "Unable to generate parts report" });
  }
};
async function output(req: any, res: any, dealerId: number, filename: string, title: string, rows: Record<string, unknown>[], columns?: string[]) {
  const format = z.enum(["csv", "pdf"]).parse(req.query.format);
  if (format === "csv") {
    res.type("text/csv").attachment(`${filename}.csv`).send(reportCsv(rows, columns));
  } else {
    const branding = await getDealerPdfBranding(dealerId);
    const bytes = await buildPartsAnalysisPdf(title, rows, branding);
    res.type("application/pdf").attachment(`${filename}.pdf`).send(bytes);
  }
}

router.use(view);
router.get("/cycle-counts/:id", handler(async (req, res, dealerId) => {
  const count = await countWithPartNames(dealerId, z.coerce.number().int().positive().parse(req.params.id));
  if (!count) { res.status(404).json({ error: "Cycle count not found" }); return; }
  res.json(count);
}));
router.get("/cycle-counts/:id/export", handler(async (req, res, dealerId) => {
  const count = await countWithPartNames(dealerId, z.coerce.number().int().positive().parse(req.params.id));
  if (!count) { res.status(404).json({ error: "Cycle count not found" }); return; }
  await output(req, res, dealerId, `cycle-count-${count.id}`, `Cycle Count #${count.id} · ${count.status.replace(/_/g, " ")}`, countExportRows(count.lines), ["Part Number", "Part Name", "Bin", "Expected", "Counted", "Variance"]);
}));
router.get("/aging/export", handler(async (req, res, dealerId) => {
  const thresholds = req.query.thresholds ? z.string().parse(req.query.thresholds).split(",").map((v: string) => z.coerce.number().int().min(1).max(36500).parse(v)) : [30, 60, 90];
  if (thresholds.length > 10 || thresholds.some((n: number, i: number) => i > 0 && n <= thresholds[i - 1]!)) { res.status(400).json({ error: "Thresholds must be ascending unique days" }); return; }
  const report = await agingReport(dealerId, {
    thresholds,
    locationId: req.query.locationId ? z.coerce.number().int().positive().parse(req.query.locationId) : undefined,
    category: req.query.category ? z.string().trim().min(1).max(500).parse(req.query.category) : undefined,
  });
  await output(req, res, dealerId, "parts-aging", "Stock Aging Analysis", agingExportRows(report.rows as any), ["Part Number", "Part Name", "Category", "Location", "Idle Qty", "Tied Capital (GYD)", "Age (days)", "Age Bucket"]);
}));
router.get("/valuation", handler(async (req, res, dealerId) => {
  const raw = req.query.asOf;
  let asOf = raw ? z.coerce.date().parse(raw) : new Date();
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    asOf = new Date(`${z.iso.date().parse(raw)}T23:59:59.999Z`);
    if (raw === new Date().toISOString().slice(0, 10)) asOf = new Date();
  }
  const locationId = req.query.locationId ? z.coerce.number().int().positive().parse(req.query.locationId) : undefined;
  const report = await valuationReport(dealerId, asOf, locationId);
  // The legacy report already names valued rows; resolve unavailable historical rows
  // from the same dealership, never from a client-side (paginated) catalog.
  const ids = report.unavailable.map(row => row.partId);
  const names = ids.length ? await db.select({ id: partsTable.id, name: partsTable.name }).from(partsTable).where(and(eq(partsTable.dealerId, dealerId), inArray(partsTable.id, ids))) : [];
  const lookup = new Map(names.map(row => [row.id, row.name]));
  const enriched = { ...report, unavailable: report.unavailable.map(row => {
    const name = lookup.get(row.partId);
    if (name === undefined) throw new Error("Valuation part is unavailable in this dealership");
    return { ...row, name };
  }) };
  if (req.query.format) {
    const valued = enriched.rows.map(row => ({
      "Part Number": row.sku, "Part Name": row.name, "Location": row.locationId,
      "Quantity": row.quantity, "Value (GYD)": row.value, "Method": row.method, "Status": "Valued",
    }));
    await output(req, res, dealerId, "parts-valuation", "Inventory Valuation Analysis", [
      ...valued,
      ...enriched.unavailable.map(row => ({
        "Part Number": row.sku, "Part Name": row.name, "Location": "", "Quantity": "",
        "Value (GYD)": "", "Method": "", "Status": row.reason,
      })),
    ]);
  } else res.json(enriched);
}));

export default router;