/**
 * Pure unit assertions over the @workspace/gra-duty engine — no DB, no server.
 * Run: pnpm --filter @workspace/scripts run verify-gra-duty
 */
import {
  computeGraDuty,
  missingGraInputs,
  normalizeFuelType,
  isUnderFourYears,
  FOUR_PLUS_SMALL_ENGINE_FLAT_GYD,
  type GraDutyInput,
} from "@workspace/gra-duty";

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const approx = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

const base = (over: Partial<GraDutyInput>): GraDutyInput => ({
  cifUsd: 20_000,
  engineCc: 1300,
  fuelType: "gasoline",
  yearOfManufacture: 2025,
  yearOfImport: 2026,
  importerType: "private",
  exchangeRate: 209,
  asOfDate: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

console.log("Spec acceptance case: 2755cc diesel, dealer_used, CIF US$33,800, under 4");
{
  const r = computeGraDuty(
    base({
      cifUsd: 33_800,
      engineCc: 2755,
      fuelType: "diesel",
      importerType: "dealer_used",
      yearOfManufacture: 2024,
      yearOfImport: 2026,
    }),
  );
  // duty = 45% of 33,800 = 15,210; excise base = 1.5*33,800 + 15,210 = 65,910
  // excise = 110% = 72,501; VAT = 14% * (33,800 + 15,210 + 72,501) = 17,011.54
  check("duty = 15,210", approx(r.dutyUsd, 15_210), String(r.dutyUsd));
  check("excise ≈ 72,501", approx(r.exciseUsd, 72_501), String(r.exciseUsd));
  check("VAT ≈ 17,012", approx(r.vatUsd, 17_011.54, 2), String(r.vatUsd));
  check("total ≈ 104,723", approx(r.totalUsd, 104_722.54, 2), String(r.totalUsd));
  check("breakdown under_4 dealer_used", r.breakdown.ageCategory === "under_4" && r.breakdown.importerType === "dealer_used");
  check("no flags", r.reviewFlags.length === 0);
}

console.log("Age category boundary");
{
  check("yom 2023 / yoi 2026 = under 4", isUnderFourYears(2023, 2026));
  check("yom 2022 / yoi 2026 = 4+", !isUnderFourYears(2022, 2026));
}

console.log("Duty rate boundary at 1500cc");
{
  const at = computeGraDuty(base({ engineCc: 1500 }));
  const above = computeGraDuty(base({ engineCc: 1501 }));
  check("1500cc duty 35%", at.breakdown.dutyRatePct === 35);
  check("1501cc duty 45%", above.breakdown.dutyRatePct === 45);
}

console.log("Gasoline excise bands (under 4, private)");
{
  check("1500cc → 0%", computeGraDuty(base({ engineCc: 1500 })).breakdown.exciseRatePct === 0);
  check("2000cc → 10%", computeGraDuty(base({ engineCc: 2000 })).breakdown.exciseRatePct === 10);
  check("2500cc → 110%", computeGraDuty(base({ engineCc: 2500 })).breakdown.exciseRatePct === 110);
  check("3000cc → 110%", computeGraDuty(base({ engineCc: 3000 })).breakdown.exciseRatePct === 110);
  check("3001cc → 140%", computeGraDuty(base({ engineCc: 3001 })).breakdown.exciseRatePct === 140);
}

console.log("Diesel bands + 1800-2000cc gap");
{
  const d = (cc: number) => computeGraDuty(base({ engineCc: cc, fuelType: "diesel" }));
  check("1500cc → 0%", d(1500).breakdown.exciseRatePct === 0);
  check("1800cc → 10%", d(1800).breakdown.exciseRatePct === 10);
  const gap = d(1900);
  check("1900cc flagged diesel_cc_gap_1800_2000", gap.reviewFlags.includes("diesel_cc_gap_1800_2000"));
  check("gap: excise & VAT NOT computed", gap.exciseUsd === 0 && gap.vatUsd === 0);
  check("2001cc → 110%", d(2001).breakdown.exciseRatePct === 110);
}

console.log("Importer-type excise bases (under 4, 2000cc gasoline, CIF 20k)");
{
  const cif = 20_000;
  const duty = cif * 0.45;
  const priv = computeGraDuty(base({ engineCc: 2000, cifUsd: cif, importerType: "private" }));
  const dealer = computeGraDuty(base({ engineCc: 2000, cifUsd: cif, importerType: "dealer_used" }));
  const trader = computeGraDuty(
    base({ engineCc: 2000, cifUsd: cif, importerType: "new_vehicle_trader", retailPriceUsd: 35_000 }),
  );
  check("private base = CIF + duty", approx(priv.breakdown.exciseBaseUsd ?? 0, cif + duty));
  check("dealer_used base = 1.5·CIF + duty", approx(dealer.breakdown.exciseBaseUsd ?? 0, 1.5 * cif + duty));
  check("trader base = retail + duty", approx(trader.breakdown.exciseBaseUsd ?? 0, 35_000 + duty));
  const noRetail = computeGraDuty(base({ engineCc: 2000, importerType: "new_vehicle_trader" }));
  check("trader w/o retail flagged", noRetail.reviewFlags.includes("missing_retail_price"));
}

console.log("4+ years flat-rate tables (0% duty, 0% VAT)");
{
  const old = (over: Partial<GraDutyInput>) =>
    computeGraDuty(base({ yearOfManufacture: 2020, yearOfImport: 2026, ...over }));
  const small = old({ engineCc: 1400 });
  check("≤1500cc flat GY$800,000 / rate", approx(small.exciseUsd, FOUR_PLUS_SMALL_ENGINE_FLAT_GYD / 209, 0.01));
  check("4+ duty = 0 and VAT = 0", small.dutyUsd === 0 && small.vatUsd === 0);
  const g2500 = old({ engineCc: 2500, cifUsd: 10_000 });
  // gasoline 2000-3000: (10,000 + 13,500) * 0.7 + 13,500 = 29,950
  check("gasoline 2500cc 4+ formula = 29,950", approx(g2500.exciseUsd, 29_950), String(g2500.exciseUsd));
  const d2600 = old({ engineCc: 2600, cifUsd: 10_000, fuelType: "diesel" });
  // diesel 2500-3000: (10,000 + 15,500) * 0.7 + 15,500 = 33,350
  check("diesel 2600cc 4+ formula = 33,350", approx(d2600.exciseUsd, 33_350), String(d2600.exciseUsd));
}

console.log("Electric vehicles zero-rated");
{
  const ev = computeGraDuty(base({ fuelType: "electric", engineCc: 0 }));
  check("EV total = 0", ev.totalUsd === 0);
  check("EV exemption tagged", ev.breakdown.exemptionApplied === "electric_vehicle");
}

console.log("VAT exemptions (effective 2026-02-16)");
{
  const dc = computeGraDuty(base({ engineCc: 2400, bodyType: "double_cab_pickup", fuelType: "diesel" }));
  check("double-cab ≤2500cc VAT = 0", dc.vatUsd === 0 && dc.breakdown.exemptionApplied === "double_cab_pickup_2500cc");
  const dcBig = computeGraDuty(base({ engineCc: 2600, bodyType: "double_cab_pickup", fuelType: "diesel" }));
  check("double-cab 2600cc NOT exempt", dcBig.vatUsd > 0);
  const nv = computeGraDuty(base({ engineCc: 1400, yearOfManufacture: 2026, yearOfImport: 2026 }));
  check("new <1500cc VAT = 0", nv.vatUsd === 0 && nv.breakdown.exemptionApplied === "new_vehicle_under_1500cc");
  const hy = computeGraDuty(base({ engineCc: 1800, isHybrid: true }));
  check("hybrid <2000cc VAT = 0", hy.vatUsd === 0 && hy.breakdown.exemptionApplied === "hybrid_under_2000cc");
  const hyBig = computeGraDuty(base({ engineCc: 2200, isHybrid: true }));
  check("hybrid 2200cc NOT exempt", hyBig.vatUsd > 0);
  const before = computeGraDuty(base({ engineCc: 1800, isHybrid: true, asOfDate: new Date("2026-01-10T00:00:00Z") }));
  check("hybrid before 2026-02-16 NOT exempt", before.vatUsd > 0);
}

console.log("missingGraInputs");
{
  check("blank draft reports required fields", missingGraInputs({}).length >= 4);
  check(
    "trader without retail → retailPrice missing",
    missingGraInputs({
      cifUsd: 10_000,
      engineCc: 2000,
      fuelType: "gasoline",
      yearOfManufacture: 2025,
      yearOfImport: 2026,
      importerType: "new_vehicle_trader",
      exchangeRate: 209,
    }).includes("retailPrice"),
  );
  check(
    "electric only needs fuel type",
    missingGraInputs({ fuelType: "electric" }).length === 0,
  );
}

console.log("normalizeFuelType");
{
  check("Petrol → gasoline", normalizeFuelType("Petrol").fuelType === "gasoline");
  check("Hybrid → gasoline+hybrid", normalizeFuelType("Hybrid").isHybrid);
  check("EV → electric", normalizeFuelType("ev").fuelType === "electric");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
