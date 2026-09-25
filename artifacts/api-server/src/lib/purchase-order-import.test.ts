import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOrderCsv, parseOrderFile, validateOrderFields } from "./purchase-order-import";
import ExcelJS from "exceljs";

const header = "supplier_code,part_number,part_name,qty,unit_cost,special_order,customer_ref,ro_number";
test("template columns, quoted CSV, and row numbering", async () => {
  const rows = await parseOrderFile("order.csv", Buffer.from(`${header}\nSUP-2,P-1,"Filter, oil",2,100.25,N,,\n`));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].part_name, "Filter, oil");
  assert.equal(rows[0].rowNumber, 2);
  assert.deepEqual(validateOrderFields(rows[0]), []);
});
test("invalid quantities, money and special order references surface per-row errors", async () => {
  const [row] = await parseOrderFile("order.csv", Buffer.from(`${header}\nSUP-1,X,X,0,2.345,Y,,`));
  assert.match(validateOrderFields(row).join(" "), /Quantity/);
  assert.match(validateOrderFields(row).join(" "), /Unit cost/);
  assert.match(validateOrderFields(row).join(" "), /customer_ref/);
});
test("bad header and broken CSV quotes fail explicitly", async () => {
  await assert.rejects(parseOrderFile("order.csv", Buffer.from("sku,name\nA,B\n")), /Columns/);
  assert.throws(() => parseOrderCsv('"unclosed'), /Unterminated/);
});
test("XLSX template is accepted and extra populated columns are rejected", async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Order");
  sheet.addRow(header.split(","));
  sheet.addRow(["SUP-2", "P-1", "Filter", 2, 100.25, "N", "", ""]);
  const data = Buffer.from(await book.xlsx.writeBuffer());
  const rows = await parseOrderFile("order.xlsx", data);
  assert.equal(rows[0].unit_cost, "100.25");
  sheet.getRow(2).getCell(9).value = "extra";
  await assert.rejects(parseOrderFile("order.xlsx", Buffer.from(await book.xlsx.writeBuffer())), /extra columns/);
});