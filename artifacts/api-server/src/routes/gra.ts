import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  db,
  gatesTable,
  graFilingsTable,
  dealersTable,
  dealsTable,
  vehiclesTable,
  divisionsTable,
  timelineEventsTable,
  auditLogsTable,
} from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import { idempotent } from "../middlewares/idempotency";
import { buildGraDutyPackPdf } from "../lib/gra-pdf";
import {
  isAgentEnabled,
  recordAgentRun,
  guardUntrusted,
  MIN_AGENT_CONFIDENCE,
} from "../lib/agent-governance";
import { computeDraftDuty, dealerExchangeRate, taxLinesMatch } from "../lib/gra-duty";
import {
  ComputeGraDutyBody,
  ComputeGraDutyResponse,
  ExtractGraFilingBody,
  ExtractGraFilingResponse,
  ReviewGraFilingBody,
  ReviewGraFilingResponse,
  SubmitGraFilingBody,
  SubmitGraFilingResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Extraction (17-mB step 2): the vision model transcribes ONLY the legible
// allowlisted fields — make, model, year, cifPrinted, engineCc, fuelType.
// It NEVER returns TIN, VIN, owner, HS code or any duty figure; those are
// human-keyed from the source documents, and duty is computed server-side
// from dealer_taxes. Fields below MIN_AGENT_CONFIDENCE are dropped, not
// low-trust auto-filled.
// ---------------------------------------------------------------------------
const EXTRACT_ALLOWLIST = [
  "make",
  "model",
  "year",
  "cifPrinted",
  "engineCc",
  "fuelType",
] as const;

const EXTRACTION_PROMPT = `You are reading an uploaded vehicle import document (bill of lading, commercial invoice, customs declaration, or similar).

Transcribe ONLY what is actually legible on the document. Return ONLY a JSON object (no markdown, no commentary) with exactly these keys:

{
  "make": string|null,
  "model": string|null,
  "year": number|null,        // year of manufacture
  "cifPrinted": number|null,  // the CIF (Cost, Insurance & Freight) value exactly as printed, plain number
  "engineCc": number|null,    // engine capacity in cubic centimetres
  "fuelType": string|null,    // Petrol, Diesel, Hybrid, or Electric
  "confidence": {             // 0..1 per field: how certain you are the value is read correctly
    "make": number, "model": number, "year": number,
    "cifPrinted": number, "engineCc": number, "fuelType": number
  },
  "notes": string             // one short sentence on anything unclear
}

STRICT RULES:
- If a field is not clearly legible, return null for it with a low confidence. NEVER guess, infer, or invent a value.
- Do NOT return a TIN, VIN, chassis number, owner name, HS code, duty, VAT, or levy — even if printed. Those are entered by a human.
- Monetary values must be plain numbers with no currency symbols or separators.`;

const RawExtraction = z.object({
  make: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  year: z.number().nullable().optional(),
  cifPrinted: z.number().nullable().optional(),
  engineCc: z.number().nullable().optional(),
  fuelType: z.string().nullable().optional(),
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
  if (!(await isAgentEnabled(dealerId, "gra_extract"))) {
    await recordAgentRun({
      dealerId,
      agentKey: "gra_extract",
      runType: "gra_document_extraction",
      inputSource: "gra",
      status: "blocked",
      errorMessage: "Agent paused by dealer kill switch",
    });
    res
      .status(409)
      .json({ error: "The GRA extract agent is paused for this dealership" });
    return;
  }

  const startedAt = Date.now();
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
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
      res.status(502).json({ error: "The document could not be transcribed" });
      return;
    }
    const x = extraction.data;
    const rawConf = x.confidence ?? {};

    // Server-enforced allowlist: anything else the model returned is ignored;
    // low-confidence or null fields are DROPPED for human key-in.
    const fields: Record<string, string | number | null> = {};
    const confidence: Record<string, number> = {};
    const dropped: string[] = [];
    for (const key of EXTRACT_ALLOWLIST) {
      const value = x[key] ?? null;
      const conf = rawConf[key] ?? 0;
      if (value == null || conf < MIN_AGENT_CONFIDENCE) {
        dropped.push(key);
        fields[key] = null;
      } else {
        fields[key] = value;
        confidence[key] = Math.round(conf * 100) / 100;
      }
    }

    const notes = x.notes?.trim()
      ? guardUntrusted("GRA extraction note", x.notes.trim(), 500)
      : null;

    const keptCount = EXTRACT_ALLOWLIST.length - dropped.length;
    const confValues = Object.values(confidence);
    const avgConfidence =
      confValues.length > 0
        ? Math.round(
            (confValues.reduce((a, b) => a + b, 0) / confValues.length) * 100,
          ) / 100
        : 0;

    await recordAgentRun({
      dealerId,
      agentKey: "gra_extract",
      runType: "gra_document_extraction",
      inputSource: "gra",
      inputSummary: `Uploaded ${parsed.data.mediaType} document${parsed.data.sourceDocId ? ` (doc #${parsed.data.sourceDocId})` : ""}`,
      outputSummary:
        keptCount > 0
          ? `Transcribed ${keptCount}/${EXTRACT_ALLOWLIST.length} legible fields${dropped.length ? `; dropped for key-in: ${dropped.join(", ")}` : ""}`
          : "Document unreadable — all fields require human key-in",
      confidence: avgConfidence || null,
      latencyMs: Date.now() - startedAt,
    });

    if (keptCount === 0) {
      // 17-mB: an unreadable document is a hard 422 — the officer keys in
      // every value; nothing is auto-filled.
      res.status(422).json({
        error:
          "No field on this document was legible enough to transcribe — enter the values manually from the source paperwork.",
        dropped,
        notes,
      });
      return;
    }

    res.json(
      ExtractGraFilingResponse.parse({ fields, confidence, dropped, notes }),
    );
  } catch (err) {
    req.log.error({ err }, "GRA extraction request failed");
    await recordAgentRun({
      dealerId,
      agentKey: "gra_extract",
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

// ---------------------------------------------------------------------------
// Review (17-mB step 7): the human-confirmed draft comes in, the server
// computes the duty sheet deterministically from dealer_taxes, and a
// gra_filing gate is raised holding the sheet + a pending filing snapshot.
// Filing to GRA is a SEPARATE call that requires this gate to be resolved.
// ---------------------------------------------------------------------------
router.post("/gra/review", async (req, res): Promise<void> => {
  const parsed = ReviewGraFilingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const d = parsed.data.draft;

  // CIF composition check: when all three components are supplied they must
  // sum (±0.01) to the confirmed CIF — otherwise the pack would print an
  // internally inconsistent valuation.
  if (d.fobValue != null && d.freightValue != null && d.insuranceValue != null) {
    const sum = d.fobValue + d.freightValue + d.insuranceValue;
    if (Math.abs(sum - d.cifValue) > 0.01) {
      res.status(422).json({
        error: `FOB + freight + insurance (US$${sum.toLocaleString()}) does not equal the CIF value (US$${d.cifValue.toLocaleString()}). Correct the components before review.`,
        unmet: ["cif_components_mismatch"],
      });
      return;
    }
  }

  const duty = await computeDraftDuty(dealerId, {
    cifValue: d.cifValue,
    engineCc: d.engineCc,
    fuelType: d.fuelType,
    year: d.year,
    yearOfImport: d.yearOfImport,
  });
  if (duty.missingInputs.length > 0) {
    res.status(422).json({
      error:
        "Required duty inputs are missing — fill them in before sending for review.",
      unmet: duty.missingInputs,
    });
    return;
  }

  const exchangeRate = await dealerExchangeRate(dealerId);

  // Deal / vehicle tagging (404 foreign ids, vehicle consistency).
  let vehicleId: number | null = parsed.data.vehicleId ?? null;
  let dealId: number | null = null;
  if (vehicleId != null) {
    const [veh] = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(
        and(eq(vehiclesTable.id, vehicleId), eq(vehiclesTable.dealerId, dealerId)),
      );
    if (!veh) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
  }
  if (parsed.data.dealId != null) {
    const [deal] = await db
      .select()
      .from(dealsTable)
      .where(
        and(eq(dealsTable.id, parsed.data.dealId), eq(dealsTable.dealerId, dealerId)),
      );
    if (!deal) {
      res.status(404).json({ error: "Deal not found" });
      return;
    }
    if (vehicleId != null && deal.vehicleId !== vehicleId) {
      res.status(422).json({
        error: "The deal is for a different vehicle than this filing.",
      });
      return;
    }
    dealId = deal.id;
    if (vehicleId == null && deal.vehicleId != null) vehicleId = deal.vehicleId;
  }

  const both = (n: number) =>
    gyd(n);

  const { gate } = await db.transaction(async (tx) => {
    const [gateRow] = await tx
      .insert(gatesTable)
      .values({
        dealerId,
        type: "gra_filing",
        status: "pending",
        priority: "high",
        customerName: d.ownerName,
        refType: "vehicle",
        refId: vehicleId,
        title: `GRA duty filing — ${d.year} ${d.make} ${d.model}`,
        summary: `Human-confirmed import details with a duty sheet computed from this dealership's configured GRA tax rules for the ${d.year} ${d.make} ${d.model} (VIN ${d.vin}). Total assessed duty ${both(
          duty.totalPayable,
        )} awaits officer confirmation. Filing to GRA is only possible AFTER this gate is approved.`,
        recommendation:
          "Verify each figure against the source documents (AI transcription covered legible fields only; TIN, VIN and CIF were keyed by staff), then approve to authorise filing the duty pack.",
        amount: duty.totalPayable,
        evidence: [
          { label: "Importer", value: d.ownerName },
          { label: "TIN", value: d.tin },
          { label: "Chassis / VIN", value: d.vin },
          { label: "Vehicle", value: `${d.year} ${d.make} ${d.model}` },
          {
            label: "Engine",
            value: `${d.engineCc.toLocaleString()} cc ${d.fuelType}`,
          },
          { label: "HS Code", value: d.hsCode },
          { label: "CIF Value", value: both(d.cifValue) },
          ...(d.fobValue != null &&
          d.freightValue != null &&
          d.insuranceValue != null
            ? [
                {
                  label: "CIF composition",
                  value: `FOB ${both(d.fobValue)} + freight ${both(d.freightValue)} + insurance ${both(d.insuranceValue)}`,
                },
              ]
            : []),
          ...duty.taxLines.map((l) => ({
            label: l.name,
            value: `${both(l.amount)}${l.basis ? ` — ${l.basis}` : ""}`,
          })),
          ...(duty.evSkipped.length > 0
            ? [
                {
                  label: "EV exclusions applied",
                  value: duty.evSkipped.join(", "),
                },
              ]
            : []),
          { label: "Total Payable", value: both(duty.totalPayable) },
          
        ],
      })
      .returning();

    // Pending filing snapshot — flipped to "filed" ONLY by POST /gra/filings
    // after this gate is resolved (17-mB steps 7–8).
    await tx.insert(graFilingsTable).values({
      dealerId,
      gateId: gateRow.id,
      vehicleId,
      dealId,
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
      fobValue: d.fobValue ?? null,
      freightValue: d.freightValue ?? null,
      insuranceValue: d.insuranceValue ?? null,
      sourceDocIds: d.sourceDocIds ?? null,
      fieldConfidence: d.fieldConfidence ?? null,
      yearOfImport: d.yearOfImport ?? null,
      breakdown: null,
      reviewFlags: duty.reviewFlags,
      exchangeRate,
      evExcluded: duty.isEv,
      taxLines: duty.taxLines,
      totalPayable: duty.totalPayable,
      sourceNotes: d.notes ?? null,
      createdBy: res.locals.user?.email ?? "system",
    });

    return { gate: gateRow };
  });

  req.log.info(
    { gateId: gate.id, dealerId },
    "GRA duty sheet sent for review; awaiting gra_filing gate",
  );
  res.status(201).json(ReviewGraFilingResponse.parse(gate));
});

// ---------------------------------------------------------------------------
// Filing (17-mB step 8): requires the gra_filing gate to be RESOLVED
// (approved/adjusted). 404 foreign gate, 409 unresolved or rejected, 422 if
// the client's figures no longer match the deterministic server recompute.
// Idempotent via X-Idempotency-Key.
// ---------------------------------------------------------------------------
router.post(
  "/gra/filings",
  idempotent("gra.filings"),
  async (req, res): Promise<void> => {
    const parsed = SubmitGraFilingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const dealerId = activeDealerId(res);
    const body = parsed.data;

    const [gate] = await db
      .select()
      .from(gatesTable)
      .where(
        and(
          eq(gatesTable.id, body.gateId),
          eq(gatesTable.dealerId, dealerId),
          eq(gatesTable.type, "gra_filing"),
        ),
      );
    if (!gate) {
      res.status(404).json({ error: "GRA filing gate not found" });
      return;
    }
    if (gate.status === "pending") {
      res.status(409).json({
        error:
          "The gra_filing gate has not been resolved yet — an officer must approve the duty sheet before it can be filed to GRA.",
      });
      return;
    }
    if (gate.status === "dismissed") {
      res.status(409).json({
        error: "The officer rejected this duty sheet — it cannot be filed.",
      });
      return;
    }

    const [filing] = await db
      .select()
      .from(graFilingsTable)
      .where(
        and(
          eq(graFilingsTable.gateId, gate.id),
          eq(graFilingsTable.dealerId, dealerId),
        ),
      );
    if (!filing) {
      res.status(404).json({ error: "No filing snapshot found for this gate" });
      return;
    }
    if (filing.status === "filed") {
      res.status(409).json({ error: "This duty sheet has already been filed." });
      return;
    }
    if (filing.status === "rejected") {
      res.status(409).json({
        error: "This duty sheet was rejected — it cannot be filed.",
      });
      return;
    }

    // Never trust client figures: recompute from dealer_taxes and require the
    // client's cif / rate / lines to match both the recompute AND the gated
    // snapshot the officer approved.
    const duty = await computeDraftDuty(dealerId, {
      cifValue: filing.cifValue,
      engineCc: filing.engineCc,
      fuelType: filing.fuelType,
      year: filing.year,
      yearOfImport: filing.yearOfImport,
    });
    const serverLines = filing.taxLines;
    const serverTotal = filing.totalPayable;
    const recomputeDrifted =
      duty.missingInputs.length > 0 ||
      Math.abs(duty.totalPayable - serverTotal) > 0.01 ||
      !taxLinesMatch(duty.taxLines, serverLines);
    const clientMismatch =
      Math.abs(body.cif - filing.cifValue) > 0.01 ||
      Math.abs(body.exchangeRate - filing.exchangeRate) > 0.01 ||
      body.taxLines.length !== serverLines.length ||
      body.taxLines.some((l, i) => {
        const s = serverLines[i];
        return !s || s.code !== l.code || Math.abs(s.amount - l.amount) > 0.01;
      });
    if (recomputeDrifted || clientMismatch) {
      res.status(422).json({
        error: recomputeDrifted
          ? "The dealer's tax rules changed since the officer approved this sheet — resubmit it for review."
          : "Submitted figures do not match the approved duty sheet. Duty is always computed server-side from the dealer's tax rules.",
        serverTaxLines: serverLines,
        serverTotalPayable: serverTotal,
      });
      return;
    }

    const actor = res.locals.user?.email ?? "system";
    const [filed] = await db.transaction(async (tx) => {
      const updated = await tx
        .update(graFilingsTable)
        .set({
          status: "filed",
          filedBy: gate.resolvedBy ?? actor,
          filedAt: new Date(),
          ...(body.sourceDocIds != null ? { sourceDocIds: body.sourceDocIds } : {}),
        })
        .where(
          and(
            eq(graFilingsTable.id, filing.id),
            eq(graFilingsTable.dealerId, dealerId),
            eq(graFilingsTable.status, "pending_gate"),
          ),
        )
        .returning();
      if (updated.length === 0) return updated;

      await tx.insert(timelineEventsTable).values({
        dealerId,
        domain: "finance",
        kind: "gra_filing_filed",
        title: `GRA duty pack filed — ${filing.filingRef}`,
        detail: `${filing.year} ${filing.make} ${filing.model} (VIN ${filing.vin}); total duty GY$${Math.round(filing.totalPayable).toLocaleString()}. Authorised via gate #${gate.id}.`,
        actor,
        isAgent: false,
        cause: "GRA filing submitted after officer approval",
        refType: "vehicle",
        refId: filing.vehicleId,
      });
      await tx.insert(auditLogsTable).values({
        dealerId,
        actorEmail: actor,
        action: "create",
        module: "gra",
        entityType: "gra_filing",
        entityId: String(filing.id),
        summary: `Filed GRA duty pack ${filing.filingRef} (gate #${gate.id}, total US$${filing.totalPayable.toLocaleString()})`,
      });
      return updated;
    });

    if (!filed) {
      res.status(409).json({ error: "This duty sheet has already been filed." });
      return;
    }
    req.log.info(
      { filingId: filed.id, gateId: gate.id, dealerId },
      "GRA filing filed after gate approval",
    );
    res.status(201).json(SubmitGraFilingResponse.parse(filed));
  },
);

// Live recompute for the officer while editing the draft: pure, no writes.
router.post("/gra/compute", async (req, res): Promise<void> => {
  const parsed = ComputeGraDutyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const b = parsed.data;
  const duty = await computeDraftDuty(dealerId, {
    cifValue: b.cifValue,
    engineCc: b.engineCc,
    fuelType: b.fuelType,
    year: b.yearOfManufacture,
    yearOfImport: b.yearOfImport,
  });
  res.json(
    ComputeGraDutyResponse.parse({
      taxLines: duty.taxLines,
      totalPayable: duty.totalPayable,
      reviewFlags: duty.reviewFlags,
      missingInputs: duty.missingInputs,
      isEv: duty.isEv,
      evSkipped: duty.evSkipped,
    }),
  );
});

router.get("/gra/filings", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const gateId = req.query.gateId ? Number(req.query.gateId) : undefined;
  const vehicleId = req.query.vehicleId ? Number(req.query.vehicleId) : undefined;
  const conds = [eq(graFilingsTable.dealerId, dealerId)];
  if (gateId && Number.isFinite(gateId)) conds.push(eq(graFilingsTable.gateId, gateId));
  if (vehicleId && Number.isFinite(vehicleId))
    conds.push(eq(graFilingsTable.vehicleId, vehicleId));
  const dealIdQ = req.query.dealId ? Number(req.query.dealId) : undefined;
  if (dealIdQ && Number.isFinite(dealIdQ))
    conds.push(eq(graFilingsTable.dealId, dealIdQ));
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
        "The duty pack is generated only after the gra_filing gate is approved and the sheet is filed to GRA.",
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
    dealerTin: dealer?.tin ?? null,
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
