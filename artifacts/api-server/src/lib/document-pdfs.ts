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
 * warranty / AMC certificate and service invoice. All amounts stored in the
 * system are USD-scale; GYD is display-only via the snapshot / dealer rate.
 */

const LEFT = 54;

const usd = (n: number) =>
  `US$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const gyd = (n: number, rate: number) =>
  `GY$${Math.round(n * rate).toLocaleString("en-US")}`;
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
    const rate = receipt.exchangeRate ?? 209;
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
      .text(gyd(receipt.amount, rate), LEFT, y + 16, {
        width: contentW,
        align: "center",
      });
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor("#777777")
      .text(
        `${usd(receipt.amount)} · ${receipt.currency ?? "USD"} @ rate ${rate.toLocaleString("en-US")} (snapshot at issue)`,
        LEFT,
        y + 48,
        { width: contentW, align: "center" },
      );
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
        "This receipt confirms funds received against the invoice above. Amounts are recorded in USD with the " +
          "Guyana-dollar equivalent shown at the exchange rate snapshotted when the receipt was issued.",
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
    const rate = Number(payload.exchangeRate) || 209;
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
      .text(gyd(amount, rate), LEFT, y + 16, {
        width: contentW,
        align: "center",
      });
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor("#777777")
      .text(
        `${usd(amount)} · USD @ rate ${rate.toLocaleString("en-US")} (snapshot at issue)`,
        LEFT,
        y + 48,
        { width: contentW, align: "center" },
      );
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
        rows.push([line.label, usd(line.amount)]);
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
        "Amounts are recorded in USD with the Guyana-dollar equivalent shown at the exchange rate snapshotted " +
          "when the invoice was issued. Your advisor is available for any question about this invoice.",
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

export function buildHandoverPdf(
  delivery: Delivery,
  vehicle: Vehicle | undefined,
  advisorName: string | null,
): Promise<Buffer> {
  return collect((doc) => {
    let y = header(doc, "VEHICLE HANDOVER FORM", [
      `Delivery #${delivery.id}`,
      `Date ${fmtDate(delivery.completedAt ?? delivery.appointmentAt ?? new Date())}`,
    ]);

    y = sectionLabel(doc, "CUSTOMER", y);
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#111111")
      .text(delivery.customerName ?? "Customer", LEFT, y);
    y += 30;

    y = sectionLabel(doc, "VEHICLE", y);
    y = detailRows(
      doc,
      [
        [
          "Vehicle",
          vehicle
            ? `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""}`
            : `Vehicle #${delivery.vehicleId}`,
        ],
        ["VIN", vehicle?.vin ?? "—"],
        ["Engine no.", vehicle?.engineNumber ?? "—"],
        ["Colour", vehicle?.exteriorColor ?? "—"],
        ["Registration plate", delivery.registrationNumber ?? "Pending"],
        [
          "Insurance",
          delivery.insurancePolicy
            ? `${delivery.insurancePolicy}${delivery.insuranceProvider ? ` (${delivery.insuranceProvider})` : ""}`
            : "Pending",
        ],
        [
          "Accessories",
          vehicle && vehicle.accessories.length > 0
            ? vehicle.accessories.join(", ")
            : "None recorded",
        ],
        ["Expected delivery", fmtDate(delivery.appointmentAt ?? null)],
        ["Actual delivery", fmtDate(delivery.deliveredAt ?? null)],
        ["Delivery advisor", advisorName ?? "—"],
      ],
      y,
    );

    // PDI summary (tri-state: pass / fail / waived with reason)
    const items = delivery.pdiItems ?? [];
    const done = items.filter(
      (i) => i.status === "pass" || i.status === "waived",
    ).length;
    y = sectionLabel(doc, "PRE-DELIVERY INSPECTION", y);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#111111")
      .text(
        items.length > 0
          ? `${done} of ${items.length} checks passed or waived`
          : "No PDI checklist recorded",
        LEFT,
        y,
      );
    y += 18;
    const pdiMark: Record<string, string> = {
      pass: "[PASS]",
      fail: "[FAIL]",
      waived: "[WAIVED]",
      pending: "[ ]",
    };
    for (const item of items) {
      const suffix =
        item.status === "waived" && item.waiveReason
          ? ` — waived: ${item.waiveReason}`
          : item.note
            ? ` — ${item.note}`
            : "";
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(
          item.status === "fail"
            ? "#b30f16"
            : item.status === "pending"
              ? "#999999"
              : "#333333",
        )
        .text(
          `${pdiMark[item.status] ?? "[ ]"}  ${item.label}${suffix}`,
          LEFT + 12,
          y,
        );
      y += 14;
    }
    y += 16;

    // Acknowledgement + signature
    y = sectionLabel(doc, "ACKNOWLEDGEMENT", y);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#555555")
      .text(
        "I confirm that I have received the vehicle described above, together with all keys, documents and " +
          "accessories, in the condition recorded by the pre-delivery inspection.",
        LEFT,
        y,
        { width: doc.page.width - LEFT * 2, lineGap: 2 },
      );
    y += 44;

    const half = (doc.page.width - LEFT * 2 - 30) / 2;
    if (delivery.signatureData?.startsWith("data:image")) {
      try {
        const b64 = delivery.signatureData.split(",")[1] ?? "";
        doc.image(Buffer.from(b64, "base64"), LEFT, y, {
          fit: [half, 50],
        });
      } catch {
        /* unreadable signature payload — leave the line blank */
      }
    }
    y += 54;
    doc
      .moveTo(LEFT, y)
      .lineTo(LEFT + half, y)
      .strokeColor("#999999")
      .lineWidth(1)
      .stroke();
    doc
      .moveTo(LEFT + half + 30, y)
      .lineTo(doc.page.width - LEFT, y)
      .stroke();
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor("#777777")
      .text(
        `Customer signature${delivery.signatureName ? ` — ${delivery.signatureName}` : ""}`,
        LEFT,
        y + 6,
        { width: half },
      )
      .text("Delivery advisor", LEFT + half + 30, y + 6, { width: half });

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
        .text(gyd(amount, exchangeRate), colAmt, y + 8, {
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
      .text(gyd(invoice.total, exchangeRate), colAmt - 90, y - 2, {
        width: 200 - 12,
        align: "right",
      });
    y += 24;
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#777777")
      .text(`${usd(invoice.total)} @ rate ${exchangeRate.toLocaleString("en-US")}`, colAmt - 90, y, {
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
