import PDFDocument from "pdfkit";

export type QuotePdfData = Record<string, string>;

const val = (d: QuotePdfData, key: string, fallback = "—") =>
  d[key] && d[key].trim() ? d[key].trim() : fallback;

const GREEN = "#2e7d32";
const HEADER_BG = "#cfe0cc";
const LABEL_GREY = "#8a8a8a";
const TEXT = "#222222";

/** "August 17, 2026" | ISO → "08/17/2026"; unparseable input passes through. */
const shortDate = (s: string): string => {
  const t = s.trim();
  if (!t) return t;
  // Date-only ISO values must not go through new Date() — it parses them as
  // UTC midnight, which prints a day earlier in negative-offset timezones.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
};

/**
 * Normalize a money string from any payload generation ("GY$12,500,000",
 * "GYD 12,500,000.00", "12,500,000.00") into a bare "12,500,000.00".
 */
const bareAmount = (s: string): string => {
  const t = s.trim().replace(/^GY\$\s*/i, "").replace(/^GYD\s*/i, "");
  if (!t) return t;
  return /\.\d{2}$/.test(t) ? t : `${t}.00`;
};

/**
 * Render a dealer-branded vehicle estimate PDF matching the dealership's
 * reference estimate layout: serif letterhead (name/address/TIN/phone/email)
 * top-left, logo top-right, green "Estimate" title, ADDRESS block +
 * ESTIMATE/DATE/EXPIRATION DATE meta, split green table header
 * (DATE | QTY/AMOUNT), spec-line vehicle description, SUBTOTAL/TAX/TOTAL
 * (bold "GYD" total), acceptance lines and a "Page 1 of 1" footer.
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
    const pageH = doc.page.height;
    const left = 46;
    const right = pageW - 46;
    const contentW = right - left;
    const dealerName = val(data, "dealerName", "AURA Dealership");

    // ---- Letterhead --------------------------------------------------------
    // Single brand mark: the dealer logo IS the letterhead (top-left), with
    // the address/TIN/phone lines beneath it. Only when no logo is on file
    // does the bold company name render instead — never both.
    let hy = 64;
    let logoDrawn = false;
    if (logo) {
      try {
        doc.image(logo, left, 40, { fit: [190, 44] });
        logoDrawn = true;
        hy = 96;
      } catch {
        // Unreadable logo bytes — keep the text-only letterhead.
      }
    }
    if (!logoDrawn) {
      doc.font("Times-Bold").fontSize(12).fillColor(TEXT).text(dealerName, left, 46);
    }
    const headerLine = (text: string) => {
      doc.font("Times-Roman").fontSize(8.5).fillColor("#333333").text(text, left, hy, {
        width: contentW / 2,
      });
      hy += 12;
    };
    const dealerAddress = data.dealerAddress?.trim() ?? "";
    if (dealerAddress) {
      // Split a comma-separated address onto letterhead lines.
      const parts = dealerAddress
        .replace(/\.\s*$/, "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      // Keep it to at most 3 lines: join overflow onto the last line.
      const lines =
        parts.length > 3
          ? [parts[0]!, parts[1]!, parts.slice(2).join(", ")]
          : parts;
      for (const line of lines) headerLine(line);
    }
    if (data.dealerTin?.trim()) headerLine(`TIN: ${data.dealerTin.trim()}`);
    if (data.dealerPhone?.trim()) headerLine(data.dealerPhone.trim());
    if (data.dealerEmail?.trim()) headerLine(data.dealerEmail.trim());

    // ---- Title -------------------------------------------------------------
    let y = Math.max(150, hy + 24);
    doc.font("Times-Roman").fontSize(16).fillColor(GREEN).text("Estimate", left, y);
    y += 28;

    // ---- Customer block (left) + estimate meta (right) ---------------------
    const metaLabelX = right - 250;
    const metaValueX = right - 130;
    doc
      .font("Times-Roman")
      .fontSize(9)
      .fillColor(LABEL_GREY)
      .text("ADDRESS", left, y, { characterSpacing: 0.5 });
    const metaRow = (label: string, value: string, my: number) => {
      doc
        .font("Times-Roman")
        .fontSize(9)
        .fillColor(LABEL_GREY)
        .text(label, metaLabelX, my, { characterSpacing: 0.5 });
      doc
        .font("Times-Roman")
        .fontSize(9.5)
        .fillColor(TEXT)
        .text(value, metaValueX, my, { width: 130 });
    };
    metaRow("ESTIMATE", val(data, "quoteRef", ""), y);
    metaRow("DATE", shortDate(val(data, "issuedOn", "")), y + 16);
    if (data.validUntil?.trim()) {
      metaRow("EXPIRATION DATE", shortDate(data.validUntil), y + 32);
    }
    y += 14;
    const custLines = [
      val(data, "name", "Valued Customer"),
      ...(data.address && data.address.trim()
        ? data.address
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean)
        : []),
    ];
    for (const line of custLines) {
      doc.font("Times-Roman").fontSize(9.5).fillColor(TEXT).text(line, left, y, {
        width: contentW / 2,
      });
      y += 14;
    }
    y = Math.max(y, doc.y, custLines.length ? y : y + 14);
    y = Math.max(y + 18, 6 + y);

    // ---- Line-item table ---------------------------------------------------
    const colDate = left;
    const colDesc = left + 165;
    const colQty = right - 260;
    const colAmt = right - 130;

    // Split header band (left "DATE" band + right "QTY / AMOUNT" band) like
    // the reference estimate.
    const gapX = colQty - 60;
    doc.rect(left, y, gapX - left - 4, 18).fill(HEADER_BG);
    doc.rect(gapX, y, right - gapX, 18).fill(HEADER_BG);
    doc
      .font("Times-Roman")
      .fontSize(9)
      .fillColor("#3c5a3c")
      .text("DATE", colDate + 6, y + 5, { characterSpacing: 0.5 })
      .text("QTY", colQty, y + 5, { width: 60, align: "right", characterSpacing: 0.5 })
      .text("AMOUNT", colAmt, y + 5, {
        width: right - colAmt - 6,
        align: "right",
        characterSpacing: 0.5,
      });
    y += 30;

    // Description block: manufacturer, model, spec lines, year.
    let specLines: string[] = [];
    try {
      const parsed = JSON.parse(data.specLines ?? "[]");
      if (Array.isArray(parsed)) {
        specLines = parsed
          .filter((s): s is string => typeof s === "string" && !!s.trim())
          .slice(0, 6); // keep the estimate to a single page
      }
    } catch {
      // Missing/legacy payloads have no spec lines.
    }
    const manufacturer = data.manufacturer?.trim() ?? "";
    let model = val(data, "vehicle", val(data, "model", ""));
    // De-duplicate "BYD" / "BYD SHARK" → "BYD" / "SHARK".
    if (
      manufacturer &&
      model.toLowerCase().startsWith(`${manufacturer.toLowerCase()} `)
    ) {
      model = model.slice(manufacturer.length + 1).trim();
    }
    const descLines = [
      manufacturer || model,
      ...(manufacturer && model && model !== manufacturer ? [model] : []),
      ...specLines,
      ...(data.modelYear && data.modelYear.trim()
        ? [`Year Make: ${data.modelYear.trim()}`]
        : []),
    ].filter(Boolean);

    doc
      .font("Times-Roman")
      .fontSize(9.5)
      .fillColor(TEXT)
      .text(shortDate(val(data, "issuedOn", "")), colDate + 6, y);
    let dy = y;
    const descW = colQty - colDesc - 12;
    for (const line of descLines) {
      doc.font("Times-Roman").fontSize(9.5).fillColor(TEXT).text(line, colDesc, dy, {
        width: descW,
      });
      dy += doc.heightOfString(line, { width: descW }) + 3;
    }
    doc
      .font("Times-Roman")
      .fontSize(9.5)
      .fillColor(TEXT)
      .text(val(data, "quantity", "1"), colQty, y, { width: 60, align: "right" })
      .text(bareAmount(val(data, "subtotal", val(data, "total"))), colAmt, y, {
        width: right - colAmt - 6,
        align: "right",
      });
    y = Math.max(dy, y + 14) + 14;

    doc
      .moveTo(left, y)
      .lineTo(right, y)
      .dash(1.5, { space: 2 })
      .strokeColor("#cccccc")
      .lineWidth(0.7)
      .stroke()
      .undash();
    y += 20;

    // ---- Totals (right-aligned block) --------------------------------------
    const labelX = right - 260;
    const totalRow = (
      label: string,
      value: string,
      opts: { bold?: boolean; rule?: boolean } = {},
    ) => {
      doc
        .font("Times-Roman")
        .fontSize(9.5)
        .fillColor(LABEL_GREY)
        .text(label, labelX, y + (opts.bold ? 4 : 1), { characterSpacing: 0.5 });
      doc
        .font(opts.bold ? "Times-Bold" : "Times-Roman")
        .fontSize(opts.bold ? 13 : 9.5)
        .fillColor(TEXT)
        .text(value, right - 200, y, { width: 200, align: "right" });
      y += opts.bold ? 24 : 22;
      if (opts.rule) {
        doc
          .moveTo(labelX, y - 8)
          .lineTo(right, y - 8)
          .dash(1.5, { space: 2 })
          .strokeColor("#cccccc")
          .lineWidth(0.7)
          .stroke()
          .undash();
      }
    };
    totalRow("SUBTOTAL", bareAmount(val(data, "subtotal", val(data, "total"))));
    totalRow("TAX", bareAmount(val(data, "totalTax", "0.00")), { rule: true });
    totalRow("TOTAL", `GYD ${bareAmount(val(data, "totalGyd", val(data, "total")))}`, {
      bold: true,
    });
    y += 40;

    // ---- Acceptance --------------------------------------------------------
    doc.font("Times-Roman").fontSize(9.5).fillColor(LABEL_GREY).text("Accepted By", left, y);
    y += 34;
    doc.text("Accepted Date", left, y);
    y += 40;

    // ---- Disclaimer ---------------------------------------------------------
    // Derive the validity wording from the quote's own dates so historical
    // 30-day quotes don't contradict their printed expiration date.
    let validityClause = "is valid until the expiration date shown above";
    {
      const issued = new Date(val(data, "issuedOn", ""));
      const until = new Date(val(data, "validUntil", ""));
      if (!Number.isNaN(issued.getTime()) && !Number.isNaN(until.getTime())) {
        const days = Math.round((until.getTime() - issued.getTime()) / 86400000);
        if (days > 0) validityClause = `is valid for ${days} days`;
      }
    }
    const disclaimer =
      `All vehicles are subject to availability at the time of order confirmation. ` +
      `Allocation is on a first-come, first-served basis and is not guaranteed until a ` +
      `deposit or bank letter of undertaking is received and confirmed by ${dealerName}. ` +
      `Pricing, availability, and colors may change without notice. This quotation ` +
      `${validityClause} and does not constitute a binding agreement.`;
    const discHeight =
      14 +
      doc.font("Times-Roman").fontSize(8).heightOfString(disclaimer, { width: contentW });
    // Render just under the acceptance block, never above it (moving up would
    // overlap already-drawn content). If the page is unusually full, it sits
    // closer to the footer rather than colliding with the content above.
    const discY = y;
    doc
      .font("Times-Bold")
      .fontSize(8.5)
      .fillColor(LABEL_GREY)
      .text("DISCLAIMER", left, discY, { characterSpacing: 0.5 });
    doc
      .font("Times-Roman")
      .fontSize(8)
      .fillColor(LABEL_GREY)
      .text(disclaimer, left, discY + 14, { width: contentW, align: "justify" });

    // ---- Footer ------------------------------------------------------------
    doc
      .font("Times-Roman")
      .fontSize(9)
      .fillColor(LABEL_GREY)
      .text("Page 1 of 1", left, pageH - 46, { width: contentW, align: "center" });

    doc.end();
  });
}
