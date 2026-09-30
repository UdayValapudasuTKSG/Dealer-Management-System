import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { buildPdf } from "../lib/report-export";
import type { ReportPayload } from "../routes/reports";

// Fictional data only. Covers every Reports-tab builder and the call-centre card.
const types = [
  "sales_pipeline", "sales_performance", "sales_advisor_activity",
  "inventory_aging", "finance_applications", "service_workshop",
  "parts_inventory", "revenue_receivables", "tax_gra",
  "delivery_operations", "agent_activity", "collision_claims", "call_centre",
];
const meta = {
  dealerName: "DEMO · Harbour Motors",
  address: "12 Fictional Quay, Georgetown",
  phone: "+592 000 0000",
  color: "#266681",
  timezone: "America/Guyana",
  usdExchangeRate: 1,
};
const build = (type: string, rows: number): ReportPayload => ({
  type,
  label: type.split("_").map(s => s[0]!.toUpperCase() + s.slice(1)).join(" "),
  from: "2026-01-01T04:00:00.000Z",
  to: "2026-02-01T03:59:59.999Z",
  kpis: [
    { label: "Demo count", value: String(rows), sub: "Fictional, non-production data" },
    { label: "Demo value", value: "GYD 42,500", sub: "Sample only" },
    { label: "Demo conversion", value: "20.5%" },
  ],
  chart: {
    kind: type === "tax_gra" ? "pie" : type === "sales_performance" ? "area" : "bar",
    valueLabel: type === "tax_gra" ? "Tax by code (GYD)" : "Count by status",
    currency: type === "tax_gra",
    points: [{ label: "First", value: 14 }, { label: "Second", value: 9 }, { label: "Third", value: 5 }],
  },
  table: {
    columns: type === "service_workshop" ? ["Reference", "Status", "Details", "Date", "Technician", "Notes", "Next action", "Age", "Follow-up"] : ["Reference", "Status", "Details", "Amount"],
    rows: Array.from({ length: rows }, (_, i) =>
      type === "service_workshop"
        ? [`DEMO-${i + 1}`, "Open", "Sample unit", "2026-01-15", "Example Person",
          `Fictional notes ${"long-value ".repeat(12)}`, "Follow up", "2 days", "2026-01-17"]
        : [`DEMO-${i + 1}`, "Open", `Fictional detail ${"long-value ".repeat(10)} ${i + 1}`, "GYD 42,500"]),
  },
});

async function main() {
  await mkdir("outputs", { recursive: true });
  for (const type of types) {
    const pdf = await buildPdf(build(type, type === "service_workshop" ? 170 : 5), meta);
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.ok(pdf.length > 2000, `${type} produced an incomplete PDF`);
    await writeFile(`outputs/demo-test-${type}.pdf`, pdf);
    if (type === "sales_pipeline") await writeFile("outputs/demo-report-sales-pipeline.pdf", pdf);
  }
  const huge = await buildPdf(build("finance_applications", 500), meta);
  await writeFile("outputs/demo-report-large.pdf", huge);
  const empty = await buildPdf(build("inventory_aging", 0), meta);
  assert.ok(empty.length > 1000);
  console.log(`Rendered ${types.length} report types, 500-row and empty-state PDFs.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });