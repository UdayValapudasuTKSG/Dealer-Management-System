import type { ShipmentImportRow } from "@workspace/api-client-react";

/**
 * Browser-side CSV/XLSX parsing for shipment line / manifest imports.
 * Files never leave the browser: only parsed rows + a SHA-256 of the bytes
 * (for idempotent retries) are sent to the API.
 */

const HEADER_ALIASES: Record<string, keyof Omit<ShipmentImportRow, "rowNumber">> = {
  vin: "vin",
  make: "make",
  brand: "make",
  model: "model",
  year: "year",
  modelyear: "year",
  variant: "variant",
  trim: "variant",
  exterior: "exteriorColor",
  exteriorcolor: "exteriorColor",
  exteriorcolour: "exteriorColor",
  colour: "exteriorColor",
  color: "exteriorColor",
  interior: "interiorColor",
  interiorcolor: "interiorColor",
  interiorcolour: "interiorColor",
  quantity: "quantity",
  qty: "quantity",
  units: "quantity",
};

export const TEMPLATE_HEADERS = {
  lines: ["Make", "Model", "Year", "Variant", "Exterior Colour", "Interior Colour", "Quantity"],
  manifest: ["VIN", "Make", "Model", "Year", "Variant", "Exterior Colour", "Interior Colour"],
} as const;

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

async function parseXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals: string[] = [];
    for (let c = 1; c <= ws.columnCount; c += 1) {
      const v = r.getCell(c).value as unknown;
      let s = "";
      if (v == null) s = "";
      else if (typeof v === "object" && v !== null && "text" in v) s = String((v as { text: unknown }).text);
      else if (typeof v === "object" && v !== null && "result" in v) s = String((v as { result: unknown }).result ?? "");
      else if (v instanceof Date) s = v.toISOString().slice(0, 10);
      else s = String(v);
      vals.push(s);
    }
    out.push(vals);
  });
  return out.filter((r) => r.some((x) => x.trim() !== ""));
}

export type ParsedFile = { fileName: string; fileHash: string; rows: ShipmentImportRow[]; unknownHeaders: string[] };

export async function parseImportFile(file: File): Promise<ParsedFile> {
  const buf = await file.arrayBuffer();
  const isXlsx = /\.xlsx$/i.test(file.name);
  if (!isXlsx && !/\.csv$/i.test(file.name)) throw new Error("Upload a .csv or .xlsx file");
  const grid = isXlsx ? await parseXlsx(buf) : parseCsv(new TextDecoder().decode(buf));
  if (grid.length < 2) throw new Error("The file has no data rows under a header row");
  const header = grid[0]!.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const unknownHeaders: string[] = [];
  const map = header.map((h, i) => {
    const k = HEADER_ALIASES[h];
    if (!k && h) unknownHeaders.push(grid[0]![i]!);
    return k;
  });
  if (grid.length - 1 > 5000) throw new Error("Maximum 5,000 rows per file");
  const rows = grid.slice(1).map((cells, idx) => {
    const r: ShipmentImportRow = { rowNumber: idx + 2 };
    map.forEach((k, i) => {
      if (k) r[k] = (cells[i] ?? "").trim();
    });
    return r;
  });
  return { fileName: file.name, fileHash: await sha256Hex(buf), rows, unknownHeaders };
}

/** Neutralise spreadsheet formula injection in exported cells. */
export function csvCell(value: string): string {
  let v = value ?? "";
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

export function downloadCsv(fileName: string, header: string[], rows: string[][]) {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
