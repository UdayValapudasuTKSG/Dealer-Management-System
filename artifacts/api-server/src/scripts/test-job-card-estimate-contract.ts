import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculateQuotedLaborTotal,
  effectiveQuotedLaborHours,
} from "../lib/service-labor-hours";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "../../../..");
const read = (relativePath: string) =>
  readFileSync(resolve(workspaceRoot, relativePath), "utf8");

const serviceRoutes = read("artifacts/api-server/src/routes/service.ts");
const initialJobCard = read("artifacts/api-server/src/lib/initial-job-card.ts");
const estimateBreakdown = read("artifacts/api-server/src/lib/service-estimate-breakdown.ts");
const routeIndex = read("artifacts/api-server/src/routes/index.ts");
const rbac = read("artifacts/api-server/src/middlewares/rbac.ts");
const client = read("lib/api-client-react/src/generated/api.ts");
const clientSchemas = read("lib/api-client-react/src/generated/api.schemas.ts");
const openapi = read("lib/api-spec/openapi.yaml");
const commercialPage = read("artifacts/aura/src/pages/job-card-detail.tsx");
const workshopSchema = read("lib/db/src/schema/workshop.ts");
const quotedHoursMigration = read("lib/db/migrations/2026-09-27-job-card-quoted-labor-hours.sql");

// Keep the staff Commercial-tab request and its server route in lockstep.
// This is deliberately a source contract check: a stale API process is fixed
// by rebuilding/restarting the API artifact, while a future path drift should
// fail before it reaches a screenshot.
assert.match(
  serviceRoutes,
  /router\.get\("\/job-cards\/:id\/estimate\/preview"/,
  "service router must register the staff estimate preview endpoint",
);
assert.match(
  serviceRoutes,
  /router\.get\("\/job-cards\/:id\/estimate\/preview"[\s\S]{0,320}res\.set\("Cache-Control", "no-store"\)/,
  "estimate preview must not be shared-cached across dealer or staff scopes",
);
assert.match(
  routeIndex,
  /router\.use\(serviceRouter\)/,
  "API route barrel must mount the service router",
);
assert.match(
  client,
  /return `\/api\/job-cards\/\$\{id\}\/estimate\/preview`/,
  "generated client must call the API-mounted estimate preview endpoint",
);
assert.match(
  openapi,
  /\/job-cards\/\{id\}\/estimate\/preview:\s+get:/,
  "OpenAPI must document the estimate preview endpoint",
);
assert.match(
  rbac,
  /req\.method === "GET"[\s\S]{0,180}\/job-cards\\\/\\d\+\\\/estimate\\\/preview/,
  "estimate preview must retain an explicit service view permission",
);
assert.match(
  estimateBreakdown,
  /effectiveQuotedLaborHours\(/,
  "canonical estimate breakdown must resolve quoted hours with planned-hour fallback",
);
assert.match(
  estimateBreakdown,
  /calculateQuotedLaborTotal\(/,
  "canonical estimate breakdown must use the tested quoted-labour calculation",
);
assert.equal(
  effectiveQuotedLaborHours(3, 2),
  3,
  "a quoted-hours override must replace planned booking hours",
);
assert.equal(
  effectiveQuotedLaborHours(0, 2),
  0,
  "an explicit zero quoted-hours override must remain zero",
);
assert.equal(
  effectiveQuotedLaborHours(null, 2),
  2,
  "a null quoted-hours override must fall back to planned booking hours",
);
assert.equal(
  calculateQuotedLaborTotal(3, 2, 120),
  360,
  "quoted labour calculation must use the override",
);
assert.equal(
  calculateQuotedLaborTotal(null, 2, 120),
  240,
  "quoted labour calculation must use planned hours only when override is null",
);
assert.match(
  initialJobCard,
  /quotedLaborHours\s*=\s*laborHours/,
  "new job cards must initialize quoted hours from planned booking hours",
);
assert.match(
  workshopSchema,
  /quotedLaborHours: doublePrecision\("quoted_labor_hours"\),/,
  "quoted hours must remain a nullable override in the database schema",
);
assert.doesNotMatch(
  quotedHoursMigration,
  /\bUPDATE\s+job_cards\b/i,
  "quoted-hours migration must not require a production data backfill",
);
assert.match(
  serviceRoutes,
  /parsed\.data\.quotedLaborHours\s*!==\s*undefined/,
  "changing quoted hours must enter the estimate repricing/version path",
);
assert.match(
  serviceRoutes,
  /invalidateServiceEstimate\(tx,\s*lockedCard\.dealerId,\s*lockedCard\.id\)/,
  "repricing must invalidate prior decisions and linked outbox delivery in the locked transaction",
);
assert.match(
  serviceRoutes,
  /effectiveQuotedLaborHours\(card\.quotedLaborHours,\s*card\.laborHours\)/,
  "invoice precheck must use quoted labour hours with planned-hour fallback",
);
assert.match(
  openapi,
  /quotedLaborHours: \{ type: \["number", "null"\]/,
  "OpenAPI must expose nullable quoted labour hours for legacy cards",
);
assert.match(
  clientSchemas,
  /quotedLaborHours: number \| null;/,
  "generated client JobCard type must expose nullable quoted labour hours",
);
assert.match(
  commercialPage,
  /name="quotedLaborHours"|id=\{`quoted-labor-hours-\$\{card\.id\}`\}/,
  "Commercial UI must expose an editable quoted-hours field",
);
assert.match(
  commercialPage,
  /does not send it/,
  "Commercial UI must make explicit-send behavior clear after repricing",
);

console.log("Job-card estimate contract: quote hours, route, client path, OpenAPI, and RBAC are aligned");