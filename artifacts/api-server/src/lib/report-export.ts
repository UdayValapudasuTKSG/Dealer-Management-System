import type { Response } from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { ReportPayload } from "../routes/reports";
import { guyanaDateLabel } from "./report-scope";

type ExportMeta = {
  dealerName: string;
  usdExchangeRate: number;
};

const nowGuyana = () =>
  new Date().toLocaleString("en-GB", {
    timeZone: "America/Guyana",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const fileBase = (payload: ReportPayload) =>
  `${payload.type}-${payload.from.slice(0, 10)}-${payload.to.slice(0, 10)}`;

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function buildCsv(payload: ReportPayload, meta: ExportMeta): string {
  const lines: string[] = [];
  lines.push(`${payload.label} — ${meta.dealerName}`);
  lines.push(
    `Range,${guyanaDateLabel(payload.from)} - ${guyanaDateLabel(payload.to)}`,
  );
  lines.push(
    `Money,GYD (USD x ${meta.usdExchangeRate}),Generated,${nowGuyana()} (Guyana)`,
  );
  lines.push("");
  lines.push("KPI,Value,Note");
  for (const k of payload.kpis)
    lines.push(
      [k.label, k.value, k.sub ?? ""].map((v) => csvEscape(String(v))).join(","),
    );
  lines.push("");
  lines.push(payload.table.columns.map(csvEscape).join(","));
  for (const row of payload.table.rows)
    lines.push(row.map((c) => csvEscape(c)).join(","));
  return lines.join("\r\n");
}

async function buildXlsx(
  payload: ReportPayload,
  meta: ExportMeta,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AURA Dealership OS";
  const ws = wb.addWorksheet(payload.label.slice(0, 31));
  ws.addRow([`${payload.label} — ${meta.dealerName}`]);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.addRow([
    `Range: ${guyanaDateLabel(payload.from)} – ${guyanaDateLabel(payload.to)}`,
  ]);
  ws.addRow([
    `Money in GYD (USD × ${meta.usdExchangeRate}) · Generated ${nowGuyana()} (Guyana)`,
  ]);
  ws.addRow([]);
  const kpiHeader = ws.addRow(["KPI", "Value", "Note"]);
  kpiHeader.font = { bold: true };
  for (const k of payload.kpis) ws.addRow([k.label, k.value, k.sub ?? ""]);
  ws.addRow([]);
  const tableHeader = ws.addRow(payload.table.columns);
  tableHeader.font = { bold: true };
  for (const row of payload.table.rows) ws.addRow(row);
  ws.columns.forEach((col) => {
    let max = 12;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      max = Math.max(max, String(cell.value ?? "").length + 2);
    });
    col.width = Math.min(max, 48);
  });
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function buildPdf(payload: ReportPayload, meta: ExportMeta): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const bronze = "#A97142";
    doc
      .fillColor(bronze)
      .fontSize(20)
      .font("Helvetica-Bold")
      .text(payload.label);
    doc
      .fillColor("#444444")
      .fontSize(10)
      .font("Helvetica")
      .text(meta.dealerName)
      .text(
        `Range: ${guyanaDateLabel(payload.from)} – ${guyanaDateLabel(payload.to)}`,
      )
      .text(
        `Money in GYD (USD × ${meta.usdExchangeRate}) · Generated ${nowGuyana()} (Guyana time)`,
      );
    doc.moveDown(1);

    doc.fillColor("#000000").fontSize(13).font("Helvetica-Bold").text("Key metrics");
    doc.moveDown(0.4);
    for (const k of payload.kpis) {
      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .fillColor("#000000")
        .text(`${k.label}: `, { continued: true })
        .font("Helvetica")
        .text(`${k.value}${k.sub ? `  (${k.sub})` : ""}`);
    }
    doc.moveDown(1);

    doc.fontSize(13).font("Helvetica-Bold").text("Breakdown");
    doc.moveDown(0.4);
    const cols = payload.table.columns;
    const usable = doc.page.width - 96;
    const colW = usable / Math.max(1, cols.length);
    const startX = doc.page.margins.left;
    let y = doc.y;

    const drawRow = (cells: string[], bold: boolean) => {
      if (y > doc.page.height - 72) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
      let maxH = 0;
      cells.forEach((cell, i) => {
        const h = doc.heightOfString(cell, { width: colW - 6 });
        maxH = Math.max(maxH, h);
        doc.fillColor(bold ? bronze : "#222222").text(cell, startX + i * colW, y, {
          width: colW - 6,
        });
      });
      y += maxH + 5;
    };
    drawRow(cols, true);
    for (const row of payload.table.rows) drawRow(row, false);
    doc.end();
  });
}

/** Stream the export file for the already-RBAC-filtered report payload. */
export async function renderReportExport(
  res: Response,
  payload: ReportPayload,
  format: "csv" | "xlsx" | "pdf",
  meta: ExportMeta,
): Promise<void> {
  const base = fileBase(payload);
  if (format === "csv") {
    res
      .type("text/csv")
      .setHeader("Content-Disposition", `attachment; filename="${base}.csv"`)
      .send(buildCsv(payload, meta));
    return;
  }
  if (format === "xlsx") {
    const buf = await buildXlsx(payload, meta);
    res
      .type(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .setHeader("Content-Disposition", `attachment; filename="${base}.xlsx"`)
      .send(buf);
    return;
  }
  const buf = await buildPdf(payload, meta);
  res
    .type("application/pdf")
    .setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`)
    .send(buf);
}
