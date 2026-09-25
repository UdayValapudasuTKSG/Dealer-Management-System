import PDFDocument from "pdfkit";
import type { PdfBranding } from "./dealer-branding";
import { formatDealerDate } from "./timezone";

export type PrintablePurchaseOrder = {
  id: number;
  reference: string | null;
  createdAt: Date;
  expectedDate: string | null;
  notes: string | null;
  lines: {
    partName: string;
    quantity: number;
    unitCost: number;
    landedCostComponents: { freight?: number; duty?: number; handling?: number; other?: number };
  }[];
};

export type PrintableDealer = {
  address: string | null;
  city: string | null;
  country: string | null;
  servicePhone: string | null;
};

export type PrintableSupplier = {
  name: string;
  contactName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
};

const LEFT = 72;
const RIGHT = 540;
const WIDTH = RIGHT - LEFT;
const BOTTOM = 737;
const BLUE = "#326aa4";
const INK = "#23364e";
const BORDER = "#d9e2ec";

function currency(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Invalid purchase order amount");
  return `GYD ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Fresh document, never overlays the example template or its sample contacts. */
export function buildPurchaseOrderPdf(
  order: PrintablePurchaseOrder,
  dealer: PrintableDealer,
  supplier: PrintableSupplier | null,
  branding: PdfBranding,
  timezone: string,
): Promise<Buffer> {
  if (!branding.displayName?.trim()) throw new Error("Dealership branding is unavailable");
  const doc = new PDFDocument({ size: "LETTER", margins: { top: 0, bottom: 0, left: 0, right: 0 }, autoFirstPage: false });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const text = (value: string, x: number, y: number, width: number, size = 10, bold = false, color = INK) =>
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color)
      .text(value, x, y, { width });
  const height = (value: string, width: number, size = 10) =>
    doc.font("Helvetica").fontSize(size).heightOfString(value, { width, lineGap: 2 });
  const rule = (y: number) => doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor(BORDER).lineWidth(0.8).stroke();
  let y = 0;
  const header = () => {
    doc.addPage();
    let logoShown = false;
    if (branding.logo) {
      try {
        doc.image(branding.logo, LEFT, 27, { fit: [205, 49] });
        logoShown = true;
      } catch {
        // Unreadable configured logo: keep the active dealership name.
      }
    }
    const brandY = logoShown ? 79 : 32;
    const brandHeight = doc.font("Helvetica-Bold").fontSize(13)
      .heightOfString(branding.displayName!, { width: 238 });
    text(branding.displayName!, LEFT, brandY, 238, 13, true);
    const contact = [dealer.address, [dealer.city, dealer.country].filter(Boolean).join(", "), dealer.servicePhone].filter(Boolean);
    contact.forEach((line, index) => text(line!, 312, 32 + index * 14, 228, 9, false));
    const lineY = Math.max(111, brandY + brandHeight + 10);
    rule(lineY);
    y = lineY + 15;
  };
  const tableHeader = () => {
    doc.rect(LEFT, y, WIDTH, 33).fill(BLUE);
    text("Item #", LEFT + 9, y + 10, 46, 9, true, "#ffffff");
    text("Description", LEFT + 65, y + 10, 205, 9, true, "#ffffff");
    text("Qty", LEFT + 276, y + 10, 35, 9, true, "#ffffff");
    text("Unit Price (GYD)", LEFT + 317, y + 10, 82, 9, true, "#ffffff");
    text("Total (GYD)", LEFT + 403, y + 10, 78, 9, true, "#ffffff");
    y += 33;
  };
  const nextTablePage = () => { header(); tableHeader(); };
  const nextClosingPage = () => { header(); };
  header();
  text("PURCHASE ORDER", LEFT, y, WIDTH, 21, true);
  y += 39;
  const detailLines = [
    `P.O. Number: ${order.reference?.trim() || `#${order.id}`}`,
    `Date: ${formatDealerDate(order.createdAt, timezone)}`,
    ...(order.expectedDate ? [`Delivery Date: ${formatDealerDate(order.expectedDate, timezone)}`] : []),
  ];
  const addressLines = [dealer.address, [dealer.city, dealer.country].filter(Boolean).join(", "), dealer.servicePhone].filter(Boolean) as string[];
  const brandBoxHeight = doc.font("Helvetica-Bold").fontSize(11)
    .heightOfString(branding.displayName!, { width: 218 });
  const addressY = y + 11 + brandBoxHeight + 5;
  const detailsHeight = Math.max(94, addressY - y + addressLines.length * 15 + 10, 28 + detailLines.length * 15);
  doc.rect(LEFT, y, WIDTH, detailsHeight).strokeColor(INK).lineWidth(0.7).stroke();
  doc.moveTo(306, y).lineTo(306, y + detailsHeight).stroke();
  text(branding.displayName!, LEFT + 8, y + 9, 218, 11, true, BLUE);
  addressLines.forEach((line, i) => text(line, LEFT + 8, addressY + 15 * i, 218, 9));
  text("P.O. DETAILS", 314, y + 9, 215, 11, true, BLUE);
  detailLines.forEach((line, i) => text(line, 314, y + 29 + 15 * i, 215, 9));
  y += detailsHeight + 16;
  const supplierLines = [
    supplier?.name ?? "Supplier not assigned",
    ...(supplier?.contactName ? [`Contact: ${supplier.contactName}`] : []),
    ...(supplier?.address ? [`Address: ${supplier.address}`] : []),
    ...(supplier?.phone ? [`Phone: ${supplier.phone}`] : []),
    ...(supplier?.email ? [`Email: ${supplier.email}`] : []),
  ];
  const supplierHeight = 37 + supplierLines.reduce((sum, line) => sum + Math.max(14, height(line, WIDTH - 16, 9)), 0);
  doc.rect(LEFT, y, WIDTH, supplierHeight).fill("#f7fbfe").strokeColor(BORDER).stroke();
  text("VENDOR / SUPPLIER", LEFT + 8, y + 8, WIDTH - 16, 11, true, BLUE);
  let supplierY = y + 29;
  supplierLines.forEach((line) => { text(line, LEFT + 8, supplierY, WIDTH - 16, 9); supplierY += Math.max(14, height(line, WIDTH - 16, 9)); });
  y += supplierHeight + 16;
  text("Order Details", LEFT, y, WIDTH, 15, true);
  y += 28;
  tableHeader();

  let subtotal = 0;
  const components = { freight: 0, duty: 0, handling: 0, other: 0 };
  for (const [index, line] of order.lines.entries()) {
    const lineTotal = line.quantity * line.unitCost;
    subtotal += lineTotal;
    for (const key of Object.keys(components) as (keyof typeof components)[]) {
      components[key] += line.landedCostComponents?.[key] ?? 0;
    }
    let remainder = line.partName || " ";
    let first = true;
    while (remainder.length) {
      if (y + 38 > BOTTOM) nextTablePage();
      const available = BOTTOM - y - 13;
      let cut = remainder.length;
      if (height(remainder, 202) > available) {
        let lo = 1, hi = remainder.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (height(remainder.slice(0, mid), 202) <= available) lo = mid;
          else hi = mid - 1;
        }
        cut = Math.max(1, lo);
        const space = remainder.lastIndexOf(" ", cut);
        if (space > cut / 2) cut = space + 1;
      }
      const segment = remainder.slice(0, cut);
      const rowHeight = Math.max(37, height(segment, 202) + 13);
      if (y + rowHeight > BOTTOM) {
        nextTablePage();
        continue;
      }
      doc.rect(LEFT, y, WIDTH, rowHeight).fill(index % 2 ? "#f7fbfe" : "#ffffff").strokeColor(BORDER).lineWidth(0.6).stroke();
      if (first) {
        text(String(index + 1), LEFT + 9, y + 10, 46, 9);
        text(String(line.quantity), LEFT + 276, y + 10, 35, 9);
        text(currency(line.unitCost), LEFT + 317, y + 10, 83, 8);
        text(currency(lineTotal), LEFT + 403, y + 10, 76, 8);
      }
      doc.font("Helvetica").fontSize(9).fillColor(INK).text(segment, LEFT + 65, y + 10, { width: 202, lineGap: 2 });
      y += rowHeight;
      remainder = remainder.slice(cut);
      first = false;
    }
  }
  const costRows: [string, number][] = [["Subtotal", subtotal]];
  for (const key of Object.keys(components) as (keyof typeof components)[]) {
    if (components[key]) costRows.push([`${key[0]!.toUpperCase()}${key.slice(1)} (landed)`, components[key]]);
  }
  costRows.push(["Total", subtotal + Object.values(components).reduce((sum, amount) => sum + amount, 0)]);
  const instructions = [
    "Please reference the Purchase Order number on all shipping documents, invoices, and packing slips.",
    "Notify us immediately if unable to deliver as specified or by the requested delivery date.",
    "All goods are subject to inspection and approval upon arrival.",
  ];
  const instructionHeights = instructions.map((instruction) => Math.max(16, height(instruction, WIDTH - 31, 9) + 4));
  const instructionsHeight = 22 + instructionHeights.reduce((sum, h) => sum + h, 0) + 9;
  const note = order.notes?.trim();
  const closingHeight = 18 + costRows.length * 23 + instructionsHeight + 15;
  if (y + closingHeight > BOTTOM) nextClosingPage();
  y += 13;
  costRows.forEach(([label, value], index) => {
    const last = index === costRows.length - 1;
    if (last) doc.rect(LEFT, y, WIDTH, 23).fill("#f1f7fc");
    text(`${label}:`, LEFT + 8, y + 6, 275, 10, last);
    text(currency(value), 360, y + 6, 170, 10, last);
    rule(y + 23);
    y += 23;
  });
  y += 15;
  const noteHeight = note ? 30 + height(note, WIDTH - 14, 9) : 0;
  if (y + instructionsHeight + noteHeight + 143 > BOTTOM) nextClosingPage();
  text("SPECIAL INSTRUCTIONS & TERMS", LEFT, y, WIDTH, 12, true);
  y += 23;
  instructions.forEach((instruction, index) => {
    doc.circle(LEFT + 12, y + 6, 1.7).fill(INK);
    text(instruction, LEFT + 23, y, WIDTH - 31, 9);
    y += instructionHeights[index]!;
  });
  y += 9;
  if (note) {
    if (y + 52 > BOTTOM) nextClosingPage();
    text("Additional PO Notes", LEFT, y, WIDTH, 12, true);
    y += 21;
    let remainder = note;
    while (remainder.length) {
      if (y + 28 > BOTTOM) nextClosingPage();
      const available = BOTTOM - y - 5;
      let cut = remainder.length;
      if (height(remainder, WIDTH - 14, 9) > available) {
        let lo = 1, hi = remainder.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (height(remainder.slice(0, mid), WIDTH - 14, 9) <= available) lo = mid;
          else hi = mid - 1;
        }
        cut = Math.max(1, lo);
        const space = remainder.lastIndexOf(" ", cut);
        if (space > cut / 2) cut = space + 1;
      }
      const segment = remainder.slice(0, cut);
      doc.font("Helvetica").fontSize(9).fillColor(INK).text(segment, LEFT + 7, y, { width: WIDTH - 14, lineGap: 2 });
      y += height(segment, WIDTH - 14, 9) + 4;
      remainder = remainder.slice(cut);
    }
    y += 8;
  }
  if (y + 143 > BOTTOM) nextClosingPage();
  text("Authorization", LEFT, y, WIDTH, 14, true);
  y += 25;
  doc.rect(LEFT, y, WIDTH, 116).strokeColor(INK).stroke();
  doc.moveTo(306, y).lineTo(306, y + 116).stroke();
  text("Authorized Signature:", LEFT + 8, y + 8, 205, 9, true);
  text("Date Signed:", 314, y + 8, 205, 9, true);
  text("_________________________", LEFT + 8, y + 44, 205, 9);
  text("_________________________", 314, y + 44, 205, 9);
  text("Name: ____________________", LEFT + 8, y + 74, 205, 9, true);
  text("Title: _____________________", LEFT + 8, y + 94, 205, 9, true);
  doc.end();
  return result;
}