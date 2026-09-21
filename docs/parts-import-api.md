# Parts import API (PARTS-013)

All endpoints are dealer-scoped and require the existing parts authorization.

- `POST /api/parts/imports`: multipart **raw fetch/FormData**, field `file` (CSV/XLSX, max 10MB), optional `options` JSON. Do not use generated multipart mutation serializers.
- Options: `{mode:"upsert"|"reject", mapping:{sku:"SKU header",name:"Name header",unitCost:"Cost header"}, applyStock:false}`. Mapping keys are canonical fields: sku, name, description, category, unitCost, unitPrice, costingMethod, reorderMin, reorderMax, barcode, location, stock. Defaults recognize canonical camel/snake-case headers.
- Returns `202` job `{id,status,totalRows,processedRows,errorCount,errors,...}`. Creation queues validation automatically. Parsed source rows and options are persisted, not files on local disk.
- `GET /api/parts/imports/:id`: poll progress and errors (`{row,field,message}`). Statuses: pending (validation queued), validating, validated (ready to commit), invalid, queued (commit queued/in progress), completed, failed. Validation progress persists every 500 rows; atomic commit advances to total only after successful commit.
- `POST /api/parts/imports/:id/validate`: requeue validation after fixing policies; no part writes.
- `POST /api/parts/imports/:id/commit`: explicit atomic commit; only validated jobs accepted. Returns 202; poll job. Invalid/stale data fails the entire transaction.
- `GET /api/parts/pricing-policies`: list.
- `PUT /api/parts/pricing-policies`: `{category:null|string,markupFactor:number}`; null means global fallback. Category overrides global. Markup factor 1.25 means cost × 1.25. Explicit uploaded unit prices are retained.
- `DELETE /api/parts/pricing-policies/:id`: remove policy.

Required per row: SKU, name, nonnegative finite unit cost. Duplicates within the file are errors in either mode. Reject mode also errors for existing SKUs. Reorder values and stock must be nonnegative integers, max must be >= min. Costing methods: average, fifo, landed. Stock columns are rejected unless applyStock is explicitly true; absent stock preserves balances. Upserts preserve optional fields absent from the upload. Maximum 10,000 data rows and 100 columns. Formula cells are rejected; export values only.

Explicit stock is a desired aggregate balance; its difference is posted as a ledger adjustment in the default warehouse. Holds, cycle counts, and insufficient default-warehouse stock can reject the commit; use location-specific inventory operations for such stock changes instead. Validation checks file/master data; commit revalidates current data and enforces inventory constraints transactionally.

Integration: mount routes/parts-imports.ts before parts.ts. Call startPartsImportWorker() from application startup; stopPartsImportWorker() at shutdown. Legacy `/parts/import` can delegate to exported createPartsImport handler (same multipart contract), but now returns an asynchronous job rather than a synchronous inserted/updated summary.