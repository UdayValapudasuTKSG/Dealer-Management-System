import PDFDocument from "pdfkit";
import type {
  Receipt,
  Delivery,
  CoveragePlan,
  ServiceInvoice,
  Vehicle,
} from "@workspace/db";

/**
 * AURA-branded printable documents: payment receipt, vehicle handover form,
 * warranty / AMC certificate and service invoice. All amounts are stored and
 * displayed in GYD (Guyana dollars) — the system's only currency.
 */

const LEFT = 54;

const gyd = (n: number) =>
  `GY$${Math.round(n).toLocaleString("en-US")}`;
const fmtDate = (d: Date | string | null | undefined) =>
  d
    ? new Date(d).toLocaleDateString("en-US", {
        timeZone: "America/Guyana",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "—";

type Doc = InstanceType<typeof PDFDocument>;

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
function header(doc: Doc, title: string, refLines: string[]): number {
  const pageW = doc.page.width;
  const contentW = pageW - LEFT * 2;
  doc.rect(0, 0, pageW, 118).fill("#0a0a0a");
  doc.rect(0, 118, pageW, 4).fill("#a97142");
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

function footer(doc: Doc, note: string) {
  const pageW = doc.page.width;
  const footY = doc.page.height - 70;
  doc.rect(0, footY, pageW, 70).fill("#0a0a0a");
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#ffffff")
    .text("AURA Dealership", LEFT, footY + 20, { continued: true })
    .font("Helvetica")
    .fillColor("#9a9a9a")
    .text("  —  Premium Automotive Concierge");
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#6f6f6f")
    .text(note, LEFT, footY + 38, { width: pageW - LEFT * 2 });
}

// ---------------------------------------------------------------------------
// 1) Payment receipt
// ---------------------------------------------------------------------------

export function buildReceiptPdf(receipt: Receipt): Promise<Buffer> {
  return collect((doc) => {
    let y = header(doc, "PAYMENT RECEIPT", [
      `Receipt ${receipt.receiptNumber}`,
      `Issued ${fmtDate(receipt.createdAt)}`,
    ]);

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
        ["Date", fmtDate(receipt.createdAt)],
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
    );
  });
}

// ---------------------------------------------------------------------------
// 1b) Customer invoice (rebuilt from outbox payload on every send attempt,
//     so retries never depend on in-memory state)
// ---------------------------------------------------------------------------

export function buildInvoicePdfFromPayload(
  payload: Record<string, string>,
): Promise<Buffer> {
  return collect((doc) => {
    const amount = Number(payload.amount) || 0;
    let y = header(doc, "INVOICE", [
      `Invoice ${payload.invoiceNumber ?? ""}`,
      `Issued ${fmtDate(payload.issuedAt || new Date())}`,
    ]);

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
      ["Due date", payload.dueDate ? fmtDate(payload.dueDate) : "On receipt"],
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
    );
  });
}

// ---------------------------------------------------------------------------
// 2) Vehicle handover form
// ---------------------------------------------------------------------------

export interface HandoverPdfExtras {
  salesAdvisorName?: string | null;
  dealerName?: string | null;
  dealerAddress?: string | null;
  customerAddress?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  invoiceNumber?: string | null;
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
  extras: HandoverPdfExtras = {},
): Promise<Buffer> {
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
      if (value) {
        doc
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(INK)
          .text(value, x + lw, y - 1, { width: width - lw, height: 10, ellipsis: true });
      }
      doc
        .moveTo(x + lw, y + 9)
        .lineTo(x + width, y + 9)
        .strokeColor(RULE)
        .lineWidth(0.7)
        .stroke();
      return y + 16;
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
      doc
        .fillColor(INK)
        .font("Helvetica-Bold")
        .fontSize(15)
        .text(extras.dealerName ?? "AURA MOTORS", rightX, 38, {
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
      return 74;
    };

    // ---------------- Page 1 ----------------
    let y = pageHeader();

    // Customer details (left)
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("CUSTOMER DETAILS", M, y);
    let ly = y + 14;
    ly = fieldLine("CUSTOMER NAME:", delivery.customerName ?? "", M, ly, colW, 82);
    ly = fieldLine("ADDRESS:", extras.customerAddress ?? "", M, ly, colW, 50);
    ly = fieldLine("", "", M, ly, colW, 0);
    ly = fieldLine("EMAIL ADDRESS:", extras.customerEmail ?? "", M, ly, colW, 80);
    ly = fieldLine("TEL NOS.:", extras.customerPhone ?? "", M, ly, colW, 48);

    // Salesperson / date / invoice (right)
    let ry = y + 14;
    ry = fieldLine(
      "SALESPERSON:",
      extras.salesAdvisorName ?? advisorName ?? "",
      rightX,
      ry,
      colW,
      74,
    );
    ry = fieldLine(
      "DATE:",
      fmtDate(delivery.deliveredAt ?? delivery.appointmentAt ?? new Date()),
      rightX,
      ry,
      colW,
      34,
    );
    ry = fieldLine("INVOICE#", extras.invoiceNumber ?? "", rightX, ry, colW, 48);

    y = Math.max(ly, ry) + 6;

    // Vehicle details (left, two mini-columns)
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("VEHICLE DETAILS", M, y);
    y += 14;
    const halfCol = (colW - 12) / 2;
    let vy = fieldLine("MAKE:", vehicle?.make ?? "", M, y, halfCol, 34);
    fieldLine("MODEL:", vehicle?.model ?? "", M + halfCol + 12, y, halfCol, 40);
    let vy2 = fieldLine(
      "REGISTRATION#",
      delivery.registrationNumber ?? "",
      M,
      vy,
      halfCol,
      74,
    );
    fieldLine("VIN:", vehicle?.vin ?? "", M + halfCol + 12, vy, halfCol, 26);
    const vy3 = fieldLine("KEY #", "", M, vy2, halfCol, 32);
    fieldLine("MILEAGE:", "", M + halfCol + 12, vy2, halfCol, 48);
    y = fieldLine(
      "STOCK#",
      vehicle ? `V-${String(vehicle.id).padStart(5, "0")}` : "",
      M,
      vy3,
      halfCol,
      40,
    );
    y += 4;

    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text("EXPLAIN AND/OR DEMONSTRATE", M, y);
    y += 18;

    // Checklists — left column continues from here; right column starts at the
    // same height as the vehicle details block for visual balance.
    let leftY = y;
    for (const [title, items] of HANDOVER_LEFT_SECTIONS) {
      leftY = checklist(title, items, M, leftY);
    }
    let rightY = ry + 10;
    for (const [title, items] of HANDOVER_RIGHT_SECTIONS) {
      rightY = checklist(title, items, rightX, rightY);
    }

    // ---------------- Page 2 ----------------
    doc.addPage();
    y = pageHeader();

    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("CUSTOMER DETAILS", M, y);
    let p2y = y + 14;
    p2y = fieldLine("CUSTOMER NAME:", delivery.customerName ?? "", M, p2y, colW, 82);
    p2y = fieldLine("ADDRESS:", extras.customerAddress ?? "", M, p2y, colW, 50);
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
): Promise<Buffer> {
  return collect((doc) => {
    const kind = plan.type === "amc" ? "AMC" : "WARRANTY";
    let y = header(doc, `${kind} CERTIFICATE`, [
      `Certificate #CP-${String(plan.id).padStart(5, "0")}`,
      `Issued ${fmtDate(plan.createdAt)}`,
    ]);

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
        ["Valid from", fmtDate(plan.startDate)],
        ["Valid until", fmtDate(plan.endDate)],
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
    );
  });
}

// ---------------------------------------------------------------------------
// 4) Service invoice
// ---------------------------------------------------------------------------

export function buildServiceInvoicePdf(
  invoice: ServiceInvoice,
  exchangeRate: number,
): Promise<Buffer> {
  return collect((doc) => {
    let y = header(doc, "SERVICE INVOICE", [
      `Invoice #SV-${String(invoice.id).padStart(5, "0")}`,
      `Issued ${fmtDate(invoice.createdAt)}`,
      `Status ${invoice.status.toUpperCase()}`,
    ]);

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

    const lines: [string, number][] = [
      ["Parts & consumables", invoice.partsTotal],
      ["Labour", invoice.laborTotal],
      ["Tax (VAT)", invoice.tax],
    ];
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
    );
  });
}
