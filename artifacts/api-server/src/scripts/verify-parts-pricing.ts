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
const { db, pool, dealersTable, partsTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { persistImportedPart } = await import("../lib/parts-imports");
const { validateImportRows } = await import("../lib/parts-import-validation");
const { CreatePartBody, UpdatePartBody, CreatePartResponse } = await import("@workspace/api-zod");
try {
  if (process.argv.includes("--migrate")) {
    await pool.query(await readFile(new URL("../../../../lib/db/migrations/2026-10-04-part-pricing-details.sql", import.meta.url), "utf8"));
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
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  console.info("PASS: API schema/DB round-trip, import preservation, explicit price, stock opt-in, null clear. All fixtures rolled back; no sends.");
} finally {
  await pool.end();
}