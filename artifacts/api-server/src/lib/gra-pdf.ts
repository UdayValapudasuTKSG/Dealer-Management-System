import PDFDocument from "pdfkit";
import type { GraFiling } from "@workspace/db";
import { formatDealerDateTime } from "./timezone";

/**
 * GRA IMPORT DUTY PACK (R8.7) — Guyana Revenue Authority duty filing PDF.
 * Every figure on this document is either human-confirmed (vehicle identity,
 * CIF) or server-computed from dealer_taxes at the snapshotted exchange rate.
 * Nothing on this page is AI-generated.
 */
export type GraPdfContext = {
  dealerName: string;
  timezone: string;
  divisionName?: string | null;
  dealerAddress?: string | null;
  dealerTin?: string | null;
  gateResolvedBy?: string | null;
  gateResolution?: string | null;
  extractedFieldNotes?: string | null;
};

const usd = (n: number) =>
  `GY$${Math.round(n).toLocaleString("en-US")}`;
const gydFmt = (n: number) =>
  `GY$${Math.round(n).toLocaleString("en-GY", { maximumFractionDigits: 0 })}`;

export function buildGraDutyPackPdf(
  filing: GraFiling,
  ctx: GraPdfContext,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const left = 54;
    const right = pageW - 54;
    const contentW = right - left;
    const rate = filing.exchangeRate;
    const toGyd = (n: number) => n; // amounts already GYD

    const dealerDate = (d: Date | null | undefined) =>
      formatDealerDateTime(d ?? new Date(), ctx.timezone);

    // ---- Header band -------------------------------------------------------
    doc.rect(0, 0, pageW, 118).fill("#0a0a0a");
    doc.rect(0, 118, pageW, 4).fill("#A97142");
    doc
      .fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(24)
      .text(ctx.dealerName, left, 32);
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor("#b3a08c")
      .text(
        [ctx.divisionName, ctx.dealerAddress].filter(Boolean).join("  ·  ") ||
          "AURA DEALERSHIP OPERATING SYSTEM",
        left,
        62,
        { characterSpacing: 1.5 },
      );
    doc
      .font("Helvetica-Bold")
      .fontSize(15)
      .fillColor("#ffffff")
      .text("GRA IMPORT DUTY PACK", left, 32, {
        width: contentW,
        align: "right",
      });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#c9c9c9")
      .text("Guyana Revenue Authority", left, 54, {
        width: contentW,
        align: "right",
      })
      .text(`Filing ${filing.filingRef}`, left, 68, {
        width: contentW,
        align: "right",
      })
      .text(`Filed ${dealerDate(filing.filedAt)} (${ctx.timezone})`, left, 82, {
        width: contentW,
        align: "right",
      });

    let y = 146;

    // ---- Party / entity block ---------------------------------------------
    const block = (title: string, rows: [string, string][], x: number, w: number) => {
      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor("#A97142")
        .text(title.toUpperCase(), x, y, { characterSpacing: 1.5 });
      let yy = y + 14;
      for (const [k, v] of rows) {
        doc.font("Helvetica").fontSize(8.5).fillColor("#777777").text(k, x, yy);
        doc
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor("#1a1a1a")
          .text(v || "—", x + 92, yy, { width: w - 96 });
        yy += 15;
      }
      return yy;
    };

    const colW = contentW / 2 - 10;
    const yLeft = block(
      "Importer & Dealer",
      [
        ["Importer", filing.ownerName],
        ["Importer TIN", filing.tin],
        ["Dealer", ctx.dealerName],
        ["Dealer TIN", ctx.dealerTin ?? "On file with GRA"],
        ["Division", ctx.divisionName ?? "—"],
      ],
      left,
      colW,
    );
    const yRight = block(
      "Vehicle (human-confirmed)",
      [
        ["Vehicle", `${filing.year} ${filing.make} ${filing.model}`],
        ["Chassis / VIN", filing.vin],
        ["Engine", `${filing.engineCc.toLocaleString()} cc ${filing.fuelType}`],
        ["HS Code", filing.hsCode],
        ["CIF Value", gydFmt(filing.cifValue)],
        ...(filing.fobValue != null &&
        filing.freightValue != null &&
        filing.insuranceValue != null
          ? ([
              [
                "CIF Breakdown",
                `FOB ${usd(filing.fobValue)} + Frt ${usd(filing.freightValue)} + Ins ${usd(filing.insuranceValue)}`,
              ],
            ] as [string, string][])
          : []),
      ],
      left + colW + 20,
      colW,
    );
    y = Math.max(yLeft, yRight) + 10;

    // ---- Extracted fields note ----------------------------------------------
    doc.rect(left, y, contentW, 30).fill("#f6f1ea");
    doc
      .font("Helvetica")
      .fontSize(7.8)
      .fillColor("#6b543c")
      .text(
        `AI transcription covered legible fields only (make/model/year/CIF/engine/fuel${filing.fieldConfidence && Object.keys(filing.fieldConfidence).length > 0 ? ` — confidence: ${Object.entries(filing.fieldConfidence).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ")}` : ""}); TIN, VIN, owner and HS code were keyed by staff${filing.sourceDocIds && filing.sourceDocIds.length > 0 ? ` from source document(s) #${filing.sourceDocIds.join(", #")}` : ""}. All figures were human-confirmed at the gra_filing gate before this pack was generated.${ctx.extractedFieldNotes ? ` Review notes: ${ctx.extractedFieldNotes}` : ""}`,
        left + 10,
        y + 7,
        { width: contentW - 20 },
      );
    y += 44;

    // ---- Tax / duty lines ----------------------------------------------------
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor("#A97142")
      .text("DUTY & TAX ASSESSMENT — SERVER-COMPUTED FROM THE DEALER'S GRA TAX RULES", left, y, {
        characterSpacing: 1.2,
      });
    y += 16;

    // Rule-path summary from the immutable breakdown snapshot (real GRA rules).
    const bd = filing.breakdown;
    if (bd) {
      const importerLabel =
        bd.importerType === "dealer_used"
          ? "Dealer (used vehicle)"
          : bd.importerType === "new_vehicle_trader"
            ? "New-vehicle trader"
            : "Private individual";
      const parts = [
        `Age category: ${bd.ageCategory === "under_4" ? "Under 4 years" : "4 years & older"}`,
        `Band: ${bd.ccBand}`,
        `Importer: ${importerLabel}`,
        bd.exciseBaseUsd != null ? `Excise base: ${usd(bd.exciseBaseUsd)}` : null,
        `Formula: ${bd.formulaPath}`,
        bd.exemptionApplied ? `VAT exemption: ${bd.exemptionApplied}` : null,
      ].filter(Boolean);
      doc.rect(left, y, contentW, 26).fill("#f7f5f2");
      doc
        .font("Helvetica")
        .fontSize(7.6)
        .fillColor("#4a4a4a")
        .text(parts.join("   ·   "), left + 8, y + 6, { width: contentW - 16 });
      y += 32;
    }

    // Table header
    doc.rect(left, y, contentW, 20).fill("#0a0a0a");
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#ffffff");
    const cols = [
      { label: "LINE", x: left + 8, w: 170, align: "left" as const },
      { label: "BASIS", x: left + 182, w: 90, align: "left" as const },
      { label: "RATE", x: left + 276, w: 60, align: "right" as const },
      { label: "AMOUNT (GYD)", x: left + 340, w: 70, align: "right" as const },
      { label: "AMOUNT (GYD)", x: left + 414, w: contentW - 422, align: "right" as const },
    ];
    for (const c of cols) doc.text(c.label, c.x, y + 6, { width: c.w, align: c.align });
    y += 20;

    const row = (
      name: string,
      basis: string,
      rateLabel: string,
      amount: number,
      shade: boolean,
    ) => {
      if (shade) doc.rect(left, y, contentW, 18).fill("#f7f5f2");
      doc.font("Helvetica").fontSize(8.5).fillColor("#1a1a1a");
      doc.text(name, cols[0].x, y + 5, { width: cols[0].w });
      doc.fillColor("#666666").text(basis, cols[1].x, y + 5, { width: cols[1].w });
      doc.fillColor("#666666").text(rateLabel, cols[2].x, y + 5, { width: cols[2].w, align: "right" });
      doc.fillColor("#1a1a1a").text(usd(amount), cols[3].x, y + 5, { width: cols[3].w, align: "right" });
      doc
        .font("Helvetica-Bold")
        .text(gydFmt(toGyd(amount)), cols[4].x, y + 5, { width: cols[4].w, align: "right" });
      y += 18;
    };

    const basisFor = (l: (typeof filing.taxLines)[number]): string => {
      if (l.basis) return l.basis;
      if (l.kind === "fixed") return "Flat fee";
      const code = l.code.toLowerCase();
      if (code.includes("excise")) return "CIF + duty";
      if (code.includes("vat")) return "CIF + duty + excise";
      return "CIF value";
    };
    filing.taxLines.forEach((l, i) => {
      row(
        l.name,
        basisFor(l),
        l.kind === "percent" ? `${l.rate}%` : "flat",
        l.amount,
        i % 2 === 1,
      );
    });
    if (filing.evExcluded) {
      doc.rect(left, y, contentW, 18).fill("#eef6ef");
      doc
        .font("Helvetica-Oblique")
        .fontSize(8)
        .fillColor("#2f6b3a")
        .text(
          "Electric vehicle — duty/excise/VAT lines flagged excludeEv were skipped per Guyana EV exclusions.",
          left + 8,
          y + 5,
          { width: contentW - 16 },
        );
      y += 18;
    }
    y += 8;

    // ---- Totals block ---------------------------------------------------------
    const totalsX = left + contentW - 250;
    const totalRow = (k: string, vUsd: string, vGyd: string, bold = false) => {
      doc
        .font(bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(bold ? 10.5 : 8.5)
        .fillColor(bold ? "#0a0a0a" : "#555555")
        .text(k, totalsX, y, { width: 110 });
      doc.text(vUsd, totalsX + 100, y, { width: 70, align: "right" });
      doc.text(vGyd, totalsX + 172, y, { width: 78, align: "right" });
      y += bold ? 20 : 15;
    };
    totalRow("CIF value", gydFmt(filing.cifValue), "");
    totalRow(
      "Total duty & levies",
      usd(filing.totalPayable),
      gydFmt(toGyd(filing.totalPayable)),
    );
    doc
      .moveTo(totalsX, y + 2)
      .lineTo(right, y + 2)
      .lineWidth(1)
      .strokeColor("#A97142")
      .stroke();
    y += 8;
    totalRow(
      "TOTAL PAYABLE TO GRA",
      usd(filing.totalPayable),
      gydFmt(toGyd(filing.totalPayable)),
      true,
    );

    // ---- Footer -----------------------------------------------------------------
    const footY = doc.page.height - 96;
    doc.rect(0, footY - 12, pageW, 108).fill("#f4f0ea");
    doc
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .fillColor("#6b543c")
      .text("PROVENANCE & DECLARATION", left, footY, { characterSpacing: 1.5 });
    doc
      .font("Helvetica")
      .fontSize(7.8)
      .fillColor("#4a4a4a")
      .text(
        [
          `Duty lines server-computed from the GRA rule set (age bands, fuel/cc excise bands, importer-type bases, 14% VAT); AI-extracted fields human-confirmed. Nothing on this document was AI-generated.`,
          `Gate #${filing.gateId} resolved by ${ctx.gateResolvedBy ?? filing.filedBy ?? "officer"}${ctx.gateResolution ? ` — "${ctx.gateResolution}"` : ""}.`,
          `Filed by ${filing.filedBy ?? "—"} on ${dealerDate(filing.filedAt)} (${ctx.timezone}).`,
          `Exchange rate snapshot: US$1 = GY$${rate} (locked at submission; later rate changes do not alter this filing).`,
        ].join("\n"),
        left,
        footY + 13,
        { width: contentW, lineGap: 2.5 },
      );

    doc.end();
  });
}
