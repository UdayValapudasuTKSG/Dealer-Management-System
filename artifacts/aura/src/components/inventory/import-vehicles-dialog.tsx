import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getListVehiclesQueryKey } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  FileSpreadsheet,
  Download,
  Upload,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  X,
} from "lucide-react";

const apiBase = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

type ImportResult = {
  mode: "preview" | "apply";
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: { row: number; field?: string | null; message: string }[];
};

export function ImportVehiclesDialog({ trigger }: { trigger: React.ReactNode }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const reset = () => {
    setFile(null);
    setResult(null);
    setUploading(false);
    setDragOver(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const pickFile = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".xlsx")) {
      toast({
        title: "Unsupported file",
        description: "Please upload an Excel .xlsx file. Download the template if you need the format.",
        variant: "destructive",
      });
      return;
    }
    setResult(null);
    setFile(f);
  };

  const onImport = async (mode: "preview" | "apply") => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Maximum file size is 10 MB.",
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${apiBase()}/vehicles/import?mode=${mode}`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Import failed (${res.status})`);
      }
      const summary = (await res.json()) as ImportResult & { mode?: string };
      setResult(summary);

      if (mode === "apply") {
        const applied = summary.inserted + summary.updated;
        if (applied > 0) {
          qc.invalidateQueries({ queryKey: getListVehiclesQueryKey() });
          toast({
            title: "Inventory imported",
            description: `${summary.inserted} added, ${summary.updated} updated, ${summary.unchanged} unchanged.`,
          });
        } else if (summary.unchanged > 0 && summary.skipped === 0) {
          toast({
            title: "Inventory already up to date",
            description: `${summary.unchanged} row${summary.unchanged === 1 ? "" : "s"} matched without changes.`,
          });
        } else {
          toast({
            title: "No changes applied",
            description: "Review the rejected rows before trying again.",
            variant: "destructive",
          });
        }
      }
    } catch (err) {
      toast({
        title: "Import failed",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="glass-panel border-white/10 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-xl tracking-tight">Import inventory from Excel</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Upload an .xlsx stock sheet to add vehicles or update existing stock.
            Keep exported Inventory IDs unchanged; a blank ID uses VIN matching or creates a new vehicle.
            (Max 1,000 rows, 10 MB).
          </DialogDescription>
        </DialogHeader>

        <a
          href={`${apiBase()}/vehicles/import/template`}
          className="flex items-center gap-2 rounded-xl bg-primary/5 border border-primary/15 px-3 py-2.5 text-sm text-foreground hover:bg-primary/10 transition-colors"
          download
        >
          <Download className="w-4 h-4 text-primary shrink-0" />
          <span className="font-medium">Download the Excel template</span>
          <span className="text-xs text-muted-foreground ml-auto">headers + example row</span>
        </a>

        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0])}
        />

        {!file ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              pickFile(e.dataTransfer.files?.[0]);
            }}
            className={`flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 transition-colors ${
              dragOver
                ? "border-primary/60 bg-primary/10"
                : "border-white/15 bg-foreground/[0.03] hover:border-primary/40 hover:bg-foreground/[0.05]"
            }`}
          >
            <FileSpreadsheet className="w-8 h-8 text-primary" />
            <div className="text-sm font-medium">Drop your .xlsx here or click to browse</div>
            <div className="text-xs text-muted-foreground">
              Required columns: Make, Model, Year, Price, Powertrain, Mileage, Exterior Color, Body Type
            </div>
          </button>
        ) : (
          <div className="flex items-center gap-3 rounded-xl bg-foreground/[0.04] border border-white/10 px-4 py-3">
            <FileSpreadsheet className="w-5 h-5 text-primary shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{file.name}</div>
              <div className="text-xs text-muted-foreground">
                {(file.size / 1024).toFixed(0)} KB
              </div>
            </div>
            {!uploading && !result && (
              <button
                type="button"
                onClick={reset}
                className="p-2 rounded-full hover:bg-foreground/10 transition-colors"
                aria-label="Remove file"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-3" aria-live="polite">
            <div className="flex flex-wrap items-center gap-4 rounded-xl bg-foreground/[0.03] border border-white/10 px-4 py-3 text-sm">
              <span className="flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
                {result.inserted} {result.mode === "preview" ? "will be added" : "added"}
              </span>
              <span className="flex items-center gap-1.5 text-sky-400">
                <CheckCircle2 className="w-4 h-4" />
                {result.updated} {result.mode === "preview" ? "will be updated" : "updated"}
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <CheckCircle2 className="w-4 h-4" />
                {result.unchanged} unchanged
              </span>
              <span className="flex items-center gap-1.5 text-amber-400">
                <AlertTriangle className="w-4 h-4" />
                {result.skipped} {result.mode === "preview" ? "will be rejected" : "rejected"}
              </span>
              <span className="text-muted-foreground ml-auto">{result.total} rows</span>
            </div>
            {result.errors.length > 0 && (
              <div className="max-h-44 overflow-y-auto rounded-xl border border-amber-500/20 bg-amber-500/[0.04] divide-y divide-white/5">
                {result.errors.map((e, i) => (
                  <div key={i} className="px-4 py-2 text-xs">
                    <span className="font-semibold text-amber-400">
                      Row {e.row}
                      {e.field ? ` · ${e.field}` : ""}:
                    </span>{" "}
                    <span className="text-muted-foreground">{e.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="mt-4 flex-row justify-end gap-2">
          {result?.mode === "preview" ? (
            <>
              <Button
                onClick={reset}
                variant="outline"
                className="rounded-full px-6 border-white/15 mr-auto"
                disabled={uploading}
              >
                Choose a different file
              </Button>
              <Button
                onClick={() => onImport("apply")}
                disabled={uploading || result.inserted + result.updated === 0}
                className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
              >
                {uploading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                Confirm and apply
              </Button>
            </>
          ) : result?.mode === "apply" ? (
            <Button
              onClick={reset}
              variant="outline"
              className="rounded-full px-6 border-white/15"
            >
              Start over
            </Button>
          ) : (
            <Button
              onClick={() => onImport("preview")}
              disabled={!file || uploading}
              className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
            >
              {uploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Previewing…
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Preview import
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
