import {
  computeGraDuty,
  missingGraInputs,
  normalizeFuelType,
  type GraDutyBreakdown,
  type GraDutyLine,
  type GraFuelType,
  type GraImporterType,
} from "@workspace/gra-duty";
import { db, dealersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export type GraDraftInputs = {
  cifValue: number;
  engineCc?: number | null;
  fuelType?: string | null;
  year?: number | null; // year of manufacture
  yearOfImport?: number | null;
  importerType?: string | null;
  bodyType?: string | null;
  isHybrid?: boolean | null;
  retailPrice?: number | null;
};

export type GraDutyComputation = {
  taxLines: GraDutyLine[];
  totalPayable: number;
  breakdown: GraDutyBreakdown | null;
  reviewFlags: string[];
  missingInputs: string[];
  isEv: boolean;
};

/**
 * Run the real-GRA-rules duty engine over a (possibly incomplete) filing
 * draft. Incomplete inputs never throw: the result carries `missingInputs`
 * and empty lines so the officer sees exactly what to fill in. Review flags
 * (diesel 1800-2000cc gap, missing trader retail price) block submission and
 * gate approval — never silently computed.
 */
export function computeDraftDuty(
  draft: GraDraftInputs,
  exchangeRate: number,
): GraDutyComputation {
  const fuel = normalizeFuelType(draft.fuelType);
  const isHybrid = draft.isHybrid ?? fuel.isHybrid;
  const isEv = fuel.fuelType === "electric";

  const missing = missingGraInputs({
    cifUsd: draft.cifValue,
    engineCc: draft.engineCc,
    fuelType: fuel.fuelType,
    yearOfManufacture: draft.year,
    yearOfImport: draft.yearOfImport,
    importerType: draft.importerType,
    retailPriceUsd: draft.retailPrice,
    exchangeRate,
  });

  if (missing.length > 0) {
    return {
      taxLines: [],
      totalPayable: 0,
      breakdown: null,
      reviewFlags: [],
      missingInputs: missing,
      isEv,
    };
  }

  const result = computeGraDuty({
    cifUsd: draft.cifValue,
    engineCc: draft.engineCc ?? 0,
    fuelType: fuel.fuelType as GraFuelType,
    yearOfManufacture: draft.year ?? 0,
    yearOfImport: draft.yearOfImport ?? 0,
    importerType: (isEv ? (draft.importerType ?? "private") : draft.importerType) as GraImporterType,
    bodyType: draft.bodyType,
    isHybrid,
    retailPriceUsd: draft.retailPrice,
    exchangeRate,
  });

  return {
    taxLines: result.lines,
    totalPayable: result.totalUsd,
    breakdown: result.breakdown,
    reviewFlags: result.reviewFlags,
    missingInputs: [],
    isEv,
  };
}

/** Dealer's locked GYD-per-USD rate (defaults to 209 like the rest of the app). */
export async function dealerExchangeRate(dealerId: number): Promise<number> {
  const [dealer] = await db
    .select({ usdExchangeRate: dealersTable.usdExchangeRate })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  return dealer?.usdExchangeRate ?? 209;
}
