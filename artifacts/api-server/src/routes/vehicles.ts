import { Router, type IRouter } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import {
  eq,
  desc,
  and,
  ilike,
  or,
  inArray,
  ne,
  isNull,
  isNotNull,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  db,
  vehiclesTable,
  auditLogsTable,
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
  ImportVehiclesQueryParams,
  PreviewVehicleModelYear2026Response,
  UpdateVehicleModelYear2026Body,
  UpdateVehicleModelYear2026Response,
} from "@workspace/api-zod";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import {
  findBlockedEditField,
  redactHiddenFields,
} from "../lib/field-permissions";
import { defaultDivisionId, divisionBelongsToDealer } from "./divisions";
import { computeTaxes, ensureDealerTaxes } from "../lib/taxes";
import { vehicleActivelyAllocated } from "../lib/reservation-allocations";
import {
  canonicalizeVehiclePowertrain,
  normalizePowertrain,
  normalizeVehiclePowertrainInput,
} from "../lib/vehicle-compat";
import {
  GT_AUTOMOTIVE_DEALER_ID,
  GT_AUTOMOTIVE_DEFAULT_YEAR,
  modelYearBulkScope,
  defaultVehicleYearForDealer,
  vehicleYearRequirementError,
  canNormalizeGtAutomotiveModelYears as canNormalizeGtAutomotiveModelYearsPolicy,
} from "../lib/model-year-bulk";

const router: IRouter = Router();

/** VIN and engine numbers accept 17–18 characters. */
export function vehicleIdentifierError(body: {
  vin?: string;
  engine?: string;
}): string | null {
  if (body.vin !== undefined && (body.vin.length < 17 || body.vin.length > 18))
    return "VIN must be 17 or 18 characters";
  if (body.engine !== undefined && (body.engine.length < 17 || body.engine.length > 18))
    return "Engine number must be 17 or 18 characters";
  return null;
}

function normalizeVin(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized || undefined;
}

function vinLockKey(dealerId: number): string {
  return `vehicle-vin:${dealerId}`;
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
  if (query.data.powertrain) {
    const powertrain = normalizePowertrain(query.data.powertrain);
    // Existing reviewed history may still contain the pre-contract
    // "electric" spelling.  Treat it as EV for filters without mutating the
    // imported row.
    filters.push(
      powertrain === "EV"
        ? or(eq(vehiclesTable.powertrain, "EV"), eq(vehiclesTable.powertrain, "electric"))!
        : eq(vehiclesTable.powertrain, String(powertrain)),
    );
  }
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
  res.json(ListVehiclesResponse.parse(visible.map(canonicalizeVehiclePowertrain)));
});

router.post("/vehicles", async (req, res): Promise<void> => {
  const normalizedBody = normalizeVehiclePowertrainInput(req.body);
  const dealerId = activeDealerId(res);
  const parsed = CreateVehicleBody.safeParse(normalizedBody);
  if (!parsed.success) {
    res.status(400).json({
      error: vehicleIdentifierError(normalizedBody ?? {}) ?? parsed.error.message,
    });
    return;
  }

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

  let divisionId = parsed.data.divisionId ?? null;
  if (divisionId != null && !(await divisionBelongsToDealer(divisionId, dealerId))) {
    res.status(404).json({ error: "Division not found" });
    return;
  }
  if (divisionId == null) divisionId = await defaultDivisionId(dealerId);

  const year = defaultVehicleYearForDealer(dealerId, parsed.data.year);
  const yearError = vehicleYearRequirementError(dealerId, parsed.data.year);
  if (year === undefined || yearError) {
    res.status(400).json({
      error: yearError ?? "Year is required for this dealership.",
    });
    return;
  }
  const normalizedVin = normalizeVin(parsed.data.vin);
  const createData = {
    ...parsed.data,
    year,
    ...(normalizedVin ? { vin: normalizedVin } : {}),
  };
  const outcome = await db.transaction(async (tx) => {
    if (normalizedVin) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${vinLockKey(dealerId)}))`,
      );
      const [collision] = await tx
        .select({ id: vehiclesTable.id })
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.dealerId, dealerId),
            isNull(vehiclesTable.deletedAt),
            eq(
              sql<string>`upper(btrim(${vehiclesTable.vin}))`,
              normalizedVin,
            ),
          ),
        )
        .limit(1);
      if (collision) return { kind: "vin-conflict" as const };
    }

    const [vehicle] = await tx
      .insert(vehiclesTable)
      .values({ ...createData, divisionId, dealerId })
      .returning();
    return { kind: "created" as const, vehicle };
  });

  if (outcome.kind === "vin-conflict") {
    res.status(409).json({
      error: `VIN ${normalizedVin} already belongs to an active vehicle.`,
    });
    return;
  }

  res.status(201).json(
    GetVehicleResponse.parse(canonicalizeVehiclePowertrain(outcome.vehicle)),
  );
});

// ---------------------------------------------------------------------------
// GT Automotive dealer-1 model-year normalization
// ---------------------------------------------------------------------------

router.get("/vehicles/model-year-2026", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  if (
    !canNormalizeGtAutomotiveModelYearsPolicy(
      dealerId,
      !!res.locals.user &&
        hasPermission(res.locals.user, "inventory", "edit"),
    )
  ) {
    res.status(403).json({
      error:
        "Only GT Automotive users with inventory edit permission can review model years.",
    });
    return;
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.dealerId, GT_AUTOMOTIVE_DEALER_ID),
        isNull(vehiclesTable.deletedAt),
        ne(vehiclesTable.year, GT_AUTOMOTIVE_DEFAULT_YEAR),
      ),
    );

  res.json(
    PreviewVehicleModelYear2026Response.parse({
      targetYear: GT_AUTOMOTIVE_DEFAULT_YEAR,
      affectedCount: Number(count ?? 0),
      scope: modelYearBulkScope(),
    }),
  );
});

router.post("/vehicles/model-year-2026", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const user = res.locals.user;
  if (
    !canNormalizeGtAutomotiveModelYearsPolicy(
      dealerId,
      !!user && hasPermission(user, "inventory", "edit"),
    )
  ) {
    res.status(403).json({
      error:
        "Only GT Automotive users with inventory edit permission can update model years.",
    });
    return;
  }
  const blocked = await findBlockedEditField(
    user,
    "inventory",
    { year: GT_AUTOMOTIVE_DEFAULT_YEAR },
  );
  if (blocked) {
    res.status(403).json({
      error: `Your role cannot edit ${blocked.groupLabel} (field: ${blocked.field})`,
    });
    return;
  }
  const parsedBody = UpdateVehicleModelYear2026Body.safeParse(req.body);
  if (!parsedBody.success || parsedBody.data.confirm !== true) {
    res.status(400).json({
      error: "Explicit confirmation is required to update all GT Automotive model years.",
    });
    return;
  }

  const scope = modelYearBulkScope();
  const result = await db.transaction(async (tx) => {
    const changed = await tx
      .update(vehiclesTable)
      .set({ year: GT_AUTOMOTIVE_DEFAULT_YEAR })
      .where(
        and(
          eq(vehiclesTable.dealerId, GT_AUTOMOTIVE_DEALER_ID),
          isNull(vehiclesTable.deletedAt),
          ne(vehiclesTable.year, GT_AUTOMOTIVE_DEFAULT_YEAR),
        ),
      )
      .returning({ id: vehiclesTable.id });
    const changedCount = changed.length;

    await tx.insert(auditLogsTable).values({
      dealerId: GT_AUTOMOTIVE_DEALER_ID,
      actorUserId: user?.id ?? null,
      actorClerkId: user?.clerkId ?? null,
      actorName: user?.name ?? null,
      actorEmail: user?.email ?? null,
      action: "update",
      module: "inventory",
      entityType: "vehicle_inventory",
      entityId: "model-year-2026",
      summary: `${user?.name ?? user?.email ?? "Inventory user"} set GT Automotive model years to 2026`,
      details: {
        targetYear: GT_AUTOMOTIVE_DEFAULT_YEAR,
        changedCount,
        scope,
        fieldsChanged: ["year"],
      },
    });

    return { changedCount };
  });

  res.json(
    UpdateVehicleModelYear2026Response.parse({
      targetYear: GT_AUTOMOTIVE_DEFAULT_YEAR,
      changedCount: result.changedCount,
      scope,
    }),
  );
});

// ---------------------------------------------------------------------------
// Canonical workbook column definition — shared by template + export
// ---------------------------------------------------------------------------

type WorkbookColumn = {
  /** Spreadsheet header text */
  header: string;
  /** Example value shown in the template */
  example: string | number;
  /** exceljs numFmt — undefined means plain text/general */
  numFmt?: string;
  /** When true, force text format (prefix @) */
  asText?: boolean;
  /** Width hint (chars) */
  width?: number;
};

/**
 * Single canonical column list.  Inventory ID comes first; Featured last.
 * money columns use GYD format; text identifiers force text format.
 */
const WORKBOOK_COLUMNS: WorkbookColumn[] = [
  {
    header: "Inventory ID",
    example: "",
    asText: true,
    width: 14,
  },
  { header: "VIN", example: "WBY73AW0XPCK00001", asText: true, width: 20 },
  { header: "Make", example: "BMW", width: 14 },
  { header: "Model", example: "i7", width: 14 },
  { header: "Trim", example: "xDrive60 M Sport", width: 22 },
  { header: "Year", example: 2026, width: 8 },
  {
    header: "Engine Number",
    example: "ENG0000000PCK0001",
    asText: true,
    width: 22,
  },
  {
    header: "Engine",
    example: "ENG0000000PCK0001",
    asText: true,
    width: 22,
  },
  {
    header: "Registration",
    example: "PAB1234",
    asText: true,
    width: 14,
  },
  { header: "Division", example: "GT Automotive", width: 18 },
  { header: "Transmission", example: "Single-speed automatic", width: 24 },
  {
    header: "Price",
    example: 25000000,
    numFmt: "#,##0",
    width: 16,
  },
  {
    header: "Duty-free Amount (GYD)",
    example: 0,
    numFmt: "#,##0",
    width: 24,
  },
  { header: "Powertrain", example: "EV", width: 14 },
  { header: "Range (km)", example: 610, width: 12 },
  { header: "Mileage (km)", example: 0, width: 12 },
  { header: "Exterior Color", example: "Obsidian Black", width: 18 },
  { header: "Body Type", example: "Sedan", width: 14 },
  { header: "Status", example: "available", width: 14 },
  { header: "Variant", example: "Long Wheelbase", width: 18 },
  { header: "Image URL", example: "/vehicles/bmw-i7.png", width: 30 },
  {
    header: "Images",
    example:
      "https://example.com/front.jpg, https://example.com/interior.jpg",
    width: 50,
  },
  {
    header: "Accessories",
    example: "Floor mats, Roof rack, Tow bar",
    width: 36,
  },
  { header: "Description", example: "Flagship electric sedan.", width: 36 },
  { header: "Featured", example: "false", width: 10 },
];

/** Apply text / money cell formats to a header row and all data rows. */
function applyColumnFormats(sheet: ExcelJS.Worksheet): void {
  WORKBOOK_COLUMNS.forEach((col, idx) => {
    const excelCol = sheet.getColumn(idx + 1);
    excelCol.width = col.width ?? Math.max(col.header.length + 4, 14);
    if (col.asText) {
      excelCol.numFmt = "@";
    } else if (col.numFmt) {
      excelCol.numFmt = col.numFmt;
    }
  });
}

function buildInstructionsSheet(workbook: ExcelJS.Workbook): void {
  const notes = workbook.addWorksheet("Instructions");
  const rows = [
    ["AURA Inventory Spreadsheet — Import Instructions"],
    [""],
    [
      "1. Inventory ID (column A): IDs come from AURA exports. Do not change or invent them; leave the cell blank only for a new vehicle.",
    ],
    [
      "2. When Inventory ID is filled, it is the sole update key — VIN is ignored for matching.",
    ],
    [
      "3. When Inventory ID is blank and VIN is provided, a matching active vehicle in this dealer will be updated; otherwise a new vehicle is created.",
    ],
    ["4. Duplicate Inventory IDs or duplicate VINs within the file are rejected as row errors."],
    [""],
    ["Required columns: Make, Model, Year, Price, Powertrain, Mileage (km), Exterior Color, Body Type. GT Automotive (dealer 1) may leave Year blank for new rows; it defaults to 2026."],
    [""],
    ["Powertrain values: EV, Hybrid, Petrol, Diesel  (aliases: Electric/BEV → EV; Gas/Gasoline → Petrol; PHEV → Hybrid)"],
    ["Status (optional): available, reserved, booked, delivered, in_transit, sold, service, under_repair  (defaults to available for new vehicles)"],
    ["VIN and Engine Number (optional): must be 17 or 18 characters when provided."],
    ["Registration (optional): 3 uppercase letters followed by 1–4 digits, e.g. PAB1234"],
    ["Division (optional): must match one of this dealer's division names exactly"],
    ["Duty-free Amount (GYD): non-negative GYD amount; leave blank or 0 if not applicable"],
    ["Price: stored in GYD"],
    ["Images and Accessories: separate multiple values with commas"],
    ["Featured: true or false"],
    [""],
    ["Template row: The example row in the Vehicles sheet is clearly marked — delete it before importing your stock."],
    ["Row limit: 1 000 data rows per file; 10 MB file size limit."],
  ];
  for (const r of rows) {
    notes.addRow(r);
  }
  notes.getColumn(1).width = 110;
  notes.getRow(1).font = { bold: true, size: 13 };
}

// ---------------------------------------------------------------------------
// GET /vehicles/export — current inventory as Excel workbook
// ---------------------------------------------------------------------------

router.get("/vehicles/export", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);

  // This workbook is generated from live, dealer-scoped, permission-redacted
  // data. Never let a browser or reverse proxy satisfy it with a bodyless 304.
  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, max-age=0, must-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.removeHeader("ETag");

  // Fetch active, non-deleted vehicles for this dealer.
  const rows = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.dealerId, dealerId),
        isNull(vehiclesTable.deletedAt),
      ),
    )
    .orderBy(desc(vehiclesTable.featured), desc(vehiclesTable.createdAt));

  // Fetch division lookup for this dealer.
  const divisions = await db
    .select({ id: divisionsTable.id, name: divisionsTable.name })
    .from(divisionsTable)
    .where(eq(divisionsTable.dealerId, dealerId));
  const divisionNameById = new Map(divisions.map((d) => [d.id, d.name]));

  // Redact hidden fields before writing (field-permission aware).
  const visible = await redactHiddenFields(res.locals.user, "inventory", rows);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Vehicles");

  // Header row.
  sheet.addRow(WORKBOOK_COLUMNS.map((c) => c.header));
  sheet.getRow(1).font = { bold: true };

  // Data rows.
  for (const v of visible) {
    const r = v as Record<string, unknown>;
    sheet.addRow([
      r["id"] != null ? String(r["id"]) : "",
      r["vin"] != null ? String(r["vin"]) : "",
      r["make"] ?? "",
      r["model"] ?? "",
      r["trim"] ?? "",
      r["year"] ?? "",
      r["engineNumber"] ?? "",
      r["engine"] ?? "",
      r["registration"] ?? "",
      r["divisionId"] != null
        ? (divisionNameById.get(r["divisionId"] as number) ?? "")
        : "",
      r["transmission"] ?? "",
      r["price"] ?? 0,
      r["dutyFreeAmount"] ?? 0,
      normalizePowertrain(r["powertrain"]) ?? "",
      r["rangeKm"] ?? "",
      r["mileageKm"] ?? "",
      r["exteriorColor"] ?? "",
      r["bodyType"] ?? "",
      r["status"] ?? "",
      r["variant"] ?? "",
      r["imageUrl"] ?? "",
      Array.isArray(r["images"]) ? (r["images"] as string[]).join(", ") : "",
      Array.isArray(r["accessories"])
        ? (r["accessories"] as string[]).join(", ")
        : "",
      r["description"] ?? "",
      r["featured"] ? "true" : "false",
    ]);
  }

  applyColumnFormats(sheet);
  buildInstructionsSheet(workbook);

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="aura-current-inventory.xlsx"',
  );
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Length", String(buffer.byteLength));
  req.log.info(
    { dealerId, rowCount: visible.length },
    "vehicle inventory exported",
  );
  res.end(Buffer.from(buffer));
});

// ---------------------------------------------------------------------------
// Bulk import from Excel
// ---------------------------------------------------------------------------

/** Normalized header text → vehicle field name. */
const IMPORT_HEADER_MAP: Record<string, string> = {
  inventoryid: "inventoryId",
  id: "inventoryId",
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
  dutyfreeamountgyd: "dutyFreeAmount",
  dutyfreeamount: "dutyFreeAmount",
  dutyfree: "dutyFreeAmount",
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

/**
 * Normalise a vehicle DB row into the same shape produced by CreateVehicleBody
 * parsing so that exported-then-reimported rows compare as unchanged.
 */
function normalizeExistingRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const stringFields = [
    "make", "model", "trim", "variant", "engine", "transmission",
    "exteriorColor", "bodyType", "imageUrl", "description",
    "vin", "engineNumber", "registration", "powertrain",
  ];
  for (const f of stringFields) {
    const v = row[f];
    out[f] =
      v != null && v !== ""
        ? f === "powertrain"
          ? normalizePowertrain(v)
          : String(v)
        : undefined;
  }
  // Numbers
  const numFields = ["year", "price", "rangeKm", "mileageKm", "dutyFreeAmount"];
  for (const f of numFields) {
    const v = row[f];
    out[f] = v != null ? Number(v) : undefined;
  }
  // dutyFreeAmount defaults to 0 from DB, match CreateVehicleBody default
  if (out["dutyFreeAmount"] == null) out["dutyFreeAmount"] = 0;
  // Status
  out["status"] = row["status"] ?? "available";
  // Boolean
  out["featured"] = Boolean(row["featured"]);
  // Arrays
  out["images"] = Array.isArray(row["images"]) ? row["images"] : [];
  out["accessories"] = Array.isArray(row["accessories"])
    ? row["accessories"]
    : [];
  out["documents"] = Array.isArray(row["documents"]) ? row["documents"] : [];
  // divisionId
  if (row["divisionId"] != null) out["divisionId"] = Number(row["divisionId"]);
  return out;
}

/**
 * Compare an imported CreateVehicleBody payload against a normalised existing
 * row. Returns true when they are logically equivalent (no write needed).
 */
/**
 * Default values that CreateVehicleBody applies when a field is absent.
 * Used so that an exported-then-reimported workbook that omits optional
 * fields with their DB defaults still counts as "unchanged".
 */
const IMPORT_DEFAULTS: Record<string, unknown> = {
  status: "available",
  featured: false,
  dutyFreeAmount: 0,
};

function isUnchanged(
  imported: typeof CreateVehicleBody._type,
  existing: Record<string, unknown>,
): boolean {
  const imp = imported as Record<string, unknown>;
  const scalarFields = [
    "make", "model", "trim", "variant", "engine", "transmission",
    "exteriorColor", "bodyType", "imageUrl", "description",
    "vin", "engineNumber", "registration",
    "year", "price", "rangeKm", "mileageKm", "dutyFreeAmount",
    "status", "featured", "powertrain", "divisionId",
  ];
  for (const f of scalarFields) {
    // A blank Year cell on an existing import row means "leave the current
    // year unchanged"; only newly-created GT Automotive rows receive the
    // dealer-specific default at insert time.
    if (f === "year" && imp[f] === undefined) continue;
    // For fields with create defaults, treat an absent import value as its
    // default so that an exported workbook reimports as unchanged.
    const dflt = IMPORT_DEFAULTS[f];
    const iv = imp[f] !== undefined ? imp[f] : dflt;
    const ev = existing[f] !== undefined ? existing[f] : dflt;
    if (iv !== ev) return false;
  }
  // Arrays: images, accessories
  for (const f of ["images", "accessories"] as const) {
    const iv: string[] = Array.isArray(imp[f]) ? (imp[f] as string[]) : [];
    const ev: string[] = Array.isArray(existing[f])
      ? (existing[f] as string[])
      : [];
    if (iv.length !== ev.length) return false;
    for (let i = 0; i < iv.length; i++) {
      if (iv[i] !== ev[i]) return false;
    }
  }
  return true;
}

type VehicleImportUpdate = Partial<typeof vehiclesTable.$inferInsert>;

const NULLABLE_IMPORT_FIELDS = [
  "trim",
  "vin",
  "engineNumber",
  "registration",
  "variant",
  "engine",
  "transmission",
  "rangeKm",
  "imageUrl",
  "description",
] as const;

/**
 * Blank optional cells in an update mean "clear this value", while blank
 * status means "leave the lifecycle unchanged". New rows keep DB defaults.
 */
function buildUpdatePatch(
  data: typeof CreateVehicleBody._type,
  blankFields: ReadonlySet<string>,
): VehicleImportUpdate {
  const patch: VehicleImportUpdate = { ...data };
  for (const field of NULLABLE_IMPORT_FIELDS) {
    if (blankFields.has(field)) {
      (patch as Record<string, unknown>)[field] = null;
    }
  }
  if (blankFields.has("division")) patch.divisionId = null;
  if (blankFields.has("images")) patch.images = [];
  if (blankFields.has("accessories")) patch.accessories = [];
  if (blankFields.has("featured")) patch.featured = false;
  if (blankFields.has("status")) delete patch.status;
  return patch;
}

function importValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return left === right;
}

function importedFieldsChangedConcurrently(
  current: typeof vehiclesTable.$inferSelect,
  baseline: typeof vehiclesTable.$inferSelect,
  patch: VehicleImportUpdate,
  includeStatus = false,
): boolean {
  const currentNormalized = normalizeExistingRow(current);
  const baselineNormalized = normalizeExistingRow(baseline);
  return Object.keys(patch)
    .filter((field) => includeStatus || field !== "status")
    .some((field) =>
      !importValuesEqual(
        currentNormalized[field],
        baselineNormalized[field],
      ),
    );
}

router.post(
  "/vehicles/import",
  async (req, res): Promise<void> => {
    if (!(await handleUpload(req, res))) return;
    if (!req.file) {
      res.status(400).json({ error: "No file provided (field name: file)" });
      return;
    }

    // Parse mode query param; default preview.
    const queryParsed = ImportVehiclesQueryParams.safeParse(req.query);
    if (!queryParsed.success) {
      res.status(400).json({ error: queryParsed.error.message });
      return;
    }
    const mode = queryParsed.data.mode;

    const dealerId = activeDealerId(res);
    const user = res.locals.user;

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
      "price",
      "powertrain",
      "mileageKm",
      "exteriorColor",
      "bodyType",
    ];
    if (dealerId !== GT_AUTOMOTIVE_DEALER_ID) requiredFields.splice(2, 0, "year");
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

    type RowError = { row: number; field?: string | null; message: string };
    const errors: RowError[] = [];
    const validRows: {
      row: number;
      data: typeof CreateVehicleBody._type;
      inventoryId: number | null;
      blankFields: Set<string>;
    }[] = [];

    // Duplicate detection maps: track first-seen row for each key.
    const seenInventoryIds = new Map<number, number>(); // id → first rowNumber
    const seenVins = new Map<string, number>(); // normalised VIN → first rowNumber

    let total = 0;

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const raw: Record<string, unknown> = {};
      let hasValue = false;
      let rawInventoryIdText = "";
      const blankFields = new Set<string>();

      for (const [colNumber, field] of columnFields) {
        const text = cellText(row.getCell(colNumber).value);
        if (field === "inventoryId") {
          rawInventoryIdText = text;
          // Don't add to raw here; handle separately below.
          if (text !== "") hasValue = true;
          continue;
        }
        if (text === "") {
          blankFields.add(field);
          continue;
        }
        hasValue = true;
        if (NUMBER_FIELDS.has(field)) {
          const num = Number(text.replace(/[$,\s]/g, ""));
          raw[field] = Number.isFinite(num) ? num : text;
        } else if (field === "dutyFreeAmount") {
          // Blank → 0. Reject negative/non-finite.
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
          raw[field] = normalizePowertrain(text);
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

      // Handle dutyFreeAmount: blank → 0 (default).
      if (raw["dutyFreeAmount"] === undefined) {
        raw["dutyFreeAmount"] = 0;
      } else {
        const dfa = raw["dutyFreeAmount"];
        if (typeof dfa === "number") {
          if (!Number.isFinite(dfa) || dfa < 0) {
            errors.push({
              row: rowNumber,
              field: "dutyFreeAmount",
              message: `Duty-free amount must be a non-negative finite number (got ${dfa}).`,
            });
            return;
          }
        }
      }

      // Parse Inventory ID.
      let inventoryId: number | null = null;
      if (rawInventoryIdText !== "") {
        const parsed = Number(rawInventoryIdText.replace(/[$,\s]/g, ""));
        if (!Number.isInteger(parsed) || parsed <= 0) {
          errors.push({
            row: rowNumber,
            field: "inventoryId",
            message: `Inventory ID must be a positive integer (got "${rawInventoryIdText}").`,
          });
          return;
        }
        inventoryId = parsed;
      }

      // Resolve "Division" name → id.
      const divisionText =
        typeof raw["division"] === "string" ? raw["division"] : "";
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

      // Reject in-file duplicate Inventory IDs.
      if (inventoryId !== null) {
        const firstSeen = seenInventoryIds.get(inventoryId);
        if (firstSeen !== undefined) {
          errors.push({
            row: rowNumber,
            field: "inventoryId",
            message: `Duplicate Inventory ID ${inventoryId} — already seen at row ${firstSeen}. Both rows are rejected.`,
          });
          // Also reject the earlier row if it was accepted.
          const earlierIdx = validRows.findIndex(
            (r) => r.inventoryId === inventoryId,
          );
          if (earlierIdx !== -1) {
            errors.push({
              row: firstSeen,
              field: "inventoryId",
              message: `Duplicate Inventory ID ${inventoryId} — also seen at row ${rowNumber}. Both rows are rejected.`,
            });
            validRows.splice(earlierIdx, 1);
          }
          return;
        }
        seenInventoryIds.set(inventoryId, rowNumber);
      }

      // Reject duplicate VINs across every row, including ID-keyed updates.
      const vin = typeof raw["vin"] === "string"
        ? raw["vin"].trim().toUpperCase()
        : undefined;
      if (vin) {
        const firstSeen = seenVins.get(vin);
        if (firstSeen !== undefined) {
          errors.push({
            row: rowNumber,
            field: "vin",
            message: `Duplicate VIN ${vin} — already seen at row ${firstSeen}. Both rows are rejected.`,
          });
          const earlierIdx = validRows.findIndex(
            (r) => r.data.vin?.trim().toUpperCase() === vin,
          );
          if (earlierIdx !== -1) {
            errors.push({
              row: firstSeen,
              field: "vin",
              message: `Duplicate VIN ${vin} — also seen at row ${rowNumber}. Both rows are rejected.`,
            });
            validRows.splice(earlierIdx, 1);
          }
          return;
        }
        seenVins.set(vin, rowNumber);
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
      if (parsed.data.year === undefined && dealerId !== GT_AUTOMOTIVE_DEALER_ID) {
        errors.push({
          row: rowNumber,
          field: "year",
          message: "Year is required for this dealership.",
        });
        return;
      }

      validRows.push({
        row: rowNumber,
        data: parsed.data,
        inventoryId,
        blankFields,
      });
    });

    // -----------------------------------------------------------------------
    // Resolve update targets from the DB
    // -----------------------------------------------------------------------

    // Collect IDs-by-inventory-id.
    const idSet = new Set(
      validRows
        .filter((r) => r.inventoryId !== null)
        .map((r) => r.inventoryId as number),
    );

    // Collect every imported VIN so ID-keyed VIN changes are collision-checked.
    const vinSet = new Set(
      validRows
        .filter((r) => r.data.vin)
        .map((r) => r.data.vin!.trim().toUpperCase()),
    );

    // Fetch existing vehicles by Inventory ID strictly within the active
    // dealer. Foreign/deleted/unknown IDs are intentionally indistinguishable.
    const existingById = new Map<
      number,
      {
        id: number;
        vin: string | null;
        status: string;
      }
    >();
    if (idSet.size > 0) {
      const rows = await db
        .select({
          id: vehiclesTable.id,
          vin: vehiclesTable.vin,
          status: vehiclesTable.status,
        })
        .from(vehiclesTable)
        .where(
          and(
            inArray(vehiclesTable.id, [...idSet]),
            eq(vehiclesTable.dealerId, dealerId),
            isNull(vehiclesTable.deletedAt),
          ),
        );
      for (const r of rows) {
        existingById.set(r.id, r);
      }
    }

    // Fetch existing active (non-deleted) vehicles by VIN for dealer (VIN
    // fallback path only).
    const existingByVin = new Map<
      string,
      { id: number; vin: string | null; status: string }[]
    >();
    if (vinSet.size > 0) {
      const rows = await db
        .select({
          id: vehiclesTable.id,
          vin: vehiclesTable.vin,
          status: vehiclesTable.status,
        })
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.dealerId, dealerId),
            inArray(
              sql<string>`upper(btrim(${vehiclesTable.vin}))`,
              [...vinSet],
            ),
            isNull(vehiclesTable.deletedAt),
          ),
        );
      for (const r of rows) {
        const v = r.vin?.trim().toUpperCase();
        if (v) {
          const matches = existingByVin.get(v) ?? [];
          matches.push(r);
          existingByVin.set(v, matches);
        }
      }
    }

    // Fetch full existing rows for unchanged comparison (only update candidates).
    const updateCandidateIds: number[] = [];
    for (const { inventoryId, data } of validRows) {
      if (inventoryId !== null) {
        const ex = existingById.get(inventoryId);
        if (ex) updateCandidateIds.push(ex.id);
      } else if (data.vin) {
        const v = data.vin.trim().toUpperCase();
        const matches = existingByVin.get(v);
        if (matches?.length === 1) updateCandidateIds.push(matches[0]!.id);
      }
    }

    const existingFullById = new Map<number, Record<string, unknown>>();
    if (updateCandidateIds.length > 0) {
      const rows = await db
        .select()
        .from(vehiclesTable)
        .where(
          and(
            inArray(vehiclesTable.id, updateCandidateIds),
            eq(vehiclesTable.dealerId, dealerId),
            isNull(vehiclesTable.deletedAt),
          ),
        );
      for (const r of rows) {
        existingFullById.set(r.id, r as Record<string, unknown>);
      }
    }

    // -----------------------------------------------------------------------
    // Per-row classification & permission checks
    // -----------------------------------------------------------------------

    type ClassifiedRow = {
      row: number;
      data: typeof CreateVehicleBody._type;
      inventoryId: number | null;
      kind: "insert" | "update" | "unchanged";
      existingDbId?: number;
      existingStatus?: string;
      updatePatch?: VehicleImportUpdate;
      existingSnapshot?: typeof vehiclesTable.$inferSelect;
    };

    const classified: ClassifiedRow[] = [];
    const rowErrors: RowError[] = [];

    for (const { row, data, inventoryId, blankFields } of validRows) {
      // --- Resolve existing record ---
      let resolvedDbId: number | undefined;
      let resolvedExisting: Record<string, unknown> | undefined;
      let resolvedStatus: string | undefined;

      if (inventoryId !== null) {
        // Inventory ID is the authoritative key.
        const ex = existingById.get(inventoryId);
        if (!ex) {
          // Unknown ID — never leak whether it belongs to another dealer.
          rowErrors.push({
            row,
            field: "inventoryId",
            message: `Inventory ID ${inventoryId} was not found or is not available.`,
          });
          continue;
        }
        resolvedDbId = ex.id;
        resolvedExisting = existingFullById.get(ex.id);
        resolvedStatus = ex.status;

        // Detect VIN collision: if imported VIN differs from existing VIN and
        // the new VIN is already used by another active vehicle.
        const importedVin = data.vin?.trim().toUpperCase();
        const existingVin = ex.vin?.trim().toUpperCase();
        if (importedVin && importedVin !== existingVin) {
          const vinColliders = existingByVin.get(importedVin) ?? [];
          if (vinColliders.some((candidate) => candidate.id !== resolvedDbId)) {
            rowErrors.push({
              row,
              field: "vin",
              message: `VIN ${importedVin} is already assigned to another active vehicle in this dealer.`,
            });
            continue;
          }
        }
      } else {
        // Blank ID — attempt VIN lookup, then create.
        const vin = data.vin?.trim().toUpperCase();
        if (vin) {
          const matches = existingByVin.get(vin) ?? [];
          if (matches.length > 1) {
            rowErrors.push({
              row,
              field: "vin",
              message: `VIN ${vin} matches more than one active vehicle. Add the correct Inventory ID before importing.`,
            });
            continue;
          }
          const ex = matches[0];
          if (ex) {
            resolvedDbId = ex.id;
            resolvedExisting = existingFullById.get(ex.id);
            resolvedStatus = ex.status;
          }
        }
        // resolvedDbId still undefined → insert path.
      }

      // --- Permission check ---
      const isUpdate = resolvedDbId !== undefined;
      const updatePatch = isUpdate
        ? buildUpdatePatch(data, blankFields)
        : undefined;
      if (isUpdate) {
        // Requires inventory:edit permission.
        if (!hasPermission(user!, "inventory", "edit")) {
          rowErrors.push({
            row,
            field: null,
            message: "Missing permission: edit on inventory",
          });
          continue;
        }
        // Check field-level restrictions on changed fields only.
        const changedFields: Record<string, unknown> = {};
        if (resolvedExisting) {
          const norm = normalizeExistingRow(resolvedExisting);
          const imp = updatePatch as Record<string, unknown>;
          for (const k of Object.keys(imp)) {
            const comparableValue = imp[k] === null ? undefined : imp[k];
            if (comparableValue !== norm[k]) changedFields[k] = imp[k];
          }
        } else {
          Object.assign(changedFields, data);
        }
        if (Object.keys(changedFields).length > 0) {
          const blocked = await findBlockedEditField(
            user,
            "inventory",
            changedFields,
          );
          if (blocked) {
            rowErrors.push({
              row,
              field: blocked.field,
              message: `Your role cannot edit ${blocked.groupLabel} (field: ${blocked.field})`,
            });
            continue;
          }
        }
      } else {
        // Requires inventory:create permission.
        if (!hasPermission(user!, "inventory", "create")) {
          rowErrors.push({
            row,
            field: null,
            message: "Missing permission: create on inventory",
          });
          continue;
        }
        const blocked = await findBlockedEditField(
          user,
          "inventory",
          data as Record<string, unknown>,
        );
        if (blocked) {
          rowErrors.push({
            row,
            field: blocked.field,
            message: `Your role cannot edit ${blocked.groupLabel} (field: ${blocked.field})`,
          });
          continue;
        }
      }

      // --- Status transition check ---
      if (isUpdate && data.status && resolvedStatus && data.status !== resolvedStatus) {
        const allowed =
          VEHICLE_STATUS_TRANSITIONS[resolvedStatus as VehicleStatus] ?? [];
        if (!allowed.includes(data.status as VehicleStatus)) {
          rowErrors.push({
            row,
            field: "status",
            message: `Status ${resolvedStatus} → ${data.status} is not a legal transition.`,
          });
          continue;
        }
        if (
          resolvedDbId != null &&
          (await vehicleActivelyAllocated(resolvedDbId, dealerId))
        ) {
          rowErrors.push({
            row,
            field: "status",
            message:
              "This VIN is temporarily held for a paid reservation — resolve the deal instead of importing a status change.",
          });
          continue;
        }
      }

      // --- Unchanged detection ---
      if (isUpdate && resolvedExisting) {
        const norm = normalizeExistingRow(resolvedExisting);
        const comparable = {
          ...data,
          ...(blankFields.has("images") ? { images: [] } : {}),
          ...(blankFields.has("accessories") ? { accessories: [] } : {}),
          ...(blankFields.has("featured") ? { featured: false } : {}),
          ...(blankFields.has("status")
            ? { status: norm["status"] as typeof data.status }
            : {}),
        };
        if (isUnchanged(comparable, norm)) {
          classified.push({
            row,
            data,
            inventoryId,
            kind: "unchanged",
            existingDbId: resolvedDbId,
            existingStatus: resolvedStatus,
            updatePatch,
            existingSnapshot: resolvedExisting as
              | typeof vehiclesTable.$inferSelect
              | undefined,
          });
          continue;
        }
      }

      classified.push({
        row,
        data,
        inventoryId,
        kind: isUpdate ? "update" : "insert",
        existingDbId: resolvedDbId,
        existingStatus: resolvedStatus,
        updatePatch,
        existingSnapshot: resolvedExisting as
          | typeof vehiclesTable.$inferSelect
          | undefined,
      });
    }

    // Merge row errors from per-row checks.
    errors.push(...rowErrors);

    const wouldInsert = classified.filter((r) => r.kind === "insert").length;
    const wouldUpdate = classified.filter((r) => r.kind === "update").length;
    const wouldUnchanged = classified.filter((r) => r.kind === "unchanged").length;

    if (mode === "preview") {
      errors.sort((a, b) => a.row - b.row);
      res.json(
        ImportVehiclesResponse.parse({
          mode: "preview",
          total,
          inserted: wouldInsert,
          updated: wouldUpdate,
          unchanged: wouldUnchanged,
          skipped:
            total -
            wouldInsert -
            wouldUpdate -
            wouldUnchanged,
          errors,
        }),
      );
      return;
    }

    // -----------------------------------------------------------------------
    // Apply mode: revalidate and persist
    // -----------------------------------------------------------------------

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const importDivisionId = await defaultDivisionId(dealerId);

    for (const cr of classified) {
      try {
        const outcome = await db.transaction(async (tx) => {
          if (
            cr.kind === "unchanged" &&
            cr.existingDbId !== undefined &&
            cr.existingSnapshot
          ) {
            const [current] = await tx
              .select()
              .from(vehiclesTable)
              .where(
                and(
                  eq(vehiclesTable.id, cr.existingDbId),
                  eq(vehiclesTable.dealerId, dealerId),
                  isNull(vehiclesTable.deletedAt),
                ),
              )
              .for("update");
            if (
              !current ||
              importedFieldsChangedConcurrently(
                current,
                cr.existingSnapshot,
                cr.updatePatch ?? cr.data,
                true,
              )
            ) {
              return { kind: "concurrent" as const };
            }
            return { kind: "unchanged" as const };
          }

          if (cr.kind === "update" && cr.existingDbId !== undefined) {
            const existingId = cr.existingDbId;
            const patch = cr.updatePatch ?? cr.data;
            const normalizedPatchVin =
              typeof patch.vin === "string"
                ? normalizeVin(patch.vin)
                : undefined;

            if ("vin" in patch) {
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${vinLockKey(dealerId)}))`,
              );
            }

            const [current] = await tx
              .select()
              .from(vehiclesTable)
              .where(
                and(
                  eq(vehiclesTable.id, existingId),
                  eq(vehiclesTable.dealerId, dealerId),
                  isNull(vehiclesTable.deletedAt),
                ),
              )
              .for("update");

            if (!current) return { kind: "concurrent" as const };
            if (
              cr.existingSnapshot &&
              importedFieldsChangedConcurrently(
                current,
                cr.existingSnapshot,
                patch,
              )
            ) {
              return { kind: "concurrent" as const };
            }

            const requestedStatus = patch.status;
            let statusPatch: { status?: string } = {};
            if (requestedStatus && requestedStatus !== current.status) {
              const allowed =
                VEHICLE_STATUS_TRANSITIONS[current.status as VehicleStatus] ??
                [];
              if (!allowed.includes(requestedStatus as VehicleStatus)) {
                return {
                  kind: "status-conflict" as const,
                  currentStatus: current.status,
                  requestedStatus,
                };
              }
              statusPatch = { status: requestedStatus };
            }

            if (normalizedPatchVin) {
              const collisions = await tx
                .select({ id: vehiclesTable.id })
                .from(vehiclesTable)
                .where(
                  and(
                    eq(vehiclesTable.dealerId, dealerId),
                    isNull(vehiclesTable.deletedAt),
                    eq(
                      sql<string>`upper(btrim(${vehiclesTable.vin}))`,
                      normalizedPatchVin,
                    ),
                  ),
                );
              if (collisions.some((vehicle) => vehicle.id !== existingId)) {
                return {
                  kind: "vin-conflict" as const,
                  vin: normalizedPatchVin,
                };
              }
            }

            const writePatch: VehicleImportUpdate = {
              ...patch,
              ...(normalizedPatchVin ? { vin: normalizedPatchVin } : {}),
            };
            const { status: _status, ...rest } = writePatch;
            const [updatedRow] = await tx
              .update(vehiclesTable)
              .set({ ...rest, ...statusPatch })
              .where(
                and(
                  eq(vehiclesTable.id, existingId),
                  eq(vehiclesTable.dealerId, dealerId),
                  isNull(vehiclesTable.deletedAt),
                  eq(vehiclesTable.status, current.status),
                ),
              )
              .returning({ id: vehiclesTable.id });
            return updatedRow
              ? { kind: "updated" as const }
              : { kind: "concurrent" as const };
          }

          const insertYear = defaultVehicleYearForDealer(
            dealerId,
            cr.data.year,
          );
          if (insertYear === undefined) {
            return { kind: "year-required" as const };
          }
          const normalizedInsertVin = normalizeVin(cr.data.vin);
          if (normalizedInsertVin) {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${vinLockKey(dealerId)}))`,
            );
            const [collision] = await tx
              .select({ id: vehiclesTable.id })
              .from(vehiclesTable)
              .where(
                and(
                  eq(vehiclesTable.dealerId, dealerId),
                  isNull(vehiclesTable.deletedAt),
                  eq(
                    sql<string>`upper(btrim(${vehiclesTable.vin}))`,
                    normalizedInsertVin,
                  ),
                ),
              )
              .limit(1);
            if (collision) {
              return {
                kind: "vin-conflict" as const,
                vin: normalizedInsertVin,
              };
            }
          }

          await tx.insert(vehiclesTable).values({
            ...cr.data,
            year: insertYear,
            ...(normalizedInsertVin ? { vin: normalizedInsertVin } : {}),
            divisionId: cr.data.divisionId ?? importDivisionId,
            dealerId,
          });
          return { kind: "inserted" as const };
        });

        if (outcome.kind === "updated") {
          updated += 1;
        } else if (outcome.kind === "inserted") {
          inserted += 1;
        } else if (outcome.kind === "unchanged") {
          unchanged += 1;
        } else if (outcome.kind === "vin-conflict") {
          errors.push({
            row: cr.row,
            field: "vin",
            message: `VIN ${outcome.vin} is already assigned to another active vehicle in this dealer.`,
          });
        } else if (outcome.kind === "status-conflict") {
          errors.push({
            row: cr.row,
            field: "status",
            message: `Status transition ${outcome.currentStatus} → ${outcome.requestedStatus} is not allowed (concurrent status change).`,
          });
        } else if (outcome.kind === "year-required") {
          errors.push({
            row: cr.row,
            field: "year",
            message: "Year is required for this dealership.",
          });
        } else {
          errors.push({
            row: cr.row,
            message:
              "Vehicle was modified or deleted concurrently — row skipped.",
          });
        }
      } catch (err) {
        req.log.error({ err, row: cr.row }, "vehicle import row write failed");
        errors.push({ row: cr.row, message: "Database write failed for this row." });
      }
    }

    errors.sort((a, b) => a.row - b.row);
    res.json(
      ImportVehiclesResponse.parse({
        mode: "apply",
        total,
        inserted,
        updated,
        unchanged,
        skipped: total - inserted - updated - unchanged,
        errors,
      }),
    );
  },
);

router.get("/vehicles/import/template", async (_req, res): Promise<void> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Vehicles");

  // Build from canonical WORKBOOK_COLUMNS so template and export share
  // the same column definition.
  sheet.columns = WORKBOOK_COLUMNS.map((c) => ({
    header: c.header,
    width: c.width ?? Math.max(c.header.length + 4, 14),
  }));
  sheet.getRow(1).font = { bold: true };
  applyColumnFormats(sheet);

  // Example row — clearly removable.
  const exampleValues: (string | number)[] = [
    "", // Inventory ID — blank for new vehicles
    "WBY73AW0XPCK00001",
    "BMW",
    "i7",
    "xDrive60 M Sport",
    2026,
    "ENG0000000PCK0001",
    "ENG0000000PCK0001",
    "PAB1234",
    "GT Automotive",
    "Single-speed automatic",
    25000000,
    0,
    "EV",
    610,
    0,
    "Obsidian Black",
    "Sedan",
    "available",
    "Long Wheelbase",
    "/vehicles/bmw-i7.png",
    "https://example.com/front.jpg, https://example.com/interior.jpg",
    "Floor mats, Roof rack, Tow bar",
    "Flagship electric sedan.",
    "false",
  ];
  sheet.addRow(exampleValues);
  // Mark example row comment so users know to delete it.
  sheet.getRow(2).getCell(1).note =
    "This is an example row — delete it before importing your stock.";

  buildInstructionsSheet(workbook);

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
  res.json(
    GetVehicleResponse.parse(
      canonicalizeVehiclePowertrain({ ...visible, ...priceExtras }),
    ),
  );
});

router.patch("/vehicles/:id", async (req, res): Promise<void> => {
  const params = UpdateVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const normalizedBody = normalizeVehiclePowertrainInput(req.body);
  const parsed = UpdateVehicleBody.safeParse(normalizedBody);
  if (!parsed.success) {
    res.status(400).json({
      error: vehicleIdentifierError(normalizedBody ?? {}) ?? parsed.error.message,
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
  const normalizedUpdateVin =
    typeof parsed.data.vin === "string"
      ? normalizeVin(parsed.data.vin)
      : undefined;
  const updateData = {
    ...parsed.data,
    ...(normalizedUpdateVin ? { vin: normalizedUpdateVin } : {}),
  };

  const outcome = await db.transaction(async (tx) => {
    if ("vin" in parsed.data) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${vinLockKey(dealerId)}))`,
      );
    }

    const [current] = await tx
      .select({ status: vehiclesTable.status })
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, params.data.id),
          eq(vehiclesTable.dealerId, dealerId),
          isNull(vehiclesTable.deletedAt),
        ),
      )
      .for("update");
    if (!current) return { kind: "not-found" as const };

    if (parsed.data.status && parsed.data.status !== current.status) {
      // A VIN actively soft-locked by a paid reservation cannot have its
      // status edited manually — release goes through the deal workflows.
      if (await vehicleActivelyAllocated(params.data.id, dealerId, tx)) {
        return { kind: "allocation-held" as const };
      }
      const allowed =
        VEHICLE_STATUS_TRANSITIONS[current.status as VehicleStatus] ?? [];
      if (!allowed.includes(parsed.data.status as VehicleStatus)) {
        if (
          (parsed.data.status === "reserved" ||
            parsed.data.status === "booked") &&
          current.status !== "available"
        ) {
          return {
            kind: "locked" as const,
            currentStatus: current.status,
          };
        }
        return {
          kind: "invalid-status" as const,
          currentStatus: current.status,
          requestedStatus: parsed.data.status,
        };
      }
    }

    if (normalizedUpdateVin) {
      const collisions = await tx
        .select({ id: vehiclesTable.id })
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.dealerId, dealerId),
            isNull(vehiclesTable.deletedAt),
            eq(
              sql<string>`upper(btrim(${vehiclesTable.vin}))`,
              normalizedUpdateVin,
            ),
          ),
        );
      if (collisions.some((vehicle) => vehicle.id !== params.data.id)) {
        return { kind: "vin-conflict" as const };
      }
    }

    const [vehicle] = await tx
      .update(vehiclesTable)
      .set(updateData)
      .where(
        and(
          eq(vehiclesTable.id, params.data.id),
          eq(vehiclesTable.dealerId, dealerId),
          isNull(vehiclesTable.deletedAt),
          eq(vehiclesTable.status, current.status),
        ),
      )
      .returning();
    return vehicle
      ? { kind: "updated" as const, vehicle }
      : { kind: "concurrent" as const };
  });

  if (outcome.kind === "not-found") {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }
  if (outcome.kind === "vin-conflict") {
    res.status(409).json({
      error: `VIN ${normalizedUpdateVin} already belongs to an active vehicle.`,
    });
    return;
  }
  if (outcome.kind === "locked") {
    res.status(409).json({
      error: `This unit is already ${outcome.currentStatus} — refresh and pick another VIN`,
    });
    return;
  }
  if (outcome.kind === "allocation-held") {
    res.status(409).json({
      error:
        "This VIN is temporarily held for a paid reservation — resolve the deal (commit, cancel, or refund) instead of editing its status.",
    });
    return;
  }
  if (outcome.kind === "invalid-status") {
    res.status(422).json({
      error: `Invalid status transition: ${outcome.currentStatus} → ${outcome.requestedStatus}`,
    });
    return;
  }
  if (outcome.kind === "concurrent") {
    res.status(409).json({
      error:
        "This vehicle changed while you were editing it — refresh and try again.",
    });
    return;
  }

  res.json(
    UpdateVehicleResponse.parse(canonicalizeVehiclePowertrain(outcome.vehicle)),
  );
});

router.delete("/vehicles/:id", async (req, res): Promise<void> => {
  const params = DeleteVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Soft delete (R4.8): never hard-remove from the data plane.
  // A VIN actively soft-locked by a paid reservation cannot be removed.
  if (await vehicleActivelyAllocated(params.data.id, activeDealerId(res))) {
    res.status(409).json({
      error:
        "This VIN is temporarily held for a paid reservation — resolve the deal before deleting it.",
    });
    return;
  }
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
  res.json(
    UpdateVehicleResponse.parse(canonicalizeVehiclePowertrain(vehicle)),
  );
});

export default router;
