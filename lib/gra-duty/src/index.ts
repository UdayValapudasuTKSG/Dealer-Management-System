/**
 * GRA (Guyana Revenue Authority) vehicle import duty engine.
 *
 * Pure and deterministic — implements the real GRA rule set:
 *  - Age category: "under 4 years" when yearOfManufacture >= yearOfImport - 3.
 *  - Electric vehicles: 0% duty, 0% excise, 0% VAT regardless of age.
 *  - Under-4 duty: 35% of CIF at <=1500cc, 45% above. 4+ years: 0% duty, 0% VAT.
 *  - Under-4 excise base by importer type:
 *      private            = CIF + duty
 *      dealer_used        = 1.5 x CIF + duty
 *      new_vehicle_trader = retail price + duty
 *  - Under-4 excise rates by fuel + cc band:
 *      gasoline: <=1500 0% | 1500-2000 10% | 2000-3000 110% | >3000 140%
 *      diesel:   <=1500 0% | 1500-1800 10% | >2000 110%
 *      diesel 1800-2000cc is a published-table gap: flagged for human review,
 *      NEVER silently computed.
 *  - 4+ years excise: GRA flat-rate tables. <=1500cc = flat GY$800,000 (GYD,
 *    converted at the locked exchange rate); larger bands use the GRA formula
 *    (CIF + base) x rate + base with USD bases.
 *  - VAT = 14% x (CIF + duty + excise) for under-4 non-exempt vehicles.
 *    Exemptions effective 16 Feb 2026: double-cab pickups <=2500cc, new
 *    (yearOfManufacture >= yearOfImport) under-4 vehicles <1500cc, hybrids
 *    under 4yr <2000cc.
 *
 * All monetary inputs/outputs are USD-scale except where explicitly GYD.
 * Environmental levy / registration fees are NOT duty items and are never
 * included here.
 */

export const GRA_FUEL_TYPES = ["gasoline", "diesel", "electric"] as const;
export type GraFuelType = (typeof GRA_FUEL_TYPES)[number];

export const GRA_IMPORTER_TYPES = [
  "private",
  "dealer_used",
  "new_vehicle_trader",
] as const;
export type GraImporterType = (typeof GRA_IMPORTER_TYPES)[number];

/** VAT exemptions (double-cab <=2500cc, new <1500cc, hybrid <2000cc) apply from this date. */
export const VAT_EXEMPTIONS_EFFECTIVE = new Date("2026-02-16T00:00:00Z");

export const GRA_VAT_RATE = 0.14;

export type GraDutyInput = {
  /** CIF (cost, insurance & freight) value in USD. */
  cifUsd: number;
  engineCc: number;
  fuelType: GraFuelType;
  yearOfManufacture: number;
  yearOfImport: number;
  importerType: GraImporterType;
  /** e.g. "double_cab_pickup" — drives the double-cab VAT exemption. */
  bodyType?: string | null;
  isHybrid?: boolean | null;
  /** Required for new_vehicle_trader importers (excise base). USD. */
  retailPriceUsd?: number | null;
  /** GYD per USD, locked at submission. */
  exchangeRate: number;
  /** Date used against the Feb 2026 VAT-exemption cutoff (default: now). */
  asOfDate?: Date;
};

export type GraDutyBreakdown = {
  ageCategory: "under_4" | "four_plus";
  ccBand: string;
  importerType: GraImporterType;
  /** USD excise base actually used (null when excise is flat-rate or blocked). */
  exciseBaseUsd: number | null;
  formulaPath: string;
  exemptionApplied: string | null;
  dutyRatePct: number;
  exciseRatePct: number | null;
  vatRatePct: number;
};

export type GraDutyLine = {
  code: "import_duty" | "excise" | "vat";
  name: string;
  kind: "percent" | "fixed";
  rate: number;
  amount: number;
};

export type GraDutyResult = {
  dutyUsd: number;
  exciseUsd: number;
  vatUsd: number;
  totalUsd: number;
  dutyGyd: number;
  exciseGyd: number;
  vatGyd: number;
  totalGyd: number;
  lines: GraDutyLine[];
  breakdown: GraDutyBreakdown;
  /** Human-review blockers, e.g. "diesel_cc_gap_1800_2000", "missing_retail_price". */
  reviewFlags: string[];
};

/** GRA flat-rate excise for 4+ year vehicles <=1500cc — a GYD amount, not USD. */
export const FOUR_PLUS_SMALL_ENGINE_FLAT_GYD = 800_000;

/** 4+ years formula bands: excise = (CIF + base) x rate + base (USD). */
const FOUR_PLUS_GASOLINE_BANDS: { maxCc: number; base: number; rate: number; band: string }[] = [
  { maxCc: 1800, base: 6_000, rate: 0.3, band: "1500-1800cc" },
  { maxCc: 2000, base: 6_500, rate: 0.3, band: "1800-2000cc" },
  { maxCc: 3000, base: 13_500, rate: 0.7, band: "2000-3000cc" },
  { maxCc: Infinity, base: 14_500, rate: 1.0, band: ">3000cc" },
];
const FOUR_PLUS_DIESEL_BANDS: { maxCc: number; base: number; rate: number; band: string }[] = [
  { maxCc: 2000, base: 15_400, rate: 0.3, band: "1500-2000cc" },
  { maxCc: 2500, base: 15_400, rate: 0.7, band: "2000-2500cc" },
  { maxCc: 3000, base: 15_500, rate: 0.7, band: "2500-3000cc" },
  { maxCc: Infinity, base: 17_200, rate: 1.0, band: ">3000cc" },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** True when GRA classifies the vehicle as "under 4 years old". */
export function isUnderFourYears(yearOfManufacture: number, yearOfImport: number): boolean {
  return yearOfManufacture >= yearOfImport - 3;
}

/** Normalize a free-form fuel string ("Petrol", "Hybrid", …) to engine inputs. */
export function normalizeFuelType(
  raw: string | null | undefined,
): { fuelType: GraFuelType | null; isHybrid: boolean } {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return { fuelType: null, isHybrid: false };
  if (s.includes("electric") || s === "ev" || s === "bev")
    return { fuelType: "electric", isHybrid: false };
  if (s.includes("hybrid")) return { fuelType: "gasoline", isHybrid: true };
  if (s.includes("diesel")) return { fuelType: "diesel", isHybrid: false };
  if (s.includes("petrol") || s.includes("gasoline") || s.includes("gas"))
    return { fuelType: "gasoline", isHybrid: false };
  return { fuelType: null, isHybrid: false };
}

/**
 * Validate a partial input set. Returns the machine-readable list of missing
 * required inputs (empty = complete). retailPriceUsd is required only for
 * new_vehicle_trader importers; none of it matters for electric vehicles
 * beyond the fuel type itself.
 */
export function missingGraInputs(input: {
  cifUsd?: number | null;
  engineCc?: number | null;
  fuelType?: string | null;
  yearOfManufacture?: number | null;
  yearOfImport?: number | null;
  importerType?: string | null;
  retailPriceUsd?: number | null;
  exchangeRate?: number | null;
}): string[] {
  const missing: string[] = [];
  const fuel = (input.fuelType ?? "") as string;
  const isElectric = fuel === "electric";
  if (!input.cifUsd || input.cifUsd <= 0) {
    if (!isElectric) missing.push("cifValue");
  }
  if (!fuel || !GRA_FUEL_TYPES.includes(fuel as GraFuelType)) missing.push("fuelType");
  if (isElectric) return missing;
  if (!input.engineCc || input.engineCc <= 0) missing.push("engineCc");
  if (!input.yearOfManufacture) missing.push("yearOfManufacture");
  if (!input.yearOfImport) missing.push("yearOfImport");
  if (
    !input.importerType ||
    !GRA_IMPORTER_TYPES.includes(input.importerType as GraImporterType)
  ) {
    missing.push("importerType");
  } else if (
    input.importerType === "new_vehicle_trader" &&
    (!input.retailPriceUsd || input.retailPriceUsd <= 0)
  ) {
    missing.push("retailPrice");
  }
  if (!input.exchangeRate || input.exchangeRate <= 0) missing.push("exchangeRate");
  return missing;
}

/** Compute GRA duty, excise and VAT from a COMPLETE input set. */
export function computeGraDuty(input: GraDutyInput): GraDutyResult {
  const {
    cifUsd,
    engineCc,
    fuelType,
    yearOfManufacture,
    yearOfImport,
    importerType,
    exchangeRate,
  } = input;
  const isHybrid = input.isHybrid === true;
  const bodyType = (input.bodyType ?? "").trim().toLowerCase();
  const asOf = input.asOfDate ?? new Date();
  const flags: string[] = [];

  const under4 = isUnderFourYears(yearOfManufacture, yearOfImport);
  const ageCategory: GraDutyBreakdown["ageCategory"] = under4 ? "under_4" : "four_plus";

  const finish = (
    duty: number,
    excise: number,
    vat: number,
    breakdown: Omit<GraDutyBreakdown, "importerType" | "ageCategory">,
  ): GraDutyResult => {
    const dutyUsd = round2(duty);
    const exciseUsd = round2(excise);
    const vatUsd = round2(vat);
    const totalUsd = round2(dutyUsd + exciseUsd + vatUsd);
    const lines: GraDutyLine[] = [
      {
        code: "import_duty",
        name: "Import Duty",
        kind: "percent",
        rate: breakdown.dutyRatePct,
        amount: dutyUsd,
      },
      {
        code: "excise",
        name: "Excise Tax",
        kind: breakdown.exciseRatePct == null ? "fixed" : "percent",
        rate: breakdown.exciseRatePct ?? 0,
        amount: exciseUsd,
      },
      {
        code: "vat",
        name: "VAT",
        kind: "percent",
        rate: breakdown.vatRatePct,
        amount: vatUsd,
      },
    ];
    return {
      dutyUsd,
      exciseUsd,
      vatUsd,
      totalUsd,
      dutyGyd: round2(dutyUsd * exchangeRate),
      exciseGyd: round2(exciseUsd * exchangeRate),
      vatGyd: round2(vatUsd * exchangeRate),
      totalGyd: round2(totalUsd * exchangeRate),
      lines,
      breakdown: { ageCategory, importerType, ...breakdown },
      reviewFlags: flags,
    };
  };

  // Electric vehicles: fully zero-rated regardless of age.
  if (fuelType === "electric") {
    return finish(0, 0, 0, {
      ccBand: "electric",
      exciseBaseUsd: null,
      formulaPath: "electric_zero_rated",
      exemptionApplied: "electric_vehicle",
      dutyRatePct: 0,
      exciseRatePct: 0,
      vatRatePct: 0,
    });
  }

  if (under4) {
    const dutyRatePct = engineCc <= 1500 ? 35 : 45;
    const duty = cifUsd * (dutyRatePct / 100);

    // Excise base by importer type.
    let exciseBase: number | null = null;
    if (importerType === "private") exciseBase = cifUsd + duty;
    else if (importerType === "dealer_used") exciseBase = 1.5 * cifUsd + duty;
    else {
      const retail = input.retailPriceUsd ?? 0;
      if (retail > 0) exciseBase = retail + duty;
      else flags.push("missing_retail_price");
    }

    // Excise rate by fuel + cc band.
    let exciseRatePct: number | null = null;
    let ccBand: string;
    if (fuelType === "gasoline") {
      if (engineCc <= 1500) {
        exciseRatePct = 0;
        ccBand = "gasoline <=1500cc";
      } else if (engineCc <= 2000) {
        exciseRatePct = 10;
        ccBand = "gasoline 1500-2000cc";
      } else if (engineCc <= 3000) {
        exciseRatePct = 110;
        ccBand = "gasoline 2000-3000cc";
      } else {
        exciseRatePct = 140;
        ccBand = "gasoline >3000cc";
      }
    } else {
      if (engineCc <= 1500) {
        exciseRatePct = 0;
        ccBand = "diesel <=1500cc";
      } else if (engineCc <= 1800) {
        exciseRatePct = 10;
        ccBand = "diesel 1500-1800cc";
      } else if (engineCc <= 2000) {
        // Published GRA tables have no under-4 diesel 1800-2000cc band —
        // NEVER silently computed; a human must resolve it with GRA.
        ccBand = "diesel 1800-2000cc (no published band)";
        flags.push("diesel_cc_gap_1800_2000");
      } else {
        exciseRatePct = 110;
        ccBand = "diesel >2000cc";
      }
    }

    const exciseBlocked = flags.length > 0;
    const excise =
      !exciseBlocked && exciseBase != null && exciseRatePct != null
        ? exciseBase * (exciseRatePct / 100)
        : 0;

    // VAT exemptions effective 16 Feb 2026.
    let exemption: string | null = null;
    if (asOf.getTime() >= VAT_EXEMPTIONS_EFFECTIVE.getTime()) {
      if (bodyType.includes("double") && bodyType.includes("cab") && engineCc <= 2500) {
        exemption = "double_cab_pickup_2500cc";
      } else if (yearOfManufacture >= yearOfImport && engineCc < 1500) {
        exemption = "new_vehicle_under_1500cc";
      } else if (isHybrid && engineCc < 2000) {
        exemption = "hybrid_under_2000cc";
      }
    }
    const vatRatePct = exemption ? 0 : round2(GRA_VAT_RATE * 100);
    const vat = exciseBlocked || exemption ? 0 : (cifUsd + duty + excise) * GRA_VAT_RATE;

    return finish(duty, excise, vat, {
      ccBand,
      exciseBaseUsd: exciseBlocked ? null : exciseBase == null ? null : round2(exciseBase),
      formulaPath: exciseBlocked
        ? "under_4_blocked_for_review"
        : `under_4_${importerType}_ad_valorem`,
      exemptionApplied: exemption,
      dutyRatePct,
      exciseRatePct,
      vatRatePct,
    });
  }

  // 4+ years: 0% duty, 0% VAT; excise from the GRA flat-rate tables.
  if (engineCc <= 1500) {
    const excise = FOUR_PLUS_SMALL_ENGINE_FLAT_GYD / exchangeRate;
    return finish(0, excise, 0, {
      ccBand: `${fuelType} <=1500cc`,
      exciseBaseUsd: null,
      formulaPath: "four_plus_flat_gyd_800000",
      exemptionApplied: null,
      dutyRatePct: 0,
      exciseRatePct: null,
      vatRatePct: 0,
    });
  }
  const bands = fuelType === "gasoline" ? FOUR_PLUS_GASOLINE_BANDS : FOUR_PLUS_DIESEL_BANDS;
  const band = bands.find((b) => engineCc <= b.maxCc)!;
  const excise = (cifUsd + band.base) * band.rate + band.base;
  return finish(0, excise, 0, {
    ccBand: `${fuelType} ${band.band}`,
    exciseBaseUsd: band.base,
    formulaPath: `four_plus_formula_(cif+${band.base})x${band.rate * 100}%+${band.base}`,
    exemptionApplied: null,
    dutyRatePct: 0,
    exciseRatePct: round2(band.rate * 100),
    vatRatePct: 0,
  });
}
