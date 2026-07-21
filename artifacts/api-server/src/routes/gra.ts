import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, gatesTable } from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
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

const ghs = (n: number) =>
  `GHS ${n.toLocaleString("en-GH", { maximumFractionDigits: 0 })}`;

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
  const d = {
    ...submitted,
    taxLines: duty.lines,
    totalPayable: duty.totalPayable,
  };

  const [gate] = await db
    .insert(gatesTable)
    .values({
      dealerId,
      type: "gra_filing",
      status: "pending",
      priority: "high",
      customerName: d.ownerName,
      refType: "vehicle",
      title: `GRA duty filing — ${d.year} ${d.make} ${d.model}`,
      summary: `Concierge prepared a Ghana Revenue Authority vehicle-duty filing for the ${d.year} ${d.make} ${d.model} (VIN ${d.vin}). Total assessed duty of ${ghs(
        d.totalPayable,
      )} is ready for an officer to file.`,
      recommendation:
        "Figures reconcile against the CIF value at standard GRA rates. Approve to file the duty pack and unblock clearance and registration.",
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
        { label: "CIF Value", value: ghs(d.cifValue) },
        ...d.taxLines.map((l) => ({ label: l.name, value: ghs(l.amount) })),
        { label: "Total Payable", value: ghs(d.totalPayable) },
      ],
    })
    .returning();

  res.json(SubmitGraFilingResponse.parse(gate));
});

export default router;
