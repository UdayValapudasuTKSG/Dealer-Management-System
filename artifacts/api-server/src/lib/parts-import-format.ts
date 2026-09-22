import type { partsTable } from "@workspace/db";

/** Source workbook first, then catalogue fields. Suppliers deliberately blank. */
export const partTemplateColumns: { header: string; example: string | number | boolean }[] = [
  { header: "QTY", example: 1 }, { header: "PART NO", example: "EXAMPLE-001" },
  { header: "PART NAME", example: "Example part — replace before importing" },
  { header: "UNIT COST USD", example: 10 }, { header: "TOTAL USD", example: 10 },
  { header: "CIF USD", example: 12 }, { header: "DUTY", example: 0.2 },
  { header: "VAT", example: 0.14 }, { header: "DUTY GYD", example: 480 },
  { header: "VAT GYD", example: 403.2 }, { header: "LAN/COST (GYD)", example: 3283.2 },
  { header: "UNIT COST  (GYD)", example: 3283.2 }, { header: " UNIT SP 10% (GYD)", example: 3611.52 },
  { header: "14%VAT", example: 505.6128 }, { header: "FINAL SP", example: 4117.1328 },
  { header: "Make", example: "" }, { header: "Barcode", example: "001234567890" },
  { header: "Costing Method", example: "average" }, { header: "Supplier", example: "" },
  { header: "Supplier ID", example: "" }, { header: "Description", example: "" },
  { header: "Category", example: "general" }, { header: "Reorder Min", example: 5 },
  { header: "Reorder Max", example: 10 }, { header: "Location", example: "" },
  { header: "Active", example: true }, { header: "Pricing Quantity", example: "" },
];

export const partExportHeaders = [
  "SKU", "Name", "Description", "Category", "Make", "Supplier ID", "Supplier", "Barcode",
  "Costing Method", "Unit Cost", "Unit Price", "Stock", "Reorder Min", "Reorder Max", "Location", "Active",
  "Pricing Quantity", "UNIT COST USD", "TOTAL USD", "CIF USD", "DUTY", "VAT", "DUTY GYD",
  "VAT GYD", "LAN/COST (GYD)", "14%VAT", "FINAL SP",
];
export function partExportValues(part: typeof partsTable.$inferSelect, supplierName: string | null) {
  const d = part.pricingDetails;
  return [
    part.sku, part.name, part.description ?? "", part.category, part.make ?? "", part.supplierId ?? "",
    supplierName ?? "", part.barcode ?? "", part.costingMethod, part.unitCost, part.unitPrice, part.stock,
    part.reorderLevel, part.reorderMax, part.location ?? "", part.active,
    d?.quantity ?? "", d?.unitCostUsd ?? "", d?.totalUsd ?? "", d?.cifUsd ?? "", d?.dutyRate ?? "",
    d?.vatRate ?? "", d?.dutyGyd ?? "", d?.vatGyd ?? "", d?.landedCostGyd ?? "",
    d?.sellingVatGyd ?? "", d?.finalSellingPriceGyd ?? "",
  ];
}