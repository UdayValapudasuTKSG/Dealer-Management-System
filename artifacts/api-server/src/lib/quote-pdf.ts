import PDFDocument from "pdfkit";

export type QuotePdfData = Record<string, string>;

const val = (d: QuotePdfData, key: string, fallback = "—") =>
  d[key] && d[key].trim() ? d[key].trim() : fallback;

const GREEN = "#2e7d32";
const HEADER_BG = "#cfe0cc";
const LABEL_GREY = "#8a8a8a";
const TEXT = "#222222";

/**
 * Render a dealer-branded vehicle estimate PDF (classic "Estimate" layout:
 * dealer letterhead, green title, customer block, line-item table with
 * subtotal/tax/total, acceptance lines and disclaimer) and return a Buffer.
 * All inputs arrive as strings (email queue payloads are Record<string,string>).
 */
export function buildQuotePdf(
  data: QuotePdfData,
  logo?: Buffer | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const left = 46;
    const right = pageW - 46;
    const contentW = right - left;
    const dealerName = val(data, "dealerName", "AURA Dealership");

    // ---- Letterhead --------------------------------------------------------
    let nameY = 44;
    if (logo) {
      try {
        doc.image(logo, left, 36, { fit: [110, 42] });
        nameY = 84;
      } catch {
        // Unreadable logo bytes — keep the text-only letterhead.
      }
    }
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor(TEXT)
      .text(dealerName, left, nameY);
    let hy = nameY + 18;
    for (const key of ["dealerAddress", "dealerPhone", "dealerEmail"]) {
      if (data[key] && data[key].trim()) {
        doc
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor("#555555")
          .text(data[key].trim(), left, hy);
        hy += 12;
      }
    }
    // Wordmark, top-right.
    doc
      .font("Helvetica-BoldOblique")
      .fontSize(14)
      .fillColor(TEXT)
      .text(dealerName.toUpperCase(), left, 46, {
        width: contentW,
        align: "right",
      });

    // ---- Title -------------------------------------------------------------
    let y = Math.max(130, hy + 14);
    doc
      .font("Helvetica")
      .fontSize(18)
      .fillColor(GREEN)
      .text("Estimate", left, y);
    y += 34;

    // ---- Customer block (left) + estimate meta (right) ---------------------
    const metaX = right - 220;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(LABEL_GREY)
      .text("NAME", left, y, { characterSpacing: 0.5 });
    doc
      .text("ESTIMATE", metaX, y, { width: 100, align: "right" })
      .text(val(data, "quoteRef", ""), metaX + 110, y, {
        width: 110,
        align: "right",
      });
    y += 13;
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(TEXT)
      .text(val(data, "name", "Valued Customer"), left, y);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(LABEL_GREY)
      .text("DATE", metaX, y + 1, { width: 100, align: "right" });
    doc
      .fontSize(9.5)
      .fillColor(TEXT)
      .text(val(data, "issuedOn", ""), metaX + 110, y, {
        width: 110,
        align: "right",
      });
    y += 20;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(LABEL_GREY)
      .text("ADDRESS", left, y, { characterSpacing: 0.5 });
    y += 13;
    const address = data.address && data.address.trim() ? data.address.trim() : "—";
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(TEXT)
      .text(address, left, y, { width: contentW / 2, lineGap: 2 });
    y += doc.heightOfString(address, { width: contentW / 2, lineGap: 2 }) + 26;

    // ---- Line-item table ---------------------------------------------------
    const colDate = left;
    const colDesc = left + 140;
    const colQty = right - 200;
    const colAmt = right - 110;

    doc.rect(left, y, contentW, 22).fill(HEADER_BG);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#4a5a4a")
      .text("DATE", colDate + 10, y + 7, { characterSpacing: 0.5 })
      .text("DESCRIPTION", colDesc, y + 7, { characterSpacing: 0.5 })
      .text("QTY", colQty, y + 7, { width: 60, align: "right", characterSpacing: 0.5 })
      .text("AMOUNT", colAmt, y + 7, { width: 110 - 10, align: "right", characterSpacing: 0.5 });
    y += 34;

    // Description block: headline + secondary lines.
    const descLines = [
      val(data, "vehicle"),
      data.model && data.model.trim() ? data.model.trim() : "",
      data.modelYear && data.modelYear.trim()
        ? `Manufactured Year: ${data.modelYear.trim()}`
        : "",
    ].filter(Boolean);

    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(TEXT)
      .text(val(data, "issuedOn", ""), colDate + 10, y);
    let dy = y;
    const descW = colQty - colDesc - 12;
    for (let i = 0; i < descLines.length; i++) {
      doc
        .font("Helvetica")
        .fontSize(i === 0 ? 9.5 : 8.5)
        .fillColor(i === 0 ? TEXT : "#555555")
        .text(descLines[i]!, colDesc, dy, { width: descW });
      dy += doc.heightOfString(descLines[i]!, { width: descW }) + 2;
    }
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(TEXT)
      .text(val(data, "quantity", "1"), colQty, y, { width: 60, align: "right" })
      .text(val(data, "subtotal", val(data, "total")), colAmt, y, {
        width: 110 - 10,
        align: "right",
      });
    y = Math.max(dy, y + 14) + 16;

    doc
      .moveTo(left, y)
      .lineTo(right, y)
      .strokeColor("#e0e0e0")
      .lineWidth(0.8)
      .stroke();
    y += 18;

    // ---- Totals (right-aligned block) --------------------------------------
    const labelX = right - 260;
    const totalRow = (
      label: string,
      value: string,
      opts: { bold?: boolean; rule?: boolean } = {},
    ) => {
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor(LABEL_GREY)
        .text(label, labelX, y + 1, { width: 130, align: "right", characterSpacing: 0.5 });
      doc
        .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(opts.bold ? 10 : 9.5)
        .fillColor(TEXT)
        .text(value, right - 120, y, { width: 120, align: "right" });
      y += 18;
      if (opts.rule) {
        doc
          .moveTo(labelX, y - 4)
          .lineTo(right, y - 4)
          .dash(1.5, { space: 2 })
          .strokeColor("#cccccc")
          .lineWidth(0.7)
          .stroke()
          .undash();
        y += 4;
      }
    };
    totalRow("SUBTOTAL", val(data, "subtotal", val(data, "total")), {
      rule: true,
    });
    totalRow("TOTAL", val(data, "total"), { bold: true });
    y += 30;

    // ---- Acceptance --------------------------------------------------------
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(LABEL_GREY)
      .text("Accepted By", left, y);
    y += 36;
    doc.text("Accepted Date", left, y);
    y += 46;

    // ---- Disclaimer --------------------------------------------------------
    doc
      .moveTo(left, y)
      .lineTo(right, y)
      .strokeColor("#dddddd")
      .lineWidth(0.8)
      .stroke();
    y += 14;
    doc
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .fillColor("#444444")
      .text("DISCLAIMER", left, y, { characterSpacing: 0.5 });
    y += 12;
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor("#666666")
      .text(
        "All vehicles are subject to availability at the time of order confirmation. Allocation is on a first-come, " +
          `first-served basis and is not guaranteed until a deposit or bank letter of undertaking is received and confirmed by ${dealerName}. ` +
          "Pricing, availability, and colors may change without notice. This quotation is valid for 60 days and does not constitute a binding agreement.",
        left,
        y,
        { width: contentW, lineGap: 2.5 },
      );

    doc.end();
  });
}
