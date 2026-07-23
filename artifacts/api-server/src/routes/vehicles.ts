import { Router, type IRouter } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { eq, desc, and, ilike, or, inArray, isNull, isNotNull, type SQL } from "drizzle-orm";
import {
  db,
  vehiclesTable,
  divisionsTable,
  VEHICLE_STATUS_TRANSITIONS,
  type VehicleStatus,
} from "@workspace/db";
import {
  CreateVehicleBody,
  UpdateVehicleBody,
  GetVehicleParams,
  UpdateVehicleParams,
  DeleteVehicleParams,
  ListVehiclesQueryParams,
  ListVehiclesResponse,
  GetVehicleResponse,
  UpdateVehicleResponse,
  ImportVehiclesResponse,
} from "@workspace/api-zod";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import {
  findBlockedEditField,
  redactHiddenFields,
} from "../lib/field-permissions";
import { defaultDivisionId, divisionBelongsToDealer } from "./divisions";
import { computeTaxes, ensureDealerTaxes } from "../lib/taxes";

const router: IRouter = Router();

/** Human-readable VIN/Engine# validation (17 chars, DMS spec §9). */
export function vehicleIdentifierError(body: {
  vin?: string;
  engine?: string;
}): string | null {
  if (body.vin !== undefined && body.vin.length !== 17)
    return "VIN must be exactly 17 characters";
  if (body.engine !== undefined && body.engine.length !== 17)
    return "Engine number must be exactly 17 characters";
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.get("/vehicles", async (req, res): Promise<void> => {
  const query = ListVehiclesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const filters: SQL[] = [eq(vehiclesTable.dealerId, activeDealerId(res))];
  // Soft delete (R4.8): default reads exclude deleted rows.
  if (!query.data.includeDeleted)
    filters.push(isNull(vehiclesTable.deletedAt));
  if (query.data.divisionId)
    filters.push(eq(vehiclesTable.divisionId, query.data.divisionId));
  if (query.data.status) filters.push(eq(vehiclesTable.status, query.data.status));
  if (query.data.powertrain)
    filters.push(eq(vehiclesTable.powertrain, query.data.powertrain));
  if (query.data.search) {
    const term = `%${query.data.search}%`;
    const searchClause = or(
      ilike(vehiclesTable.make, term),
      ilike(vehiclesTable.model, term),
      ilike(vehiclesTable.bodyType, term),
      ilike(vehiclesTable.vin, term),
      ilike(vehiclesTable.registration, term),
    );
    if (searchClause) filters.push(searchClause);
  }

  const rows = await db
    .select()
    .from(vehiclesTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(vehiclesTable.featured), desc(vehiclesTable.createdAt));

  const visible = await redactHiddenFields(res.locals.user, "inventory", rows);
  res.json(ListVehiclesResponse.parse(visible));
});

router.post("/vehicles", async (req, res): Promise<void> => {
  const parsed = CreateVehicleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: vehicleIdentifierError(req.body ?? {}) ?? parsed.error.message,
    });
    return;
  }

  const dealerId = activeDealerId(res);
  let divisionId = parsed.data.divisionId ?? null;
  if (divisionId != null && !(await divisionBelongsToDealer(divisionId, dealerId))) {
    res.status(404).json({ error: "Division not found" });
    return;
  }
  if (divisionId == null) divisionId = await defaultDivisionId(dealerId);

  const [vehicle] = await db
    .insert(vehiclesTable)
    .values({ ...parsed.data, divisionId, dealerId })
    .returning();

  res.status(201).json(GetVehicleResponse.parse(vehicle));
});

// ---------------------------------------------------------------------------
// Bulk import from Excel
// ---------------------------------------------------------------------------

/** Normalized header text → vehicle field name. */
const IMPORT_HEADER_MAP: Record<string, string> = {
  make: "make",
  brand: "make",
  model: "model",
  trim: "trim",
  year: "year",
  modelyear: "year",
  vin: "vin",
  variant: "variant",
  engine: "engine",
  enginenumber: "engineNumber",
  engineno: "engineNumber",
  registration: "registration",
  registrationnumber: "registration",
  registrationno: "registration",
  regno: "registration",
  plate: "registration",
  licenseplate: "registration",
  numberplate: "registration",
  division: "division",
  divisionname: "division",
  transmission: "transmission",
  gearbox: "transmission",
  price: "price",
  priceusd: "price",
  powertrain: "powertrain",
  fueltype: "powertrain",
  fuel: "powertrain",
  range: "rangeKm",
  rangekm: "rangeKm",
  mileage: "mileageKm",
  mileagekm: "mileageKm",
  odometer: "mileageKm",
  odometerkm: "mileageKm",
  exteriorcolor: "exteriorColor",
  exteriorcolour: "exteriorColor",
  color: "exteriorColor",
  colour: "exteriorColor",
  bodytype: "bodyType",
  body: "bodyType",
  bodystyle: "bodyType",
  status: "status",
  imageurl: "imageUrl",
  image: "imageUrl",
  images: "images",
  imageurls: "images",
  gallery: "images",
  galleryimages: "images",
  accessories: "accessories",
  accessory: "accessories",
  description: "description",
  featured: "featured",
};

// Multi-value cells (gallery images, accessories) accept comma, semicolon,
// pipe or newline separators.
const LIST_FIELDS = new Set(["images", "accessories"]);
function splitList(text: string): string[] {
  return text
    .split(/[,;|\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const NUMBER_FIELDS = new Set(["year", "price", "rangeKm", "mileageKm"]);

const POWERTRAIN_ALIASES: Record<string, string> = {
  ev: "EV",
  electric: "EV",
  bev: "EV",
  hybrid: "Hybrid",
  phev: "Hybrid",
  petrol: "Petrol",
  gas: "Petrol",
  gasoline: "Petrol",
  diesel: "Diesel",
};

function normalizeHeader(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Excel cells sometimes carry the same URL pasted twice back-to-back
 * ("https://…https://…"). Keep only the first URL so the stored value is
 * always a single valid link.
 */
function firstUrl(text: string): string {
  if (!/^https?:/i.test(text)) return text;
  const dup = text.indexOf("http", 1);
  return dup > 0 ? text.slice(0, dup) : text;
}

/** exceljs cell values can be rich objects — reduce them to plain text. */
function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    if ("richText" in value)
      return value.richText.map((r) => r.text).join("").trim();
    if ("text" in value) return String(value.text).trim();
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if (value instanceof Date) return value.toISOString();
    return "";
  }
  return String(value).trim();
}

function handleUpload(
  req: Parameters<ReturnType<typeof upload.single>>[0],
  res: Parameters<ReturnType<typeof upload.single>>[1],
): Promise<boolean> {
  return new Promise((resolve) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (!err) {
        resolve(true);
        return;
      }
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res
          .status(413)
          .json({ error: "File is too large — the limit is 10 MB." });
      } else {
        res.status(400).json({ error: "Could not process the uploaded file." });
      }
      resolve(false);
    });
  });
}

router.post(
  "/vehicles/import",
  async (req, res): Promise<void> => {
    if (!(await handleUpload(req, res))) return;
    if (!req.file) {
      res.status(400).json({ error: "No file provided (field name: file)" });
      return;
    }
    const dealerId = activeDealerId(res);

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    } catch {
      res
        .status(400)
        .json({ error: "Could not read the file — please upload a valid .xlsx spreadsheet." });
      return;
    }

    const sheet = workbook.worksheets[0];
    if (!sheet) {
      res.status(422).json({ error: "The spreadsheet has no worksheets." });
      return;
    }

    // Map columns from the header row.
    const columnFields = new Map<number, string>();
    const headerRow = sheet.getRow(1);
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const field = IMPORT_HEADER_MAP[normalizeHeader(cellText(cell.value))];
      if (field) columnFields.set(colNumber, field);
    });

    const mappedFields = new Set(columnFields.values());
    const requiredFields = [
      "make",
      "model",
      "year",
      "price",
      "powertrain",
      "mileageKm",
      "exteriorColor",
      "bodyType",
    ];
    const missing = requiredFields.filter((f) => !mappedFields.has(f));
    if (missing.length > 0) {
      res.status(422).json({
        error: `Missing required columns: ${missing.join(", ")}. Download the template for the expected format.`,
      });
      return;
    }

    const MAX_ROWS = 1000;

    // Resolve "Division" cells by name against the dealer's own divisions.
    const divisionIdByName = new Map<string, number>();
    for (const d of await db
      .select({ id: divisionsTable.id, name: divisionsTable.name })
      .from(divisionsTable)
      .where(eq(divisionsTable.dealerId, dealerId))) {
      divisionIdByName.set(d.name.trim().toLowerCase(), d.id);
    }

    const errors: { row: number; field?: string | null; message: string }[] = [];
    const validRows: { row: number; data: typeof CreateVehicleBody._type }[] = [];
    const seenVins = new Map<string, number>();
    let total = 0;

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const raw: Record<string, unknown> = {};
      let hasValue = false;
      for (const [colNumber, field] of columnFields) {
        const text = cellText(row.getCell(colNumber).value);
        if (text === "") continue;
        hasValue = true;
        if (NUMBER_FIELDS.has(field)) {
          const num = Number(text.replace(/[$,\s]/g, ""));
          raw[field] = Number.isFinite(num) ? num : text;
        } else if (LIST_FIELDS.has(field)) {
          raw[field] =
            field === "images"
              ? splitList(text).map(firstUrl)
              : splitList(text);
        } else if (field === "imageUrl") {
          raw[field] = firstUrl(text);
        } else if (field === "engineNumber" || field === "vin") {
          raw[field] = text.toUpperCase();
        } else if (field === "registration") {
          raw[field] = text.toUpperCase().replace(/[\s-]/g, "");
        } else if (field === "powertrain") {
          raw[field] = POWERTRAIN_ALIASES[text.toLowerCase()] ?? text;
        } else if (field === "status") {
          raw[field] = text.toLowerCase().replace(/[\s-]+/g, "_");
        } else if (field === "featured") {
          raw[field] = ["true", "yes", "1", "y"].includes(text.toLowerCase());
        } else {
          raw[field] = text;
        }
      }
      if (!hasValue) return; // fully empty row — skip silently
      total += 1;

      const divisionText = typeof raw["division"] === "string" ? raw["division"] : "";
      delete raw["division"];
      if (divisionText) {
        const divId = divisionIdByName.get(divisionText.trim().toLowerCase());
        if (divId === undefined) {
          errors.push({
            row: rowNumber,
            field: "division",
            message: `Unknown division "${divisionText}" — expected one of: ${[...divisionIdByName.keys()].join(", ") || "(none configured)"}.`,
          });
          return;
        }
        raw["divisionId"] = divId;
      }

      if (total > MAX_ROWS) {
        if (total === MAX_ROWS + 1) {
          errors.push({
            row: rowNumber,
            message: `Import limited to ${MAX_ROWS} rows per file — remaining rows skipped.`,
          });
        }
        return;
      }

      const parsed = CreateVehicleBody.safeParse(raw);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        errors.push({
          row: rowNumber,
          field: first ? String(first.path[0] ?? null) : null,
          message: issues,
        });
        return;
      }
      const vin = parsed.data.vin?.trim().toUpperCase();
      if (vin) {
        // Upsert key is (dealerId, vin): a VIN listed twice in the same file
        // means the LATER row wins — the earlier one is skipped and reported.
        const firstRow = seenVins.get(vin);
        if (firstRow !== undefined) {
          const idx = validRows.findIndex(
            (r) => r.data.vin?.trim().toUpperCase() === vin,
          );
          if (idx !== -1) validRows.splice(idx, 1);
          errors.push({
            row: firstRow,
            field: "vin",
            message: `Duplicate VIN ${vin} — superseded by row ${rowNumber} of this file (later row wins).`,
          });
        }
        seenVins.set(vin, rowNumber);
      }
      validRows.push({ row: rowNumber, data: parsed.data });
    });

    // Upsert by (dealerId, vin): rows whose VIN already exists UPDATE the
    // existing vehicle; new VINs (or VIN-less rows) INSERT.
    const existingByVin = new Map<string, number>();
    if (seenVins.size > 0) {
      const existing = await db
        .select({ id: vehiclesTable.id, vin: vehiclesTable.vin })
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.dealerId, dealerId),
            inArray(vehiclesTable.vin, [...seenVins.keys()]),
            isNull(vehiclesTable.deletedAt),
          ),
        );
      for (const r of existing) {
        const v = r.vin?.trim().toUpperCase();
        if (v) existingByVin.set(v, r.id);
      }
    }

    let inserted = 0;
    let updated = 0;
    const importDivisionId = await defaultDivisionId(dealerId);
    for (const { row, data } of validRows) {
      const vin = data.vin?.trim().toUpperCase();
      const existingId = vin ? existingByVin.get(vin) : undefined;
      try {
        if (existingId !== undefined) {
          // Never let an import perform an illegal status jump.
          const { status: requestedStatus, ...rest } = data;
          const [before] = await db
            .select({ status: vehiclesTable.status })
            .from(vehiclesTable)
            .where(eq(vehiclesTable.id, existingId));
          let statusPatch: Record<string, string> = {};
          if (
            requestedStatus &&
            before &&
            requestedStatus !== before.status
          ) {
            const allowed =
              VEHICLE_STATUS_TRANSITIONS[before.status as VehicleStatus] ?? [];
            if (allowed.includes(requestedStatus as VehicleStatus)) {
              statusPatch = { status: requestedStatus };
            } else {
              errors.push({
                row,
                field: "status",
                message: `Status ${before.status} → ${requestedStatus} is not a legal transition — other fields updated, status left unchanged.`,
              });
            }
          }
          await db
            .update(vehiclesTable)
            .set({ ...rest, ...statusPatch })
            .where(
              and(
                eq(vehiclesTable.id, existingId),
                eq(vehiclesTable.dealerId, dealerId),
              ),
            );
          updated += 1;
        } else {
          await db.insert(vehiclesTable).values({
            ...data,
            divisionId: data.divisionId ?? importDivisionId,
            dealerId,
          });
          inserted += 1;
        }
      } catch (err) {
        req.log.error({ err, row }, "vehicle import row write failed");
        errors.push({ row, message: "Database write failed for this row." });
      }
    }

    errors.sort((a, b) => a.row - b.row);
    res.json(
      ImportVehiclesResponse.parse({
        total,
        inserted,
        updated,
        skipped: total - inserted - updated,
        errors,
      }),
    );
  },
);

const TEMPLATE_COLUMNS: { header: string; example: string | number }[] = [
  { header: "Make", example: "BMW" },
  { header: "Model", example: "i7" },
  { header: "Trim", example: "xDrive60 M Sport" },
  { header: "Year", example: 2026 },
  { header: "VIN", example: "WBY73AW0XPCK00001" },
  { header: "Variant", example: "Long Wheelbase" },
  { header: "Engine Number", example: "ENG0000000PCK0001" },
  { header: "Registration", example: "PAB1234" },
  { header: "Division", example: "GT Automotive" },
  { header: "Transmission", example: "Single-speed automatic" },
  { header: "Price", example: 125000 },
  { header: "Powertrain", example: "EV" },
  { header: "Range (km)", example: 610 },
  { header: "Mileage (km)", example: 0 },
  { header: "Exterior Color", example: "Obsidian Black" },
  { header: "Body Type", example: "Sedan" },
  { header: "Status", example: "available" },
  { header: "Image URL", example: "/vehicles/bmw-i7.png" },
  { header: "Images", example: "https://example.com/front.jpg, https://example.com/interior.jpg" },
  { header: "Accessories", example: "Floor mats, Roof rack, Tow bar" },
  { header: "Description", example: "Flagship electric sedan." },
];

router.get("/vehicles/import/template", async (_req, res): Promise<void> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Vehicles");

  sheet.columns = TEMPLATE_COLUMNS.map((c) => ({
    header: c.header,
    width: Math.max(c.header.length + 4, 16),
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.addRow(TEMPLATE_COLUMNS.map((c) => c.example));

  const notes = workbook.addWorksheet("Notes");
  notes.addRow(["Required columns: Make, Model, Year, Price, Powertrain, Mileage (km), Exterior Color, Body Type"]);
  notes.addRow(["Powertrain: EV, Hybrid, Petrol or Diesel (Electric/Gas aliases accepted)"]);
  notes.addRow(["Status (optional): available, in_transit or service — defaults to available"]);
  notes.addRow(["VIN and Engine Number (optional) must be exactly 17 characters when provided"]);
  notes.addRow(["Registration (optional): 3 uppercase letters + 1-4 digits, e.g. PAB1234"]);
  notes.addRow(["Division (optional): must match one of your dealer's divisions by name"]);
  notes.addRow(["Images and Accessories (optional): separate multiple values with commas"]);
  notes.addRow(["Delete the example row before importing your own stock."]);
  notes.getColumn(1).width = 100;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="aura-inventory-import-template.xlsx"',
  );
  const buffer = await workbook.xlsx.writeBuffer();
  res.end(Buffer.from(buffer));
});

router.get("/vehicles/:id", async (req, res): Promise<void> => {
  const params = GetVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, params.data.id),
        eq(vehiclesTable.dealerId, activeDealerId(res)),
        isNull(vehiclesTable.deletedAt),
      ),
    );

  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  const [visible] = await redactHiddenFields(res.locals.user, "inventory", [
    vehicle,
  ]);

  // Server-computed price composition from dealer_taxes — the client never
  // computes tax (same deterministic engine as quotes/deals). Only attached
  // when the role can see `price`; derived amounts must not leak a redacted
  // price.
  let priceExtras: Record<string, unknown> = {};
  const priceVisible =
    visible != null &&
    typeof (visible as Record<string, unknown>).price === "number";
  if (priceVisible) try {
    const taxes = await ensureDealerTaxes(vehicle.dealerId);
    const composed = computeTaxes(vehicle.price, taxes, {
      powertrain: vehicle.powertrain,
    });
    priceExtras = {
      priceLines: composed.lines,
      priceTotalWithTax: composed.totalWithTax,
    };
  } catch (err) {
    req.log.error({ err, vehicleId: vehicle.id }, "vehicle price composition failed");
  }
  res.json(GetVehicleResponse.parse({ ...visible, ...priceExtras }));
});

router.patch("/vehicles/:id", async (req, res): Promise<void> => {
  const params = UpdateVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateVehicleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: vehicleIdentifierError(req.body ?? {}) ?? parsed.error.message,
    });
    return;
  }

  // Field-level permissions: reject edits to restricted field groups.
  const blocked = await findBlockedEditField(
    res.locals.user,
    "inventory",
    parsed.data,
  );
  if (blocked) {
    res.status(403).json({
      error: `Your role cannot edit ${blocked.groupLabel} (field: ${blocked.field})`,
    });
    return;
  }

  const dealerId = activeDealerId(res);
  if (
    parsed.data.divisionId != null &&
    !(await divisionBelongsToDealer(parsed.data.divisionId, dealerId))
  ) {
    res.status(404).json({ error: "Division not found" });
    return;
  }
  const [before] = await db
    .select({ status: vehiclesTable.status })
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, params.data.id),
        eq(vehiclesTable.dealerId, dealerId),
        isNull(vehiclesTable.deletedAt),
      ),
    );
  if (!before) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  // Enforce the stock-status lifecycle (Available→Reserved→Booked→Delivered).
  if (parsed.data.status && parsed.data.status !== before.status) {
    const allowed =
      VEHICLE_STATUS_TRANSITIONS[before.status as VehicleStatus] ?? [];
    if (!allowed.includes(parsed.data.status as VehicleStatus)) {
      // Concurrent soft-lock: trying to reserve a unit someone else already
      // locked is a conflict (re-fetch and pick again), not a bad request.
      if (
        (parsed.data.status === "reserved" || parsed.data.status === "booked") &&
        before.status !== "available"
      ) {
        res.status(409).json({
          error: `This unit is already ${before.status} — refresh and pick another VIN`,
        });
        return;
      }
      res.status(422).json({
        error: `Invalid status transition: ${before.status} → ${parsed.data.status}`,
      });
      return;
    }
  }

  // Race-safe soft-lock: when locking (available → reserved/booked) the
  // UPDATE is conditional on the row still being available — first writer
  // wins, the loser gets a 409 instead of silently double-locking.
  const locking =
    parsed.data.status &&
    parsed.data.status !== before.status &&
    (parsed.data.status === "reserved" || parsed.data.status === "booked") &&
    before.status === "available";

  const [vehicle] = await db
    .update(vehiclesTable)
    .set(parsed.data)
    .where(
      and(
        eq(vehiclesTable.id, params.data.id),
        eq(vehiclesTable.dealerId, dealerId),
        ...(locking ? [eq(vehiclesTable.status, "available")] : []),
      ),
    )
    .returning();

  if (locking && !vehicle) {
    res.status(409).json({
      error: "This unit was just locked by someone else — refresh and pick another VIN",
    });
    return;
  }

  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  res.json(UpdateVehicleResponse.parse(vehicle));
});

router.delete("/vehicles/:id", async (req, res): Promise<void> => {
  const params = DeleteVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Soft delete (R4.8): never hard-remove from the data plane.
  const actor = res.locals.user;
  const [vehicle] = await db
    .update(vehiclesTable)
    .set({
      deletedAt: new Date(),
      deletedBy: actor?.email ?? actor?.name ?? null,
    })
    .where(
      and(
        eq(vehiclesTable.id, params.data.id),
        eq(vehiclesTable.dealerId, activeDealerId(res)),
        isNull(vehiclesTable.deletedAt),
      ),
    )
    .returning();

  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  res.sendStatus(204);
});

// R4.8: restore a soft-deleted vehicle (delete-class privilege).
router.post("/vehicles/:id/restore", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const user = res.locals.user;
  if (!user || !hasPermission(user, "inventory", "delete")) {
    res.status(403).json({ error: "Missing permission: delete on inventory" });
    return;
  }
  const [vehicle] = await db
    .update(vehiclesTable)
    .set({ deletedAt: null, deletedBy: null })
    .where(
      and(
        eq(vehiclesTable.id, id),
        eq(vehiclesTable.dealerId, activeDealerId(res)),
        isNotNull(vehiclesTable.deletedAt),
      ),
    )
    .returning();
  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }
  res.json(UpdateVehicleResponse.parse(vehicle));
});

export default router;
