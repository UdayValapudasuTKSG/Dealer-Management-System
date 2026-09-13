/**
 * In-process failure injection only: no database queries or outbound messages.
 * Run with: pnpm --filter @workspace/api-server exec tsx src/scripts/verify-email-worker-resilience.ts
 */
import assert from "node:assert/strict";
import { db, pool } from "@workspace/db";
import { processQueue, processTaskReminders } from "../lib/email";

const originalSelect = db.select;
const originalDisabled = process.env.OUTBOX_WORKER_DISABLED;
let selections = 0;
const replaceSelect = (implementation: () => unknown) =>
  Object.defineProperty(db, "select", { configurable: true, writable: true, value: implementation });

try {
  delete process.env.OUTBOX_WORKER_DISABLED;
  replaceSelect(() => {
    selections++;
    throw new Error("Simulated database connection failure");
  });
  await processTaskReminders();
  await processTaskReminders();
  assert.equal(selections, 2, "reminder failure must release the guard for retry");
  selections = 0;
  await processQueue();
  const firstPassSelections = selections;
  assert.ok(firstPassSelections > 0);
  await processQueue();
  assert.equal(selections, firstPassSelections * 2, "outbox failure must release its guard");

  let release!: () => void;
  const blocked = new Promise<never[]>((resolve) => { release = () => resolve([]); });
  selections = 0;
  replaceSelect(() => {
    selections++;
    return { from: () => ({ where: () => blocked }) };
  });
  const running = processTaskReminders();
  await processTaskReminders();
  assert.equal(selections, 1, "overlapping reminder pass must be skipped");
  release();
  await running;
  await processTaskReminders();
  assert.equal(selections, 2, "successful pass must also release the guard");

  process.env.OUTBOX_WORKER_DISABLED = "1";
  await processQueue();
  await processTaskReminders();
  assert.equal(selections, 2, "disabled workers must not query");
  assert.equal(pool.options.connectionTimeoutMillis, 10_000);
  console.log("PASS: worker failures are contained, retry guards reset, overlaps skipped, disabled workers idle, connection wait bounded.");
} finally {
  replaceSelect(originalSelect);
  if (originalDisabled === undefined) delete process.env.OUTBOX_WORKER_DISABLED;
  else process.env.OUTBOX_WORKER_DISABLED = originalDisabled;
  await pool.end();
}