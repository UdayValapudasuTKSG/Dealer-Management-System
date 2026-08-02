import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  useExtractGraFiling,
  useReviewGraFiling,
  useSubmitGraFiling,
  useListGraFilings,
  useListGates,
  useComputeGraDuty,
  getListGraFilingsQueryKey,
  getListGatesQueryKey,
  getGetGraFilingPdfUrl,
  type GraFilingDraft,
  type GraComputeResponse,
  type GraExtractResponse,
} from "@workspace/api-client-react";
import type { GraExtractRequestMediaType } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  UploadCloud,
  Loader2,
  FileText,
  Sparkles,
  ShieldCheck,
  Check,
  ScanLine,
  PenLine,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMoney } from "@/lib/format";

const ACCEPTED: Record<string, GraExtractRequestMediaType> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

const EXTRACT_LABELS: Record<string, string> = {
  make: "Make",
  model: "Model",
  year: "Year",
  cifPrinted: "CIF value",
  engineCc: "Engine (cc)",
  fuelType: "Fuel type",
};

const EMPTY_DRAFT: GraFilingDraft = {
  ownerName: "",
  tin: "",
  vin: "",
  make: "",
  model: "",
  year: 0,
  engineCc: 0,
  fuelType: "",
  hsCode: "",
  cifValue: 0,
  fobValue: null,
  freightValue: null,
  insuranceValue: null,
  yearOfImport: new Date().getFullYear(),
  sourceDocIds: null,
  fieldConfidence: null,
  notes: null,
};

/** Futuristic X-ray scan overlay: moving green rays + grid over the doc. */
function XrayScanOverlay() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <div className="absolute inset-0 bg-emerald-950/55 mix-blend-multiply" />
      <div className="absolute inset-0 bg-emerald-400/[0.07]" />
      <div
        className="absolute inset-0 opacity-30"
        style={{
          backgroundImage:
            "linear-gradient(rgba(52,211,153,0.35) 1px, transparent 1px), linear-gradient(90deg, rgba(52,211,153,0.35) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
        }}
      />
      <motion.div
        className="absolute inset-x-0 h-24 -translate-y-1/2"
        initial={{ top: "-12%" }}
        animate={{ top: "112%" }}
        transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
      >
        <div className="absolute inset-x-0 top-1/2 h-px bg-emerald-300 shadow-[0_0_18px_4px_rgba(52,211,153,0.75)]" />
        <div className="absolute inset-x-0 top-1/2 h-24 -translate-y-full bg-gradient-to-t from-emerald-400/25 to-transparent" />
        <div className="absolute inset-x-0 top-1/2 h-10 bg-gradient-to-b from-emerald-400/20 to-transparent" />
      </motion.div>
      <motion.div
        className="absolute inset-x-0 h-px bg-emerald-300/50 shadow-[0_0_10px_2px_rgba(52,211,153,0.4)]"
        initial={{ top: "112%" }}
        animate={{ top: "-12%" }}
        transition={{ duration: 3.4, repeat: Infinity, ease: "linear" }}
      />
      {[
        "top-2 left-2 border-t-2 border-l-2",
        "top-2 right-2 border-t-2 border-r-2",
        "bottom-2 left-2 border-b-2 border-l-2",
        "bottom-2 right-2 border-b-2 border-r-2",
      ].map((pos) => (
        <div key={pos} className={cn("absolute w-6 h-6 border-emerald-300/80", pos)} />
      ))}
      <div className="absolute bottom-3 inset-x-0 flex items-center justify-center">
        <motion.div
          animate={{ opacity: [1, 0.45, 1] }}
          transition={{ duration: 1.4, repeat: Infinity }}
          className="inline-flex items-center gap-2 rounded-full bg-black/70 text-emerald-300 text-[11px] font-bold uppercase tracking-[0.25em] px-4 py-1.5 ring-1 ring-emerald-400/40"
        >
          <ScanLine className="w-3.5 h-3.5" />
          Transcribing legible fields
        </motion.div>
      </div>
    </div>
  );
}

export function DutyFiling({
  compact = false,
  prefillNotes,
  vehicleId,
  dealId,
}: {
  /** compact = embedded in a dialog (delivery process) */
  compact?: boolean;
  /** context stamped into the filing notes, e.g. the delivery/customer ref */
  prefillNotes?: string;
  /** vehicle this filing clears (tags the immutable snapshot) */
  vehicleId?: number | null;
  /** deal this filing clears customs for (transaction-level tag) */
  dealId?: number | null;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [draft, setDraft] = useState<GraFilingDraft | null>(null);
  const [extractMeta, setExtractMeta] = useState<Pick<
    GraExtractResponse,
    "confidence" | "dropped" | "notes"
  > | null>(null);
  const [computed, setComputed] = useState<GraComputeResponse | null>(null);
  const [submittedGateId, setSubmittedGateId] = useState<number | null>(null);

  const extract = useExtractGraFiling();
  const review = useReviewGraFiling();
  const file = useSubmitGraFiling();
  const compute = useComputeGraDuty();
  const money = useMoney();

  // Debounced server-side recompute: whenever the officer edits a duty input,
  // POST /gra/compute refreshes the lines/total from the dealer's tax rules.
  // The client NEVER computes duty itself.
  const computeRef = useRef(compute.mutate);
  computeRef.current = compute.mutate;
  const dutyInputs = draft
    ? [draft.cifValue, draft.engineCc, draft.fuelType, draft.year, draft.yearOfImport].join("|")
    : null;
  useEffect(() => {
    if (!draft || submittedGateId) return;
    const t = setTimeout(() => {
      computeRef.current(
        {
          data: {
            cifValue: draft.cifValue ?? 0,
            engineCc: draft.engineCc || null,
            fuelType: draft.fuelType || null,
            yearOfManufacture: draft.year || null,
            yearOfImport: draft.yearOfImport ?? null,
          },
        },
        { onSuccess: (r) => setComputed(r) },
      );
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dutyInputs, submittedGateId]);

  // After sending for review, watch the gate and the pending filing so the
  // "File to GRA" step unlocks the moment the officer approves.
  const gatesQuery = useListGates(undefined, {
    query: {
      queryKey: getListGatesQueryKey(undefined),
      enabled: submittedGateId != null,
      refetchInterval: 5000,
    },
  });
  const gate = submittedGateId
    ? gatesQuery.data?.find((g) => g.id === submittedGateId)
    : undefined;
  const filingQuery = useListGraFilings(
    submittedGateId ? { gateId: submittedGateId } : undefined,
    {
      query: {
        queryKey: getListGraFilingsQueryKey(
          submittedGateId ? { gateId: submittedGateId } : undefined,
        ),
        enabled: submittedGateId != null,
        refetchInterval: 5000,
      },
    },
  );
  const filing = submittedGateId ? filingQuery.data?.[0] : undefined;
  const gateApproved =
    gate?.status === "approved" || gate?.status === "adjusted";
  const gateRejected = gate?.status === "dismissed" || filing?.status === "rejected";

  const handleFile = async (f: File) => {
    const mediaType = ACCEPTED[f.type];
    if (!mediaType) {
      toast({
        title: "Unsupported file",
        description: "Upload a PNG, JPEG, WebP, or GIF image of the document.",
        variant: "destructive",
      });
      return;
    }

    setSubmittedGateId(null);
    setDraft(null);
    setExtractMeta(null);
    setFileName(f.name);

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(f);
    });
    setPreview(dataUrl);

    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);

    extract.mutate(
      { data: { imageBase64: base64, mediaType } },
      {
        onSuccess: (result) => {
          setDraft({
            ...EMPTY_DRAFT,
            make: result.fields.make ?? "",
            model: result.fields.model ?? "",
            year: result.fields.year ?? 0,
            engineCc: result.fields.engineCc ?? 0,
            fuelType: result.fields.fuelType ?? "",
            cifValue: result.fields.cifPrinted ?? 0,
            fieldConfidence: result.confidence as Record<string, number>,
            notes: [result.notes, prefillNotes].filter(Boolean).join(" — ") || null,
          });
          setExtractMeta({
            confidence: result.confidence,
            dropped: result.dropped,
            notes: result.notes,
          });
          toast({
            title: "Transcription complete",
            description:
              result.dropped.length > 0
                ? `Legible fields filled in — key in the rest (${result.dropped.map((d) => EXTRACT_LABELS[d] ?? d).join(", ")}).`
                : "Legible fields filled in. TIN, VIN, owner and HS code are always keyed in by staff.",
          });
        },
        onError: () => {
          // Unreadable document (422) or service error: open a blank draft —
          // everything is keyed in manually. Nothing is ever auto-filled.
          setDraft({
            ...EMPTY_DRAFT,
            notes: prefillNotes ?? null,
          });
          setExtractMeta(null);
          toast({
            title: "Could not read the document",
            description:
              "No field was legible enough to transcribe — enter the values manually from the paperwork.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const startManual = () => {
    setSubmittedGateId(null);
    setExtractMeta(null);
    setDraft({ ...EMPTY_DRAFT, notes: prefillNotes ?? null });
  };

  const total = computed?.totalPayable ?? 0;
  const taxLines = computed?.taxLines ?? [];
  const missingInputs = computed?.missingInputs ?? [];

  const cifComponentsSet =
    draft &&
    draft.fobValue != null &&
    draft.freightValue != null &&
    draft.insuranceValue != null &&
    (draft.fobValue > 0 || draft.freightValue > 0 || draft.insuranceValue > 0);
  const cifMismatch =
    cifComponentsSet &&
    Math.abs(
      (draft!.fobValue ?? 0) + (draft!.freightValue ?? 0) + (draft!.insuranceValue ?? 0) -
        (draft!.cifValue ?? 0),
    ) > 0.01;

  const updateText = (key: keyof GraFilingDraft, value: string) =>
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  const updateNumber = (key: keyof GraFilingDraft, value: string) =>
    setDraft((prev) =>
      prev
        ? { ...prev, [key]: Number(value.replace(/[^0-9.]/g, "")) || 0 }
        : prev,
    );
  const updateNullableNumber = (key: keyof GraFilingDraft, value: string) =>
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            [key]:
              value.trim() === "" ? null : Number(value.replace(/[^0-9.]/g, "")) || 0,
          }
        : prev,
    );

  const missingIdentity =
    !draft ||
    !draft.ownerName.trim() ||
    !draft.tin.trim() ||
    !draft.vin.trim() ||
    !draft.hsCode.trim() ||
    !draft.make.trim() ||
    !draft.model.trim();

  const handleReview = () => {
    if (!draft) return;
    review.mutate(
      { data: { draft, vehicleId: vehicleId ?? null, dealId: dealId ?? null } },
      {
        onSuccess: (g) => {
          setSubmittedGateId(g.id);
          toast({
            title: "Duty sheet sent for review",
            description:
              "An officer must approve the computation before it can be filed to GRA.",
          });
        },
        onError: (err) => {
          const msg =
            (err as { data?: { error?: string } } | undefined)?.data?.error ??
            "Please check the inputs and try again.";
          toast({
            title: "Could not send for review",
            description: msg,
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleFileToGra = () => {
    if (!submittedGateId || !filing) return;
    file.mutate(
      {
        data: {
          gateId: submittedGateId,
          vehicleId: filing.vehicleId ?? null,
          cif: filing.cifValue,
          exchangeRate: filing.exchangeRate,
          taxLines: filing.taxLines,
          evExcluded: filing.evExcluded,
          sourceDocIds: filing.sourceDocIds ?? null,
        },
      },
      {
        onSuccess: () => {
          void filingQuery.refetch();
          toast({
            title: "Filed to GRA",
            description: "The duty pack PDF is now available.",
          });
        },
        onError: (err) => {
          const msg =
            (err as { data?: { error?: string } } | undefined)?.data?.error ??
            "Please try again.";
          toast({ title: "Could not file", description: msg, variant: "destructive" });
        },
      },
    );
  };

  const IDENTITY_FIELDS: {
    key: keyof GraFilingDraft;
    label: string;
    numeric?: boolean;
    manual?: boolean;
  }[] = [
    { key: "ownerName", label: "Importer / Owner", manual: true },
    { key: "tin", label: "TIN", manual: true },
    { key: "vin", label: "Chassis / VIN", manual: true },
    { key: "hsCode", label: "HS Code", manual: true },
    { key: "make", label: "Make" },
    { key: "model", label: "Model" },
    { key: "year", label: "Year", numeric: true },
    { key: "engineCc", label: "Engine (cc)", numeric: true },
    { key: "fuelType", label: "Fuel Type" },
  ];

  const confFor = (key: string): number | null => {
    const map: Record<string, string> = {
      make: "make",
      model: "model",
      year: "year",
      engineCc: "engineCc",
      fuelType: "fuelType",
      cifValue: "cifPrinted",
    };
    const c = (extractMeta?.confidence as Record<string, number> | undefined)?.[
      map[key] ?? ""
    ];
    return typeof c === "number" ? c : null;
  };

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-6",
        compact ? "" : "lg:grid-cols-5 lg:gap-8",
      )}
    >
      {/* Upload / preview column */}
      <div className={cn("space-y-6", !compact && "lg:col-span-2")}>
        <Card className="glass-panel border-none shadow-lg overflow-hidden">
          <CardContent className={compact ? "p-4" : "p-6"}>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />

            <div
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") fileRef.current?.click();
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
              className="relative rounded-2xl border-2 border-dashed border-primary/30 bg-white/[0.03] hover:border-primary/60 hover:bg-primary/5 transition-colors cursor-pointer aspect-[4/3] flex flex-col items-center justify-center text-center p-6 overflow-hidden"
            >
              {preview ? (
                <img
                  src={preview}
                  alt="Uploaded document"
                  className="absolute inset-0 w-full h-full object-cover"
                />
              ) : (
                <>
                  <div className="w-14 h-14 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-4">
                    <UploadCloud className="w-7 h-7" />
                  </div>
                  <p className="font-medium">Drop the import document here</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    or click to browse — PNG, JPEG, WebP, GIF
                  </p>
                </>
              )}

              {extract.isPending && <XrayScanOverlay />}
            </div>

            {fileName && (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="w-4 h-4 shrink-0" />
                <span className="truncate">{fileName}</span>
                {extract.isPending && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400 ml-auto shrink-0" />
                )}
              </div>
            )}

            {!draft && !extract.isPending && (
              <Button
                variant="outline"
                onClick={startManual}
                className="mt-4 w-full rounded-full gap-2"
              >
                <PenLine className="w-4 h-4" />
                Enter details manually
              </Button>
            )}
          </CardContent>
        </Card>

        {!compact && (
          <Card className="glass-panel border-none shadow-lg">
            <CardContent className="p-6">
              <div className="text-xs font-bold uppercase tracking-widest text-primary mb-3">
                How it works
              </div>
              <ol className="space-y-3 text-sm text-muted-foreground">
                <li className="flex gap-3">
                  <span className="font-semibold text-foreground">1.</span>
                  Upload an import document — the scanner transcribes only the
                  clearly legible fields (make, model, year, CIF, engine, fuel).
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-foreground">2.</span>
                  You key in the TIN, VIN, owner and HS code from the paperwork;
                  the duty sheet is computed from this dealership's GRA tax rules.
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-foreground">3.</span>
                  Send for review — after an officer approves the gate, file to
                  GRA and download the duty pack PDF.
                </li>
              </ol>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Draft column */}
      <div className={cn(!compact && "lg:col-span-3")}>
        <AnimatePresence mode="wait">
          {!draft ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <Card className="glass-panel border-none shadow-lg h-full">
                <CardContent
                  className={cn(
                    "flex flex-col items-center justify-center text-center",
                    compact ? "p-8 min-h-[240px]" : "p-12 min-h-[400px]",
                  )}
                >
                  {extract.isPending ? (
                    <>
                      <motion.div
                        animate={{ opacity: [1, 0.4, 1] }}
                        transition={{ duration: 1.4, repeat: Infinity }}
                        className="w-14 h-14 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center mb-4 ring-1 ring-emerald-400/30"
                      >
                        <ScanLine className="w-7 h-7" />
                      </motion.div>
                      <p className="text-lg font-medium">Scanning document</p>
                      <p className="text-muted-foreground max-w-sm mt-1">
                        Transcribing the legible fields — anything unclear is
                        left for you to key in.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="w-14 h-14 rounded-full bg-white/[0.05] text-muted-foreground flex items-center justify-center mb-4">
                        <FileText className="w-7 h-7" />
                      </div>
                      <p className="text-lg font-medium">No filing yet</p>
                      <p className="text-muted-foreground max-w-sm mt-1">
                        Upload a document (or enter details manually) and the
                        duty sheet will appear here for your review.
                      </p>
                    </>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          ) : (
            <motion.div
              key="draft"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <Card className="glass-panel border-none shadow-lg overflow-hidden">
                <CardContent
                  className={cn("space-y-6", compact ? "p-5" : "p-6 md:p-8")}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      {extractMeta ? (
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-emerald-400 mb-1">
                          <Sparkles className="w-3.5 h-3.5" />
                          Legible fields transcribed
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1">
                          <PenLine className="w-3.5 h-3.5" />
                          Manual entry
                        </div>
                      )}
                      <h2 className="text-xl font-semibold">Vehicle Duty Pack</h2>
                    </div>
                    {submittedGateId && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary text-xs font-semibold px-3 py-1.5">
                        <Check className="w-3.5 h-3.5" />
                        In review
                      </span>
                    )}
                  </div>

                  {extractMeta && extractMeta.dropped.length > 0 && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-300">
                      Not legible on the document — key in from the paperwork:{" "}
                      {extractMeta.dropped
                        .map((d) => EXTRACT_LABELS[d] ?? d)
                        .join(", ")}
                      .
                    </div>
                  )}

                  {/* Identity + vehicle fields */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {IDENTITY_FIELDS.map((f, i) => (
                      <ScanField
                        key={f.key}
                        index={i}
                        label={f.label}
                        badge={
                          f.manual
                            ? "keyed in"
                            : confFor(f.key) != null
                              ? `${Math.round((confFor(f.key) ?? 0) * 100)}%`
                              : undefined
                        }
                        value={String(draft[f.key] ?? "") === "0" ? "" : String(draft[f.key] ?? "")}
                        disabled={!!submittedGateId}
                        onChange={(v) =>
                          f.numeric ? updateNumber(f.key, v) : updateText(f.key, v)
                        }
                      />
                    ))}
                  </div>

                  {/* Valuation — CIF and its composition */}
                  <div className="pt-2">
                    <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                      Valuation (GYD)
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <ScanField
                        index={IDENTITY_FIELDS.length}
                        label="CIF Value (GYD)"
                        badge={
                          confFor("cifValue") != null
                            ? `${Math.round((confFor("cifValue") ?? 0) * 100)}%`
                            : undefined
                        }
                        value={draft.cifValue ? String(draft.cifValue) : ""}
                        disabled={!!submittedGateId}
                        onChange={(v) => updateNumber("cifValue", v)}
                      />
                      <ScanField
                        index={IDENTITY_FIELDS.length + 1}
                        label="Year of import"
                        value={String(draft.yearOfImport ?? "")}
                        disabled={!!submittedGateId}
                        onChange={(v) => updateNumber("yearOfImport", v)}
                      />
                      <ScanField
                        index={IDENTITY_FIELDS.length + 2}
                        label="FOB (GYD)"
                        value={draft.fobValue != null ? String(draft.fobValue) : ""}
                        disabled={!!submittedGateId}
                        onChange={(v) => updateNullableNumber("fobValue", v)}
                      />
                      <ScanField
                        index={IDENTITY_FIELDS.length + 3}
                        label="Freight (GYD)"
                        value={draft.freightValue != null ? String(draft.freightValue) : ""}
                        disabled={!!submittedGateId}
                        onChange={(v) => updateNullableNumber("freightValue", v)}
                      />
                      <ScanField
                        index={IDENTITY_FIELDS.length + 4}
                        label="Insurance (GYD)"
                        value={
                          draft.insuranceValue != null ? String(draft.insuranceValue) : ""
                        }
                        disabled={!!submittedGateId}
                        onChange={(v) => updateNullableNumber("insuranceValue", v)}
                      />
                    </div>
                    {cifMismatch && (
                      <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300">
                        FOB + freight + insurance does not equal the CIF value —
                        correct the components before sending for review.
                      </div>
                    )}
                  </div>

                  {/* Server-computed duty lines (dealer tax rules) — read-only */}
                  <div>
                    <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                      Duty & levies — computed from this dealership's GRA tax rules
                    </div>
                    <div className="rounded-xl border border-border bg-white/[0.03] divide-y divide-border">
                      {taxLines.map((line) => (
                        <motion.div
                          key={line.code}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="flex items-center justify-between px-4 py-2.5 text-sm"
                        >
                          <span className="text-muted-foreground">
                            {line.name}
                            {line.kind === "percent" && (
                              <span className="ml-1.5 text-xs opacity-70">
                                {line.rate}%
                              </span>
                            )}
                            {line.basis && (
                              <span className="ml-1.5 text-xs opacity-50">
                                on {line.basis}
                              </span>
                            )}
                          </span>
                          <span className="font-medium tabular-nums">
                            {money.dual(line.amount)}
                          </span>
                        </motion.div>
                      ))}
                      {taxLines.length === 0 && (
                        <div className="px-4 py-2.5 text-sm text-muted-foreground">
                          {compute.isPending
                            ? "Computing duty…"
                            : "No duty assessed yet — complete the inputs above."}
                        </div>
                      )}
                    </div>
                    {computed && computed.evSkipped.length > 0 && (
                      <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400 px-1">
                        Electric vehicle — skipped: {computed.evSkipped.join(", ")}.
                      </div>
                    )}
                  </div>

                  {missingInputs.length > 0 && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-300">
                      Required before review:{" "}
                      {missingInputs
                        .map((f) =>
                          f === "cifValue"
                            ? "CIF value"
                            : f === "engineCc"
                              ? "engine cc"
                              : f === "fuelType"
                                ? "fuel type (petrol / diesel / hybrid / electric)"
                                : f === "year"
                                  ? "year of manufacture"
                                  : f,
                        )
                        .join(", ")}
                      .
                    </div>
                  )}

                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl bg-primary/5 border border-primary/10 p-5 flex items-center justify-between"
                  >
                    <div>
                      <div className="text-xs font-bold uppercase tracking-widest text-primary mb-1">
                        Total payable to GRA
                      </div>
                      <div className="text-3xl font-semibold tracking-tight">
                        {money.gyd(submittedGateId && filing ? filing.totalPayable : total)}
                      </div>
                      <div className="text-sm text-muted-foreground mt-0.5 tabular-nums">
                        {money.usd(submittedGateId && filing ? filing.totalPayable : total)}{" "}
                      </div>
                    </div>
                    <ShieldCheck className="w-10 h-10 text-primary/40" />
                  </motion.div>

                  {submittedGateId ? (
                    <div className="space-y-3">
                      {filing?.status === "filed" ? (
                        <a
                          href={getGetGraFilingPdfUrl(filing.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center gap-2 w-full rounded-full bg-primary hover:bg-primary/90 text-white h-12 font-medium transition-colors"
                        >
                          <FileText className="w-5 h-5" />
                          Download GRA Duty Pack (PDF)
                        </a>
                      ) : gateRejected ? (
                        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300">
                          The duty sheet was declined at the review gate. Correct
                          the details and send it for review again.
                        </div>
                      ) : gateApproved ? (
                        <Button
                          onClick={handleFileToGra}
                          disabled={file.isPending || !filing}
                          className="w-full h-12 rounded-full bg-primary hover:bg-primary/90 text-white gap-2 text-base"
                        >
                          {file.isPending ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                          ) : (
                            <Send className="w-5 h-5" />
                          )}
                          File to GRA — generate the duty pack
                        </Button>
                      ) : (
                        <div className="flex items-center justify-center gap-2 w-full rounded-full border border-primary/20 bg-primary/5 text-primary h-12 font-medium">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Awaiting officer approval — filing unlocks when the gate
                          is approved
                        </div>
                      )}
                    </div>
                  ) : (
                    <Button
                      onClick={handleReview}
                      disabled={
                        review.isPending ||
                        compute.isPending ||
                        missingInputs.length > 0 ||
                        missingIdentity ||
                        !!cifMismatch
                      }
                      className="w-full h-12 rounded-full bg-primary hover:bg-primary/90 text-white gap-2 text-base"
                    >
                      {review.isPending ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <ShieldCheck className="w-5 h-5" />
                      )}
                      Send duty sheet for officer review
                    </Button>
                  )}
                  {!submittedGateId && missingIdentity && (
                    <p className="text-xs text-muted-foreground text-center">
                      Importer, TIN, VIN, HS code, make and model must be keyed in
                      before review — they are never auto-filled.
                    </p>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Field that materializes with a green flash, as if just extracted. */
function ScanField({
  label,
  value,
  index,
  onChange,
  badge,
  disabled,
}: {
  label: string;
  value: string;
  index: number;
  onChange: (value: string) => void;
  badge?: string;
  disabled?: boolean;
}) {
  return (
    <motion.div
      className="space-y-1.5"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.3 }}
    >
      <label className="text-xs uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
        {label}
        {badge && (
          <span
            className={cn(
              "text-[10px] normal-case tracking-normal rounded-full px-1.5 py-px font-semibold",
              badge === "keyed in"
                ? "bg-white/[0.06] text-muted-foreground"
                : "bg-emerald-500/10 text-emerald-500",
            )}
          >
            {badge}
          </span>
        )}
      </label>
      <motion.div
        initial={{ boxShadow: "0 0 0 1px rgba(52,211,153,0.65), 0 0 14px rgba(52,211,153,0.35)" }}
        animate={{ boxShadow: "0 0 0 0px rgba(52,211,153,0), 0 0 0px rgba(52,211,153,0)" }}
        transition={{ delay: index * 0.06 + 0.5, duration: 0.9 }}
        className="rounded-md"
      >
        <Input
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="bg-white/[0.04] border-border focus-visible:ring-primary/20"
        />
      </motion.div>
    </motion.div>
  );
}
