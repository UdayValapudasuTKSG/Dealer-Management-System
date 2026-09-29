import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDealerBrochures, useCreateDealerBrochure, useUpdateDealerBrochure,
  useArchiveDealerBrochure, getListDealerBrochuresQueryKey, requestUploadUrl,
} from "@workspace/api-client-react";
import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useAuthz } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { FileText, Plus, Pencil, Archive, Loader2 } from "lucide-react";

const LIMIT = 20 * 1024 * 1024;
// Display-only presets for GT Automotive; no PDF exists for M9 yet.
// Applying one is explicit and does not change the attachment or title.
const GT_FINANCE_PRESETS = {
  "dolphin-mini": { model: "Mini", kind: "amount", down: "150000", emi: "49900", dp: "4500000", df: "" },
  "song-pro": { model: "Pro", kind: "amount", down: "300000", emi: "69900", dp: "5699000", df: "" },
  "yuan-plus": { model: "Yuan Plus", kind: "percent", down: "10", emi: "95500", dp: "7500000", df: "" },
  "song-plus-dmi": { model: "Song Plus", kind: "percent", down: "10", emi: "122141", dp: "9600000", df: "7600000" },
  shark: { model: "Shark", kind: "amount", down: "625000", emi: "154900", dp: "12500000", df: "10500000" },
  "atto-8": { model: "Atto 8", kind: "percent", down: "10", emi: "177920", dp: "14500000", df: "" },
  m9: { model: "M9", kind: "percent", down: "10", emi: "177920", dp: "14500000", df: "" },
} as const;
type Selected = { id: string; title: string; fileName: string;
  financeModel?: string | null; downPaymentType?: "amount" | "percent" | null;
  downPaymentValue?: number | null; monthlyEmi?: number | null;
  priceDp?: number | null; priceDf?: number | null } | null;

async function uploadBrochurePdf(file: File): Promise<string> {
  // The shared useUpload hook calls fetch directly for presigning; it does
  // not attach the Clerk bearer token, active dealer, or dev persona header.
  // Use the generated authenticated API request for presigning instead.
  let signed: Awaited<ReturnType<typeof requestUploadUrl>>;
  try {
    signed = await requestUploadUrl({ name: file.name, size: file.size, contentType: file.type });
  } catch (error) {
    throw new Error(`Could not authorize PDF upload: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The GCS signed URL is an external endpoint: do NOT forward API auth,
  // dealer or persona headers to it (and do not JSON-encode the PDF bytes).
  let response: Response;
  try {
    response = await fetch(signed.uploadURL, {
      method: "PUT", headers: { "Content-Type": file.type }, body: file,
    });
  } catch (error) {
    throw new Error(`PDF storage upload could not connect (network or storage CORS): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`PDF storage upload rejected (${response.status} ${response.statusText}).`);
  return signed.objectPath;
}

export default function SettingsBrochures() {
  const { can, activeDealer } = useAuthz();
  const editable = can("settings", "edit");
  const gtPresetsAvailable = activeDealer?.dealerId === 1 && activeDealer.dealerName === "GT Automotive";
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: brochures, isLoading, isError, refetch } = useListDealerBrochures();
  const [isUploading, setIsUploading] = useState(false);
  const create = useCreateDealerBrochure();
  const update = useUpdateDealerBrochure();
  const archive = useArchiveDealerBrochure();
  const [editor, setEditor] = useState<Selected | "new">(null);
  const [archiveTarget, setArchiveTarget] = useState<Selected>(null);
  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [financeModel, setFinanceModel] = useState("");
  const [downPaymentType, setDownPaymentType] = useState<"amount" | "percent" | "">("");
  const [downPaymentValue, setDownPaymentValue] = useState("");
  const [monthlyEmi, setMonthlyEmi] = useState("");
  const [priceDp, setPriceDp] = useState("");
  const [priceDf, setPriceDf] = useState("");
  const [error, setError] = useState("");
  const pending = isUploading || create.isPending || update.isPending || archive.isPending;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: getListDealerBrochuresQueryKey() });
    // Lead dialogs use a lead-specific key, so invalidate all of them.
    qc.invalidateQueries({ predicate: (query) => /^\/api\/leads\/\d+\/brochures$/.test(String(query.queryKey[0])) });
  };
  const open = (item: Selected | "new") => {
    setTitle(item === "new" || !item ? "" : item.title);
    setFileName(item === "new" || !item ? "" : item.fileName);
    setFinanceModel(item === "new" || !item ? "" : item.financeModel ?? "");
    setDownPaymentType(item === "new" || !item ? "" : item.downPaymentType ?? "");
    setDownPaymentValue(item === "new" || !item ? "" : String(item.downPaymentValue ?? ""));
    setMonthlyEmi(item === "new" || !item ? "" : String(item.monthlyEmi ?? ""));
    setPriceDp(item === "new" || !item ? "" : String(item.priceDp ?? ""));
    setPriceDf(item === "new" || !item ? "" : String(item.priceDf ?? ""));
    setFile(null);
    setError("");
    setEditor(item);
  };
  const save = async () => {
    if (!title.trim() || !fileName.trim()) { setError("Enter a display name and PDF filename."); return; }
    if (editor === "new" && !file) { setError("Choose a PDF file."); return; }
    if (file && (file.type !== "application/pdf" || file.size < 8 || file.size > LIMIT)) {
      setError("Choose a PDF up to 20 MB."); return;
    }
    if (!!downPaymentType !== !!downPaymentValue || (downPaymentType === "percent" && Number(downPaymentValue) > 100) ||
        [downPaymentValue, monthlyEmi, priceDp, priceDf].some((value) => value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0))) {
      setError("Enter a valid down payment type and value together, and non-negative GYD amounts."); return;
    }
    const finance = {
      financeModel: financeModel.trim() || null,
      downPaymentType: downPaymentType || null,
      downPaymentValue: downPaymentValue === "" ? null : Number(downPaymentValue),
      monthlyEmi: monthlyEmi === "" ? null : Number(monthlyEmi),
      priceDp: priceDp === "" ? null : Number(priceDp),
      priceDf: priceDf === "" ? null : Number(priceDf),
    } as const;
    setError("");
    try {
      // Only metadata travels through JSON; bytes go directly to private App Storage.
      let objectPath: string | undefined;
      if (file) {
        setIsUploading(true);
        try { objectPath = await uploadBrochurePdf(file); }
        finally { setIsUploading(false); }
      }
      if (editor === "new") {
        await create.mutateAsync({ data: { title: title.trim(), fileName: fileName.trim(),
          objectPath: objectPath!, ...finance } });
      } else if (editor) {
        await update.mutateAsync({ brochureId: editor.id, data: {
          title: title.trim(), fileName: fileName.trim(),
          ...(objectPath ? { objectPath } : {}), ...finance,
        } });
      }
      refresh();
      setEditor(null);
      toast({ title: "Brochure saved", description: "It is available on lead Send brochures." });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save brochure.");
    }
  };

  return <>
    <PageHero eyebrow="Settings" icon={FileText} title="Brochure" accent="Library"
      subtitle="Manage the PDFs your team can attach when emailing brochures from a lead."
      action={editable ? <Button onClick={() => open("new")}><Plus className="mr-2 h-4 w-4" />Add brochure</Button> : undefined} />
    <SettingsTabs />
    <div className="px-5 md:px-8 pb-10 space-y-4">
      <p className="text-sm text-muted-foreground">Up to seven PDFs per email, with a combined 20 MB limit. Archived brochures disappear from future selections; queued emails keep their original files.</p>
      {isLoading && <p className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin" /> Loading brochures…</p>}
      {isError && <div role="alert" className="text-sm text-destructive">Could not load brochures. <Button variant="outline" onClick={() => refetch()}>Retry</Button></div>}
      {!isLoading && !isError && !brochures?.length && <p className="text-sm text-muted-foreground">No brochures yet. Add a PDF to get started.</p>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {brochures?.map((item) => {
          const builtin = !/^[0-9a-f-]{36}$/i.test(item.id);
          return <div key={item.id} className={`rounded-xl border border-border bg-card p-5 space-y-3 ${!item.active ? "opacity-60" : ""}`}>
            <div className="flex items-start justify-between gap-2">
              <FileText className="h-5 w-5 text-primary shrink-0" />
              <Badge variant="outline">{builtin ? "Provided" : item.active ? "Active" : "Archived"}</Badge>
            </div>
            <div className="font-semibold break-words">{item.title}</div>
            <div className="text-xs text-muted-foreground break-all">{item.fileName} · {(item.sizeBytes / 1048576).toFixed(1)} MB</div>
            {(item.financeModel || item.monthlyEmi != null || item.priceDp != null) && <div className="text-xs text-muted-foreground">
              {item.financeModel && <span>{item.financeModel} · </span>}
              {item.downPaymentValue != null && <span>Down {item.downPaymentType === "percent" ? `${item.downPaymentValue}%` : `GYD ${item.downPaymentValue.toLocaleString()}`} · </span>}
              {item.monthlyEmi != null && <span>EMI GYD {item.monthlyEmi.toLocaleString()} · </span>}
              {item.priceDp != null && <span>DP GYD {item.priceDp.toLocaleString()} · </span>}
              {item.priceDf != null && <span>DF GYD {item.priceDf.toLocaleString()}</span>}
            </div>}
            {editable && item.active && <div className="flex gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => open(item)}><Pencil className="h-3.5 w-3.5 mr-1" />Edit</Button>
              <Button variant="outline" size="sm" onClick={() => setArchiveTarget(item)}><Archive className="h-3.5 w-3.5 mr-1" />Archive</Button>
            </div>}
          </div>;
        })}
      </div>
    </div>
    <Dialog open={editor !== null} onOpenChange={(value) => { if (!value && !pending) setEditor(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editor === "new" ? "Add brochure" : "Edit brochure"}</DialogTitle>
          <DialogDescription>Upload a PDF up to 20 MB. Email attachments have a combined 20 MB limit. Replacing a PDF won't change attachments in emails already queued.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1"><Label htmlFor="brochure-title">Display name</Label><Input id="brochure-title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. New model brochure" /></div>
          <div className="space-y-1"><Label htmlFor="brochure-filename">Attachment filename</Label><Input id="brochure-filename" maxLength={120} value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="New-Model-Brochure.pdf" /></div>
          <div className="space-y-1"><Label htmlFor="brochure-file">PDF {editor !== "new" && "(optional replacement)"}</Label><Input id="brochure-file" type="file" accept="application/pdf,.pdf" onChange={(e) => { const selected = e.target.files?.[0] ?? null; setFile(selected); if (selected && !fileName) setFileName(selected.name); }} /></div>
          <div className="border-t pt-3 text-sm font-semibold">Vehicle finance · GYD (optional)</div>
          {gtPresetsAvailable && <div className="space-y-1">
            <Label htmlFor="finance-preset">Apply a GT finance preset (optional)</Label>
            <select id="finance-preset" className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm" value=""
              onChange={(e) => {
                const preset = GT_FINANCE_PRESETS[e.target.value as keyof typeof GT_FINANCE_PRESETS];
                if (!preset) return;
                setFinanceModel(preset.model);
                setDownPaymentType(preset.kind);
                setDownPaymentValue(preset.down);
                setMonthlyEmi(preset.emi);
                setPriceDp(preset.dp);
                setPriceDf(preset.df);
              }}>
              <option value="">Choose to fill finance fields…</option>
              {Object.entries(GT_FINANCE_PRESETS).map(([key, preset]) =>
                <option key={key} value={key}>{preset.model}{key === "m9" ? " (PDF upload required)" : ""}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">Selecting a preset fills the fields below. You can edit or clear them before saving. M9 has no supplied PDF.</p>
          </div>}
          <div className="space-y-1"><Label htmlFor="finance-model">Model name</Label><Input id="finance-model" value={financeModel} maxLength={120} onChange={(e) => setFinanceModel(e.target.value)} placeholder="e.g. M9" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label htmlFor="down-type">Down payment type</Label><select id="down-type" className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm" value={downPaymentType} onChange={(e) => setDownPaymentType(e.target.value as "amount" | "percent" | "")}><option value="">Not specified</option><option value="amount">GYD amount</option><option value="percent">Percentage</option></select></div>
            <div className="space-y-1"><Label htmlFor="down-value">Down payment value</Label><Input id="down-value" type="number" min="0" step="0.01" value={downPaymentValue} onChange={(e) => setDownPaymentValue(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="monthly-emi">Monthly EMI (GYD)</Label><Input id="monthly-emi" type="number" min="0" step="0.01" value={monthlyEmi} onChange={(e) => setMonthlyEmi(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="price-dp">DP price (GYD)</Label><Input id="price-dp" type="number" min="0" step="0.01" value={priceDp} onChange={(e) => setPriceDp(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="price-df">DF price (GYD)</Label><Input id="price-df" type="number" min="0" step="0.01" value={priceDf} onChange={(e) => setPriceDf(e.target.value)} /></div>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setEditor(null)}>Cancel</Button><Button disabled={pending} onClick={save}>{pending ? "Saving…" : "Save brochure"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!archiveTarget} onOpenChange={(value) => { if (!value && !pending) setArchiveTarget(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Archive brochure?</DialogTitle><DialogDescription>{archiveTarget?.title} will no longer be available for new lead emails. Already queued emails retain the attached PDF.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setArchiveTarget(null)}>Cancel</Button>
          <Button variant="destructive" disabled={pending} onClick={async () => {
            if (!archiveTarget) return;
            try {
              await archive.mutateAsync({ brochureId: archiveTarget.id });
              refresh();
              setArchiveTarget(null);
              toast({ title: "Brochure archived" });
            } catch (e) { toast({ title: "Could not archive brochure", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
          }}>Archive</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}