import { useRef, useState } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  useExtractGraFiling,
  useSubmitGraFiling,
  useListGraFilings,
  getListGraFilingsQueryKey,
  getGetGraFilingPdfUrl,
  type GraFilingDraft,
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
  ChevronRight,
  Check,
  ScanLine,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMoney } from "@/lib/format";

const ACCEPTED: Record<string, GraExtractRequestMediaType> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

const MONEY_FIELDS: { key: keyof GraFilingDraft; label: string }[] = [
  { key: "cifValue", label: "CIF Value (US$)" },
];

/** Futuristic X-ray scan overlay: moving green rays + grid over the doc. */
function XrayScanOverlay() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* Green x-ray tint over the document */}
      <div className="absolute inset-0 bg-emerald-950/55 mix-blend-multiply" />
      <div className="absolute inset-0 bg-emerald-400/[0.07]" />
      {/* Scan grid */}
      <div
        className="absolute inset-0 opacity-30"
        style={{
          backgroundImage:
            "linear-gradient(rgba(52,211,153,0.35) 1px, transparent 1px), linear-gradient(90deg, rgba(52,211,153,0.35) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
        }}
      />
      {/* Primary sweeping ray */}
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
      {/* Secondary faint ray, opposite direction */}
      <motion.div
        className="absolute inset-x-0 h-px bg-emerald-300/50 shadow-[0_0_10px_2px_rgba(52,211,153,0.4)]"
        initial={{ top: "112%" }}
        animate={{ top: "-12%" }}
        transition={{ duration: 3.4, repeat: Infinity, ease: "linear" }}
      />
      {/* Corner brackets */}
      {[
        "top-2 left-2 border-t-2 border-l-2",
        "top-2 right-2 border-t-2 border-r-2",
        "bottom-2 left-2 border-b-2 border-l-2",
        "bottom-2 right-2 border-b-2 border-r-2",
      ].map((pos) => (
        <div
          key={pos}
          className={cn("absolute w-6 h-6 border-emerald-300/80", pos)}
        />
      ))}
      {/* Status readout */}
      <div className="absolute bottom-3 inset-x-0 flex items-center justify-center">
        <motion.div
          animate={{ opacity: [1, 0.45, 1] }}
          transition={{ duration: 1.4, repeat: Infinity }}
          className="inline-flex items-center gap-2 rounded-full bg-black/70 text-emerald-300 text-[11px] font-bold uppercase tracking-[0.25em] px-4 py-1.5 ring-1 ring-emerald-400/40"
        >
          <ScanLine className="w-3.5 h-3.5" />
          X-ray scan in progress
        </motion.div>
      </div>
    </div>
  );
}

export function DutyFiling({
  compact = false,
  prefillNotes,
}: {
  /** compact = embedded in a dialog (delivery process) */
  compact?: boolean;
  /** context stamped into the filing notes, e.g. the delivery/customer ref */
  prefillNotes?: string;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [draft, setDraft] = useState<GraFilingDraft | null>(null);
  const [submittedGateId, setSubmittedGateId] = useState<number | null>(null);

  const extract = useExtractGraFiling();
  const submit = useSubmitGraFiling();
  const money = useMoney();

  // After submission, watch the filing so the PDF unlocks the moment the
  // human gate is approved (server flips pending_gate → filed).
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

  const handleFile = async (file: File) => {
    const mediaType = ACCEPTED[file.type];
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
    setFileName(file.name);

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    setPreview(dataUrl);

    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);

    extract.mutate(
      { data: { imageBase64: base64, mediaType } },
      {
        onSuccess: (result) => {
          setDraft(
            prefillNotes
              ? {
                  ...result,
                  notes: [result.notes, prefillNotes]
                    .filter(Boolean)
                    .join(" — "),
                }
              : result,
          );
          toast({
            title: "Scan complete",
            description: "The duty pack was autofilled from the document.",
          });
        },
        onError: () => {
          toast({
            title: "Could not read the document",
            description: "Try a clearer image of the import document.",
            variant: "destructive",
          });
        },
      },
    );
  };

  // Duty lines and the total are computed server-side from the dealer's
  // configured tax rules — never recomputed (or editable) in the client.
  const total = draft ? draft.totalPayable : 0;

  const updateField = (key: keyof GraFilingDraft, value: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const isNumeric =
        key === "year" ||
        key === "engineCc" ||
        key === "cifValue";
      return {
        ...prev,
        [key]: isNumeric ? Number(value.replace(/[^0-9.]/g, "")) || 0 : value,
      };
    });
  };

  const handleSubmit = () => {
    if (!draft) return;
    submit.mutate(
      { data: { draft } },
      {
        onSuccess: (gate) => {
          setSubmittedGateId(gate.id);
          toast({
            title: "Filing routed to a decision gate",
            description: "A manager can now approve the duty pack on the deal.",
          });
        },
        onError: () => {
          toast({
            title: "Could not submit the filing",
            description: "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  // Ordered fields for the staggered auto-fill animation
  const IDENTITY_FIELDS: { key: keyof GraFilingDraft; label: string }[] = [
    { key: "ownerName", label: "Importer / Owner" },
    { key: "tin", label: "TIN" },
    { key: "vin", label: "Chassis / VIN" },
    { key: "hsCode", label: "HS Code" },
    { key: "make", label: "Make" },
    { key: "model", label: "Model" },
    { key: "year", label: "Year" },
    { key: "engineCc", label: "Engine (cc)" },
    { key: "fuelType", label: "Fuel Type" },
  ];

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
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = "";
              }}
            />

            <div
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ")
                  fileRef.current?.click();
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) handleFile(file);
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
                  Upload any import document — invoice, bill of lading, or
                  customs declaration.
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-foreground">2.</span>
                  The X-ray scanner reads the vehicle and computes the GRA duty
                  at standard rates.
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-foreground">3.</span>
                  Review, adjust if needed, and submit — it routes to a human
                  approval gate.
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
                        Extracting the vehicle, importer, and duty figures —
                        fields will fill in automatically.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="w-14 h-14 rounded-full bg-white/[0.05] text-muted-foreground flex items-center justify-center mb-4">
                        <FileText className="w-7 h-7" />
                      </div>
                      <p className="text-lg font-medium">No filing yet</p>
                      <p className="text-muted-foreground max-w-sm mt-1">
                        Upload a document and the duty pack will appear here,
                        autofilled and ready for your review.
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
                  className={cn(
                    "space-y-6",
                    compact ? "p-5" : "p-6 md:p-8",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-emerald-400 mb-1">
                        <Sparkles className="w-3.5 h-3.5" />
                        Autofilled by X-ray scan
                      </div>
                      <h2 className="text-xl font-semibold">
                        Vehicle Duty Pack
                      </h2>
                    </div>
                    {submittedGateId && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary text-xs font-semibold px-3 py-1.5">
                        <Check className="w-3.5 h-3.5" />
                        Submitted
                      </span>
                    )}
                  </div>

                  {/* Vehicle & owner — staggered auto-fill */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {IDENTITY_FIELDS.map((f, i) => (
                      <ScanField
                        key={f.key}
                        index={i}
                        label={f.label}
                        value={String(draft[f.key] ?? "")}
                        onChange={(v) => updateField(f.key, v)}
                      />
                    ))}
                  </div>

                  {/* Duty breakdown */}
                  <div className="pt-2">
                    <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                      Duty & levies
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {MONEY_FIELDS.map((f, i) => (
                        <ScanField
                          key={f.key}
                          index={IDENTITY_FIELDS.length + i}
                          label={f.label}
                          value={String(draft[f.key])}
                          onChange={(v) => updateField(f.key, v)}
                        />
                      ))}
                    </div>
                    {/* Server-computed duty lines (dealer tax rules) — read-only */}
                    <div className="mt-4 rounded-xl border border-border bg-white/[0.03] divide-y divide-border">
                      {draft.taxLines.map((line, i) => (
                        <motion.div
                          key={line.code}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{
                            delay:
                              (IDENTITY_FIELDS.length + MONEY_FIELDS.length + i) *
                              0.08,
                          }}
                          className="flex items-center justify-between px-4 py-2.5 text-sm"
                        >
                          <span className="text-muted-foreground">
                            {line.name}
                            {line.kind === "percent" && (
                              <span className="ml-1.5 text-xs opacity-70">
                                {line.rate}%
                              </span>
                            )}
                          </span>
                          <span className="font-medium tabular-nums">
                            {money.dual(line.amount)}
                          </span>
                        </motion.div>
                      ))}
                      {draft.taxLines.length === 0 && (
                        <div className="px-4 py-2.5 text-sm text-muted-foreground">
                          No duty assessed — check the CIF value.
                        </div>
                      )}
                    </div>
                  </div>

                  {draft.uncertainFields.length > 0 && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-300">
                      Verify before filing — not read confidently:{" "}
                      {draft.uncertainFields.join(", ")}.
                    </div>
                  )}

                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      delay: (IDENTITY_FIELDS.length + MONEY_FIELDS.length) * 0.08 + 0.2,
                    }}
                    className="rounded-2xl bg-primary/5 border border-primary/10 p-5 flex items-center justify-between"
                  >
                    <div>
                      <div className="text-xs font-bold uppercase tracking-widest text-primary mb-1">
                        Total payable to GRA
                      </div>
                      <div className="text-3xl font-semibold tracking-tight">
                        {money.gyd(total)}
                      </div>
                      <div className="text-sm text-muted-foreground mt-0.5 tabular-nums">
                        {money.usd(total)} at GY${money.rate}/US$
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
                      ) : filing?.status === "rejected" ? (
                        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300">
                          The filing was declined at the approval gate. Review
                          the document and resubmit.
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-2 w-full rounded-full border border-primary/20 bg-primary/5 text-primary h-12 font-medium">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Awaiting gate approval — PDF unlocks when approved
                        </div>
                      )}
                      <Link
                        href="/deals"
                        className="flex items-center justify-center gap-2 w-full rounded-full border border-border hover:bg-white/[0.04] h-11 text-sm font-medium transition-colors"
                      >
                        Review on the deal
                        <ChevronRight className="w-4 h-4" />
                      </Link>
                    </div>
                  ) : (
                    <Button
                      onClick={handleSubmit}
                      disabled={submit.isPending}
                      className="w-full h-12 rounded-full bg-primary hover:bg-primary/90 text-white gap-2 text-base"
                    >
                      {submit.isPending ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <ShieldCheck className="w-5 h-5" />
                      )}
                      Submit filing to a decision gate
                    </Button>
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
}: {
  label: string;
  value: string;
  index: number;
  onChange: (value: string) => void;
}) {
  return (
    <motion.div
      className="space-y-1.5"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.08, duration: 0.3 }}
    >
      <label className="text-xs uppercase tracking-widest text-muted-foreground">
        {label}
      </label>
      <motion.div
        initial={{ boxShadow: "0 0 0 1px rgba(52,211,153,0.65), 0 0 14px rgba(52,211,153,0.35)" }}
        animate={{ boxShadow: "0 0 0 0px rgba(52,211,153,0), 0 0 0px rgba(52,211,153,0)" }}
        transition={{ delay: index * 0.08 + 0.5, duration: 0.9 }}
        className="rounded-md"
      >
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-white/[0.04] border-border focus-visible:ring-primary/20"
        />
      </motion.div>
    </motion.div>
  );
}
