import PDFDocument from "pdfkit";
import type {
  Receipt,
  Delivery,
  CoveragePlan,
  ServiceInvoice,
  Vehicle,
} from "@workspace/db";
import { formatDealerDate } from "./timezone";

/**
 * AURA-branded printable documents: payment receipt, vehicle handover form,
 * warranty / AMC certificate and service invoice. All amounts are stored and
 * displayed in GYD (Guyana dollars) — the system's only currency.
 */

const LEFT = 54;

const gyd = (n: number) =>
  `GY$${Math.round(n).toLocaleString("en-US")}`;
const fmtDate = (
  d: Date | string | null | undefined,
  tz: string,
) =>
  formatDealerDate(d, tz).replace(
    /^([A-Z][a-z]{2}) /,
    (short) =>
      ({
        Jan: "January ",
        Feb: "February ",
        Mar: "March ",
        Apr: "April ",
        May: "May ",
        Jun: "June ",
        Jul: "July ",
        Aug: "August ",
        Sep: "September ",
        Oct: "October ",
        Nov: "November ",
        Dec: "December ",
      })[short.trim()] ?? short,
  );

type Doc = InstanceType<typeof PDFDocument>;

/** GM-configured white-label branding; null/missing fields fall back to AURA. */
export type PdfBranding = {
  displayName: string | null;
  logo: Buffer | null;
};

function collect(build: (doc: Doc) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

/** Dark header band + document title, returns content start y. */
function header(
  doc: Doc,
  title: string,
  refLines: string[],
  branding?: PdfBranding | null,
): number {
  const pageW = doc.page.width;
  const contentW = pageW - LEFT * 2;
  doc.rect(0, 0, pageW, 118).fill("#0a0a0a");
  doc.rect(0, 118, pageW, 4).fill("#a97142");
  if (branding?.displayName) {
    if (branding.logo) {
      try {
        doc.image(branding.logo, LEFT, 26, { fit: [140, 52] });
        doc
          .font("Helvetica-Bold")
          .fontSize(11)
          .fillColor("#ffffff")
          .text(branding.displayName, LEFT, 88, { width: 260 });
      } catch {
        // Unreadable image bytes — fall back to the name-only wordmark.
        doc
          .fillColor("#ffffff")
          .font("Helvetica-Bold")
          .fontSize(20)
          .text(branding.displayName, LEFT, 40, { width: 300 });
      }
    } else {
      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(20)
        .text(branding.displayName, LEFT, 40, { width: 300 });
    }
  } else {
    doc
      .fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(26)
      .text("AURA", LEFT, 34, { continued: true })
      .fillColor("#c89b6d")
      .text(".OS");
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor("#9a9a9a")
      .text("DEALERSHIP OPERATING SYSTEM", LEFT, 66, { characterSpacing: 2 });
  }
  doc
    .font("Helvetica-Bold")
    .fontSize(15)
    .fillColor("#ffffff")
    .text(title, LEFT, 34, { width: contentW, align: "right" });
  let y = 58;
  for (const line of refLines) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#c9c9c9")
      .text(line, LEFT, y, { width: contentW, align: "right" });
    y += 14;
  }
  return 152;
}

function sectionLabel(doc: Doc, label: string, y: number): number {
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#a97142")
    .text(label, LEFT, y, { characterSpacing: 1.5 });
  return y + 16;
}

function detailRows(doc: Doc, rows: [string, string][], y: number): number {
  const contentW = doc.page.width - LEFT * 2;
  const rowH = 24;
  for (let i = 0; i < rows.length; i++) {
    const [label, value] = rows[i]!;
    const ry = y + i * rowH;
    if (i % 2 === 0) doc.rect(LEFT, ry, contentW, rowH).fill("#f5f5f5");
    doc
      .font("Helvetica-Bold")
      .fontSize(9.5)
      .fillColor("#555555")
      .text(label, LEFT + 12, ry + 7, { width: 150 });
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#111111")
      .text(value, LEFT + 170, ry + 6.5, { width: contentW - 182 });
  }
  return y + rows.length * rowH + 24;
}

function footer(doc: Doc, note: string, branding?: PdfBranding | null) {
  const pageW = doc.page.width;
  const footY = doc.page.height - 70;
  doc.rect(0, footY, pageW, 70).fill("#0a0a0a");
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#ffffff")
    .text(branding?.displayName ?? "AURA Dealership", LEFT, footY + 20, {
      continued: !branding?.displayName,
    });
  if (!branding?.displayName) {
    doc
      .font("Helvetica")
      .fillColor("#9a9a9a")
      .text("  —  Premium Automotive Concierge");
  }
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#6f6f6f")
    .text(note, LEFT, footY + 38, { width: pageW - LEFT * 2 });
}

// ---------------------------------------------------------------------------
// 1) Payment receipt
// ---------------------------------------------------------------------------

export function buildReceiptPdf(
  receipt: Receipt,
  tz: string,
  branding?: PdfBranding | null,
): Promise<Buffer> {
  return collect((doc) => {
    let y = header(doc, "PAYMENT RECEIPT", [
      `Receipt ${receipt.receiptNumber}`,
      `Issued ${fmtDate(receipt.createdAt, tz)}`,
    ], branding);

    y = sectionLabel(doc, "RECEIVED FROM", y);
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#111111")
      .text(receipt.customerName, LEFT, y);
    y += 34;

    // Amount hero block
    const contentW = doc.page.width - LEFT * 2;
    doc.rect(LEFT, y, contentW, 72).fill("#faf6f1");
    doc
      .font("Helvetica-Bold")
      .fontSize(24)
      .fillColor("#111111")
      .text(gyd(receipt.amount), LEFT, y + 16, {
        width: contentW,
        align: "center",
      });
    y += 96;

    y = sectionLabel(doc, "PAYMENT DETAILS", y);
    y = detailRows(
      doc,
      [
        ["Against invoice", receipt.invoiceNumber],
        ["Method", receipt.method.replace(/_/g, " ")],
        ["Issued by", receipt.issuedBy ?? "—"],
        ["Date", fmtDate(receipt.createdAt, tz)],
      ],
      y,
    );

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#777777")
      .text(
        "This receipt confirms funds received against the invoice above. All amounts are in Guyana dollars (GYD).",
        LEFT,
        y,
        { width: doc.page.width - LEFT * 2, lineGap: 2 },
      );

    footer(
      doc,
      "Generated by the AURA finance engine. Keep this receipt for your records.",
      branding,
    );
  });
}

// ---------------------------------------------------------------------------
// 1b) Customer invoice (rebuilt from outbox payload on every send attempt,
//     so retries never depend on in-memory state)
// ---------------------------------------------------------------------------

export function buildInvoicePdfFromPayload(
  payload: Record<string, string>,
  tz: string,
  branding?: PdfBranding | null,
): Promise<Buffer> {
  return collect((doc) => {
    const amount = Number(payload.amount) || 0;
    let y = header(doc, "INVOICE", [
      `Invoice ${payload.invoiceNumber ?? ""}`,
      `Issued ${fmtDate(payload.issuedAt || new Date(), tz)}`,
    ], branding);

    y = sectionLabel(doc, "BILLED TO", y);
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#111111")
      .text(payload.customerName ?? "Customer", LEFT, y);
    y += 34;

    const contentW = doc.page.width - LEFT * 2;
    doc.rect(LEFT, y, contentW, 72).fill("#faf6f1");
    doc
      .font("Helvetica-Bold")
      .fontSize(24)
      .fillColor("#111111")
      .text(gyd(amount), LEFT, y + 16, {
        width: contentW,
        align: "center",
      });
    y += 96;

    y = sectionLabel(doc, "INVOICE DETAILS", y);
    const rows: [string, string][] = [
      ["Invoice number", payload.invoiceNumber ?? "—"],
      ["Type", (payload.kind ?? "invoice").replace(/_/g, " ")],
      ["Description", payload.description || "—"],
      ["Due date", payload.dueDate ? fmtDate(payload.dueDate, tz) : "On receipt"],
    ];
    try {
      const taxLines = JSON.parse(payload.taxLines ?? "[]") as {
        label: string;
        amount: number;
      }[];
      for (const line of taxLines) {
        rows.push([line.label, gyd(line.amount)]);
      }
    } catch {
      // no tax breakdown — skip
    }
    y = detailRows(doc, rows, y);

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#777777")
      .text(
        "All amounts are in Guyana dollars (GYD). Your advisor is available for any question about this invoice.",
        LEFT,
        y,
        { width: doc.page.width - LEFT * 2, lineGap: 2 },
      );

    footer(
      doc,
      "Generated by the AURA finance engine. Please quote the invoice number on all payments.",
      branding,
    );
  });
}

// ---------------------------------------------------------------------------
// 2) Vehicle handover form
// ---------------------------------------------------------------------------

export interface HandoverPdfExtras {
  /** Resolved customer name from the delivery/customer record. */
  customerName?: string | null;
  salesAdvisorName?: string | null;
  dealerName?: string | null;
  /** White-label logo bytes; drawn above the dealership name when present. */
  logo?: Buffer | null;
  dealerAddress?: string | null;
  customerAddress?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  registrationNumber?: string | null;
  invoiceNumber?: string | null;
  /** Resolved date, including imported-history blank-date semantics. */
  handoverDate?: string | null;
  /** Manual per-field overrides from the delivery's handover_overrides. */
  overrides?: Record<string, string>;
  /** Imported workflow records must not turn an arrival/appointment into a handover date. */
  suppressAutoHandoverDate?: boolean;
  /** A legacy required numeric mileage sentinel is never a real odometer reading. */
  mileageKnown?: boolean;
}

// Checklist content mirrors the dealership's printed "New Vehicle Handover
// Record" sheet — boxes stay empty so the advisor ticks them with the
// customer during the physical handover.
const HANDOVER_LEFT_SECTIONS: [string, string[]][] = [
  [
    "VEHICLE OPERATION - INTERIOR",
    [
      "Seat adjustment/ seatbelt operation",
      "Mirror adjustment",
      "Transmission/ handbrake",
      "Window operation",
      "Gear selection",
      "Transfer lever [where fitted]",
      "Radio/ CD/ iPod & security code",
      "Air conditioning and ventilation",
      "Fuse access panel",
      "Steering column controls",
      "Headlamp operations",
      "Other facia switches",
      "Instruments and warning lights/ inc ABS",
      "Storage areas/ interior lights",
      "Sunroof operation [where fitted]",
      "Bonnet release - interior",
    ],
  ],
  [
    "VEHICLE OPERATION - EXTERIOR/ REAR TAILGATE",
    [
      "Rear door/ tailgate operation",
      "Rear seat operation",
      "Child lock operation",
      "Spare wheel, jack and toolkit location",
      "Vehicle walkaround to highlight flawless finish",
    ],
  ],
  [
    "VEHICLE OPERATION - EXTERIOR/ UNDER BONNET",
    ["Bonnet release and support", "Jacking points and procedure"],
  ],
];

const HANDOVER_RIGHT_SECTIONS: [string, string[]][] = [
  [
    "VEHICLE OPERATION - EXTERIOR/ UNDER BONNET",
    [
      "Fuel filler and types of fuel",
      "Door locking and alarm [where fitted]",
      "Owners handbook",
    ],
  ],
  [
    "VEHICLE SERVICING AND WARRANTY",
    [
      "First service - Pre-book date",
      "Service schedules - service book & owners manual",
      "Warranty documents explained and signed",
    ],
  ],
  [
    "INTRODUCE SERVICE REPS & EXPLAIN AFTER SALES CARE/ FACILITIES",
    [
      "Dealer/ Service hours of business/ Contact #'s",
      "Introduction to Service Reception",
      "Introduction to Parts Department",
      "Value of customer satisfaction feedback",
    ],
  ],
  [
    "DRIVING FAMILIARISATIONS/ CONCLUSION",
    [
      "Vehicle starting procedure",
      "Orientation drive",
      "Check whether there are related customer queries",
      "I confirm that all the items listed above and any queries that I had have been handled to my full satisfaction",
    ],
  ],
  [
    "PERIODIC CHECKS",
    [
      "Water reservoir for washers",
      "Engine oil dipstick/ filler/ top-up amount",
      "Radiator level check/ symbols",
      "Brake fluid reservoir/ symbols",
      "Tyre pressures [loaded/ unloaded]",
    ],
  ],
];

export function buildHandoverPdf(
  delivery: Delivery,
  vehicle: Vehicle | undefined,
  advisorName: string | null,
  tz: string,
  extras: HandoverPdfExtras = {},
): Promise<Buffer> {
  const ov = extras.overrides ?? {};
  return collect((doc) => {
    const M = 40;
    const pageW = doc.page.width;
    const colGap = 24;
    const colW = (pageW - M * 2 - colGap) / 2;
    const rightX = M + colW + colGap;
    const INK = "#111111";
    const RULE = "#333333";

    const fieldLine = (
      label: string,
      value: string | null | undefined,
      x: number,
      y: number,
      width: number,
      labelW?: number,
    ): number => {
      doc.font("Helvetica-Bold").fontSize(8).fillColor(INK).text(label, x, y);
      const lw = labelW ?? doc.widthOfString(label) + 6;
      const contentWidth = Math.max(12, width - lw);
      const text = value?.trim() ?? "";
      const lineGap = 1.5;
      doc.font("Helvetica").fontSize(8.5).fillColor(INK);
      const textHeight = text
        ? Math.max(
            9,
            doc.heightOfString(text, {
              width: contentWidth,
              lineGap,
              lineBreak: true,
            }),
          )
        : 9;
      if (text) {
        doc
          .text(text, x + lw, y - 1, {
            width: contentWidth,
            lineGap,
            lineBreak: true,
          });
      }
      doc
        .moveTo(x + lw, y + textHeight + 2)
        .lineTo(x + width, y + textHeight + 2)
        .strokeColor(RULE)
        .lineWidth(0.7)
        .stroke();
      return y + textHeight + 9;
    };

    const checklist = (title: string, items: string[], x: number, y: number): number => {
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text(title, x, y, { width: colW });
      y = doc.y + 3;
      for (const item of items) {
        doc.font("Helvetica").fontSize(7.8).fillColor(INK).text(item, x, y, { width: colW - 20 });
        const rowBottom = doc.y;
        const boxSize = 9;
        doc
          .rect(x + colW - boxSize - 1, y - 1, boxSize, boxSize)
          .strokeColor(RULE)
          .lineWidth(0.7)
          .stroke();
        doc
          .moveTo(x, rowBottom + 2)
          .lineTo(x + colW, rowBottom + 2)
          .strokeColor("#bbbbbb")
          .lineWidth(0.4)
          .stroke();
        y = rowBottom + 5;
      }
      return y + 10;
    };

    const pageHeader = () => {
      // Title banner (left) + dealership identity (right)
      doc.rect(M, 36, colW, 20).fill("#1a1a1a");
      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("YOUR NEW VEHICLE HANDOVER RECORD", M + 8, 42, { width: colW - 16 });
      let nameTop = 38;
      let headerBottom = 74;
      if (extras.logo) {
        try {
          doc.image(extras.logo, rightX + colW / 2 - 45, 24, { fit: [90, 30] });
          nameTop = 58;
          headerBottom = 96;
        } catch {
          /* unreadable logo bytes — name-only header */
        }
      }
      doc
        .fillColor(INK)
        .font("Helvetica-Bold")
        .fontSize(15)
        .text(extras.dealerName ?? "AURA MOTORS", rightX, nameTop, {
          width: colW,
          align: "center",
        });
      doc
        .font("Helvetica-Bold")
        .fontSize(7.5)
        .text((extras.dealerAddress ?? "").toUpperCase(), rightX, doc.y + 2, {
          width: colW,
          align: "center",
        });
      return headerBottom;
    };

    // ---------------- Page 1 ----------------
    let y = pageHeader();

    // Customer details (left)
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("CUSTOMER DETAILS", M, y);
    let ly = y + 14;
    ly = fieldLine(
      "CUSTOMER NAME:",
      extras.customerName ?? delivery.customerName ?? "",
      M,
      ly,
      colW,
      82,
    );
    ly = fieldLine(
      "ADDRESS:",
      ov.customerAddress?.trim() || extras.customerAddress || "",
      M,
      ly,
      colW,
      50,
    );
    ly = fieldLine(
      "EMAIL ADDRESS:",
      ov.customerEmail?.trim() || extras.customerEmail || "",
      M,
      ly,
      colW,
      80,
    );
    ly = fieldLine(
      "TEL NOS.:",
      ov.customerPhone?.trim() || extras.customerPhone || "",
      M,
      ly,
      colW,
      48,
    );

    // Salesperson / date / invoice (right)
    let ry = y + 14;
    ry = fieldLine(
      "SALESPERSON:",
      ov.salesperson?.trim() || extras.salesAdvisorName || advisorName || "",
      rightX,
      ry,
      colW,
      74,
    );
    ry = fieldLine(
      "DATE:",
      ov.date?.trim() ||
        extras.handoverDate ||
        (extras.suppressAutoHandoverDate
          ? delivery.deliveredAt
            ? fmtDate(delivery.deliveredAt, tz)
            : ""
          : fmtDate(
              delivery.deliveredAt ?? delivery.appointmentAt ?? new Date(),
              tz,
            )),
      rightX,
      ry,
      colW,
      34,
    );
    ry = fieldLine(
      "INVOICE#",
      ov.invoiceNumber?.trim() || extras.invoiceNumber || "",
      rightX,
      ry,
      colW,
      48,
    );

    y = Math.max(ly, ry) + 6;

    // Vehicle details (left, two mini-columns)
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("VEHICLE DETAILS", M, y);
    y += 14;
    const halfCol = (colW - 12) / 2;
    const makeY = fieldLine(
      "MAKE:",
      ov.make?.trim() || vehicle?.make || "",
      M,
      y,
      halfCol,
      34,
    );
    const modelY = fieldLine(
      "MODEL:",
      ov.model?.trim() || vehicle?.model || "",
      M + halfCol + 12,
      y,
      halfCol,
      40,
    );
    let vy = Math.max(makeY, modelY);
    const registrationY = fieldLine(
      "REGISTRATION#",
      extras.registrationNumber ?? delivery.registrationNumber ?? "",
      M,
      vy,
      halfCol,
      74,
    );
    const vinY = fieldLine(
      "VIN:",
      ov.vin?.trim() || vehicle?.vin || "",
      M + halfCol + 12,
      vy,
      halfCol,
      26,
    );
    const vy2 = Math.max(registrationY, vinY);
    const keyY = fieldLine(
      "KEY #",
      ov.keyNumber?.trim() || "",
      M,
      vy2,
      halfCol,
      32,
    );
    const mileageY = fieldLine(
      "MILEAGE:",
      ov.mileage?.trim() ||
        (extras.mileageKnown !== false && vehicle?.mileageKm != null
          ? `${vehicle.mileageKm.toLocaleString("en-US")} km`
          : ""),
      M + halfCol + 12,
      vy2,
      halfCol,
      48,
    );
    const vy3 = Math.max(keyY, mileageY);
    y = fieldLine(
      "STOCK#",
      ov.stockNumber?.trim() ||
        (vehicle ? `V-${String(vehicle.id).padStart(5, "0")}` : ""),
      M,
      vy3,
      halfCol,
      40,
    );
    y += 4;

    // Keep the checklist legible when a customer/contact value wraps into
    // several lines. Rather than compressing the checklist or allowing it to
    // run into the page edge, continue it on a branded page of its own.
    let checklistTop = y;
    let rightChecklistTop = ry + 10;
    if (checklistTop > 340) {
      doc.addPage();
      checklistTop = pageHeader() + 14;
      rightChecklistTop = checklistTop;
    }
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(INK)
      .text("EXPLAIN AND/OR DEMONSTRATE", M, checklistTop);
    checklistTop += 18;

    // Checklists — left column continues from here; right column starts at the
    // same height as the vehicle details block for visual balance.
    let leftY = checklistTop;
    for (const [title, items] of HANDOVER_LEFT_SECTIONS) {
      leftY = checklist(title, items, M, leftY);
    }
    let rightY = rightChecklistTop;
    for (const [title, items] of HANDOVER_RIGHT_SECTIONS) {
      rightY = checklist(title, items, rightX, rightY);
    }

    // ---------------- Page 2 ----------------
    doc.addPage();
    y = pageHeader();

    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("CUSTOMER DETAILS", M, y);
    let p2y = y + 14;
    p2y = fieldLine(
      "CUSTOMER NAME:",
      extras.customerName ?? delivery.customerName ?? "",
      M,
      p2y,
      colW,
      82,
    );
    p2y = fieldLine(
      "ADDRESS:",
      ov.customerAddress?.trim() || extras.customerAddress || "",
      M,
      p2y,
      colW,
      50,
    );
    p2y += 14;

    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("CONDITION OF VEHICLE", M, p2y);
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(INK)
      .text(
        "Please confirm that the vehicle you are receiving is in accordance with your order and correct in " +
          "both specification and documentation, that the vehicle's condition meets your full expectation " +
          "and that the handover process increased your excitement and pleased you.",
        M,
        p2y + 14,
        { width: colW, lineGap: 2 },
      );
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#555555")
      .text("Print in duplicate\n(1) Customer, (2) Operations Manager", M, doc.y + 24);

    // Sign & date (right column)
    let sy = y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("SIGN & DATE", rightX, sy);
    sy += 18;
    const signRow = (label: string, right?: string): void => {
      doc.font("Helvetica").fontSize(8.5).fillColor(INK).text(label, rightX, sy);
      if (right) {
        doc.text(right, rightX, sy, { width: colW, align: "right" });
      }
      if (label === "Customer" && delivery.signatureData?.startsWith("data:image")) {
        try {
          const b64 = delivery.signatureData.split(",")[1] ?? "";
          doc.image(Buffer.from(b64, "base64"), rightX + 90, sy - 6, { fit: [120, 34] });
        } catch {
          /* unreadable signature payload — leave the line blank */
        }
      }
      sy += 34;
      doc
        .moveTo(rightX, sy)
        .lineTo(rightX + colW, sy)
        .strokeColor(RULE)
        .lineWidth(0.8)
        .stroke();
      sy += 14;
    };
    signRow("Customer");
    signRow("Sales", "Consultant");
    signRow("Service", "Representative");

    sy += 4;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("Comments & Commitments", rightX, sy);
    sy += 14;
    doc.rect(rightX, sy, colW, 70).strokeColor(RULE).lineWidth(1).stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(9.5)
      .fillColor(INK)
      .text("Spare Key Received", rightX + 10, sy + 12, { continued: true })
      .text("        ____", { continued: false });

    footer(
      doc,
      "Generated by the AURA delivery workflow. One copy for the customer, one for the dealership file.",
    );
  });
}

// ---------------------------------------------------------------------------
// 3) Warranty / AMC certificate
// ---------------------------------------------------------------------------

export function buildCoverageCertificatePdf(
  plan: CoveragePlan,
  tz: string,
  branding?: PdfBranding | null,
): Promise<Buffer> {
  return collect((doc) => {
    const kind = plan.type === "amc" ? "AMC" : "WARRANTY";
    let y = header(doc, `${kind} CERTIFICATE`, [
      `Certificate #CP-${String(plan.id).padStart(5, "0")}`,
      `Issued ${fmtDate(plan.createdAt, tz)}`,
    ], branding);

    y = sectionLabel(doc, "COVERED CUSTOMER", y);
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#111111")
      .text(plan.customerName ?? "Customer", LEFT, y);
    y += 30;

    y = sectionLabel(doc, "COVERAGE DETAILS", y);
    y = detailRows(
      doc,
      [
        ["Vehicle", plan.vehicleInfo],
        [
          "Coverage type",
          plan.type === "amc"
            ? "Annual Maintenance Contract"
            : "Manufacturer / Dealer Warranty",
        ],
        ["Provider", plan.provider ?? "AURA Dealership"],
        ["Valid from", fmtDate(plan.startDate, tz)],
        ["Valid until", fmtDate(plan.endDate, tz)],
      ],
      y,
    );

    if (plan.notes) {
      y = sectionLabel(doc, "TERMS & NOTES", y);
      doc
        .font("Helvetica")
        .fontSize(9.5)
        .fillColor("#333333")
        .text(plan.notes, LEFT, y, {
          width: doc.page.width - LEFT * 2,
          lineGap: 2,
        });
      y += 60;
    }

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#777777")
      .text(
        "This certificate confirms active coverage for the vehicle above between the dates shown. Present it " +
          "(or quote the certificate number) when booking service under this plan.",
        LEFT,
        y,
        { width: doc.page.width - LEFT * 2, lineGap: 2 },
      );

    footer(
      doc,
      "Generated by the AURA after-sales engine. Coverage is subject to the plan terms on file.",
      branding,
    );
  });
}

// ---------------------------------------------------------------------------
// 4) Service invoice
// ---------------------------------------------------------------------------

export function buildServiceInvoicePdf(
  invoice: ServiceInvoice,
  exchangeRate: number,
  tz: string,
  branding?: PdfBranding | null,
): Promise<Buffer> {
  return collect((doc) => {
    let y = header(doc, "SERVICE INVOICE", [
      `Invoice #SV-${String(invoice.id).padStart(5, "0")}`,
      `Issued ${fmtDate(invoice.createdAt, tz)}`,
      `Status ${invoice.status.toUpperCase()}`,
    ], branding);

    y = sectionLabel(doc, "BILLED TO", y);
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#111111")
      .text(invoice.customerName ?? "Customer", LEFT, y);
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor("#555555")
      .text(invoice.vehicleInfo, LEFT, y + 18);
    y += 44;

    // Line table
    const right = doc.page.width - LEFT;
    const contentW = right - LEFT;
    const colAmt = right - 110;
    doc.rect(LEFT, y, contentW, 26).fill("#0a0a0a");
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#ffffff")
      .text("DESCRIPTION", LEFT + 12, y + 8.5)
      .text("AMOUNT", colAmt, y + 8.5, { width: 110 - 12, align: "right" });
    y += 26;

    const externalPartsTotal =
      "externalPartsTotal" in invoice && typeof invoice.externalPartsTotal === "number"
        ? invoice.externalPartsTotal
        : 0;
    const lines: [string, number][] = [
      ["Parts & consumables", invoice.partsTotal - externalPartsTotal],
      ["Labour", invoice.laborTotal],
    ];
    if (externalPartsTotal > 0) {
      lines.splice(1, 0, ["External parts", externalPartsTotal]);
    }
    if (invoice.surchargeTotal > 0) {
      lines.push(["Late-service surcharge", invoice.surchargeTotal]);
    }
    lines.push(["Tax (VAT)", invoice.tax]);
    if (invoice.discountTotal > 0 && invoice.discountStatus === "approved") {
      lines.push(["Approved discount", -invoice.discountTotal]);
    }
    for (const adj of invoice.adjustments ?? []) {
      lines.push([`Adjustment — ${adj.reason}`, adj.amount]);
    }
    for (let i = 0; i < lines.length; i++) {
      const [label, amount] = lines[i]!;
      if (i % 2 === 0) doc.rect(LEFT, y, contentW, 26).fill("#fafafa");
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#111111")
        .text(label, LEFT + 12, y + 8)
        .text(gyd(amount), colAmt, y + 8, {
          width: 110 - 12,
          align: "right",
        });
      y += 26;
    }

    doc
      .moveTo(LEFT, y)
      .lineTo(right, y)
      .strokeColor("#dddddd")
      .lineWidth(1)
      .stroke();
    y += 14;
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor("#111111")
      .text("Total due", LEFT + 12, y);
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .fillColor("#a97142")
      .text(gyd(invoice.total), colAmt - 90, y - 2, {
        width: 200 - 12,
        align: "right",
      });
    y += 40;

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#777777")
      .text(
        "Amounts include applicable VAT computed by the dealership tax engine. Payment is due on receipt " +
          "unless other terms have been agreed with your service advisor.",
        LEFT,
        y,
        { width: contentW, lineGap: 2 },
      );

    footer(
      doc,
      "Generated by the AURA after-sales engine from the job card's parts and labour records.",
      branding,
    );
  });
}

// ---------------------------------------------------------------------------
// 5) Service checkout receipt (FR-SR-10)
// ---------------------------------------------------------------------------

export function buildServiceReceiptPdf(
  invoice: ServiceInvoice,
  tz: string,
  branding?: PdfBranding | null,
): Promise<Buffer> {
  return collect((doc) => {
    let y = header(doc, "SERVICE RECEIPT", [
      `Receipt #SR-${String(invoice.id).padStart(5, "0")}`,
      `Job card #JC-${String(invoice.jobCardId).padStart(5, "0")}`,
      `Invoice #SV-${String(invoice.id).padStart(5, "0")}`,
      `Issued ${fmtDate(invoice.createdAt, tz)}`,
    ], branding);

    y = sectionLabel(doc, "CUSTOMER", y);
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#111111")
      .text(invoice.customerName ?? "Customer", LEFT, y);
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor("#555555")
      .text(invoice.vehicleInfo, LEFT, y + 18);
    y += 44;

    const right = doc.page.width - LEFT;
    const contentW = right - LEFT;
    const colAmt = right - 110;
    doc.rect(LEFT, y, contentW, 26).fill("#0a0a0a");
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#ffffff")
      .text("DESCRIPTION", LEFT + 12, y + 8.5)
      .text("AMOUNT", colAmt, y + 8.5, { width: 110 - 12, align: "right" });
    y += 26;

    const lines: [string, number][] = [
      ["Parts & consumables", invoice.partsTotal],
      ["Labour", invoice.laborTotal],
    ];
    if (invoice.surchargeTotal > 0)
      lines.push(["Late-service surcharge", invoice.surchargeTotal]);
    lines.push(["Tax (VAT)", invoice.tax]);
    if (invoice.discountTotal > 0 && invoice.discountStatus === "approved")
      lines.push(["Approved discount", -invoice.discountTotal]);
    for (const adj of invoice.adjustments ?? [])
      lines.push([`Adjustment — ${adj.reason}`, adj.amount]);

    for (let i = 0; i < lines.length; i++) {
      const [label, amount] = lines[i]!;
      if (i % 2 === 0) doc.rect(LEFT, y, contentW, 26).fill("#fafafa");
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#111111")
        .text(label, LEFT + 12, y + 8)
        .text(gyd(amount), colAmt, y + 8, { width: 110 - 12, align: "right" });
      y += 26;
    }

    doc
      .moveTo(LEFT, y)
      .lineTo(right, y)
      .strokeColor("#dddddd")
      .lineWidth(1)
      .stroke();
    y += 14;
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor("#111111")
      .text("Total", LEFT + 12, y);
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .fillColor("#a97142")
      .text(gyd(invoice.total), colAmt - 90, y - 2, {
        width: 200 - 12,
        align: "right",
      });
    y += 44;

    // Signed-copy acknowledgement block
    y = sectionLabel(doc, "SIGNED COPY ACKNOWLEDGEMENT", y);
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor("#555555")
      .text(
        invoice.signedCopyFiledAt
          ? `Signed copy collected & filed by ${invoice.signedCopyFiledBy ?? "staff"} on ${fmtDate(invoice.signedCopyFiledAt, tz)}.`
          : "Customer signature confirms collection of the vehicle and acceptance of the charges above. " +
              "File the signed copy against this receipt number.",
        LEFT,
        y,
        { width: contentW, lineGap: 2 },
      );
    y += invoice.signedCopyFiledAt ? 26 : 40;
    doc
      .moveTo(LEFT, y + 24)
      .lineTo(LEFT + 220, y + 24)
      .strokeColor("#999999")
      .lineWidth(1)
      .stroke();
    doc
      .moveTo(right - 220, y + 24)
      .lineTo(right, y + 24)
      .strokeColor("#999999")
      .lineWidth(1)
      .stroke();
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor("#777777")
      .text("Customer signature & date", LEFT, y + 28)
      .text("Service advisor — signed copy filed", right - 220, y + 28, {
        width: 220,
      });

    footer(
      doc,
      `Checkout receipt for job card #JC-${String(invoice.jobCardId).padStart(5, "0")}. Retain for your records.`,
      branding,
    );
  });
}
