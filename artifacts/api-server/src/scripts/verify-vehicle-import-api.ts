import assert from "node:assert/strict";
import { once } from "node:events";
import ExcelJS from "exceljs";
import { and, eq, inArray, sql } from "drizzle-orm";
import app from "../app";
import {
  db,
  dealerUsersTable,
  dealersTable,
  pool,
  roleFieldPermissionsTable,
  rolePermissionsTable,
  rolesTable,
  usersTable,
  vehiclesTable,
  type Vehicle,
} from "@workspace/db";

type ImportMode = "preview" | "apply";
type ImportResult = {
  mode: ImportMode;
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: { row: number; field?: string; message: string }[];
};

type SheetRow = Record<string, string | number>;

const HEADERS = [
  "Inventory ID",
  "VIN",
  "Make",
  "Model",
  "Year",
  "Price",
  "Duty-free Amount (GYD)",
  "Powertrain",
  "Mileage (km)",
  "Exterior Color",
  "Body Type",
  "Status",
  "Featured",
] as const;

const runToken = `${Date.now().toString(36)}${process.pid.toString(36)}`
  .replace(/[^a-z0-9]/gi, "")
  .toUpperCase();

function makeVin(index: number): string {
  return `AU${String(index).padStart(4, "0")}${runToken}XXXXXXXX`
    .slice(0, 17)
    .padEnd(17, "X");
}

function vehicleValues(
  dealerId: number,
  index: number,
  overrides: Partial<typeof vehiclesTable.$inferInsert> = {},
): typeof vehiclesTable.$inferInsert {
  return {
    dealerId,
    make: `AURA-${runToken}`,
    model: `Import-${index}`,
    year: 2026,
    vin: makeVin(index),
    price: 100_000 + index,
    dutyFreeAmount: 10_000 + index,
    powertrain: "EV",
    mileageKm: index,
    exteriorColor: "Black",
    bodyType: "Sedan",
    status: "available",
    featured: false,
    ...overrides,
  };
}

function rowFor(
  vehicle: Vehicle,
  overrides: Partial<SheetRow> = {},
): SheetRow {
  return {
    "Inventory ID": String(vehicle.id),
    VIN: vehicle.vin ?? "",
    Make: vehicle.make,
    Model: vehicle.model,
    Year: vehicle.year,
    Price: vehicle.price,
    "Duty-free Amount (GYD)": vehicle.dutyFreeAmount,
    Powertrain: vehicle.powertrain,
    "Mileage (km)": vehicle.mileageKm,
    "Exterior Color": vehicle.exteriorColor,
    "Body Type": vehicle.bodyType,
    Status: vehicle.status,
    Featured: String(vehicle.featured),
    ...overrides,
  };
}

async function workbookBuffer(rows: SheetRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Vehicles");
  sheet.addRow([...HEADERS]);
  for (const row of rows) {
    sheet.addRow(HEADERS.map((header) => row[header] ?? ""));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function test(name: string, fn: () => void): void {
  fn();
  console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
  assert.equal(
    process.env.AUTH_BYPASS,
    "1",
    "Run this verifier with AUTH_BYPASS=1",
  );

  const [dealer] = await db
    .select({ id: dealersTable.id })
    .from(dealersTable)
    .limit(1);
  assert.ok(dealer, "At least one development dealer is required");
  const dealerId = dealer.id;
  const foreignDealerId = dealerId + 1_000_000;

  const seeded = await db
    .insert(vehiclesTable)
    .values([
      vehicleValues(dealerId, 1),
      vehicleValues(dealerId, 2),
      vehicleValues(dealerId, 3, { deletedAt: new Date() }),
      vehicleValues(foreignDealerId, 4),
      vehicleValues(dealerId, 5, { vin: makeVin(5).toLowerCase() }),
    ])
    .returning();
  const [base, collider, deleted, foreign, mixedCaseVinVehicle] = seeded;
  assert.ok(base && collider && deleted && foreign && mixedCaseVinVehicle);

  const cleanupIds = new Set(seeded.map((row) => row.id));
  let restrictedRoleId: number | undefined;
  let restrictedUserId: number | undefined;
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  const postWorkbook = async (
    mode: ImportMode,
    rows: SheetRow[],
    testUserEmail?: string,
  ): Promise<ImportResult> => {
    const uploadBuffer = await workbookBuffer(rows);
    const uploadBytes = uploadBuffer.buffer.slice(
      uploadBuffer.byteOffset,
      uploadBuffer.byteOffset + uploadBuffer.byteLength,
    ) as ArrayBuffer;
    const form = new FormData();
    form.append(
      "file",
      new Blob([uploadBytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "inventory.xlsx",
    );
    const response = await fetch(`${baseUrl}/vehicles/import?mode=${mode}`, {
      method: "POST",
      headers: {
        "x-dealer-id": String(dealerId),
        ...(testUserEmail ? { "x-test-user-email": testUserEmail } : {}),
      },
      body: form,
    });
    const body = (await response.json()) as ImportResult | { error: string };
    assert.equal(
      response.status,
      200,
      `Import request failed: ${JSON.stringify(body)}`,
    );
    return body as ImportResult;
  };

  try {
    console.log("\nExport workbook");
    const exportResponse = await fetch(`${baseUrl}/vehicles/export`, {
      headers: { "x-dealer-id": String(dealerId) },
    });
    assert.equal(exportResponse.status, 200);
    assert.match(
      exportResponse.headers.get("cache-control") ?? "",
      /no-store/,
    );
    const conditionalExportResponse = await fetch(
      `${baseUrl}/vehicles/export`,
      {
        headers: {
          "x-dealer-id": String(dealerId),
          "if-none-match": exportResponse.headers.get("etag") ?? "*",
        },
      },
    );
    test("export never returns a bodyless 304", () => {
      assert.equal(conditionalExportResponse.status, 200);
    });
    assert.ok((await conditionalExportResponse.arrayBuffer()).byteLength > 0);
    const exported = new ExcelJS.Workbook();
    const exportBuffer = Buffer.from(await exportResponse.arrayBuffer());
    await exported.xlsx.load(
      exportBuffer as unknown as Parameters<typeof exported.xlsx.load>[0],
    );
    const inventory = exported.worksheets.find(
      (worksheet) => worksheet.name === "Vehicles",
    );
    assert.ok(
      inventory,
      `Vehicles sheet missing; found ${exported.worksheets.map((worksheet) => worksheet.name).join(", ")}`,
    );
    const headerIndex = new Map<string, number>();
    inventory.getRow(1).eachCell((cell, column) => {
      headerIndex.set(String(cell.value), column);
    });
    const idColumn = headerIndex.get("Inventory ID");
    const vinColumn = headerIndex.get("VIN");
    assert.ok(idColumn && vinColumn);
    assert.ok(headerIndex.has("Engine"));
    const exportedBaseRow = inventory
      .getRows(2, inventory.rowCount - 1)
      ?.find((row) => String(row.getCell(idColumn).value) === String(base.id));
    assert.ok(exportedBaseRow);
    test("Inventory ID is exported as text", () => {
      assert.equal(typeof exportedBaseRow.getCell(idColumn).value, "string");
      assert.equal(exportedBaseRow.getCell(idColumn).numFmt, "@");
    });
    test("VIN is exported as text", () => {
      assert.equal(typeof exportedBaseRow.getCell(vinColumn).value, "string");
      assert.equal(exportedBaseRow.getCell(vinColumn).numFmt, "@");
    });
    test("Instructions sheet is included", () => {
      assert.ok(exported.getWorksheet("Instructions"));
    });

    console.log("\nPreview and apply");
    const changedById = rowFor(base, {
      Price: 123_456,
      "Duty-free Amount (GYD)": "",
    });
    const preview = await postWorkbook("preview", [changedById]);
    test("preview reports an ID-based update", () => {
      assert.equal(preview.mode, "preview");
      assert.equal(preview.updated, 1);
      assert.equal(preview.inserted, 0);
    });
    let [afterPreview] = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, base.id));
    test("preview performs no writes", () => {
      assert.equal(afterPreview?.price, base.price);
      assert.equal(afterPreview?.dutyFreeAmount, base.dutyFreeAmount);
    });

    const applied = await postWorkbook("apply", [changedById]);
    test("apply updates by Inventory ID", () => {
      assert.equal(applied.mode, "apply");
      assert.equal(applied.updated, 1);
    });
    let [afterApply] = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, base.id));
    test("blank duty-free amount applies as zero", () => {
      assert.equal(afterApply?.price, 123_456);
      assert.equal(afterApply?.dutyFreeAmount, 0);
    });

    const unchanged = await postWorkbook("apply", [changedById]);
    test("re-importing the same row is unchanged", () => {
      assert.equal(unchanged.updated, 0);
      assert.equal(unchanged.unchanged, 1);
    });

    const vinFallback = await postWorkbook("apply", [
      rowFor(base, {
        "Inventory ID": "",
        Price: 234_567,
        "Duty-free Amount (GYD)": 0,
      }),
    ]);
    test("blank ID falls back to dealer-scoped VIN", () => {
      assert.equal(vinFallback.updated, 1);
      assert.equal(vinFallback.inserted, 0);
    });
    [afterApply] = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, base.id));
    assert.equal(afterApply?.price, 234_567);

    const mixedCaseFallback = await postWorkbook("apply", [
      rowFor(mixedCaseVinVehicle, {
        "Inventory ID": "",
        VIN: mixedCaseVinVehicle.vin?.toUpperCase() ?? "",
        Price: 234_568,
      }),
    ]);
    test("VIN fallback is case-insensitive and normalizes stored VINs", () => {
      assert.equal(mixedCaseFallback.updated, 1);
      assert.equal(mixedCaseFallback.inserted, 0);
    });
    const [normalizedMixedCase] = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, mixedCaseVinVehicle.id));
    assert.equal(normalizedMixedCase?.vin, mixedCaseVinVehicle.vin?.toUpperCase());

    const newModel = `New-${runToken}`;
    const inserted = await postWorkbook("apply", [
      {
        ...rowFor(base),
        "Inventory ID": "",
        VIN: "",
        Model: newModel,
        Price: 345_678,
        "Duty-free Amount (GYD)": "",
      },
    ]);
    test("blank ID and VIN create a vehicle", () => {
      assert.equal(inserted.inserted, 1);
    });
    const [newVehicle] = await db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.dealerId, dealerId),
          eq(vehiclesTable.model, newModel),
        ),
      );
    assert.ok(newVehicle);
    cleanupIds.add(newVehicle.id);
    test("new rows also default duty-free amount to zero", () => {
      assert.equal(newVehicle.dutyFreeAmount, 0);
    });

    console.log("\nFail-closed identifiers and duplicates");
    const unknownResult = await postWorkbook("preview", [
      rowFor(base, { "Inventory ID": "2000000000" }),
    ]);
    const foreignResult = await postWorkbook("preview", [
      rowFor(foreign, { "Inventory ID": String(foreign.id) }),
    ]);
    const deletedResult = await postWorkbook("preview", [
      rowFor(deleted, { "Inventory ID": String(deleted.id) }),
    ]);
    test("unknown, foreign, and deleted IDs share the same opaque rejection", () => {
      assert.equal(unknownResult.skipped, 1);
      assert.equal(foreignResult.skipped, 1);
      assert.equal(deletedResult.skipped, 1);
      for (const result of [unknownResult, foreignResult, deletedResult]) {
        assert.equal(result.errors[0]?.field, "inventoryId");
        assert.match(
          result.errors[0]?.message ?? "",
          /was not found or is not available\.$/,
        );
      }
    });

    const duplicateId = await postWorkbook("preview", [
      rowFor(base),
      rowFor(base, { VIN: makeVin(10) }),
    ]);
    test("duplicate Inventory IDs reject every duplicate row", () => {
      assert.equal(duplicateId.updated, 0);
      assert.equal(duplicateId.skipped, 2);
      assert.equal(
        duplicateId.errors.filter((error) => error.field === "inventoryId")
          .length,
        2,
      );
    });

    const proposedVin = makeVin(11);
    const duplicateVin = await postWorkbook("preview", [
      rowFor(base, { VIN: proposedVin }),
      rowFor(collider, { VIN: proposedVin }),
    ]);
    test("duplicate VINs reject ID-keyed rows too", () => {
      assert.equal(duplicateVin.updated, 0);
      assert.equal(duplicateVin.skipped, 2);
      assert.equal(
        duplicateVin.errors.filter((error) => error.field === "vin").length,
        2,
      );
    });

    const vinCollision = await postWorkbook("preview", [
      rowFor(base, { VIN: collider.vin ?? "" }),
    ]);
    test("ID-based VIN changes cannot collide with another vehicle", () => {
      assert.equal(vinCollision.updated, 0);
      assert.equal(vinCollision.skipped, 1);
      assert.equal(vinCollision.errors[0]?.field, "vin");
    });

    const negativeDuty = await postWorkbook("preview", [
      rowFor(base, { "Duty-free Amount (GYD)": -1 }),
    ]);
    test("negative duty-free amounts are rejected", () => {
      assert.equal(negativeDuty.updated, 0);
      assert.equal(negativeDuty.skipped, 1);
      assert.equal(negativeDuty.errors[0]?.field, "dutyFreeAmount");
    });

    console.log("\nAuthorization and concurrency");
    const [restrictedRole] = await db
      .insert(rolesTable)
      .values({
        name: `Inventory restricted ${runToken}`,
        description: "Temporary vehicle import verifier role",
      })
      .returning({ id: rolesTable.id });
    assert.ok(restrictedRole);
    restrictedRoleId = restrictedRole.id;
    await db.insert(rolePermissionsTable).values([
      {
        roleId: restrictedRole.id,
        module: "inventory",
        category: "view",
      },
      {
        roleId: restrictedRole.id,
        module: "inventory",
        category: "create",
      },
    ]);
    await db.insert(roleFieldPermissionsTable).values({
      roleId: restrictedRole.id,
      fieldGroup: "vehicle_pricing",
      access: "view",
    });
    const restrictedEmail = `inventory-import-${runToken.toLowerCase()}@example.test`;
    const [restrictedUser] = await db
      .insert(usersTable)
      .values({
        clerkId: `vehicle-import-${runToken}`,
        email: restrictedEmail,
        name: "Inventory Import Verifier",
        lastActiveDealerId: dealerId,
      })
      .returning({ id: usersTable.id });
    assert.ok(restrictedUser);
    restrictedUserId = restrictedUser.id;
    await db.insert(dealerUsersTable).values({
      dealerId,
      userId: restrictedUser.id,
      roleId: restrictedRole.id,
    });

    const restrictedInsert = await postWorkbook(
      "preview",
      [
        {
          ...rowFor(base),
          "Inventory ID": "",
          VIN: "",
          Model: `Restricted-${runToken}`,
        },
      ],
      restrictedEmail,
    );
    test("create permission cannot bypass restricted pricing fields", () => {
      assert.equal(restrictedInsert.inserted, 0);
      assert.equal(restrictedInsert.skipped, 1);
      assert.equal(restrictedInsert.errors[0]?.field, "price");
    });

    const concurrentVin = makeVin(12);
    const concurrentModel = `Concurrent-${runToken}`;
    const concurrentRow: SheetRow = {
      ...rowFor(base),
      "Inventory ID": "",
      VIN: concurrentVin,
      Model: concurrentModel,
      Price: 456_789,
    };
    const concurrentResults = await Promise.all([
      postWorkbook("apply", [concurrentRow]),
      postWorkbook("apply", [concurrentRow]),
    ]);
    const concurrentRows = await db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.dealerId, dealerId),
          eq(
            sql<string>`upper(btrim(${vehiclesTable.vin}))`,
            concurrentVin,
          ),
        ),
      );
    for (const vehicle of concurrentRows) cleanupIds.add(vehicle.id);
    test("concurrent imports cannot create duplicate dealer VINs", () => {
      assert.equal(
        concurrentResults.reduce((sum, result) => sum + result.inserted, 0),
        1,
      );
      assert.equal(concurrentRows.length, 1);
    });

    const [unchangedBaseline] = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, base.id));
    assert.ok(unchangedBaseline);
    let pendingUnchangedApply!: Promise<ImportResult>;
    await db.transaction(async (tx) => {
      await tx
        .select({ id: vehiclesTable.id })
        .from(vehiclesTable)
        .where(eq(vehiclesTable.id, base.id))
        .for("update");
      pendingUnchangedApply = postWorkbook("apply", [
        rowFor(unchangedBaseline),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await tx
        .update(vehiclesTable)
        .set({ price: unchangedBaseline.price + 1 })
        .where(eq(vehiclesTable.id, base.id));
    });
    const racedUnchanged = await pendingUnchangedApply;
    test("apply rechecks rows initially classified as unchanged", () => {
      assert.equal(racedUnchanged.unchanged, 0);
      assert.equal(racedUnchanged.skipped, 1);
      assert.match(
        racedUnchanged.errors[0]?.message ?? "",
        /modified or deleted concurrently/,
      );
    });
    await db
      .update(vehiclesTable)
      .set({ price: unchangedBaseline.price })
      .where(eq(vehiclesTable.id, base.id));

    console.log("\nAll live vehicle import/export checks passed.");
  } finally {
    await db
      .delete(vehiclesTable)
      .where(inArray(vehiclesTable.id, [...cleanupIds]));
    if (restrictedUserId !== undefined) {
      await db
        .delete(dealerUsersTable)
        .where(eq(dealerUsersTable.userId, restrictedUserId));
      await db.delete(usersTable).where(eq(usersTable.id, restrictedUserId));
    }
    if (restrictedRoleId !== undefined) {
      await db
        .delete(roleFieldPermissionsTable)
        .where(eq(roleFieldPermissionsTable.roleId, restrictedRoleId));
      await db
        .delete(rolePermissionsTable)
        .where(eq(rolePermissionsTable.roleId, restrictedRoleId));
      await db.delete(rolesTable).where(eq(rolesTable.id, restrictedRoleId));
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error(error);
  try {
    await pool.end();
  } catch {
    // The pool may already be closed by the cleanup path.
  }
  process.exitCode = 1;
});