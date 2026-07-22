import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  db,
  gatesTable,
  graFilingsTable,
  dealersTable,
  divisionsTable,
} from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import { buildGraDutyPackPdf } from "../lib/gra-pdf";
import {
  isAgentEnabled,
  recordAgentRun,
  MIN_AGENT_CONFIDENCE,
} from "../lib/agent-governance";
import { computeGraDuty, ensureDealerTaxes } from "../lib/taxes";
import {
  ExtractGraFilingBody,
  ExtractGraFilingResponse,
  SubmitGraFilingBody,
  SubmitGraFilingResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Extract-only: the model reads legible fields off the document. It NEVER
// computes duty/VAT/levies (that is done server-side from the dealer's
// configured tax rules) and NEVER invents identifiers or amounts.
const EXTRACTION_PROMPT = `You are reading an uploaded vehicle import document (bill of lading, commercial invoice, customs declaration, or similar) for a customs duty filing.

Extract ONLY what is actually legible on the document. Return ONLY a JSON object (no markdown, no commentary) with exactly these keys:

{
  "ownerName": string|null,   // importer / owner full name, exactly as printed
  "tin": string|null,         // Taxpayer Identification Number, exactly as printed
  "vin": string|null,         // chassis / VIN number, exactly as printed
  "make": string|null,
  "model": string|null,
  "year": number|null,
  "engineCc": number|null,    // engine capacity in cubic centimetres
  "fuelType": string|null,    // Petrol, Diesel, Hybrid, or Electric
  "hsCode": string|null,      // Harmonised System tariff code, exactly as printed
  "cifValue": number|null,    // Cost, Insurance & Freight value as printed (plain number)
  "confidence": {             // 0..1 per field: how certain you are the value is read correctly
    "ownerName": number, "tin": number, "vin": number, "make": number,
    "model": number, "year": number, "engineCc": number, "fuelType": number,
    "hsCode": number, "cifValue": number
  },
  "notes": string             // one short sentence on anything unclear
}

STRICT RULES:
- If a field is not clearly legible on the document, return null for it and a low confidence. NEVER guess, infer, or invent a TIN, VIN, amount, or any other value.
- Do NOT compute any duty, VAT, or levy. Only transcribe values printed on the document.
- Monetary values must be plain numbers with no currency symbols or separators.`;

const RawExtraction = z.object({
  ownerName: z.string().nullable(),
  tin: z.string().nullable(),
  vin: z.string().nullable(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  year: z.number().nullable(),
  engineCc: z.number().nullable(),
  fuelType: z.string().nullable(),
  hsCode: z.string().nullable(),
  cifValue: z.number().nullable(),
  confidence: z.record(z.string(), z.number()).optional(),
  notes: z.string().optional().default(""),
});

router.post("/gra/extract", async (req, res): Promise<void> => {
  const parsed = ExtractGraFilingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  if (!(await isAgentEnabled(dealerId, "customs"))) {
    await recordAgentRun({
      dealerId,
      agentKey: "customs",
      runType: "gra_document_extraction",
      inputSource: "gra",
      status: "blocked",
      errorMessage: "Agent paused by dealer kill switch",
    });
    res.status(409).json({ error: "The customs agent is paused for this dealership" });
    return;
  }

  const startedAt = Date.now();
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: parsed.data.mediaType,
                data: parsed.data.imageBase64,
              },
            },
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      req.log.error({ raw }, "GRA extraction returned no JSON object");
      res.status(502).json({ error: "Could not read the document" });
      return;
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      req.log.error({ raw }, "GRA extraction returned invalid JSON");
      res.status(502).json({ error: "Could not read the document" });
      return;
    }

    const extraction = RawExtraction.safeParse(candidate);
    if (!extraction.success) {
      req.log.error(
        { issues: extraction.error.issues },
        "GRA extraction failed validation",
      );
      res.status(502).json({ error: "The document was missing required details" });
      return;
    }
    const x = extraction.data;
    const conf = x.confidence ?? {};

    // Fields the model could not read confidently drop to human review: they
    // are left blank/zero in the draft and called out in the notes so the
    // officer corrects them before the (existing) approval gate.
    const FIELD_LABELS: Record<string, string> = {
      ownerName: "Importer / Owner",
      tin: "TIN",
      vin: "Chassis / VIN",
      make: "Make",
      model: "Model",
      year: "Year",
      engineCc: "Engine (cc)",
      fuelType: "Fuel Type",
      hsCode: "HS Code",
      cifValue: "CIF Value",
    };
    const needsReview = Object.keys(FIELD_LABELS).filter((k) => {
      const value = x[k as keyof typeof FIELD_LABELS as keyof typeof x];
      return value == null || (conf[k] ?? 0) < MIN_AGENT_CONFIDENCE;
    });

    // Legible-only guarantee: any field the model could not read confidently
    // is DROPPED (blank/zero), never passed through as a low-trust auto-fill.
    // The officer keys it in from the source document before the gate.
    const dropped = new Set(
      Object.keys(FIELD_LABELS).filter((k) => (conf[k] ?? 0) < MIN_AGENT_CONFIDENCE),
    );
    if (dropped.has("ownerName")) x.ownerName = null;
    if (dropped.has("tin")) x.tin = null;
    if (dropped.has("vin")) x.vin = null;
    if (dropped.has("make")) x.make = null;
    if (dropped.has("model")) x.model = null;
    if (dropped.has("year")) x.year = null;
    if (dropped.has("engineCc")) x.engineCc = null;
    if (dropped.has("fuelType")) x.fuelType = null;
    if (dropped.has("hsCode")) x.hsCode = null;
    if (dropped.has("cifValue")) x.cifValue = null;

    // Deterministic server-side duty computation from the dealer's configured
    // tax rules (dealer_taxes) — the model never computes amounts. Every
    // active rule lands in taxLines and totalPayable is their exact sum.
    const cifValue = x.cifValue ?? 0;
    const isEv = (x.fuelType ?? "").toLowerCase() === "electric";
    const taxRules = await ensureDealerTaxes(dealerId);
    const duty = computeGraDuty(cifValue, taxRules, { isEv });

    const reviewNote =
      needsReview.length > 0
        ? `Verify before filing (not read confidently): ${needsReview
            .map((k) => FIELD_LABELS[k])
            .join(", ")}.`
        : "";
    const notes = [x.notes?.trim(), reviewNote].filter(Boolean).join(" ") || "";

    const confValues = Object.values(conf);
    const avgConfidence =
      confValues.length > 0
        ? Math.round(
            (confValues.reduce((a, b) => a + b, 0) / confValues.length) * 100,
          ) / 100
        : null;

    const draft = ExtractGraFilingResponse.parse({
      ownerName: x.ownerName ?? "",
      tin: x.tin ?? "",
      vin: x.vin ?? "",
      make: x.make ?? "",
      model: x.model ?? "",
      year: x.year ?? 0,
      engineCc: x.engineCc ?? 0,
      fuelType: x.fuelType ?? "",
      hsCode: x.hsCode ?? "",
      cifValue,
      taxLines: duty.lines,
      totalPayable: duty.totalPayable,
      confidence: avgConfidence,
      uncertainFields: needsReview.map((k) => FIELD_LABELS[k]),
      notes,
    });

    await recordAgentRun({
      dealerId,
      agentKey: "customs",
      runType: "gra_document_extraction",
      inputSource: "gra",
      inputSummary: `Uploaded ${parsed.data.mediaType} document`,
      outputSummary: `Extracted duty draft for ${`${draft.year} ${draft.make} ${draft.model}`}${needsReview.length ? ` (${needsReview.length} fields need review)` : ""}`,
      confidence: avgConfidence,
      latencyMs: Date.now() - startedAt,
    });
    res.json(draft);
  } catch (err) {
    req.log.error({ err }, "GRA extraction request failed");
    await recordAgentRun({
      dealerId,
      agentKey: "customs",
      runType: "gra_document_extraction",
      inputSource: "gra",
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - startedAt,
    });
    res.status(502).json({ error: "The extraction service is unavailable" });
  }
});

const gyd = (n: number) =>
  `GY$${n.toLocaleString("en-GY", { maximumFractionDigits: 0 })}`;

router.post("/gra/filings", async (req, res): Promise<void> => {
  const parsed = SubmitGraFilingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const dealerId = activeDealerId(res);

  // Never trust client-submitted amounts: recompute every duty/levy/VAT line
  // and the total server-side from the dealer's configured tax rules and the
  // (possibly officer-corrected) CIF value + fuel type in the draft.
  const submitted = parsed.data.draft;
  const isEv = (submitted.fuelType ?? "").toLowerCase() === "electric";
  const taxRules = await ensureDealerTaxes(dealerId);
  const duty = computeGraDuty(submitted.cifValue, taxRules, { isEv });

  // Spec R9 D-GRA-1: if the client posts tax lines that do not match the
  // deterministic server recompute, reject the filing and return the
  // server-computed lines — the app never accepts a fabricated duty figure.
  const mismatch =
    submitted.taxLines.length !== duty.lines.length ||
    Math.abs(submitted.totalPayable - duty.totalPayable) > 0.01 ||
    submitted.taxLines.some((l, i) => {
      const s = duty.lines[i];
      return !s || s.code !== l.code || Math.abs(s.amount - l.amount) > 0.01;
    });
  if (mismatch) {
    res.status(422).json({
      error:
        "Submitted tax lines do not match the server-computed duty. Refresh the draft — duty is always computed server-side from the dealer's tax rules.",
      serverTaxLines: duty.lines,
      serverTotalPayable: duty.totalPayable,
    });
    return;
  }

  const d = {
    ...submitted,
    taxLines: duty.lines,
    totalPayable: duty.totalPayable,
  };

  // Snapshot the dealer's exchange rate at submit time so later rate drift
  // never retro-changes a filed duty (17-mB step 4).
  const [dealer] = await db
    .select()
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  const exchangeRate = dealer?.usdExchangeRate ?? 209;
  const both = (n: number) =>
    `US$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} / ${gyd(n * exchangeRate)}`;

  const { gate, filing } = await db.transaction(async (tx) => {
    const [gateRow] = await tx
      .insert(gatesTable)
      .values({
        dealerId,
        type: "gra_filing",
        status: "pending",
        priority: "high",
        customerName: d.ownerName,
        refType: "vehicle",
        refId: parsed.data.vehicleId ?? null,
        title: `GRA duty filing — ${d.year} ${d.make} ${d.model}`,
        summary: `AI-extracted fields (legible values only) with a server-computed Guyana Revenue Authority duty sheet for the ${d.year} ${d.make} ${d.model} (VIN ${d.vin}). Total assessed duty ${both(
          d.totalPayable,
        )} awaits officer confirmation before filing.`,
        recommendation:
          "Verify each extracted field against the source documents, correct anything mis-read, then approve to file the duty pack and unblock clearance and registration.",
        amount: d.totalPayable,
        evidence: [
          { label: "Importer", value: d.ownerName },
          { label: "TIN", value: d.tin },
          { label: "Chassis / VIN", value: d.vin },
          {
            label: "Vehicle",
            value: `${d.year} ${d.make} ${d.model}`,
          },
          { label: "Engine", value: `${d.engineCc.toLocaleString()} cc ${d.fuelType}` },
          { label: "HS Code", value: d.hsCode },
          { label: "CIF Value", value: both(d.cifValue) },
          ...d.taxLines.map((l) => ({ label: l.name, value: both(l.amount) })),
          { label: "Total Payable", value: both(d.totalPayable) },
          { label: "Exchange rate snapshot", value: `US$1 = GY$${exchangeRate}` },
        ],
      })
      .returning();

    // Immutable pending filing snapshot — flipped to "filed" ONLY when a
    // human resolves the gra_filing gate (17-mB steps 7–8).
    const [filingRow] = await tx
      .insert(graFilingsTable)
      .values({
        dealerId,
        gateId: gateRow.id,
        vehicleId: parsed.data.vehicleId ?? null,
        filingRef: `GRA-${new Date().getFullYear()}-${String(gateRow.id).padStart(5, "0")}`,
        status: "pending_gate",
        ownerName: d.ownerName,
        tin: d.tin,
        vin: d.vin,
        make: d.make,
        model: d.model,
        year: d.year,
        engineCc: d.engineCc,
        fuelType: d.fuelType,
        hsCode: d.hsCode,
        cifValue: d.cifValue,
        exchangeRate,
        evExcluded: isEv,
        taxLines: duty.lines,
        totalPayable: duty.totalPayable,
        sourceNotes: d.notes ?? null,
        createdBy: res.locals.user?.email ?? "system",
      })
      .returning();

    return { gate: gateRow, filing: filingRow };
  });

  req.log.info(
    { gateId: gate.id, filingId: filing.id, dealerId },
    "GRA filing draft submitted; awaiting gra_filing gate",
  );
  res.json(SubmitGraFilingResponse.parse(gate));
});

router.get("/gra/filings", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const gateId = req.query.gateId ? Number(req.query.gateId) : undefined;
  const vehicleId = req.query.vehicleId ? Number(req.query.vehicleId) : undefined;
  const conds = [eq(graFilingsTable.dealerId, dealerId)];
  if (gateId && Number.isFinite(gateId)) conds.push(eq(graFilingsTable.gateId, gateId));
  if (vehicleId && Number.isFinite(vehicleId))
    conds.push(eq(graFilingsTable.vehicleId, vehicleId));
  const rows = await db
    .select()
    .from(graFilingsTable)
    .where(and(...conds))
    .orderBy(desc(graFilingsTable.id));
  res.json(rows);
});

router.get("/gra/filings/:id/pdf", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid filing id" });
    return;
  }
  const dealerId = activeDealerId(res);
  const [filing] = await db
    .select()
    .from(graFilingsTable)
    .where(and(eq(graFilingsTable.id, id), eq(graFilingsTable.dealerId, dealerId)));
  if (!filing) {
    res.status(404).json({ error: "Filing not found" });
    return;
  }
  if (filing.status !== "filed") {
    res.status(409).json({
      error:
        "The gra_filing gate has not been resolved yet — the duty pack is generated only after an officer confirms the filing.",
    });
    return;
  }

  const [dealer] = await db
    .select()
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  const [gate] = await db
    .select()
    .from(gatesTable)
    .where(and(eq(gatesTable.id, filing.gateId), eq(gatesTable.dealerId, dealerId)));
  const divisions = await db
    .select()
    .from(divisionsTable)
    .where(eq(divisionsTable.dealerId, dealerId));
  const division = divisions[0] ?? null;

  const pdf = await buildGraDutyPackPdf(filing, {
    dealerName: dealer?.name ?? "AURA Dealership",
    divisionName: division?.name ?? null,
    dealerAddress: [dealer?.city, dealer?.country].filter(Boolean).join(", ") || null,
    dealerTin: null,
    gateResolvedBy: gate?.resolvedBy ?? null,
    gateResolution: gate?.resolution ?? null,
    extractedFieldNotes: filing.sourceNotes,
  });

  res
    .setHeader("Content-Type", "application/pdf")
    .setHeader(
      "Content-Disposition",
      `inline; filename="${filing.filingRef}-duty-pack.pdf"`,
    )
    .send(pdf);
});

export default router;
