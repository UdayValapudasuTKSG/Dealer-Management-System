import ExcelJS from "exceljs";

/** Read cached values only. Never evaluate formulas, shared formulas or external links. */
export async function parsePartsXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount > 10001 || sheet.columnCount > 100) throw new Error("Maximum 10,000 rows and 100 columns");
  const matrix: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, row => {
    const cells: string[] = [];
    for (let i = 1; i <= sheet.columnCount; i++) {
      const cell = row.getCell(i);
      if (cell.type === ExcelJS.ValueType.Error) throw new Error(`Row ${row.number}, column ${i}: Excel error cell`);
      if (cell.type === ExcelJS.ValueType.Formula) {
        const result = cell.result;
        if (typeof result !== "number" || !Number.isFinite(result)) throw new Error(`Row ${row.number}, column ${i}: formula requires a finite numeric cached result; recalculate and save in Excel`);
        cells.push(String(result));
      } else cells.push(typeof cell.value === "number" ? String(cell.value) : cell.text);
    }
    matrix.push(cells);
  });
  return matrix;
}