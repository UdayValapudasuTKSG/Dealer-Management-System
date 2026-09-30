import type { Response } from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { ReportPayload } from "../routes/reports";
import { dealerDateLabel } from "./report-scope";
import { formatDealerDateTime } from "./timezone";

type ExportMeta = {
  dealerName: string;
  usdExchangeRate: number;
  timezone: string;
  logo?: Buffer | null;
  address?: string | null;
  phone?: string | null;
  color?: string | null;
};

const generatedAt = (tz: string) => formatDealerDateTime(new Date(), tz);

const fileBase = (payload: ReportPayload) =>
  `${payload.type}-${payload.from.slice(0, 10)}-${payload.to.slice(0, 10)}`;

function csvEscape(value: string): string {
  // Customer-entered names and notes must remain text in spreadsheet apps.
  const text = /^[\s]*[=+@\t\r]/.test(value) || /^\s*-(?!\d)/.test(value)
    ? `'${value}`
    : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(payload: ReportPayload, meta: ExportMeta): string {
  const lines: string[] = [];
  lines.push(csvEscape(`${payload.label} — ${meta.dealerName}`));
  lines.push(
    ["Range", `${dealerDateLabel(payload.from, meta.timezone)} - ${dealerDateLabel(payload.to, meta.timezone)}`].map(csvEscape).join(","),
  );
  lines.push(
    ["Money", "GYD", "Generated", `${generatedAt(meta.timezone)} (${meta.timezone})`].map(csvEscape).join(","),
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
    `Range: ${dealerDateLabel(payload.from, meta.timezone)} – ${dealerDateLabel(payload.to, meta.timezone)}`,
  ]);
  ws.addRow([
    `Money in GYD · Generated ${generatedAt(meta.timezone)} (${meta.timezone})`,
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

export function buildPdf(payload: ReportPayload, meta: ExportMeta): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const left = 42, right = doc.page.width - 42, width = right - left, bottom = doc.page.height - 58;
    const accent = meta.color && /^#[0-9a-fA-F]{6}$/.test(meta.color) ? meta.color : "#A97142";
    const ink = "#172333", muted = "#566477", pale = "#F1F4F7";
    const palette = [accent, "#3C7686", "#A3A537", "#9267C6", "#E98E2E"];
    let y = 42;
    const text = (value: unknown) => String(value ?? "—").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
    const page = () => { doc.addPage(); y = 42; };
    const space = (height: number) => { if (y + height > bottom) page(); };
    // Explicit line breaks and long unbroken identifiers are wrapped before drawing;
    // no PDFKit auto-pagination can create an orphan blank page.
    const lines = (value: unknown, maxWidth: number, size = 8): string[] => {
      doc.font("Helvetica").fontSize(size);
      const out: string[] = [];
      for (const paragraph of text(value).split(/\r?\n/)) {
        let line = "";
        for (const word of paragraph.split(/(\s+)/).filter(Boolean)) {
          if (doc.widthOfString(line + word) <= maxWidth) { line += word; continue; }
          if (line.trim()) { out.push(line.trim()); line = ""; }
          for (const char of word) {
            if (doc.widthOfString(line + char) > maxWidth && line) { out.push(line); line = ""; }
            line += char;
          }
        }
        out.push(line.trim());
      }
      return out.length ? out : ["—"];
    };
    const heading = (title: string) => {
      space(37);
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(12).text(title, left, y, { lineBreak: false });
      y += 21;
      doc.moveTo(left, y).lineTo(right, y).strokeColor("#DCE3EA").lineWidth(0.8).stroke();
      y += 12;
    };

    doc.rect(0, 0, doc.page.width, 9).fill(accent);
    let logoWidth = 0;
    // Storage paths are resolved server-side; only verified small raster bytes are embedded.
    if (meta.logo && meta.logo.length < 2_000_000 &&
      ((meta.logo[0] === 0x89 && meta.logo.subarray(1, 4).toString() === "PNG") ||
       (meta.logo[0] === 0xff && meta.logo[1] === 0xd8))) {
      try {
        doc.image(meta.logo, left, y + 3, { fit: [92, 40], valign: "center" });
        logoWidth = 103;
      } catch { /* Invalid image: registered dealer name remains visible. */ }
    }
    const nameLines = lines(meta.dealerName, width - logoWidth, 16).slice(0, 2);
    for (const name of nameLines) {
      doc.font("Helvetica-Bold").fontSize(16).fillColor(ink)
        .text(name, left + logoWidth, y, { lineBreak: false });
      y += 20;
    }
    y = Math.max(y, 86);
    for (const contact of [meta.address, meta.phone].filter(Boolean)) {
      for (const line of lines(contact, width, 8)) {
        doc.font("Helvetica").fontSize(8).fillColor(muted).text(line, left, y, { lineBreak: false });
        y += 11;
      }
    }
    y += 15;
    doc.rect(left, y, width, 87).fill(pale);
    doc.rect(left, y, 4, 87).fill(accent);
    doc.font("Helvetica-Bold").fontSize(20).fillColor(ink)
      .text(payload.label, left + 17, y + 11, { width: width - 30, height: 28, ellipsis: true });
    doc.font("Helvetica").fontSize(9).fillColor(muted)
      .text(`${dealerDateLabel(payload.from, meta.timezone)} – ${dealerDateLabel(payload.to, meta.timezone)}`, left + 17, y + 43, { lineBreak: false })
      .text(`GYD  |  Generated ${generatedAt(meta.timezone)} (${meta.timezone})`, left + 17, y + 61, { width: width - 30, height: 15, ellipsis: true });
    y += 105;

    heading("KEY METRICS");
    const cardW = (width - 12) / 2;
    for (let i = 0; i < payload.kpis.length; i += 2) {
      const pair = payload.kpis.slice(i, i + 2);
      const height = Math.max(66, ...pair.map(k =>
        49 + Math.min(4, lines(k.sub ?? "", cardW - 22, 8).length) * 11));
      space(height + 10);
      pair.forEach((k, j) => {
        const x = left + j * (cardW + 12);
        doc.roundedRect(x, y, cardW, height, 5).fill(pale);
        doc.font("Helvetica-Bold").fontSize(8).fillColor(muted)
          .text(k.label.toUpperCase(), x + 11, y + 9, { width: cardW - 22, height: 12, ellipsis: true });
        doc.font("Helvetica-Bold").fontSize(16).fillColor(accent)
          .text(k.value, x + 11, y + 24, { width: cardW - 22, height: 20, ellipsis: true });
        lines(k.sub ?? "", cardW - 22, 8).slice(0, 4).forEach((s, line) =>
          doc.font("Helvetica").fontSize(8).fillColor(muted)
            .text(s, x + 11, y + 48 + line * 11, { lineBreak: false }));
      });
      y += height + 10;
    }

    heading(payload.chart.valueLabel || "BREAKDOWN");
    const chart = payload.chart;
    const points = chart.points.filter(p => Number.isFinite(p.value) && p.value >= 0);
    const shown = points.slice(0, 8);
    const total = points.reduce((n, p) => n + p.value, 0);
    if (!shown.length || total === 0) {
      space(30);
      doc.font("Helvetica").fontSize(9).fillColor(muted)
        .text(shown.length ? "No non-zero values in this period." : "No chart data in this period.", left, y);
      y += 30;
    } else if (chart.kind === "area") {
      space(185);
      const plotX = left + 52, plotY = y + 10, plotW = width - 70, plotH = 115;
      const max = Math.max(...points.map(p => p.value), 1);
      for (let tick = 0; tick <= 2; tick++) {
        const yy = plotY + plotH * tick / 2;
        doc.moveTo(plotX, yy).lineTo(plotX + plotW, yy)
          .strokeColor("#DCE3EA").lineWidth(0.6).stroke();
        const value = max * (2 - tick) / 2;
        const axis = value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` :
          value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value.toFixed(0);
        doc.font("Helvetica").fontSize(7).fillColor(muted).text(axis, left, yy - 4, { width: 45, align: "right", lineBreak: false });
      }
      const coords = points.map((p, i) => ({
        x: plotX + (points.length === 1 ? plotW / 2 : i * plotW / (points.length - 1)),
        y: plotY + plotH * (1 - p.value / max),
      }));
      if (coords.length > 1) {
        doc.moveTo(coords[0]!.x, coords[0]!.y);
        coords.slice(1).forEach(p => doc.lineTo(p.x, p.y));
        doc.strokeColor(accent).lineWidth(2).stroke();
      }
      coords.forEach(p => doc.circle(p.x, p.y, 2.4).fill(accent));
      [0, Math.floor((points.length - 1) / 2), points.length - 1].filter((v, i, arr) => arr.indexOf(v) === i)
        .forEach(i => doc.font("Helvetica").fontSize(7).fillColor(muted)
          .text(points[i]!.label, coords[i]!.x - 34, plotY + plotH + 9, { width: 68, align: "center", height: 12, ellipsis: true }));
      doc.font("Helvetica").fontSize(8).fillColor(muted).text(
        `${chart.valueLabel} · ${chart.currency ? "GYD" : "count"} · ${points.length} periods`, left, plotY + plotH + 32,
        { width, height: 13, ellipsis: true });
      y += 185;
    } else if (chart.kind === "pie" && points.length <= 5) {
      space(144);
      const cx = left + 71, cy = y + 65, radius = 52;
      let start = -Math.PI / 2;
      shown.forEach((p, i) => {
        const end = start + p.value / total * Math.PI * 2;
        doc.path(`M ${cx} ${cy} L ${cx + radius * Math.cos(start)} ${cy + radius * Math.sin(start)} ` +
          Array.from({ length: 32 }, (_, step) => {
            const a = start + (end - start) * (step + 1) / 32;
            return `L ${cx + radius * Math.cos(a)} ${cy + radius * Math.sin(a)}`;
          }).join(" ") + " Z").fill(palette[i % palette.length]!);
        start = end;
        const label = lines(p.label, 240, 8)[0]!;
        doc.rect(left + 150, y + i * 26 + 4, 8, 8).fill(palette[i % palette.length]!);
        doc.font("Helvetica").fontSize(8).fillColor(ink)
          .text(label, left + 164, y + i * 26, { width: width - 270, height: 13, ellipsis: true });
        doc.font("Helvetica-Bold").fontSize(8).fillColor(ink)
          .text(`${chart.currency ? "GYD " : ""}${p.value.toLocaleString("en-US")} (${(p.value / total * 100).toFixed(1)}%)`,
            right - 110, y + i * 26, { width: 110, align: "right", lineBreak: false });
      });
      doc.circle(cx, cy, 28).fill("#FFFFFF");
      doc.font("Helvetica-Bold").fontSize(10).fillColor(ink)
        .text(total.toLocaleString("en-US", { maximumFractionDigits: 0 }), cx - 28, cy - 7,
          { width: 56, height: 15, align: "center", ellipsis: true });
      y += 144;
    } else {
      const max = Math.max(...shown.map(p => p.value));
      const barX = left + Math.min(185, width * 0.35), barW = right - barX - 100;
      space(shown.length * 27 + 24);
      shown.forEach((p, i) => {
        const yy = y + i * 27;
        doc.font("Helvetica").fontSize(8).fillColor(ink)
          .text(p.label, left, yy + 3, { width: barX - left - 9, height: 15, ellipsis: true });
        doc.roundedRect(barX, yy + 2, barW, 11, 3).fill(pale);
        if (p.value) doc.roundedRect(barX, yy + 2, Math.max(2, barW * p.value / max), 11, 3).fill(accent);
        doc.font("Helvetica-Bold").fontSize(8).fillColor(ink)
          .text(`${chart.currency ? "GYD " : ""}${p.value.toLocaleString("en-US")}`, barX + barW + 7, yy + 2, { width: 92, align: "right", lineBreak: false });
      });
      y += shown.length * 27;
      doc.font("Helvetica").fontSize(8).fillColor(muted)
        .text(`${chart.valueLabel}${points.length > shown.length ? ` · First ${shown.length} of ${points.length} categories shown` : ""}`,
          left, y, { width, height: 13, ellipsis: true });
      y += 24;
    }
    heading("DETAIL");
    const cols = payload.table.columns;
    if (!payload.table.rows.length) {
      space(25);
      doc.font("Helvetica").fontSize(9).fillColor(muted).text("No detail records in this period.", left, y);
      y += 25;
    } else if (cols.length > 4 || cols.some(col => col.length > width / Math.max(1, cols.length) / 4)) {
      // Wide operational reports use labelled records so every field stays legible.
      payload.table.rows.forEach((row, index) => {
        space(24);
        doc.font("Helvetica-Bold").fontSize(9).fillColor(accent).text(`RECORD ${index + 1}`, left, y);
        y += 17;
        cols.forEach((col, i) => {
          const field = lines(`${col}: ${text(row[i])}`, width - 15);
          for (const line of field) {
            space(12);
            doc.font("Helvetica").fontSize(8).fillColor(ink).text(line, left + 8, y, { lineBreak: false });
            y += 11;
          }
        });
        y += 11;
      });
    } else {
      const count = Math.max(1, cols.length), colW = width / count, lineH = 10;
      const header = () => {
        space(28);
        doc.rect(left, y, width, 25).fill(ink);
        cols.forEach((col, i) => doc.font("Helvetica-Bold").fontSize(8).fillColor("#FFFFFF")
          .text(col, left + colW * i + 5, y + 5, { width: colW - 9, height: 18, ellipsis: true }));
        y += 25;
      };
      header();
      payload.table.rows.forEach((row, index) => {
        const cells = cols.map((_, i) => lines(row[i], colW - 10));
        let offset = 0;
        const length = Math.max(...cells.map(c => c.length));
        while (offset < length) {
          const fit = Math.min(length - offset, Math.max(1, Math.floor((bottom - y - 8) / lineH)));
          if (y + fit * lineH + 8 > bottom) { page(); header(); continue; }
          const h = fit * lineH + 8;
          doc.rect(left, y, width, h).fill(index % 2 ? "#F1F4F7" : "#FFFFFF");
          cells.forEach((cell, i) => cell.slice(offset, offset + fit).forEach((line, j) =>
            doc.font("Helvetica").fontSize(8).fillColor(ink)
              .text(line, left + colW * i + 5, y + 4 + j * lineH, { lineBreak: false })));
          y += h;
          offset += fit;
        }
      });
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // footer is intentionally below the content margin
      const fy = doc.page.height - 36;
      doc.moveTo(left, fy - 8).lineTo(right, fy - 8).strokeColor("#DCE3EA").lineWidth(0.7).stroke();
      doc.font("Helvetica").fontSize(8).fillColor(muted)
        .text(meta.dealerName, left, fy, { width: width - 80, height: 12, ellipsis: true })
        .text(`${i - range.start + 1} / ${range.count}`, right - 65, fy, { width: 65, align: "right", lineBreak: false });
    }
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
  res.setHeader("Cache-Control", "private, no-store");
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
