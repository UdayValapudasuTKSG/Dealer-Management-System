import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, getListPartsQueryKey, getListSuppliersQueryKey } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { PricingPolicyEditor } from "./pricing-policy-editor";

type ImportMode = "upsert" | "reject";
type ImportField =
  | "sku"
  | "name"
  | "description"
  | "category"
  | "unitCost"
  | "unitPrice"
  | "costingMethod"
  | "reorderMin"
  | "reorderMax"
  | "barcode"
  | "location"
  | "stock";
type ImportStatus =
  | "pending"
  | "queued"
  | "validating"
  | "validated"
  | "ready"
  | "invalid"
  | "processing"
  | "committing"
  | "completed"
  | "committed"
  | "failed";

interface ImportIssue {
  row: number;
  field?: string | null;
  message: string;
}

interface PartsImportJob {
  id: number;
  status: ImportStatus;
  mode: ImportMode;
  fileName: string;
  totalRows: number;
  processedRows: number;
  errorCount: number;
  errors: ImportIssue[];
  errorMessage?: string | null;
}

interface ImportOptions {
  mode: ImportMode;
  mapping: Partial<Record<ImportField, string>>;
  applyStock: boolean;
}

interface FieldDefinition {
  key: ImportField;
  label: string;
  required?: boolean;
}

const FIELDS: FieldDefinition[] = [
  { key: "sku", label: "SKU / part number", required: true },
  { key: "name", label: "Name", required: true },
  { key: "description", label: "Description" },
  { key: "category", label: "Category" },
  { key: "unitCost", label: "Unit cost", required: true },
  { key: "unitPrice", label: "Unit price" },
  { key: "costingMethod", label: "Costing method" },
  { key: "reorderMin", label: "Reorder minimum" },
  { key: "reorderMax", label: "Reorder maximum" },
  { key: "barcode", label: "Barcode" },
  { key: "location", label: "Location / bin" },
  { key: "stock", label: "Stock balance" },
];
const NONE = "__not_mapped__";
const activeStatuses = new Set<ImportStatus>(["pending", "queued", "validating", "processing", "committing"]);
const readyStatuses = new Set<ImportStatus>(["validated", "ready"]);
const successStatuses = new Set<ImportStatus>(["completed", "committed"]);
const aliases: Record<ImportField, string[]> = {
  sku: ["sku", "partnumber", "partno"],
  name: ["name", "partname"],
  description: ["description", "desc"],
  category: ["category"],
  unitCost: ["unitcost", "cost"],
  unitPrice: ["unitprice", "price", "sellprice"],
  costingMethod: ["costingmethod"],
  reorderMin: ["reordermin", "reorderlevel"],
  reorderMax: ["reordermax"],
  barcode: ["barcode"],
  location: ["location", "bin", "binlocation"],
  stock: ["stock", "quantity", "qty"],
};

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const resumeKey = "aura-parts-import-job";

function message(error: unknown) {
  return error instanceof Error ? error.message : "The import request failed.";
}

function csvHeaders(text: string): string[] {
  const headers: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell === "") quoted = true;
    else if (character === ",") {
      headers.push(cell.trim().replace(/^\uFEFF/, ""));
      cell = "";
    } else if (character === "\n" || character === "\r") {
      headers.push(cell.trim().replace(/^\uFEFF/, ""));
      return headers;
    } else cell += character;
  }
  headers.push(cell.trim().replace(/^\uFEFF/, ""));
  return headers;
}

interface ZipEntry {
  compression: number;
  compressedSize: number;
  localOffset: number;
}

function uint16(view: DataView, offset: number) {
  return view.getUint16(offset, true);
}

function uint32(view: DataView, offset: number) {
  return view.getUint32(offset, true);
}

function zipEntries(buffer: ArrayBuffer): Map<string, ZipEntry> {
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  let endOffset = -1;
  for (let offset = Math.max(0, view.byteLength - 65_557); offset <= view.byteLength - 22; offset += 1) {
    if (uint32(view, offset) === 0x06054b50) endOffset = offset;
  }
  if (endOffset < 0) throw new Error("This is not a valid XLSX archive.");
  const count = uint16(view, endOffset + 10);
  let offset = uint32(view, endOffset + 16);
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index += 1) {
    if (uint32(view, offset) !== 0x02014b50) throw new Error("The XLSX directory is invalid.");
    const fileNameLength = uint16(view, offset + 28);
    const extraLength = uint16(view, offset + 30);
    const commentLength = uint16(view, offset + 32);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, fileNameLength));
    entries.set(name, {
      compression: uint16(view, offset + 10),
      compressedSize: uint32(view, offset + 20),
      localOffset: uint32(view, offset + 42),
    });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZipText(buffer: ArrayBuffer, entries: Map<string, ZipEntry>, name: string) {
  const entry = entries.get(name);
  if (!entry) return null;
  const view = new DataView(buffer);
  if (uint32(view, entry.localOffset) !== 0x04034b50) throw new Error("The XLSX entry is invalid.");
  const dataOffset =
    entry.localOffset + 30 + uint16(view, entry.localOffset + 26) + uint16(view, entry.localOffset + 28);
  const source = buffer.slice(dataOffset, dataOffset + entry.compressedSize);
  if (entry.compression === 0) return new TextDecoder().decode(source);
  if (entry.compression !== 8) throw new Error("The XLSX uses an unsupported compression method.");
  const stream = new Blob([source]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

function xml(text: string) {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("The XLSX contains invalid XML.");
  return document;
}

function elementsByLocalName(document: Document | Element, name: string) {
  return Array.from(document.getElementsByTagName("*")).filter((element) => element.localName === name);
}

function columnIndex(reference: string) {
  const letters = reference.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? "";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

async function xlsxHeaders(file: File): Promise<string[]> {
  const buffer = await file.arrayBuffer();
  const entries = zipEntries(buffer);
  const workbookText = await readZipText(buffer, entries, "xl/workbook.xml");
  const relationshipsText = await readZipText(buffer, entries, "xl/_rels/workbook.xml.rels");
  if (!workbookText || !relationshipsText) throw new Error("The XLSX workbook metadata is missing.");
  const firstSheet = elementsByLocalName(xml(workbookText), "sheet")[0];
  const relationshipId =
    firstSheet?.getAttribute("r:id") ??
    Array.from(firstSheet?.attributes ?? []).find((attribute) => attribute.localName === "id")?.value;
  const relationship = elementsByLocalName(xml(relationshipsText), "Relationship").find(
    (element) => element.getAttribute("Id") === relationshipId,
  );
  const target = relationship?.getAttribute("Target")?.replace(/^\/?xl\//, "")?.replace(/^\//, "");
  if (!target) throw new Error("The first worksheet could not be located.");
  const sheetText = await readZipText(buffer, entries, `xl/${target.replace(/^\.\//, "")}`);
  if (!sheetText) throw new Error("The first worksheet is missing.");

  const sharedText = await readZipText(buffer, entries, "xl/sharedStrings.xml");
  const sharedStrings = sharedText
    ? elementsByLocalName(xml(sharedText), "si").map((item) =>
        elementsByLocalName(item, "t").map((value) => value.textContent ?? "").join(""),
      )
    : [];
  const firstRow = elementsByLocalName(xml(sheetText), "row").find(
    (row) => row.getAttribute("r") === "1",
  );
  if (!firstRow) throw new Error("The worksheet has no header row.");
  const headers: string[] = [];
  for (const cell of elementsByLocalName(firstRow, "c")) {
    const index = columnIndex(cell.getAttribute("r") ?? "");
    if (index < 0) continue;
    const value = elementsByLocalName(cell, "v")[0]?.textContent ?? "";
    headers[index] =
      cell.getAttribute("t") === "s"
        ? sharedStrings[Number(value)] ?? ""
        : cell.getAttribute("t") === "inlineStr"
          ? elementsByLocalName(cell, "t").map((item) => item.textContent ?? "").join("")
          : value;
  }
  return Array.from({ length: headers.length }, (_, index) => (headers[index] ?? "").trim());
}

async function readHeaders(file: File): Promise<string[]> {
  if (file.name.toLowerCase().endsWith(".csv")) return csvHeaders(await file.text());
  return xlsxHeaders(file);
}

function inferredMapping(headers: string[]): Partial<Record<ImportField, string>> {
  const mapping: Partial<Record<ImportField, string>> = {};
  for (const field of FIELDS) {
    const header = headers.find((item) => aliases[field.key].includes(normalize(item)));
    if (header) mapping[field.key] = header;
  }
  return mapping;
}

export function ImportPartsDialog({
  trigger,
  markupPercent,
}: {
  trigger: ReactNode;
  markupPercent?: number;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const announcedSuccess = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<ImportField, string>>>({});
  const [mode, setMode] = useState<ImportMode>("reject");
  const [applyStock, setApplyStock] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [jobId, setJobId] = useState<number | null>(() => {
    const value = Number(localStorage.getItem(resumeKey));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });

  const jobQuery = useQuery({
    queryKey: ["parts", "imports", jobId],
    queryFn: () => customFetch<PartsImportJob>(`/api/parts/imports/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const job = query.state.data;
      return job && activeStatuses.has(job.status) ? 1000 : false;
    },
    refetchIntervalInBackground: true,
  });
  const job = jobQuery.data;

  useEffect(() => {
    if (!job) return;
    if (successStatuses.has(job.status) && announcedSuccess.current !== job.id) {
      announcedSuccess.current = job.id;
      localStorage.removeItem(resumeKey);
      void queryClient.invalidateQueries({ queryKey: getListPartsQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
      toast({
        title: "Parts import committed",
        description: `${job.totalRows.toLocaleString()} rows were applied atomically.`,
      });
    }
  }, [job, queryClient, toast]);

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a CSV or XLSX file.");
      const options: ImportOptions = { mode, mapping, applyStock };
      const form = new FormData();
      form.append("file", file);
      form.append("options", JSON.stringify(options));
      return customFetch<PartsImportJob>("/api/parts/imports", {
        method: "POST",
        body: form,
        responseType: "json",
      });
    },
    onSuccess: (created) => {
      announcedSuccess.current = null;
      setJobId(created.id);
      localStorage.setItem(resumeKey, String(created.id));
      queryClient.setQueryData(["parts", "imports", created.id], created);
      toast({ title: "Upload received", description: "Validation is running in the background." });
    },
    onError: (error) =>
      toast({ title: "Could not upload file", description: message(error), variant: "destructive" }),
  });

  const jobAction = useMutation({
    mutationFn: (action: "validate" | "commit") => {
      if (jobId === null) throw new Error("No import job is selected.");
      return customFetch<PartsImportJob>(`/api/parts/imports/${jobId}/${action}`, {
        method: "POST",
        responseType: "json",
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["parts", "imports", updated.id], updated);
      void jobQuery.refetch();
    },
    onError: (error) =>
      toast({ title: "Import action failed", description: message(error), variant: "destructive" }),
  });

  const missingRequired = useMemo(
    () => FIELDS.filter((field) => field.required && !mapping[field.key]).map((field) => field.label),
    [mapping],
  );

  const pickFile = async (selected: File | undefined | null) => {
    if (!selected) return;
    const lowerName = selected.name.toLowerCase();
    if (!lowerName.endsWith(".csv") && !lowerName.endsWith(".xlsx")) {
      toast({ title: "Unsupported file", description: "Choose a .csv or .xlsx file.", variant: "destructive" });
      return;
    }
    if (selected.size > 10 * 1024 * 1024) {
      toast({ title: "File is too large", description: "The maximum file size is 10 MB.", variant: "destructive" });
      return;
    }
    setReadingFile(true);
    try {
      const nextHeaders = await readHeaders(selected);
      if (!nextHeaders.length || nextHeaders.some((header) => !header)) {
        throw new Error("Every source column must have a header.");
      }
      setFile(selected);
      setHeaders(nextHeaders);
      setMapping(inferredMapping(nextHeaders));
      setJobId(null);
      localStorage.removeItem(resumeKey);
    } catch (error) {
      toast({ title: "Could not read headings", description: message(error), variant: "destructive" });
    } finally {
      setReadingFile(false);
    }
  };

  const clearFile = () => {
    setFile(null);
    setHeaders([]);
    setMapping({});
    setApplyStock(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const startAnother = () => {
    clearFile();
    setJobId(null);
    localStorage.removeItem(resumeKey);
    announcedSuccess.current = null;
  };

  const progress = job?.totalRows ? Math.round((job.processedRows / job.totalRows) * 100) : 0;
  const isBusy = upload.isPending || jobAction.isPending || Boolean(job && activeStatuses.has(job.status));
  const canCommit = Boolean(job && readyStatuses.has(job.status) && job.errorCount === 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="glass-panel max-h-[92vh] overflow-y-auto border-white/10 sm:max-w-[780px]">
        <DialogHeader>
          <DialogTitle className="text-xl tracking-tight">Import parts master list</DialogTitle>
          <DialogDescription>
            Map CSV or Excel columns, validate every row, then commit all changes in one transaction.
            {markupPercent != null ? ` Your current default markup is ${markupPercent}%.` : ""}
          </DialogDescription>
        </DialogHeader>

        {!jobId ? (
          <div className="space-y-5">
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="hidden"
              onChange={(event) => void pickFile(event.target.files?.[0])}
              data-testid="input-parts-import-file"
            />
            {!file ? (
              <button
                type="button"
                disabled={readingFile}
                onClick={() => inputRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  void pickFile(event.dataTransfer.files?.[0]);
                }}
                className={`flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-9 transition-colors ${
                  dragOver ? "border-primary/60 bg-primary/10" : "border-border bg-foreground/[0.025] hover:border-primary/40"
                }`}
                data-testid="button-parts-import-dropzone"
              >
                {readingFile ? <Loader2 className="h-8 w-8 animate-spin text-primary" /> : <FileSpreadsheet className="h-8 w-8 text-primary" />}
                <span className="text-sm font-medium">{readingFile ? "Reading column headings…" : "Drop CSV/XLSX here or browse"}</span>
                <span className="text-xs text-muted-foreground">Up to 10 MB and 10,000 data rows</span>
              </button>
            ) : (
              <>
                <div className="flex items-center gap-3 rounded-xl border border-border bg-foreground/[0.025] px-4 py-3">
                  <FileSpreadsheet className="h-5 w-5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{headers.length} columns · {(file.size / 1024).toFixed(0)} KB</p>
                  </div>
                  <Button type="button" variant="ghost" size="icon" onClick={clearFile} data-testid="button-remove-import-file">
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold">Column mapping</h3>
                    <p className="text-xs text-muted-foreground">SKU, name, and unit cost are required.</p>
                  </div>
                  <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                    {FIELDS.map((field) => (
                      <div key={field.key} className="grid grid-cols-[8.5rem_1fr] items-center gap-2">
                        <Label className="text-xs">
                          {field.label}{field.required && <span className="text-destructive"> *</span>}
                        </Label>
                        <Select
                          value={mapping[field.key] ?? NONE}
                          onValueChange={(value) =>
                            setMapping((current) => {
                              const next = { ...current };
                              if (value === NONE) delete next[field.key];
                              else next[field.key] = value;
                              return next;
                            })
                          }
                        >
                          <SelectTrigger data-testid={`select-import-mapping-${field.key}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>Not mapped</SelectItem>
                            {headers.map((header, index) => (
                              <SelectItem key={`${header}-${index}`} value={header}>{header}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                  {missingRequired.length > 0 && (
                    <p className="text-xs text-destructive" data-testid="status-missing-import-mapping">
                      Map required fields: {missingRequired.join(", ")}.
                    </p>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs">Existing SKU behavior</Label>
                    <Select value={mode} onValueChange={(value: ImportMode) => setMode(value)}>
                      <SelectTrigger data-testid="select-import-mode"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="reject">Reject existing SKUs</SelectItem>
                        <SelectItem value="upsert">Update existing SKUs</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Updates preserve optional fields that are absent from this upload.
                    </p>
                  </div>
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id="apply-import-stock"
                        checked={applyStock}
                        onCheckedChange={(checked) => setApplyStock(checked === true)}
                        data-testid="checkbox-apply-import-stock"
                      />
                      <div>
                        <Label htmlFor="apply-import-stock" className="text-xs font-semibold">Import stock balances</Label>
                        <p className="mt-1 text-xs text-muted-foreground">
                          This creates inventory adjustments. Leave off to preserve all current balances.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {jobQuery.isLoading && (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" data-testid="status-import-loading">
                <Loader2 className="h-5 w-5 animate-spin" /> Resuming import…
              </div>
            )}
            {jobQuery.isError && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" data-testid="status-import-load-error">
                {message(jobQuery.error)}
                <Button type="button" variant="outline" size="sm" className="ml-3" onClick={() => void jobQuery.refetch()} data-testid="button-retry-import-status">
                  Retry
                </Button>
              </div>
            )}
            {job && (
              <>
                <div className="rounded-xl border border-border bg-foreground/[0.025] p-4">
                  <div className="flex items-center gap-3">
                    {activeStatuses.has(job.status) && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
                    {readyStatuses.has(job.status) && <ShieldCheck className="h-5 w-5 text-emerald-500" />}
                    {successStatuses.has(job.status) && <CheckCircle2 className="h-5 w-5 text-emerald-500" />}
                    {(job.status === "invalid" || job.status === "failed") && <AlertTriangle className="h-5 w-5 text-destructive" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{job.fileName}</p>
                      <p className="text-xs capitalize text-muted-foreground" data-testid="status-parts-import">{job.status}</p>
                    </div>
                    <span className="text-xs text-muted-foreground" data-testid="text-import-progress">
                      {job.processedRows.toLocaleString()} / {job.totalRows.toLocaleString()}
                    </span>
                  </div>
                  <Progress value={successStatuses.has(job.status) ? 100 : progress} className="mt-3" />
                  {readyStatuses.has(job.status) && (
                    <p className="mt-3 text-xs text-emerald-500">Validation passed. No parts have been changed yet.</p>
                  )}
                  {successStatuses.has(job.status) && (
                    <p className="mt-3 text-xs text-emerald-500">All rows were committed successfully.</p>
                  )}
                  {job.errorMessage && <p className="mt-3 text-xs text-destructive">{job.errorMessage}</p>}
                </div>

                {job.errors.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-semibold text-destructive">
                      {job.errorCount.toLocaleString()} validation issue{job.errorCount === 1 ? "" : "s"} — commit is blocked
                    </p>
                    <div className="max-h-52 divide-y divide-border overflow-y-auto rounded-xl border border-destructive/25 bg-destructive/[0.035]" data-testid="list-import-errors">
                      {job.errors.map((issue, index) => (
                        <div key={`${issue.row}-${issue.field ?? "row"}-${index}`} className="px-4 py-2 text-xs">
                          <span className="font-semibold text-destructive">
                            Row {issue.row}{issue.field ? ` · ${issue.field}` : ""}:
                          </span>{" "}
                          <span className="text-muted-foreground">{issue.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="space-y-3">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-xl border border-border px-4 py-3 text-left text-sm font-medium hover:bg-foreground/[0.03]"
            onClick={() => setPricingOpen((value) => !value)}
            data-testid="button-toggle-pricing-policies"
          >
            <Settings2 className="h-4 w-4 text-primary" />
            Pricing policies
            <span className="ml-auto text-xs font-normal text-muted-foreground">for missing sell prices</span>
            {pricingOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {pricingOpen && (
            <PricingPolicyEditor
              onPolicyChanged={() => {
                if (job?.status === "invalid") toast({ title: "Policy changed", description: "Re-run validation to apply it." });
              }}
            />
          )}
        </div>

        <DialogFooter className="gap-2">
          {!jobId ? (
            <Button
              type="button"
              onClick={() => upload.mutate()}
              disabled={!file || missingRequired.length > 0 || upload.isPending}
              data-testid="button-validate-parts-import"
            >
              {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload & validate
            </Button>
          ) : successStatuses.has(job?.status ?? "pending") ? (
            <Button type="button" variant="outline" onClick={startAnother} data-testid="button-import-another-file">
              Import another file
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={startAnother} disabled={isBusy} data-testid="button-cancel-parts-import">
                Choose another file
              </Button>
              {job?.status === "invalid" && (
                <Button type="button" variant="outline" onClick={() => jobAction.mutate("validate")} disabled={jobAction.isPending} data-testid="button-revalidate-parts-import">
                  <RefreshCw className="h-4 w-4" /> Re-run validation
                </Button>
              )}
              <Button
                type="button"
                onClick={() => jobAction.mutate("commit")}
                disabled={!canCommit || jobAction.isPending}
                data-testid="button-commit-parts-import"
              >
                {jobAction.isPending || job?.status === "processing" || job?.status === "committing" || job?.status === "queued" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4" />
                )}
                Commit all {job?.totalRows.toLocaleString() ?? ""} rows
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}