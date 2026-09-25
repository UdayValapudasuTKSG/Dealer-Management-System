import assert from "node:assert/strict";
import { test } from "node:test";
import { countExportRows, agingExportRows, reportCsv, scopedCountLineQuery } from "./parts-count-analysis";
import { buildPartsAnalysisPdf } from "./parts-count-analysis-pdf";

test("cycle count sheets retain part number and name with CSV-safe escaping", () => {
  const rows = countExportRows([{
    partNumber: "AB-22", partName: 'Filter, "large"\r\nreplacement',
    binId: 3, expectedQty: 2, countedQty: 0, variance: -2,
  }]);
  assert.deepEqual(Object.keys(rows[0]!), ["Part Number", "Part Name", "Bin", "Expected", "Counted", "Variance"]);
  assert.match(reportCsv(rows), /"AB-22","Filter, ""large""\r\nreplacement","3","2","0","'-2"/);
  assert.equal(reportCsv(countExportRows([])).split("\r\n")[0], '"Part Number","Part Name"');
});

test("analysis exports include names and neutralize spreadsheet formulas", () => {
  const rows = agingExportRows([{
    sku: "Q88", name: '=HYPERLINK("malicious")', category: "Filters", locationId: 2,
    quantity: 1, currentValue: 900, ageDays: null, bucket: "unknown",
  }]);
  assert.match(reportCsv(rows), /"Q88","'=HYPERLINK\(""malicious""\)"/);
});

test("part resolution requires matching dealer on both line and catalog", () => {
  const { sql, params } = scopedCountLineQuery(721, 17).toSQL();
  assert.match(sql, /"parts"\."dealer_id" = "inventory_cycle_count_lines"\."dealer_id"/);
  assert.match(sql, /"inventory_cycle_count_lines"\."dealer_id" = \$\d+/);
  assert.deepEqual(params, [721, 17]);
});

test("printable count sheet uses configured dealership branding", async () => {
  const pdf = await buildPartsAnalysisPdf("Cycle Count #17", countExportRows([{
    partNumber: "AB-22", partName: "Air filter", binId: null, expectedQty: 5, countedQty: 4, variance: -1,
  }]), { displayName: "Test Dealer", logo: null });
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.ok(pdf.length > 500);
});