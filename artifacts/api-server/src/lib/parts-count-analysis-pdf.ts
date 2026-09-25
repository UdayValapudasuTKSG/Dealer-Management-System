import PDFDocument from "pdfkit";
import type { PdfBranding } from "./dealer-branding";

/** Printable, paginated inventory sheet using the configured dealership letterhead. */
export function buildPartsAnalysisPdf(title: string, rows: Record<string, unknown>[], branding: PdfBranding): Promise<Buffer> {
  if (!branding.displayName) throw new Error("Dealership branding is unavailable");
  const doc = new PDFDocument({ size: "LETTER", margin: 40, autoFirstPage: false });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const columns = rows.length ? Object.keys(rows[0]!) : ["Part Number", "Part Name", "Bin", "Expected", "Counted", "Variance"];
  const page = () => {
    doc.addPage();
    if (branding.logo) {
      try { doc.image(branding.logo, 40, 32, { fit: [170, 42] }); } catch { /* configured name remains visible */ }
    }
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#23364e").text(branding.displayName!, 220, 38, { width: 350, align: "right" });
    doc.moveTo(40, 88).lineTo(572, 88).strokeColor("#d9e2ec").stroke();
    doc.font("Helvetica-Bold").fontSize(16).text(title, 40, 105);
    doc.font("Helvetica").fontSize(8).text(`Printed ${new Date().toLocaleDateString("en-GY")}`, 40, 131);
    return 155;
  };
  let y = page();
  const widths = columns.map(key => key === "Part Name" ? 145 : Math.floor((532 - (columns.includes("Part Name") ? 145 : 0)) / (columns.length - (columns.includes("Part Name") ? 1 : 0))));
  const drawRow = (values: string[], bold: boolean) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
    const height = Math.max(24, ...values.map((value, i) => doc.heightOfString(value, { width: widths[i]! - 10 }) + 10));
    if (y + height > 740 && y > 180) {
      y = page();
      if (!bold) drawRow(columns, true);
    }
    let x = 40;
    if (bold) doc.rect(x, y, 532, height).fill("#326aa4");
    doc.fillColor(bold ? "#ffffff" : "#23364e").font(bold ? "Helvetica-Bold" : "Helvetica");
    values.forEach((value, i) => { doc.text(value, x + 5, y + 5, { width: widths[i]! - 10 }); x += widths[i]!; });
    y += height;
    if (!bold) doc.moveTo(40, y).lineTo(572, y).strokeColor("#e5eaf0").stroke();
  };
  drawRow(columns, true);
  for (const row of rows) drawRow(columns.map(key => String(row[key] ?? "")), false);
  doc.end();
  return result;
}