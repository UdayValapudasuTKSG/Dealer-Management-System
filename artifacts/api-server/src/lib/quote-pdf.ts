import PDFDocument from "pdfkit";

export type QuotePdfData = Record<string, string>;

const val = (d: QuotePdfData, key: string, fallback = "—") =>
  d[key] && d[key].trim() ? d[key].trim() : fallback;

/**
 * Render an AURA-branded vehicle quotation PDF and return it as a Buffer.
 * All inputs arrive as strings (email queue payloads are Record<string,string>).
 */
export function buildQuotePdf(data: QuotePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width; // 595.28
    const left = 54;
    const right = pageW - 54;
    const contentW = right - left;

    // ---- Header band -------------------------------------------------------
    doc.rect(0, 0, pageW, 118).fill("#0a0a0a");
    doc.rect(0, 118, pageW, 4).fill("#b30f16");
    doc
      .fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(26)
      .text("AURA", left, 34, { continued: true })
      .fillColor("#e01313")
      .text(".OS");
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor("#9a9a9a")
      .text("DEALERSHIP OPERATING SYSTEM", left, 66, { characterSpacing: 2 });
    doc
      .font("Helvetica-Bold")
      .fontSize(15)
      .fillColor("#ffffff")
      .text("VEHICLE QUOTATION", left, 34, {
        width: contentW,
        align: "right",
      });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#c9c9c9")
      .text(`Quote ${val(data, "quoteRef", "")}`, left, 58, {
        width: contentW,
        align: "right",
      })
      .text(`Issued ${val(data, "issuedOn", "")}`, left, 72, {
        width: contentW,
        align: "right",
      })
      .text(`Valid until ${val(data, "validUntil", "")}`, left, 86, {
        width: contentW,
        align: "right",
      });

    // ---- Prepared for ------------------------------------------------------
    let y = 152;
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#b30f16")
      .text("PREPARED FOR", left, y, { characterSpacing: 1.5 });
    y += 15;
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#111111")
      .text(val(data, "name", "Valued Customer"), left, y);
    y += 30;

    // ---- Vehicle details ---------------------------------------------------
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#b30f16")
      .text("VEHICLE DETAILS", left, y, { characterSpacing: 1.5 });
    y += 16;

    const rows: [string, string][] = [
      ["Vehicle", val(data, "vehicle")],
      ["Model", val(data, "model")],
      ["Version", val(data, "version")],
      ["Color", val(data, "color")],
    ];
    const rowH = 24;
    for (let i = 0; i < rows.length; i++) {
      const [label, value] = rows[i]!;
      const ry = y + i * rowH;
      if (i % 2 === 0) {
        doc.rect(left, ry, contentW, rowH).fill("#f5f5f5");
      }
      doc
        .font("Helvetica-Bold")
        .fontSize(9.5)
        .fillColor("#555555")
        .text(label, left + 12, ry + 7, { width: 130 });
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#111111")
        .text(value, left + 150, ry + 6.5, { width: contentW - 162 });
    }
    y += rows.length * rowH + 30;

    // ---- Pricing table -----------------------------------------------------
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#b30f16")
      .text("PRICING", left, y, { characterSpacing: 1.5 });
    y += 16;

    const colQty = right - 260;
    const colUnit = right - 180;
    const colAmt = right - 90;

    doc.rect(left, y, contentW, 26).fill("#0a0a0a");
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#ffffff")
      .text("DESCRIPTION", left + 12, y + 8.5)
      .text("QTY", colQty, y + 8.5, { width: 60, align: "right" })
      .text("UNIT PRICE", colUnit, y + 8.5, { width: 80, align: "right" })
      .text("AMOUNT", colAmt, y + 8.5, { width: 90 - 12, align: "right" });
    y += 26;

    doc.rect(left, y, contentW, 30).fill("#fafafa");
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#111111")
      .text(val(data, "vehicle"), left + 12, y + 9, {
        width: colQty - left - 24,
      })
      .text(val(data, "quantity", "1"), colQty, y + 9, {
        width: 60,
        align: "right",
      })
      .text(val(data, "unitPrice"), colUnit, y + 9, {
        width: 80,
        align: "right",
      })
      .text(val(data, "total"), colAmt, y + 9, {
        width: 90 - 12,
        align: "right",
      });
    y += 30;

    doc
      .moveTo(left, y)
      .lineTo(right, y)
      .strokeColor("#dddddd")
      .lineWidth(1)
      .stroke();
    y += 14;
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor("#111111")
      .text("Total", left + 12, y, { continued: false });
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .fillColor("#b30f16")
      .text(val(data, "total"), colUnit, y - 2, {
        width: right - colUnit - 12,
        align: "right",
      });
    y += 40;

    // ---- Notes -------------------------------------------------------------
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#777777")
      .text(
        "This quotation reflects the current showroom list price and is valid until the date shown above. " +
          "Final on-the-road pricing may vary with optional extras, registration, insurance and any applicable duties. " +
          "Your AURA concierge will be delighted to arrange a viewing, test drive or tailored finance plan.",
        left,
        y,
        { width: contentW, lineGap: 2 },
      );

    // ---- Footer ------------------------------------------------------------
    const footY = doc.page.height - 70;
    doc.rect(0, footY, pageW, 70).fill("#0a0a0a");
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#ffffff")
      .text("AURA Dealership", left, footY + 20, { continued: true })
      .font("Helvetica")
      .fillColor("#9a9a9a")
      .text("  —  Premium Automotive Concierge");
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#6f6f6f")
      .text(
        "Generated by the AURA lead engine. Reply to this email and your concierge will take it from there.",
        left,
        footY + 38,
        { width: contentW },
      );

    doc.end();
  });
}
