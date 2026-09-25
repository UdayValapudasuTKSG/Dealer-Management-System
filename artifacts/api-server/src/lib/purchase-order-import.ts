import ExcelJS from "exceljs";

export const orderImportColumns = ["supplier_code", "part_number", "part_name", "qty", "unit_cost", "special_order", "customer_ref", "ro_number"] as const;
export type OrderImportRow = Record<(typeof orderImportColumns)[number], string> & { rowNumber: number };

export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC-4180 style CSV parser. Reject malformed quotes rather than shifting columns. */
export function parseOrderCsv(input: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, endedQuote = false;
  const text = input.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; endedQuote = true; }
      else cell += c;
    } else if (c === '"' && !cell && !endedQuote) quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; endedQuote = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); result.push(row); row = []; cell = ""; endedQuote = false;
    } else {
      if (endedQuote || c === '"') throw new Error("Malformed CSV quoting");
      cell += c;
    }
  }
  if (quoted) throw new Error("Unterminated CSV quoted field");
  if (cell || row.length || endedQuote) { row.push(cell); result.push(row); }
  return result;
}

export async function parseOrderFile(name: string, buffer: Buffer): Promise<OrderImportRow[]> {
  let matrix: string[][];
  if (/\.csv$/i.test(name)) matrix = parseOrderCsv(buffer.toString("utf8"));
  else if (/\.xlsx$/i.test(name)) {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as any);
    if (book.worksheets.length !== 1) throw new Error("XLSX must have exactly one worksheet");
    matrix = [];
    book.worksheets[0].eachRow({ includeEmpty: true }, row => {
      matrix.push(Array.from({ length: Math.max(orderImportColumns.length, row.cellCount) }, (_, i) => {
        const value = row.getCell(i + 1).value;
        if (value && typeof value === "object" && "result" in value) return String(value.result ?? "");
        if (value && typeof value === "object" && "text" in value) return String(value.text ?? "");
        return String(value ?? "");
      }));
    });
  } else throw new Error("Only CSV and XLSX files are supported");
  if (matrix.length < 2 || matrix.length > 10001) throw new Error("File must contain 1–10,000 data rows");
  const header = matrix[0].map(v => v.trim().toLowerCase());
  if (header.length !== orderImportColumns.length || orderImportColumns.some((col, i) => col !== header[i]))
    throw new Error(`Columns must appear in this order: ${orderImportColumns.join(", ")}`);
  return matrix.slice(1).map((values, index) => {
    const row = { rowNumber: index + 2 } as OrderImportRow;
    orderImportColumns.forEach((column, i) => { row[column] = (values[i] ?? "").trim(); });
    if (values.slice(orderImportColumns.length).some(v => v.trim())) throw new Error(`Row ${index + 2} contains extra columns`);
    return row;
  });
}

export function validateOrderFields(row: OrderImportRow): string[] {
  const errors: string[] = [];
  if (!row.supplier_code) errors.push("Supplier code required");
  if (!row.part_number) errors.push("Part number required");
  if (!/^[1-9]\d*$/.test(row.qty) || !Number.isSafeInteger(Number(row.qty))) errors.push("Quantity must be a positive integer");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(row.unit_cost) || Number(row.unit_cost) > 999999999999)
    errors.push("Unit cost must be a nonnegative amount with at most two decimals");
  if (!/^[YN]$/i.test(row.special_order)) errors.push("Special order must be Y or N");
  if (row.special_order.toUpperCase() === "Y" && !row.customer_ref) errors.push("Special order requires customer_ref");
  if (row.ro_number && !row.customer_ref) errors.push("RO number requires customer_ref");
  return errors;
}