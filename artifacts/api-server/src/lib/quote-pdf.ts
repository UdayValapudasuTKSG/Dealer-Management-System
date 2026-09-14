import PDFDocument from "pdfkit";
import { zonedParts } from "./timezone";

export type QuotePdfData = Record<string, string>;

const val = (d: QuotePdfData, key: string, fallback = "—") =>
  d[key] && d[key].trim() ? d[key].trim() : fallback;

const textValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A few historical snapshots contain the manufacturer in both fields (for
 * example manufacturer "BYD", model "BYD Sealion 7"). Keep the model exactly
 * as saved, but do not print a second copy of its leading brand token.
 */
const modelWithManufacturer = (manufacturer: string, model: string): string => {
  const mfg = manufacturer.trim();
  const mdl = model.trim();
  if (!mfg) return mdl;
  if (!mdl) return mfg;
  const leadingBrand = new RegExp(
    `^${escapeRegExp(mfg)}(?=$|[\\s\\-/:,|])`,
    "iu",
  );
  return leadingBrand.test(mdl) ? mdl : `${mfg} ${mdl}`;
};

const GREEN = "#2e7d32";
const HEADER_BG = "#cfe0cc";
const LABEL_GREY = "#8a8a8a";
const TEXT = "#222222";

/** "August 17, 2026" | ISO → "08/17/2026"; unparseable input passes through. */
const shortDate = (s: string, tz: string): string => {
  const t = s.trim();
  if (!t) return t;
  // Date-only ISO values must not go through new Date() — it parses them as
  // UTC midnight, which prints a day earlier in negative-offset timezones.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  // Human-readable quote dates are calendar dates, not instants. Node parses
  // them at midnight, so applying a negative-offset zone would shift them.
  if (!/[T]|(?:Z|[+-]\d{2}:?\d{2}|GMT)$/i.test(t)) {
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getUTCFullYear()}`;
  }
  const p = zonedParts(d, tz);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${mm}/${dd}/${p.year}`;
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

type PrintableQuoteItem = {
  model: string;
  manufacturer: string;
  year: string;
  variant: string;
  color: string;
  quantity: string;
  total: string;
};

type QuoteDescription = PrintableQuoteItem & {
  lines: string[];
};

type RowSegment = {
  item: QuoteDescription;
  lineStart: number;
  lineCount: number;
};

/**
 * Wrap text using the active PDFKit font metrics.  PDFKit's `ellipsis` option
 * is deliberately not used here: a model/trim can be a long, unbroken token
 * and every character in a saved quote must make it into the document.
 */
const measuredWrap = (
  doc: PDFKit.PDFDocument,
  value: string,
  width: number,
): string[] => {
  const paragraphs = value.replace(/\r/g, "").split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (doc.widthOfString(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      // A VIN-like or otherwise unbroken value still needs a measured split.
      // Splitting by code point prevents an over-wide token from being
      // silently clipped by PDFKit.
      let chunk = "";
      for (const character of Array.from(word)) {
        const next = `${chunk}${character}`;
        if (chunk && doc.widthOfString(next) > width) {
          lines.push(chunk);
          chunk = character;
        } else {
          chunk = next;
        }
      }
      line = chunk;
    }
    if (line) lines.push(line);
  }
  return lines;
};

const quoteItemFromUnknown = (value: unknown): PrintableQuoteItem | null => {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const model = textValue(item.model ?? item.vehicle ?? item.vehicleLine);
  const manufacturer = textValue(item.manufacturer);
  const year = textValue(item.year ?? item.modelYear);
  const variant = textValue(item.variant ?? item.trim ?? item.version);
  const color = textValue(item.color ?? item.colour);
  const quantity = textValue(item.quantity) || "1";
  const total = textValue(item.total ?? item.subtotal ?? item.unitPrice);
  return { model, manufacturer, year, variant, color, quantity, total };
};

/**
 * Render a quote estimate with measured rows and explicit page plans.
 *
 * Keeping all pagination here is important: letting a PDFKit text call create
 * an implicit page loses the repeated header and makes the `Page X of Y`
 * footer unknowable.
 */
export function buildQuotePdf(
  data: QuotePdfData,
  tz: string,
  logo?: Buffer | null,
  attachment?: { data: Buffer; fileName: string } | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const left = 46;
    const right = pageW - 46;
    const contentW = right - left;
    const dealerName = val(data, "dealerName", "AURA Dealership");
    const advisorName = textValue(data.salesAdvisorName);
    const priceNotice = "* Price can be subject to Change due to Duties and Taxes";

    // Footer measurements are done before laying out rows.  Long advisor names
    // therefore reduce the row budget rather than colliding with the notice or
    // page number.
    doc.font("Helvetica").fontSize(9);
    const pageNumberY = pageH - 46;
    const noticeHeight = Math.max(
      10,
      doc.heightOfString(priceNotice, { width: contentW }),
    );
    const advisorText = advisorName ? `Sales Advisor: ${advisorName}` : "";
    const advisorHeight = advisorText
      ? Math.max(10, doc.heightOfString(advisorText, { width: contentW }))
      : 0;
    const noticeY = pageNumberY - noticeHeight - 8;
    const advisorY = advisorText
      ? noticeY - advisorHeight - 4
      : noticeY;
    const footerStart = advisorText ? advisorY : noticeY;

    const drawFooter = (pageNumber: number, totalPages: number) => {
      doc.font("Helvetica").fontSize(9).fillColor(LABEL_GREY);
      if (advisorText) {
        doc.text(advisorText, left, advisorY, {
          width: contentW,
          align: "center",
        });
      }
      doc.text(priceNotice, left, noticeY, {
        width: contentW,
        align: "center",
      });
      doc.text(`Page ${pageNumber} of ${totalPages}`, left, pageNumberY, {
        width: contentW,
        align: "center",
      });
    };

    const dealerAddress = textValue(data.dealerAddress);
    const dealerAddressParts = dealerAddress
      ? dealerAddress
        .replace(/\.\s*$/, "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
      : [];
    const letterheadLines = dealerAddressParts.length > 3
      ? [dealerAddressParts[0]!, dealerAddressParts[1]!, dealerAddressParts.slice(2).join(", ")]
      : dealerAddressParts;
    if (textValue(data.dealerTin)) {
      letterheadLines.push(`TIN: ${textValue(data.dealerTin)}`);
    }
    if (textValue(data.dealerPhone)) letterheadLines.push(textValue(data.dealerPhone));
    if (textValue(data.dealerEmail)) letterheadLines.push(textValue(data.dealerEmail));

    // Preflight every variable block that appears before the item table.
    // PDFKit will otherwise create implicit pages when a wrapped customer or
    // dealer field runs past the bottom margin, invalidating the page plan.
    const colDate = left;
    const colDesc = left + 82;
    const colQty = right - 165;
    const colAmt = right - 120;
    const descW = colQty - colDesc - 12;
    const gapX = colQty - 14;
    const metaLabelX = right - 250;
    const metaValueX = right - 130;
    // Keep the customer column visibly clear of the metadata labels.
    const customerW = Math.min(contentW / 2, metaLabelX - left - 8);
    const customerLines = [
      val(data, "name", "Valued Customer"),
      ...(textValue(data.address)
        ? data.address.split(",").map((part) => part.trim()).filter(Boolean)
        : []),
    ];
    const metaRows = [
      { label: "ESTIMATE", value: val(data, "quoteRef", "") },
      { label: "DATE", value: shortDate(val(data, "issuedOn", ""), tz) },
      ...(textValue(data.validUntil)
        ? [{ label: "EXPIRATION DATE", value: shortDate(data.validUntil, tz) }]
        : []),
    ];
    const brandHeight = (() => {
      doc.font("Helvetica-Bold").fontSize(12);
      return Math.max(12, doc.heightOfString(dealerName, { width: contentW / 2 }));
    })();
    const fallbackHeaderStart = Math.max(64, 46 + brandHeight + 6);
    // An unreadable logo falls back to the wrapped dealer name at y=46. Keep
    // the logo layout at least as low as that fallback, otherwise a tall
    // dealer name can collide with the first address line after the catch.
    const plannedHeaderStart = logo
      ? Math.max(96, fallbackHeaderStart)
      : fallbackHeaderStart;
    const headerLayouts: Array<{ text: string; y: number; height: number }> = [];
    let plannedHeaderY = plannedHeaderStart;
    doc.font("Helvetica").fontSize(8.5);
    for (const text of letterheadLines) {
      const height = Math.max(
        10,
        doc.heightOfString(text, { width: contentW / 2 }),
      );
      headerLayouts.push({ text, y: plannedHeaderY, height });
      plannedHeaderY += height + 2;
    }
    const titleY = Math.max(150, plannedHeaderY + 24);
    const blockY = titleY + 28;

    const metaLayouts: Array<{
      label: string;
      value: string;
      y: number;
      height: number;
    }> = [];
    let plannedMetaY = blockY;
    for (const row of metaRows) {
      doc.font("Helvetica").fontSize(9);
      const labelHeight = Math.max(
        10,
        doc.heightOfString(row.label, { width: metaValueX - metaLabelX }),
      );
      doc.font("Helvetica").fontSize(9.5);
      const valueHeight = Math.max(
        10,
        doc.heightOfString(row.value, { width: right - metaValueX }),
      );
      const height = Math.max(labelHeight, valueHeight);
      metaLayouts.push({ ...row, y: plannedMetaY, height });
      plannedMetaY += height + 4;
    }
    doc.font("Helvetica").fontSize(9.5);
    const customerLayouts: Array<{ text: string; y: number; height: number }> = [];
    // Keep the left customer block below the complete right metadata stack.
    // This costs a little vertical compactness but prevents a wrapped quote
    // reference or expiration value from sharing a baseline with customer
    // text and makes the pre-table boundary unambiguous.
    let plannedCustomerY = Math.max(blockY + 14, plannedMetaY);
    for (const text of customerLines) {
      const height = Math.max(
        12,
        doc.heightOfString(text, { width: customerW }),
      );
      customerLayouts.push({
        text,
        y: plannedCustomerY,
        height,
      });
      plannedCustomerY += height + 2;
    }
    const tableY = Math.max(plannedCustomerY, plannedMetaY) + 18;
    const preflightLineHeight = Math.max(
      9,
      doc.heightOfString("Ag", { width: descW }),
    );
    // A row, dashed separator, totals, acceptance and the shortest disclaimer
    // must fit after the pre-table blocks.  This check runs before any drawing
    // and turns unreasonable unbounded input into an explicit error instead
    // of allowing PDFKit to append sparse, unplanned pages.
    const minimumPreflightReserve = 190;
    if (
      tableY + 30 + preflightLineHeight + 6 + minimumPreflightReserve >
      footerStart - 18
    ) {
      throw new Error(
        "Quote PDF pre-table fields leave insufficient room for the estimate body",
      );
    }

    // ---- Letterhead --------------------------------------------------------
    let logoDrawn = false;
    if (logo) {
      try {
        doc.image(logo, left, 40, { fit: [190, 44] });
        logoDrawn = true;
      } catch {
        // Keep a text letterhead for unreadable historical logo bytes.
      }
    }
    if (!logoDrawn) {
      doc.font("Helvetica-Bold").fontSize(12).fillColor(TEXT)
        .text(dealerName, left, 46, { width: contentW / 2 });
    }
    for (const line of headerLayouts) {
      doc.font("Helvetica").fontSize(8.5).fillColor("#333333")
        .text(line.text, left, line.y, { width: contentW / 2 });
    }

    // ---- Title and customer/meta blocks -----------------------------------
    doc.font("Helvetica").fontSize(16).fillColor(GREEN)
      .text("Estimate", left, titleY);
    doc.font("Helvetica").fontSize(9).fillColor(LABEL_GREY)
      .text("ADDRESS", left, blockY, { characterSpacing: 0.5 });
    for (const row of metaLayouts) {
      doc.font("Helvetica").fontSize(9).fillColor(LABEL_GREY)
        .text(row.label, metaLabelX, row.y, {
          characterSpacing: 0.5,
          width: metaValueX - metaLabelX,
        });
      doc.font("Helvetica").fontSize(9.5).fillColor(TEXT)
        .text(row.value, metaValueX, row.y, { width: right - metaValueX });
    }
    for (const line of customerLayouts) {
      doc.font("Helvetica").fontSize(9.5).fillColor(TEXT);
      doc.text(line.text, left, line.y, { width: customerW });
    }

    // ---- Line-item table ---------------------------------------------------
    const drawTableHeader = (headerY: number): number => {
      doc.rect(left, headerY, gapX - left - 4, 18).fill(HEADER_BG);
      doc.rect(gapX, headerY, right - gapX, 18).fill(HEADER_BG);
      doc.font("Helvetica").fontSize(9).fillColor("#3c5a3c")
        .text("DATE", colDate + 6, headerY + 5, { characterSpacing: 0.5 })
        .text("QTY", colQty, headerY + 5, {
          width: 35,
          align: "right",
          characterSpacing: 0.5,
        })
        .text("AMOUNT", colAmt, headerY + 5, {
          width: right - colAmt - 6,
          align: "right",
          characterSpacing: 0.5,
        });
      return headerY + 30;
    };
    let y = drawTableHeader(tableY);
    const firstRowsTop = y;
    // Continuation pages draw this same header after addPage.  Only reserve
    // its measured vertical position here; drawing it now would duplicate the
    // header on the ordinary first page.
    const continuationRowsTop = 48 + 30;

    // Parse the canonical item snapshot without imposing a renderer-side
    // twelve-item limit.  Legacy payloads continue to render one item.
    let parsedItems: PrintableQuoteItem[] = [];
    try {
      const parsed: unknown = JSON.parse(data.quoteItems ?? "[]");
      if (Array.isArray(parsed)) {
        parsedItems = parsed
          .map(quoteItemFromUnknown)
          .filter((item): item is PrintableQuoteItem => item !== null);
      }
    } catch {
      // Fall back to the historical single-line payload below.
    }
    if (!parsedItems.length) {
      parsedItems = [{
        model: textValue(data.vehicle || data.model),
        manufacturer: textValue(data.manufacturer),
        year: textValue(data.modelYear),
        variant: textValue(data.version),
        color: textValue(data.color),
        quantity: textValue(data.quantity) || "1",
        total: textValue(data.total || data.subtotal || data.unitPrice),
      }];
    }

    // `heightOfString` with the active font gives a measured line height, and
    // every description line is then drawn separately so no implicit PDFKit
    // page break can clip a row.
    doc.font("Helvetica").fontSize(8.5);
    const descriptionLineHeight = Math.max(
      9,
      doc.heightOfString("Ag", { width: descW }),
    );
    const descriptions: QuoteDescription[] = parsedItems.map((item) => {
      const modelLine = modelWithManufacturer(item.manufacturer, item.model);
      const logicalLines = [
        modelLine,
        item.variant ? `Variant: ${item.variant}` : "",
        item.color ? `Color: ${item.color}` : "",
        item.year ? `Year: ${item.year}` : "",
      ].filter(Boolean);
      const lines = logicalLines.flatMap((line) =>
        measuredWrap(doc, line, descW),
      );
      return {
        ...item,
        lines: lines.length ? lines : ["—"],
      };
    });

    let treatmentLabels: string[] = [];
    try {
      const parsedTreatments: unknown = JSON.parse(data.approvedTreatments ?? "[]");
      if (Array.isArray(parsedTreatments)) {
        treatmentLabels = parsedTreatments
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 4);
      }
    } catch {
      // No approved treatments in legacy payloads.
    }

    // ---- Disclaimer measurement and page budget ---------------------------
    let validityClause = "is valid until the expiration date shown above";
    const issued = new Date(val(data, "issuedOn", ""));
    const until = new Date(val(data, "validUntil", ""));
    if (!Number.isNaN(issued.getTime()) && !Number.isNaN(until.getTime())) {
      const days = Math.round((until.getTime() - issued.getTime()) / 86400000);
      if (days > 0) validityClause = `is valid for ${days} days`;
    }
    const disclaimer =
      `All vehicles are subject to availability at the time of order confirmation. ` +
      `Allocation is on a first-come, first-served basis and is not guaranteed until a ` +
      `deposit or bank letter of undertaking is received and confirmed by ${dealerName}. ` +
      `Pricing, availability, and colors may change without notice. This quotation ` +
      `${validityClause} and does not constitute a binding agreement.`;
    doc.font("Helvetica").fontSize(8);
    const disclaimerHeight = Math.max(
      10,
      doc.heightOfString(disclaimer, { width: contentW, align: "justify" }),
    );
    // This is the exact closing block budget used by the page planner.  Keep a
    // small safety allowance for PDFKit's text baseline rounding.
    const finalReserve =
      20 + 22 + 22 + treatmentLabels.length * 22 + 24 +
      20 + 32 + 14 + disclaimerHeight + 8;
    const rowsBottom = footerStart - 18 - finalReserve;
    const freshPageCapacity = rowsBottom - continuationRowsTop;
    const minimumSegmentHeight = descriptionLineHeight + 6;
    if (freshPageCapacity < minimumSegmentHeight) {
      throw new Error(
        "Quote PDF layout cannot fit a vehicle row after reserving the footer and closing block",
      );
    }

    // ---- Explicit row pagination ------------------------------------------
    const pagePlans: RowSegment[][] = [[]];
    let pageIndex = 0;
    let rowY = firstRowsTop;
    let itemIndex = 0;
    let lineIndex = 0;
    while (itemIndex < descriptions.length) {
      const item = descriptions[itemIndex]!;
      const available = rowsBottom - rowY;
      if (available < descriptionLineHeight + 6) {
        pagePlans.push([]);
        pageIndex += 1;
        rowY = continuationRowsTop;
        continue;
      }
      const wholeRowHeight = item.lines.length * descriptionLineHeight + 6;
      // Keep ordinary rows intact when a fresh continuation page can hold
      // them.  A row is split only when its own description exceeds the full
      // continuation-page budget (for example an exceptionally long trim).
      if (
        lineIndex === 0 &&
        wholeRowHeight > available &&
        wholeRowHeight <= freshPageCapacity
      ) {
        pagePlans.push([]);
        pageIndex += 1;
        rowY = continuationRowsTop;
        continue;
      }
      const maxLines = Math.max(
        1,
        Math.floor((available - 6) / descriptionLineHeight),
      );
      const lineCount = Math.min(maxLines, item.lines.length - lineIndex);
      pagePlans[pageIndex]!.push({ item, lineStart: lineIndex, lineCount });
      rowY += lineCount * descriptionLineHeight + 6;
      lineIndex += lineCount;
      if (lineIndex >= item.lines.length) {
        itemIndex += 1;
        lineIndex = 0;
      } else {
        pagePlans.push([]);
        pageIndex += 1;
        rowY = continuationRowsTop;
      }
    }
    if (!pagePlans.length) pagePlans.push([]);

    const totalPages = pagePlans.length + (attachment ? 1 : 0);
    const quoteDate = shortDate(val(data, "issuedOn", ""), tz);

    const drawRowSegment = (
      segment: RowSegment,
      segmentY: number,
    ): number => {
      const { item, lineStart, lineCount } = segment;
      doc.font("Helvetica").fontSize(8.5).fillColor(TEXT);
      if (lineStart === 0) {
        doc.text(quoteDate, colDate + 6, segmentY);
        doc.text(item.quantity, colQty, segmentY, {
          width: 35,
          align: "right",
        });
        doc.text(bareAmount(item.total), colAmt, segmentY, {
          width: right - colAmt - 6,
          align: "right",
        });
      }
      const lines = item.lines.slice(lineStart, lineStart + lineCount);
      lines.forEach((line, index) => {
        doc.text(line, colDesc, segmentY + index * descriptionLineHeight, {
          width: descW,
          lineBreak: false,
        });
      });
      return segmentY + lineCount * descriptionLineHeight + 6;
    };

    const drawClosing = (closingY: number) => {
      let closeY = closingY;
      doc.moveTo(left, closeY).lineTo(right, closeY)
        .dash(1.5, { space: 2 })
        .strokeColor("#cccccc").lineWidth(0.7).stroke().undash();
      closeY += 20;

      const labelX = right - 260;
      const totalRow = (
        label: string,
        value: string,
        opts: { bold?: boolean; rule?: boolean } = {},
      ) => {
        doc.font("Helvetica").fontSize(9.5).fillColor(LABEL_GREY)
          .text(label, labelX, closeY + (opts.bold ? 4 : 1), {
            characterSpacing: 0.5,
            width: 190,
          });
        doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(opts.bold ? 13 : 9.5).fillColor(TEXT)
          .text(value, right - 200, closeY, {
            width: 200,
            align: "right",
          });
        closeY += opts.bold ? 24 : 22;
        if (opts.rule) {
          doc.moveTo(labelX, closeY - 8).lineTo(right, closeY - 8)
            .dash(1.5, { space: 2 })
            .strokeColor("#cccccc").lineWidth(0.7).stroke().undash();
        }
      };
      totalRow("SUBTOTAL", bareAmount(val(data, "subtotal", val(data, "total"))));
      totalRow("TAX", bareAmount(val(data, "totalTax", "0.00")), { rule: true });
      for (const treatment of treatmentLabels) totalRow(treatment, "");
      totalRow("TOTAL", `GYD ${bareAmount(val(data, "totalGyd", val(data, "total")))}`, {
        bold: true,
      });
      closeY += 20;

      doc.font("Helvetica").fontSize(9.5).fillColor(LABEL_GREY)
        .text("Accepted By", left, closeY)
        .moveTo(left + 78, closeY + 10).lineTo(left + 245, closeY + 10)
        .strokeColor("#b8b8b8").lineWidth(0.6).stroke()
        .text("Accepted Date", left + 280, closeY)
        .moveTo(left + 370, closeY + 10).lineTo(right, closeY + 10)
        .stroke();
      closeY += 32;

      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(LABEL_GREY)
        .text("DISCLAIMER", left, closeY, { characterSpacing: 0.5 });
      doc.font("Helvetica").fontSize(8).fillColor(LABEL_GREY)
        .text(disclaimer, left, closeY + 14, {
          width: contentW,
          align: "justify",
        });
    };

    // Draw the first page's planned rows, then the remaining pages.  Closing
    // totals are intentionally only on the final estimate page.
    let firstPageY = firstRowsTop;
    for (const segment of pagePlans[0] ?? []) {
      firstPageY = drawRowSegment(segment, firstPageY);
    }
    if (pagePlans.length === 1) drawClosing(firstPageY);
    drawFooter(1, totalPages);

    for (let index = 1; index < pagePlans.length; index += 1) {
      doc.addPage({ size: "A4", margin: 0 });
      doc.font("Helvetica").fontSize(10).fillColor(LABEL_GREY)
        .text("Estimate (continued)", left, 30, { width: contentW });
      const continuationY = drawTableHeader(48);
      let nextY = continuationY;
      for (const segment of pagePlans[index] ?? []) {
        nextY = drawRowSegment(segment, nextY);
      }
      if (index === pagePlans.length - 1) drawClosing(nextY);
      drawFooter(index + 1, totalPages);
    }

    if (attachment) {
      doc.addPage({ size: "A4", margin: 0 });
      doc.font("Helvetica-Bold").fontSize(13).fillColor(TEXT)
        .text("Quote attachment", left, 42, { width: contentW });
      doc.font("Helvetica").fontSize(8.5).fillColor(LABEL_GREY);
      const fileName = textValue(attachment.fileName) || "Attachment";
      const fileNameHeight = Math.max(
        10,
        doc.heightOfString(fileName, { width: contentW }),
      );
      doc.text(fileName, left, 62, { width: contentW });
      const imageTop = Math.max(88, 62 + fileNameHeight + 14);
      const imageBottom = Math.min(pageH - 120, footerStart - 16);
      doc.image(attachment.data, left, imageTop, {
        fit: [contentW, Math.max(20, imageBottom - imageTop)],
        align: "center",
        valign: "center",
      });
      drawFooter(totalPages, totalPages);
    }

    doc.end();
  });
}
