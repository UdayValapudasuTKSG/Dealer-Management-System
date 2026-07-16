import { useRef, useState } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  useExtractGraFiling,
  useSubmitGraFiling,
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
} from "lucide-react";

const ACCEPTED: Record<string, GraExtractRequestMediaType> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

type NumericField = Exclude<
  keyof GraFilingDraft,
  | "ownerName"
  | "tin"
  | "vin"
  | "make"
  | "model"
  | "fuelType"
  | "hsCode"
  | "notes"
>;

const MONEY_FIELDS: { key: NumericField; label: string }[] = [
  { key: "cifValue", label: "CIF Value (GHS)" },
  { key: "importDuty", label: "Import Duty (GHS)" },
  { key: "vat", label: "VAT (GHS)" },
  { key: "nhil", label: "NHIL (GHS)" },
  { key: "getfundLevy", label: "GETFund Levy (GHS)" },
  { key: "exciseDuty", label: "Excise Duty (GHS)" },
];

const ghs = (n: number) =>
  `GHS ${n.toLocaleString("en-GH", { maximumFractionDigits: 0 })}`;

export default function Gra() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [draft, setDraft] = useState<GraFilingDraft | null>(null);
  const [submittedGateId, setSubmittedGateId] = useState<number | null>(null);

  const extract = useExtractGraFiling();
  const submit = useSubmitGraFiling();

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
          setDraft(result);
          toast({
            title: "Document read",
            description: "The concierge autofilled the duty pack for your review.",
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

  const total = draft
    ? draft.importDuty +
      draft.vat +
      draft.nhil +
      draft.getfundLevy +
      draft.exciseDuty
    : 0;

  const updateField = (key: keyof GraFilingDraft, value: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const isNumeric =
        key === "year" ||
        key === "engineCc" ||
        MONEY_FIELDS.some((f) => f.key === key);
      return {
        ...prev,
        [key]: isNumeric ? Number(value.replace(/[^0-9.]/g, "")) || 0 : value,
      };
    });
  };

  const handleSubmit = () => {
    if (!draft) return;
    submit.mutate(
      { data: { draft: { ...draft, totalPayable: total } } },
      {
        onSuccess: (gate) => {
          setSubmittedGateId(gate.id);
          toast({
            title: "Filing routed to a decision gate",
            description: "A manager can now approve the duty pack in Approvals.",
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

  return (
    <div className="w-full px-5 md:px-8 py-10 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-primary mb-2">
          <Sparkles className="w-4 h-4" />
          Concierge Workflow
        </div>
        <h1 className="text-4xl font-light tracking-tight mb-2">
          GRA Duty <span className="font-semibold">Filing</span>
        </h1>
        <p className="text-muted-foreground text-lg max-w-2xl">
          Upload an import document. The concierge reads it, prepares the Ghana
          Revenue Authority vehicle-duty pack, and routes it to a human decision
          gate for approval.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
        {/* Upload / preview column */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="glass-panel border-none shadow-lg overflow-hidden">
            <CardContent className="p-6">
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
                  if (e.key === "Enter" || e.key === " ") fileRef.current?.click();
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

                {extract.isPending && (
                  <div className="absolute inset-0 bg-white/[0.04] backdrop-blur-sm flex flex-col items-center justify-center">
                    <Loader2 className="w-8 h-8 animate-spin text-primary mb-3" />
                    <p className="text-sm font-medium text-primary">
                      Reading the document...
                    </p>
                  </div>
                )}
              </div>

              {fileName && (
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <FileText className="w-4 h-4 shrink-0" />
                  <span className="truncate">{fileName}</span>
                </div>
              )}
            </CardContent>
          </Card>

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
                  The concierge extracts the vehicle and computes the GRA duty at
                  standard rates.
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-foreground">3.</span>
                  Review, adjust if needed, and submit — it routes to a human
                  approval gate.
                </li>
              </ol>
            </CardContent>
          </Card>
        </div>

        {/* Draft column */}
        <div className="lg:col-span-3">
          <AnimatePresence mode="wait">
            {!draft ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <Card className="glass-panel border-none shadow-lg h-full">
                  <CardContent className="p-12 flex flex-col items-center justify-center text-center min-h-[400px]">
                    <div className="w-14 h-14 rounded-full bg-white/[0.05] text-muted-foreground flex items-center justify-center mb-4">
                      <FileText className="w-7 h-7" />
                    </div>
                    <p className="text-lg font-medium">No filing yet</p>
                    <p className="text-muted-foreground max-w-sm mt-1">
                      Upload a document and the duty pack will appear here,
                      autofilled and ready for your review.
                    </p>
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
                  <CardContent className="p-6 md:p-8 space-y-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-primary mb-1">
                          <Sparkles className="w-3.5 h-3.5" />
                          Autofilled by the concierge
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

                    {/* Vehicle & owner */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <Field
                        label="Importer / Owner"
                        value={draft.ownerName}
                        onChange={(v) => updateField("ownerName", v)}
                      />
                      <Field
                        label="TIN"
                        value={draft.tin}
                        onChange={(v) => updateField("tin", v)}
                      />
                      <Field
                        label="Chassis / VIN"
                        value={draft.vin}
                        onChange={(v) => updateField("vin", v)}
                      />
                      <Field
                        label="HS Code"
                        value={draft.hsCode}
                        onChange={(v) => updateField("hsCode", v)}
                      />
                      <Field
                        label="Make"
                        value={draft.make}
                        onChange={(v) => updateField("make", v)}
                      />
                      <Field
                        label="Model"
                        value={draft.model}
                        onChange={(v) => updateField("model", v)}
                      />
                      <Field
                        label="Year"
                        value={String(draft.year)}
                        onChange={(v) => updateField("year", v)}
                      />
                      <Field
                        label="Engine (cc)"
                        value={String(draft.engineCc)}
                        onChange={(v) => updateField("engineCc", v)}
                      />
                      <Field
                        label="Fuel Type"
                        value={draft.fuelType}
                        onChange={(v) => updateField("fuelType", v)}
                      />
                    </div>

                    {/* Duty breakdown */}
                    <div className="pt-2">
                      <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                        Duty & levies
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {MONEY_FIELDS.map((f) => (
                          <Field
                            key={f.key}
                            label={f.label}
                            value={String(draft[f.key])}
                            onChange={(v) => updateField(f.key, v)}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="rounded-2xl bg-primary/5 border border-primary/10 p-5 flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold uppercase tracking-widest text-primary mb-1">
                          Total payable to GRA
                        </div>
                        <div className="text-3xl font-semibold tracking-tight">
                          {ghs(total)}
                        </div>
                      </div>
                      <ShieldCheck className="w-10 h-10 text-primary/40" />
                    </div>

                    {submittedGateId ? (
                      <Link
                        href="/approvals"
                        className="flex items-center justify-center gap-2 w-full rounded-full bg-primary hover:bg-primary/90 text-white h-12 font-medium transition-colors"
                      >
                        Review in Approvals
                        <ChevronRight className="w-4 h-4" />
                      </Link>
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
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs uppercase tracking-widest text-muted-foreground">
        {label}
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-white/[0.04] border-border focus-visible:ring-primary/20"
      />
    </div>
  );
}
