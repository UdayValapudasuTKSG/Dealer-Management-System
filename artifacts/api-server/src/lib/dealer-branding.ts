import { eq } from "drizzle-orm";
import { db, dealersTable } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

/**
 * White-label branding used by printable documents (invoices, quotes,
 * receipts, certificates, handover forms). `displayName` is the GM-configured
 * brand name (falls back to the dealer's registered name); `logo` holds the
 * uploaded logo bytes when one is configured and readable — PDF builders fall
 * back to the default AURA wordmark when either is missing.
 */
export type PdfBranding = {
  displayName: string | null;
  logo: Buffer | null;
};

const objectStorage = new ObjectStorageService();

export async function getDealerPdfBranding(
  dealerId: number | null | undefined,
): Promise<PdfBranding> {
  if (!dealerId) return { displayName: null, logo: null };
  const [dealer] = await db
    .select({
      name: dealersTable.name,
      brandName: dealersTable.brandName,
      logoUrl: dealersTable.logoUrl,
    })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId))
    .limit(1);
  if (!dealer) return { displayName: null, logo: null };

  let logo: Buffer | null = null;
  if (dealer.logoUrl) {
    try {
      const file = await objectStorage.getObjectEntityFile(dealer.logoUrl);
      const [bytes] = await file.download();
      logo = bytes;
    } catch (err) {
      // Missing/unreadable logo must never block document generation.
      logger.warn({ err, dealerId }, "dealer logo unavailable for PDF");
    }
  }
  return { displayName: dealer.brandName ?? dealer.name, logo };
}
