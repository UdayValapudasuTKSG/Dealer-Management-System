import { Router, type IRouter } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, gatesTable } from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import { isAgentEnabled, recordAgentRun } from "../lib/agent-governance";
import {
  ExtractGraFilingBody,
  ExtractGraFilingResponse,
  SubmitGraFilingBody,
  SubmitGraFilingResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const EXTRACTION_PROMPT = `You are a customs documentation officer for a luxury automotive dealership in Ghana. You are reading an uploaded vehicle import document (bill of lading, commercial invoice, customs declaration, or similar).

Extract the details needed to prepare a Ghana Revenue Authority (GRA) vehicle import-duty filing. Return ONLY a JSON object (no markdown, no commentary) with exactly these keys:

{
  "ownerName": string,        // importer / owner full name
  "tin": string,              // Taxpayer Identification Number, format GHA-000000000-0
  "vin": string,              // chassis / VIN number
  "make": string,
  "model": string,
  "year": number,
  "engineCc": number,         // engine capacity in cubic centimetres
  "fuelType": string,         // Petrol, Diesel, Hybrid, or Electric
  "hsCode": string,           // Harmonised System tariff code, e.g. 8703.23.90
  "cifValue": number,         // Cost, Insurance & Freight value in Ghana Cedis (GHS)
  "importDuty": number,       // 20% of CIF for most passenger vehicles
  "vat": number,              // 15% of (CIF + importDuty + nhil + getfundLevy)
  "nhil": number,             // National Health Insurance Levy, 2.5% of CIF
  "getfundLevy": number,      // GETFund Levy, 2.5% of CIF
  "exciseDuty": number,       // 0 if under 1900cc, otherwise 20-50% of CIF
  "totalPayable": number,     // importDuty + vat + nhil + getfundLevy + exciseDuty
  "notes": string             // one short sentence on anything unclear or assumed
}

If any field is not legible, infer a realistic value consistent with the rest of the document. All monetary values must be plain numbers in GHS with no currency symbols or separators. Compute the levies from the CIF value using the rates above so the arithmetic is internally consistent.`;

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

    const draft = ExtractGraFilingResponse.safeParse(candidate);
    if (!draft.success) {
      req.log.error(
        { issues: draft.error.issues },
        "GRA extraction failed validation",
      );
      res.status(502).json({ error: "The document was missing required details" });
      return;
    }

    await recordAgentRun({
      dealerId,
      agentKey: "customs",
      runType: "gra_document_extraction",
      inputSource: "gra",
      inputSummary: `Uploaded ${parsed.data.mediaType} document`,
      outputSummary: `Extracted duty draft for ${`${draft.data.year} ${draft.data.make} ${draft.data.model}`}`,
      latencyMs: Date.now() - startedAt,
    });
    res.json(ExtractGraFilingResponse.parse(draft.data));
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

  const d = parsed.data.draft;
  const dealerId = activeDealerId(res);

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
        { label: "Import Duty", value: ghs(d.importDuty) },
        { label: "VAT", value: ghs(d.vat) },
        { label: "NHIL", value: ghs(d.nhil) },
        { label: "GETFund Levy", value: ghs(d.getfundLevy) },
        { label: "Excise Duty", value: ghs(d.exciseDuty) },
        { label: "Total Payable", value: ghs(d.totalPayable) },
      ],
    })
    .returning();

  res.json(SubmitGraFilingResponse.parse(gate));
});

export default router;
