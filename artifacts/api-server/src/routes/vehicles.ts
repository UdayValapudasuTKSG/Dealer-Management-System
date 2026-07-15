import { Router, type IRouter } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { eq, desc, and, ilike, or, inArray, type SQL } from "drizzle-orm";
import {
  db,
  vehiclesTable,
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

const router: IRouter = Router();

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

  const filters: SQL[] = [];
  if (query.data.status) filters.push(eq(vehiclesTable.status, query.data.status));
  if (query.data.powertrain)
    filters.push(eq(vehiclesTable.powertrain, query.data.powertrain));
  if (query.data.search) {
    const term = `%${query.data.search}%`;
    const searchClause = or(
      ilike(vehiclesTable.make, term),
      ilike(vehiclesTable.model, term),
      ilike(vehiclesTable.bodyType, term),
    );
    if (searchClause) filters.push(searchClause);
  }

  const rows = await db
    .select()
    .from(vehiclesTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(vehiclesTable.featured), desc(vehiclesTable.createdAt));

  res.json(ListVehiclesResponse.parse(rows));
});

router.post("/vehicles", async (req, res): Promise<void> => {
  const parsed = CreateVehicleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [vehicle] = await db
    .insert(vehiclesTable)
    .values(parsed.data)
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
  description: "description",
  featured: "featured",
};

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
    const errors: { row: number; message: string }[] = [];
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
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        errors.push({ row: rowNumber, message: issues });
        return;
      }
      const vin = parsed.data.vin?.trim().toUpperCase();
      if (vin) {
        const firstRow = seenVins.get(vin);
        if (firstRow !== undefined) {
          errors.push({
            row: rowNumber,
            message: `Duplicate VIN ${vin} — already listed on row ${firstRow} of this file.`,
          });
          return;
        }
        seenVins.set(vin, rowNumber);
      }
      validRows.push({ row: rowNumber, data: parsed.data });
    });

    // Skip rows whose VIN already exists in inventory.
    if (seenVins.size > 0) {
      const existing = await db
        .select({ vin: vehiclesTable.vin })
        .from(vehiclesTable)
        .where(inArray(vehiclesTable.vin, [...seenVins.keys()]));
      const existingVins = new Set(
        existing.map((r) => r.vin?.trim().toUpperCase()).filter(Boolean),
      );
      if (existingVins.size > 0) {
        for (let i = validRows.length - 1; i >= 0; i--) {
          const entry = validRows[i]!;
          const vin = entry.data.vin?.trim().toUpperCase();
          if (vin && existingVins.has(vin)) {
            errors.push({
              row: entry.row,
              message: `A vehicle with VIN ${vin} already exists in inventory — row skipped.`,
            });
            validRows.splice(i, 1);
          }
        }
      }
    }

    let created = 0;
    for (const { row, data } of validRows) {
      try {
        await db.insert(vehiclesTable).values(data);
        created += 1;
      } catch (err) {
        req.log.error({ err, row }, "vehicle import row insert failed");
        errors.push({ row, message: "Database insert failed for this row." });
      }
    }

    errors.sort((a, b) => a.row - b.row);
    res.json(
      ImportVehiclesResponse.parse({
        total,
        created,
        failed: total - created,
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
  { header: "Engine", example: "Dual electric motors" },
  { header: "Transmission", example: "Single-speed automatic" },
  { header: "Price", example: 125000 },
  { header: "Powertrain", example: "EV" },
  { header: "Range (km)", example: 610 },
  { header: "Mileage (km)", example: 0 },
  { header: "Exterior Color", example: "Obsidian Black" },
  { header: "Body Type", example: "Sedan" },
  { header: "Status", example: "available" },
  { header: "Image URL", example: "/vehicles/bmw-i7.png" },
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
    .where(eq(vehiclesTable.id, params.data.id));

  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  res.json(GetVehicleResponse.parse(vehicle));
});

router.patch("/vehicles/:id", async (req, res): Promise<void> => {
  const params = UpdateVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateVehicleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [before] = await db
    .select({ status: vehiclesTable.status })
    .from(vehiclesTable)
    .where(eq(vehiclesTable.id, params.data.id));
  if (!before) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  // Enforce the stock-status lifecycle (Available→Reserved→Booked→Delivered).
  if (parsed.data.status && parsed.data.status !== before.status) {
    const allowed =
      VEHICLE_STATUS_TRANSITIONS[before.status as VehicleStatus] ?? [];
    if (!allowed.includes(parsed.data.status as VehicleStatus)) {
      res.status(422).json({
        error: `Invalid status transition: ${before.status} → ${parsed.data.status}`,
      });
      return;
    }
  }

  const [vehicle] = await db
    .update(vehiclesTable)
    .set(parsed.data)
    .where(eq(vehiclesTable.id, params.data.id))
    .returning();

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

  const [vehicle] = await db
    .delete(vehiclesTable)
    .where(eq(vehiclesTable.id, params.data.id))
    .returning();

  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
