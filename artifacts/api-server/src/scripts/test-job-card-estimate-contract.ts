import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "../../../..");
const read = (relativePath: string) =>
  readFileSync(resolve(workspaceRoot, relativePath), "utf8");

const serviceRoutes = read("artifacts/api-server/src/routes/service.ts");
const routeIndex = read("artifacts/api-server/src/routes/index.ts");
const rbac = read("artifacts/api-server/src/middlewares/rbac.ts");
const client = read("lib/api-client-react/src/generated/api.ts");
const openapi = read("lib/api-spec/openapi.yaml");

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

console.log("Job-card estimate contract: route, client path, OpenAPI, and RBAC are aligned");