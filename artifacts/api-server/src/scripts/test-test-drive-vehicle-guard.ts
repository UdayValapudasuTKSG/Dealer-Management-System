import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import vm from "node:vm";

// Exercise the actual guard with a stubbed DB: no fixture records or messages.
const source = readFileSync(new URL("../lib/test-drive-scheduler.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("scheduler.ts", source, ts.ScriptTarget.Latest, true);
const guard = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "vehicleAvailabilityError",
);
assert.ok(guard, "shared vehicle guard exists");
let rows: object[] = [];
const context = vm.createContext({
  db: { select: () => ({ from: () => ({ where: async () => rows }) }) },
  vehiclesTable: {},
  eq: () => true,
  and: () => true,
});
const js = ts.transpileModule(guard.getText(ast).replace(/^export /, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInContext(js, context);
const check = context.vehicleAvailabilityError;
assert.match(await check({ dealerId: 1, interestedVehicleId: null }), /confirm the vehicle model/);
assert.match(await check({ dealerId: 1, interestedVehicleId: 999 }), /unavailable/);
rows = [{ year: 2026, make: "BYD", model: "Dolphin Mini", status: "sold" }];
assert.match(await check({ dealerId: 1, interestedVehicleId: 999 }), /no longer available/);
rows = [{ year: 2026, make: "BYD", model: "Dolphin Mini", status: "available" }];
assert.equal(await check({ dealerId: 1, interestedVehicleId: 999 }), null);
console.log("Vehicle guard: missing, invalid, sold and available cases passed.");
