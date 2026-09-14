/**
 * DB-free regression checks for the quote PDF renderer.
 *
 * This intentionally exercises the renderer with the same string payload shape
 * used by quotePdfPayload.  It writes the stress cases to /tmp so a reviewer
 * can inspect the actual pages without needing a database or a running server.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildQuotePdf, type QuotePdfData } from "../lib/quote-pdf";

const OUT_DIR = "/tmp/quote-pdf-regression";
const TIMEZONE = "America/Guyana";
const DUTIES_NOTICE =
  "* Price can be subject to Change due to Duties and Taxes";
const ADVISOR =
  "Alexandra Penelope Montgomery-Smythe-Worthington";
const QUOTE_REF = "EST-00433-R5";
const ISSUED_ON = "2026-09-13";
const VALID_UNTIL = "2026-10-13";
const DATE_TEXT = "09/13/2026";
const EXPIRATION_TEXT = "10/13/2026";
const TOTAL_TEXT = "5,699,000.00";
const MODEL_TEXT = "BYD YUAN PRO";
const MODEL_SOURCE_TEXT = "YUAN PRO";
const VARIANT_TEXT = "GS 410KM NEDC";
const COLOR_TEXT = "OBSIDIAN BLACK";

type PdfBlock = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

type PdfPage = {
  width: number;
  height: number;
  text: string;
  blocks: PdfBlock[];
};

type ExtractedPdf = {
  pages: PdfPage[];
};

const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

function extractWithFitz(pdfPath: string): ExtractedPdf {
  const python = String.raw`
import json
import sys
import fitz

document = fitz.open(sys.argv[1])
pages = []
for page in document:
    blocks = []
    for block in page.get_text("blocks"):
        if len(block) < 5:
            continue
        text = " ".join(str(block[4]).split())
        if not text:
            continue
        blocks.append({
            "text": text,
            "x0": float(block[0]),
            "y0": float(block[1]),
            "x1": float(block[2]),
            "y1": float(block[3]),
        })
    pages.append({
        "width": float(page.rect.width),
        "height": float(page.rect.height),
        "text": page.get_text(),
        "blocks": blocks,
    })
print(json.dumps({"pages": pages}))
`;
  const output = execFileSync("python3", ["-c", python, pdfPath], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(output) as ExtractedPdf;
}

function extractWithPdftotext(pdfPath: string): ExtractedPdf {
  const output = execFileSync("pdftotext", [pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const pages = output.split("\f").filter((page, index, all) =>
    index < all.length - 1 || page.trim(),
  );
  return {
    pages: pages.map((text) => ({
      width: 595.28,
      height: 841.89,
      text,
      blocks: [],
    })),
  };
}

function extractPdf(pdf: Buffer, fileName: string): ExtractedPdf {
  const path = join(OUT_DIR, fileName);
  writeFileSync(path, pdf);
  try {
    return extractWithFitz(path);
  } catch (fitzError) {
    try {
      return extractWithPdftotext(path);
    } catch (textError) {
      throw new Error(
        `Neither Python fitz nor pdftotext could extract ${path}: ` +
          `${String(fitzError)}; ${String(textError)}`,
      );
    }
  }
}

function allText(pdf: ExtractedPdf): string {
  return normalizeText(pdf.pages.map((page) => page.text).join("\n"));
}

function requireText(pdf: ExtractedPdf, expected: string, context: string): void {
  assert.ok(
    allText(pdf).includes(expected),
    `${context}: extracted PDF did not contain ${JSON.stringify(expected)}`,
  );
}

function requireAbsent(pdf: ExtractedPdf, unexpected: string, context: string): void {
  assert.ok(
    !allText(pdf).includes(unexpected),
    `${context}: extracted PDF unexpectedly contained ${JSON.stringify(unexpected)}`,
  );
}

function assertCommonText(pdf: ExtractedPdf, context: string): void {
  requireText(pdf, QUOTE_REF, `${context} quote reference`);
  requireText(pdf, DATE_TEXT, `${context} issue date`);
  requireText(pdf, EXPIRATION_TEXT, `${context} expiration date`);
  requireText(pdf, TOTAL_TEXT, `${context} money`);
  requireText(pdf, `GYD ${TOTAL_TEXT}`, `${context} GYD total`);
  requireText(pdf, DUTIES_NOTICE, `${context} duties notice`);
}

function assertLayout(pdf: ExtractedPdf, context: string): void {
  for (const [pageIndex, page] of pdf.pages.entries()) {
    const footerText = `Page ${pageIndex + 1} of ${pdf.pages.length}`;
    requireText({ pages: [page] }, footerText, `${context} footer`);
    if (!page.blocks.length) continue;

    const footerBlocks = page.blocks.filter(
      (block) => normalizeText(block.text) === footerText,
    );
    assert.equal(
      footerBlocks.length,
      1,
      `${context} page ${pageIndex + 1}: expected one ${footerText} footer block`,
    );
    const footer = footerBlocks[0]!;
    assert.ok(
      footer.y0 >= page.height - 80,
      `${context} page ${pageIndex + 1}: footer is not near the bottom`,
    );

    for (const block of page.blocks) {
      assert.ok(
        block.x0 >= -1 &&
          block.y0 >= -1 &&
          block.x1 <= page.width + 1 &&
          block.y1 <= page.height + 1,
        `${context} page ${pageIndex + 1}: text block is outside the page`,
      );
      if (block === footer) continue;
      assert.ok(
        block.y1 <= footer.y0 + 1,
        `${context} page ${pageIndex + 1}: content collides with the footer (${JSON.stringify(block.text)})`,
      );
    }

    // Text blocks should not overlap one another.  Ignore a one-point edge
    // touch, which is common when adjacent table rows share a baseline.
    for (let i = 0; i < page.blocks.length; i++) {
      for (let j = i + 1; j < page.blocks.length; j++) {
        const left = page.blocks[i]!;
        const right = page.blocks[j]!;
        const horizontal = Math.min(left.x1, right.x1) - Math.max(left.x0, right.x0);
        const vertical = Math.min(left.y1, right.y1) - Math.max(left.y0, right.y0);
        assert.ok(
          horizontal <= 1 || vertical <= 1,
          `${context} page ${pageIndex + 1}: overlapping text blocks ` +
            `${JSON.stringify(left.text)} / ${JSON.stringify(right.text)}`,
        );
      }
    }
  }
}

function assertPageCount(pdf: ExtractedPdf, expected: number, context: string): void {
  assert.equal(pdf.pages.length, expected, `${context}: unexpected page count`);
  for (let index = 0; index < expected; index++) {
    requireText(
      { pages: [pdf.pages[index]!] },
      `Page ${index + 1} of ${expected}`,
      `${context} page count footer`,
    );
  }
}

function assertAtLeastOnePage(pdf: ExtractedPdf, context: string): void {
  assert.ok(pdf.pages.length > 0, `${context}: renderer returned no pages`);
  for (let index = 0; index < pdf.pages.length; index++) {
    requireText(
      { pages: [pdf.pages[index]!] },
      `Page ${index + 1} of ${pdf.pages.length}`,
      `${context} page count footer`,
    );
  }
}

function baseData(): QuotePdfData {
  return {
    dealerName: "GT Automotive Inc.",
    dealerAddress: "220 Camp Street, Georgetown, Guyana",
    dealerPhone: "635-0333/712-0555",
    name: "Synthetic Customer",
    address: "24 Akawini Street, Georgetown, Guyana",
    quoteRef: QUOTE_REF,
    issuedOn: ISSUED_ON,
    validUntil: VALID_UNTIL,
    totalGyd: `GYD ${TOTAL_TEXT}`,
    total: TOTAL_TEXT,
    subtotal: TOTAL_TEXT,
    totalTax: "0",
    approvedTreatments: "[]",
  };
}

function canonicalData(): QuotePdfData {
  const items = [
    {
      model: MODEL_SOURCE_TEXT,
      manufacturer: "BYD",
      year: 2026,
      variant: VARIANT_TEXT,
      color: COLOR_TEXT,
      quantity: 1,
      unitPrice: TOTAL_TEXT,
      subtotal: TOTAL_TEXT,
      tax: "0",
      total: TOTAL_TEXT,
    },
    {
      model: "BYDfoo",
      manufacturer: "BYD",
      year: 2026,
      variant: "Urban Studio",
      color: "Pearl White",
      quantity: 1,
      unitPrice: "1000",
      subtotal: "1000",
      tax: "0",
      total: "1000",
    },
    ...Array.from({ length: 10 }, (_, offset) => {
      const number = String(offset + 3).padStart(2, "0");
      return {
        model: `Long Specification Model ${number}`,
        manufacturer: "Synthetic Motors",
        year: 2026,
        variant: `Premium Touring Package ${number} with Extended Range`,
        color: "Moonlight Silver Metallic",
        quantity: 1,
        unitPrice: "1000",
        subtotal: "1000",
        tax: "0",
        total: "1000",
      };
    }),
  ];

  return {
    ...baseData(),
    salesAdvisorName: ADVISOR,
    quoteItems: JSON.stringify(items),
  };
}

function legacyData(): QuotePdfData {
  return {
    ...baseData(),
    manufacturer: "BYD",
    vehicle: MODEL_SOURCE_TEXT,
    model: MODEL_SOURCE_TEXT,
    modelYear: "2026",
    version: VARIANT_TEXT,
    color: COLOR_TEXT,
    quantity: "1",
    unitPrice: TOTAL_TEXT,
  };
}

function longPretableData(): QuotePdfData {
  const addressFields = Array.from(
    { length: 8 },
    (_, index) =>
      `ADDRESS-FIELD-${String(index + 1).padStart(2, "0")} ` +
      "with a complete customer street and neighborhood description",
  );
  return {
    ...baseData(),
    dealerName:
      "AURA Georgetown Dealer Name With A Wrapped Brand Fallback",
    dealerAddress: [
      "Dealer address line one with a long location description",
      "Dealer address line two with a long location description",
      "Dealer address line three with a long location description",
      "Dealer address line four with a long location description",
    ].join(", "),
    dealerTin: "TIN-LONG-PRETABLE-1234567890",
    dealerPhone: "PHONE-LONG-PRETABLE-635-0333-712-0555",
    dealerEmail: "long-pretable-dealer-contact@example-dealer.test",
    name:
      "Customer Name With A Complete Long Name That Must Wrap Safely",
    address: addressFields.join(", "),
    quoteRef: "LONG-ESTIMATE-REFERENCE-300-PRETABLE",
    quoteItems: JSON.stringify([
      {
        model: MODEL_SOURCE_TEXT,
        manufacturer: "BYD",
        year: 2026,
        variant: VARIANT_TEXT,
        color: COLOR_TEXT,
        quantity: 1,
        total: TOTAL_TEXT,
      },
    ]),
  };
}

function tinyAttachmentPng(): Buffer {
  // A valid 1x1 PNG keeps the fixture DB-free and deterministic.
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const canonical = canonicalData();
  const canonicalSnapshot = JSON.parse(JSON.stringify(canonical)) as QuotePdfData;
  const canonicalPdf = await buildQuotePdf(canonical, TIMEZONE, null, null);
  assert.deepEqual(canonical, canonicalSnapshot, "canonical input was mutated");
  const canonicalExtracted = extractPdf(canonicalPdf, "canonical-12-items.pdf");
  assertAtLeastOnePage(canonicalExtracted, "canonical 12-item quote");
  assertCommonText(canonicalExtracted, "canonical 12-item quote");
  requireText(canonicalExtracted, MODEL_TEXT, "canonical complete model");
  requireText(canonicalExtracted, VARIANT_TEXT, "canonical complete variant");
  requireText(canonicalExtracted, COLOR_TEXT, "canonical complete color");
  requireText(canonicalExtracted, "Year: 2026", "canonical complete year");
  requireText(
    canonicalExtracted,
    "BYD BYDfoo",
    "canonical BYDfoo model must remain a legitimate model token",
  );
  requireAbsent(
    canonicalExtracted,
    "BYD BYD YUAN",
    "canonical leading BYD token must be deduplicated",
  );
  requireAbsent(
    canonicalExtracted,
    "BYD YUAN PRO GS 410KM",
    "canonical variant must remain a separate labelled field",
  );
  requireText(
    canonicalExtracted,
    "Long Specification Model 11",
    "canonical penultimate item",
  );
  requireText(
    canonicalExtracted,
    "Long Specification Model 12",
    "canonical final item",
  );
  requireText(canonicalExtracted, ADVISOR, "canonical long advisor name");
  assertLayout(canonicalExtracted, "canonical 12-item quote");

  const legacy = legacyData();
  const legacySnapshot = JSON.parse(JSON.stringify(legacy)) as QuotePdfData;
  const legacyPdf = await buildQuotePdf(legacy, TIMEZONE);
  assert.deepEqual(legacy, legacySnapshot, "legacy input was mutated");
  const legacyExtracted = extractPdf(legacyPdf, "legacy-no-advisor.pdf");
  assertPageCount(legacyExtracted, 1, "legacy quote");
  assertCommonText(legacyExtracted, "legacy quote");
  requireText(legacyExtracted, MODEL_TEXT, "legacy complete model");
  requireText(legacyExtracted, VARIANT_TEXT, "legacy complete variant");
  requireText(legacyExtracted, COLOR_TEXT, "legacy complete color");
  requireText(legacyExtracted, "Year: 2026", "legacy complete year");
  requireAbsent(legacyExtracted, ADVISOR, "legacy absent advisor");
  requireAbsent(
    legacyExtracted,
    "BYD BYD YUAN",
    "legacy leading BYD token must be deduplicated",
  );
  requireAbsent(
    legacyExtracted,
    "BYD YUAN PRO GS 410KM",
    "legacy variant must remain a separate labelled field",
  );
  assertLayout(legacyExtracted, "legacy quote");

  const longPretable = longPretableData();
  const longPretableSnapshot = JSON.parse(
    JSON.stringify(longPretable),
  ) as QuotePdfData;
  // Invalid logo bytes exercise the fallback brand layout: its wrapped dealer
  // name must reserve the same pre-table space as a successfully decoded logo.
  const longPretablePdf = await buildQuotePdf(
    longPretable,
    TIMEZONE,
    Buffer.from("not-a-decodable-logo"),
  );
  assert.deepEqual(
    longPretable,
    longPretableSnapshot,
    "long pre-table input was mutated",
  );
  const longPretableExtracted = extractPdf(
    longPretablePdf,
    "long-pretable-fields.pdf",
  );
  assertPageCount(longPretableExtracted, 2, "long pre-table fields");
  requireText(
    longPretableExtracted,
    "LONG-ESTIMATE",
    "long pre-table meta reference",
  );
  requireText(
    longPretableExtracted,
    "Customer Name With A Complete Long Name",
    "long pre-table customer name",
  );
  for (let index = 1; index <= 8; index++) {
    requireText(
      longPretableExtracted,
      `ADDRESS-FIELD-${String(index).padStart(2, "0")}`,
      `complete customer address field ${index}`,
    );
  }
  requireText(
    longPretableExtracted,
    "Dealer address line four",
    "complete wrapped dealer address",
  );
  requireText(
    longPretableExtracted,
    "TIN-LONG-PRETABLE",
    "wrapped dealer TIN",
  );
  requireText(
    longPretableExtracted,
    "long-pretable-dealer-contact",
    "wrapped dealer email",
  );
  assertLayout(longPretableExtracted, "long pre-table fields");

  await assert.rejects(
    () =>
      buildQuotePdf(
        {
          ...longPretable,
          name: "Unbounded Customer ".repeat(10_000),
        },
        TIMEZONE,
      ),
    /pre-table fields leave insufficient room/,
    "extreme pre-table customer input should reject before drawing",
  );

  const attachment = {
    data: tinyAttachmentPng(),
    fileName: "synthetic-customer-attachment.png",
  };
  const attachmentInput = canonicalData();
  const attachmentSnapshot = JSON.parse(JSON.stringify(attachmentInput)) as QuotePdfData;
  const attachmentPdf = await buildQuotePdf(
    attachmentInput,
    TIMEZONE,
    null,
    attachment,
  );
  assert.deepEqual(attachmentInput, attachmentSnapshot, "attachment input was mutated");
  const attachmentExtracted = extractPdf(
    attachmentPdf,
    "attachment-with-pages.pdf",
  );
  assertPageCount(
    attachmentExtracted,
    canonicalExtracted.pages.length + 1,
    "quote with attachment",
  );
  assertCommonText(attachmentExtracted, "quote with attachment");
  requireText(
    { pages: [attachmentExtracted.pages[attachmentExtracted.pages.length - 1]!] },
    attachment.fileName,
    "attachment page file name",
  );
  assertLayout(attachmentExtracted, "quote with attachment");

  console.log(
    `Quote PDF regression checks passed. Fixtures written to ${OUT_DIR} ` +
      `(${canonicalExtracted.pages.length} canonical page, ` +
      `${attachmentExtracted.pages.length} attachment pages).`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});