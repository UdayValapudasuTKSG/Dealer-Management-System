import assert from "node:assert/strict";
import { calculateLandedUnitCost, purchaseOrderReceiptUnitCost } from "../lib/parts-landed-cost";

// Pure assertions: no DB, application workers, notifications, or sends.
const components = { freight: 50 };
assert.equal(calculateLandedUnitCost(100, 10, components), 105);
const line = { unitCost: 100, quantity: 10, landedCostComponents: components, landedUnitCost: 105 };
assert.equal(purchaseOrderReceiptUnitCost(line), 105);
assert.equal(4 * purchaseOrderReceiptUnitCost(line) + 6 * purchaseOrderReceiptUnitCost(line), 1050);
assert.equal(purchaseOrderReceiptUnitCost({ ...line, landedUnitCost: null }), 105);
assert.equal(purchaseOrderReceiptUnitCost({ unitCost: 100, quantity: 10 }), 100);
assert.equal(calculateLandedUnitCost(100, 10, { freight: 20, duty: 15, handling: 10, other: 5 }), 105);
assert.throws(() => calculateLandedUnitCost(100, 10, { duty: -1 }), /nonnegative/);
assert.throws(() => calculateLandedUnitCost(100, 10, { freight: Infinity }), /finite/);
assert.throws(() => calculateLandedUnitCost(100, 0, components), /positive whole/);
console.log("PASS landed cost 100 + 50/10 = 105; partial receipts preserve total allocated costs");