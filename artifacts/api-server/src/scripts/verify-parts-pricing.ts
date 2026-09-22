import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Guard before importing any pool or application modules.
if (process.env.NODE_ENV !== "development") throw new Error("Development only");
const target = new URL(process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL ?? "");
if (!["helium", "localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Database host is not development allowlisted");
if (process.env.PROD_DATABASE_URL) {
  const prod = new URL(process.env.PROD_DATABASE_URL);
  if (prod.hostname === target.hostname && prod.port === target.port && prod.pathname === target.pathname) throw new Error("Refusing production database");
}
process.env.OUTBOX_WORKER_DISABLED = "1";
const { db, pool, dealersTable, partsTable, suppliersTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { persistImportedPart } = await import("../lib/parts-imports");
const { validateImportRows } = await import("../lib/parts-import-validation");
const { CreatePartBody, UpdatePartBody, CreatePartResponse } = await import("@workspace/api-zod");
const { partExportHeaders, partExportValues } = await import("../lib/parts-import-format");
const { mapImportRows } = await import("../lib/parts-import-validation");
const { parsePartsXlsx } = await import("../lib/parts-import-xlsx");
const { default: ExcelJS } = await import("exceljs");
try {
  if (process.argv.includes("--migrate")) {
    await pool.query(await readFile(new URL("../../../../lib/db/migrations/2026-10-04-part-pricing-details.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../../lib/db/migrations/2026-10-04-part-make.sql", import.meta.url), "utf8"));
  }
  const rollback = new Error("ROLLBACK_TEST_FIXTURES");
  try {
    await db.transaction(async tx => {
      const [dealer] = await tx.insert(dealersTable).values({ name: `Pricing regression ${crypto.randomUUID()}` }).returning();
      const input = CreatePartBody.parse({ sku: "ISOLATED-PRICING", name: "Pricing regression", unitCost: 100, unitPrice: 150, pricingDetails: { unitCostUsd: 2, quantity: 3, finalSellingPriceGyd: 171 } });
      const [part] = await tx.insert(partsTable).values({ ...input, dealerId: dealer.id }).returning();
      assert.deepEqual(CreatePartResponse.parse(part).pricingDetails, input.pricingDetails);
      const legacy = validateImportRows([{ sku: part.sku, name: part.name, unitCost: "100", unitPrice: "150" }], { mode: "upsert" }, []).rows[0];
      const preserved = await persistImportedPart(tx, dealer.id, 1, legacy, { mode: "upsert" }, part);
      assert.deepEqual(preserved.part.pricingDetails, input.pricingDetails);
      const source = [{ sku: part.sku, name: part.name, unitCost: "100", unitPrice: "150", stock: "3", totalUsd: "6", unitCostUsd: "2" }];
      for (const applyStock of [false, true]) {
        const options = { mode: "upsert" as const, applyStock };
        const checked = validateImportRows(source, options, [{ category: null, markupFactor: 99 }]);
        assert.deepEqual(checked.errors, []);
        await persistImportedPart(tx, dealer.id, 2, checked.rows[0], options, preserved.part);
        const [saved] = await tx.select().from(partsTable).where(eq(partsTable.id, part.id));
        assert.equal(saved.stock, applyStock ? 3 : 0);
        assert.equal(saved.unitPrice, 150);
        assert.equal(saved.pricingDetails?.quantity, 3);
        assert.equal(saved.pricingDetails?.finalSellingPriceGyd, 171);
      }
      await tx.update(partsTable).set(UpdatePartBody.parse({ pricingDetails: null })).where(eq(partsTable.id, part.id));
      const [cleared] = await tx.select().from(partsTable).where(eq(partsTable.id, part.id));
      assert.equal(cleared.pricingDetails, null);
      const [supplier] = await tx.insert(suppliersTable).values({ dealerId: dealer.id, name: "Regression Supplier" }).returning();
      const [foreignDealer] = await tx.insert(dealersTable).values({ name: `Foreign pricing regression ${crypto.randomUUID()}` }).returning();
      const [foreignSupplier] = await tx.insert(suppliersTable).values({ dealerId: foreignDealer.id, name: supplier.name }).returning();
      const supplierContext = await tx.select().from(suppliersTable).where(eq(suppliersTable.dealerId, dealer.id));
      const broader = { sku: "00001", name: "Master fields", unitCost: "100", unitPrice: "150", stock: "2", pricingQuantity: "5", unitCostUsd: "2", totalUsd: "10", make: "Descriptive make", supplier: " regression supplier ", barcode: "0000123456", costingMethod: "fifo", description: "Separate description", category: "general", reorderMin: "1", reorderMax: "9", location: "A-1", active: "false" };
      const broaderOptions = { mode: "upsert" as const, applyStock: true };
      const checked = validateImportRows([broader], broaderOptions, [], new Map(), undefined, supplierContext);
      assert.deepEqual(checked.errors, []);
      assert.ok(validateImportRows([{ ...broader, supplierId: String(foreignSupplier.id) }], broaderOptions, [], new Map(), undefined, supplierContext).errors.length);
      const inserted = await persistImportedPart(tx, dealer.id, 3, checked.rows[0], broaderOptions);
      const [saved] = await tx.select().from(partsTable).where(eq(partsTable.id, inserted.part.id));
      assert.equal(CreatePartResponse.parse(saved).make, broader.make);
      assert.equal(saved.supplierId, supplier.id);
      assert.equal(saved.active, false);
      assert.equal(saved.barcode, "0000123456");
      assert.equal(saved.costingMethod, "fifo");
      assert.equal(saved.description, broader.description);
      assert.equal(saved.category, broader.category);
      assert.equal(saved.location, broader.location);
      assert.equal(saved.reorderLevel, 1);
      assert.equal(saved.reorderMax, 9);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Parts");
      sheet.addRow(partExportHeaders);
      sheet.addRow(partExportValues(saved, supplier.name));
      const mapped = mapImportRows(await parsePartsXlsx(Buffer.from(await workbook.xlsx.writeBuffer())), broaderOptions);
      assert.equal(mapped[0].stock, "2");
      assert.equal(mapped[0].pricingQuantity, "5");
      assert.equal(mapped[0].sku, "00001");
      assert.equal(mapped[0].barcode, "0000123456");
      const roundtrip = validateImportRows(mapped, broaderOptions, [], new Map(), undefined, supplierContext);
      assert.deepEqual(roundtrip.errors, []);
      assert.equal(roundtrip.rows[0].pricingDetails?.quantity, 5);
      assert.equal(roundtrip.rows[0].active, false);
      const omitted = validateImportRows([{ sku: saved.sku, name: saved.name, unitCost: "100", unitPrice: "150" }], { mode: "upsert" }, []).rows[0];
      const preservedMaster = await persistImportedPart(tx, dealer.id, 4, omitted, { mode: "upsert" }, saved);
      assert.equal(preservedMaster.part.make, saved.make);
      assert.equal(preservedMaster.part.supplierId, saved.supplierId);
      assert.equal(preservedMaster.part.active, false);
      assert.equal(preservedMaster.part.barcode, saved.barcode);
      assert.deepEqual(preservedMaster.part.pricingDetails, saved.pricingDetails);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  console.info("PASS: API schema/DB round-trip, supplier tenancy, full master persistence, XLSX export/import round-trip, leading-zero identifiers, current/source quantity separation, omission preservation, explicit price, stock opt-in, null clear. All fixtures rolled back; no sends.");
} finally {
  await pool.end();
}