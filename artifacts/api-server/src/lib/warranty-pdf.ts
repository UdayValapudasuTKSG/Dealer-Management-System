import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * BYD warranty booklet, autofilled by overlaying data onto the dealership's
 * actual PDF template (assets/warranty/byd-warranty-booklet.pdf). The
 * "Vehicle Warranty Certificate" is the booklet's page 5 and is the only
 * page filled.
 */

const TEMPLATE_FILE = "byd-warranty-booklet.pdf";

/** Certificate page index within the booklet. */
const CERT_PAGE = 4;

function templatePath(): string {
  const file = TEMPLATE_FILE;
  // Resolution order: next to the built bundle (build.mjs copies assets/
  // into dist/, and the esbuild banner defines __dirname), then the dev
  // source tree (dev workflow cwd is artifacts/api-server), then the
  // workspace root as a final fallback.
  const candidates = [
    typeof __dirname !== "undefined"
      ? path.join(__dirname, "assets", "warranty", file)
      : null,
    path.join(process.cwd(), "assets", "warranty", file),
    path.join(process.cwd(), "artifacts", "api-server", "assets", "warranty", file),
  ].filter((p): p is string => p !== null);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error(`Warranty template not found: ${file}`);
}

export interface WarrantyFillData {
  ownerName?: string | null;
  ownerEmail?: string | null;
  /** Address + contact of owner (single line). */
  ownerAddressContact?: string | null;
  vehicleModel?: string | null;
  color?: string | null;
  odometer?: string | null;
  manufactureYear?: string | null;
  vin?: string | null;
  motorNumber?: string | null;
  dealerName?: string | null;
  servicePhone?: string | null;
  dealerAddress?: string | null;
  dateOfSale?: string | null;
  invoiceNumber?: string | null;
  dateOfDelivery?: string | null;
  emergencyContact?: string | null;
  /** Customer signature as a data URL (image/png or image/jpeg). */
  signatureDataUrl?: string | null;
}

const INK = rgb(0.08, 0.1, 0.42);

export async function buildWarrantyPdf(
  data: WarrantyFillData,
): Promise<Buffer> {
  const bytes = fs.readFileSync(templatePath());
  const pdf = await PDFDocument.load(bytes);
  const page = pdf.getPage(CERT_PAGE);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Page is 612 x 437 pt (landscape half-letter). Coordinates were measured
  // against the template's field labels (pdftotext -bbox), y flipped to
  // PDF-space (origin bottom-left).
  const put = (
    text: string | null | undefined,
    x: number,
    y: number,
    size = 8,
    maxWidth?: number,
  ) => {
    if (!text) return;
    let t = text;
    if (maxWidth) {
      while (t.length > 1 && font.widthOfTextAtSize(t, size) > maxWidth)
        t = t.slice(0, -1);
    }
    page.drawText(t, { x, y, size, font, color: INK });
  };

  put(data.ownerName, 185, 349, 8, 165);
  put(data.ownerEmail, 428, 349, 8, 178);
  put(data.ownerAddressContact, 243, 329.5, 8, 360);
  put(data.vehicleModel, 322, 306, 8, 105);
  put(data.color, 561, 306, 7, 48);
  // Purpose of vehicle — tick "Personal" (the □ before "Personal").
  page.drawText("X", { x: 157.1, y: 282.6, size: 8.5, font: bold, color: INK });
  put(data.odometer, 505, 277, 8, 100);
  put(data.manufactureYear, 536, 263, 8, 70);
  put(data.vin, 226, 252.5, 8, 145);
  put(data.motorNumber, 443, 252.5, 8, 160);
  put(data.dealerName, 191, 207.8, 8, 95);
  put(data.servicePhone, 312, 207.8, 8, 130);
  put(data.dealerAddress, 118, 182.7, 7, 135);
  put(data.dateOfSale, 133, 163.2, 8, 118);
  put(data.invoiceNumber, 312, 163.2, 8, 130);
  put(data.dateOfDelivery, 148, 143.7, 8, 105);
  put(data.emergencyContact, 170, 124.2, 8, 200);

  // Customer signature — drawn in the "Customer signature:" cell.
  if (data.signatureDataUrl?.startsWith("data:image/")) {
    try {
      const base64 = data.signatureDataUrl.split(",")[1] ?? "";
      const imgBytes = Buffer.from(base64, "base64");
      const img = data.signatureDataUrl.startsWith("data:image/png")
        ? await pdf.embedPng(imgBytes)
        : await pdf.embedJpg(imgBytes);
      const maxW = 110;
      const maxH = 26;
      const scale = Math.min(maxW / img.width, maxH / img.height);
      page.drawImage(img, {
        x: 345,
        y: 133,
        width: img.width * scale,
        height: img.height * scale,
      });
    } catch {
      // A malformed signature image must never block the document download.
    }
  }

  return Buffer.from(await pdf.save());
}
