import { useMemo, useRef, useState } from "react";
import {
  useListDocuments,
  useCreateDocument,
  useReviewDocumentExtraction,
  getListDocumentsQueryKey,
  getGetLeadQueryKey,
  getGetLeadTimelineQueryKey,
} from "@workspace/api-client-react";
import type {
  Document,
  DocumentInputEntityType,
  DocumentInputType,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUpload } from "@workspace/object-storage-web";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Bot,
  Check,
  ChevronDown,
  Download,
  FileText,
  History,
  Loader2,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { formatGuyanaDateTime } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  id_document: "ID Document",
  financing: "Financing",
  test_drive: "Test Drive",
  insurance: "Insurance",
  registration: "Registration",
  customs: "Customs",
  invoice: "Invoice",
  quote: "Quote",
  other: "Other",
};

const ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.docx,application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_BYTES = 20 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadUrl(doc: Document): string {
  return doc.externalUrl ?? `/api/documents/${doc.id}/download`;
}

function DocumentRow({
  doc,
  isHistory,
}: {
  doc: Document;
  isHistory?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2.5",
        isHistory && "opacity-70",
      )}
    >
      <span
        className={cn(
          "w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0",
          doc.extractionStatus === "pending" &&
            "aura-scan-frame ring-1 ring-primary/40",
        )}
      >
        <FileText className="w-4 h-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{doc.fileName}</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-foreground/[0.06] ring-1 ring-white/10 text-muted-foreground shrink-0">
            v{doc.version}
          </span>
          {doc.extractionStatus === "pending" && (
            <span className="aura-scan-glow inline-flex items-center gap-1 text-[10px] font-semibold text-primary shrink-0 px-1.5 py-0.5 rounded-full bg-primary/10 ring-1 ring-primary/30">
              <Bot className="w-3 h-3" /> AI scanning document…
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
          {doc.uploadedBy ?? "—"} · {formatGuyanaDateTime(doc.createdAt)} ·{" "}
          {formatSize(doc.sizeBytes)}
          {doc.comments ? ` · ${doc.comments}` : ""}
        </div>
      </div>
      <a
        href={downloadUrl(doc)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Download ${doc.fileName}`}
        className="w-8 h-8 rounded-lg border border-white/10 text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] flex items-center justify-center shrink-0 transition-colors"
      >
        <Download className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}

function TypeGroup({ docs }: { docs: Document[] }) {
  const [showHistory, setShowHistory] = useState(false);
  const [latest, ...history] = docs;
  if (!latest) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-foreground/[0.03] overflow-hidden">
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          {DOCUMENT_TYPE_LABEL[latest.type] ?? latest.type}
        </span>
        {history.length > 0 && (
          <button
            onClick={() => setShowHistory((s) => !s)}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <History className="w-3 h-3" />
            {history.length} previous version{history.length === 1 ? "" : "s"}
            <ChevronDown
              className={cn(
                "w-3 h-3 transition-transform",
                showHistory && "rotate-180",
              )}
            />
          </button>
        )}
      </div>
      <DocumentRow doc={latest} />
      {showHistory &&
        history.map((d) => (
          <div key={d.id} className="border-t border-white/5">
            <DocumentRow doc={d} isHistory />
          </div>
        ))}
    </div>
  );
}

export function DocumentsCard({
  entityType,
  entityId,
  canEdit,
}: {
  entityType: DocumentInputEntityType;
  entityId: number;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const params = { entityType, entityId };
  const { data: docs, isLoading } = useListDocuments(params);
  const [open, setOpen] = useState(false);
  const [docType, setDocType] = useState<DocumentInputType>("other");
  const [comments, setComments] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { uploadFile } = useUpload();

  const createDocument = useCreateDocument();

  const grouped = useMemo(() => {
    const byType = new Map<string, Document[]>();
    for (const d of docs ?? []) {
      const list = byType.get(d.type) ?? [];
      list.push(d);
      byType.set(d.type, list);
    }
    for (const list of byType.values())
      list.sort((a, b) => b.version - a.version);
    return [...byType.entries()];
  }, [docs]);

  const reset = () => {
    setDocType("other");
    setComments("");
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const submit = async () => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast({
        title: "File too large",
        description: "Documents can be up to 20MB.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      const uploaded = await uploadFile(file);
      if (!uploaded) throw new Error("Upload failed");
      await createDocument.mutateAsync({
        data: {
          entityType,
          entityId,
          type: docType,
          fileName: file.name,
          storageKey: uploaded.objectPath,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          ...(comments.trim() ? { comments: comments.trim() } : {}),
        },
      });
      await queryClient.invalidateQueries({
        queryKey: getListDocumentsQueryKey(params),
      });
      toast({
        title: "Document uploaded",
        description: `${file.name} saved as ${DOCUMENT_TYPE_LABEL[docType]}.`,
      });
      setOpen(false);
      reset();
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-foreground/[0.02] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          <FileText className="w-4 h-4" /> Documents
        </div>
        {canEdit && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-8"
            onClick={() => setOpen(true)}
          >
            <Plus className="w-3.5 h-3.5" /> Add New
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading documents…
        </div>
      ) : grouped.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-xl border border-dashed border-white/10 p-5 text-center">
          No documents yet.
          {canEdit ? " Upload PDF, JPG, PNG or DOCX up to 20MB." : ""}
        </div>
      ) : (
        <div className="space-y-2.5">
          {grouped.map(([type, list]) => (
            <TypeGroup key={type} docs={list} />
          ))}
        </div>
      )}

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add document</DialogTitle>
            <DialogDescription>
              PDF, JPG, PNG or DOCX up to 20MB. Uploading the same type again
              creates a new version — history is kept.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-muted-foreground block mb-1.5">
                Document type
              </label>
              <select
                value={docType}
                onChange={(e) => setDocType(e.target.value as DocumentInputType)}
                className="h-9 w-full rounded-md border border-white/15 bg-background/60 px-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {Object.entries(DOCUMENT_TYPE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-muted-foreground block mb-1.5">
                File
              </label>
              <Input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="h-9 bg-background/60 border-white/15 file:text-foreground"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-muted-foreground block mb-1.5">
                Comments (optional)
              </label>
              <Textarea
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                placeholder="e.g. Signed copy received in branch"
                className="bg-background/60 border-white/15 resize-none min-h-[64px]"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={!file || busy}>
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                Upload
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Inline A5 pre-fill review banner: shows proposals from uploaded documents
 * with editable values. Nothing is applied until the advisor confirms.
 */
export function DocumentPrefillBanner({ leadId }: { leadId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const params = { entityType: "lead" as const, entityId: leadId };
  const { data: docs } = useListDocuments(params, {
    query: {
      queryKey: getListDocumentsQueryKey(params),
      refetchInterval: (query) =>
        (query.state.data ?? []).some((d) => d.extractionStatus === "pending")
          ? 4000
          : false,
    },
  });
  const proposals = (docs ?? []).filter(
    (d) => d.extractionStatus === "proposed" && d.extraction,
  );
  if (proposals.length === 0) return null;
  return (
    <div className="space-y-3">
      {proposals.map((doc) => (
        <ProposalCard
          key={doc.id}
          doc={doc}
          onDone={async () => {
            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: getListDocumentsQueryKey(params),
              }),
              queryClient.invalidateQueries({
                queryKey: getGetLeadQueryKey(leadId),
              }),
              queryClient.invalidateQueries({
                queryKey: getGetLeadTimelineQueryKey(leadId),
              }),
            ]);
          }}
          toast={toast}
        />
      ))}
    </div>
  );
}

function ProposalCard({
  doc,
  onDone,
  toast,
}: {
  doc: Document;
  onDone: () => Promise<void>;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const review = useReviewDocumentExtraction();
  const fields = doc.extraction?.fields ?? [];
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(fields.map((f) => [f.field, true])),
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.field, f.value])),
  );

  const act = async (action: "accept" | "dismiss") => {
    try {
      await review.mutateAsync({
        id: doc.id,
        data:
          action === "accept"
            ? {
                action,
                fields: fields
                  .filter((f) => included[f.field])
                  .map((f) => ({
                    field: f.field,
                    value: values[f.field] ?? f.value,
                  })),
              }
            : { action },
      });
      toast({
        title: action === "accept" ? "Pre-fill applied" : "Proposal dismissed",
        description:
          action === "accept"
            ? "The confirmed values were saved to this lead."
            : "Nothing was changed on the lead.",
      });
      await onDone();
    } catch {
      toast({
        title: "Review failed",
        description: "Could not process the proposal — try again.",
        variant: "destructive",
      });
    }
  };

  const anyIncluded = fields.some((f) => included[f.field]);

  return (
    <div className="rounded-2xl border border-primary/25 bg-primary/[0.05] p-4">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
          <Bot className="w-4.5 h-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            A5 suggests pre-fills from {doc.fileName}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {doc.extraction?.summary ?? "Extracted from the uploaded document."}{" "}
            Review and edit before applying — nothing changes until you
            confirm.
          </p>
          <div className="mt-3 space-y-2">
            {fields.map((f) => (
              <label
                key={f.field}
                className="flex items-center gap-2.5 text-sm"
              >
                <input
                  type="checkbox"
                  checked={included[f.field] ?? true}
                  onChange={(e) =>
                    setIncluded((s) => ({ ...s, [f.field]: e.target.checked }))
                  }
                  className="accent-[hsl(var(--primary))] shrink-0"
                />
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground w-36 shrink-0">
                  {f.label}
                </span>
                <Input
                  value={values[f.field] ?? f.value}
                  onChange={(e) =>
                    setValues((s) => ({ ...s, [f.field]: e.target.value }))
                  }
                  disabled={!(included[f.field] ?? true)}
                  className="h-8 bg-background/60 border-white/15 text-sm"
                />
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-3.5">
            <Button
              size="sm"
              className="gap-1.5"
              disabled={review.isPending || !anyIncluded}
              onClick={() => void act("accept")}
            >
              {review.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              Apply selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={review.isPending}
              onClick={() => void act("dismiss")}
            >
              <X className="w-3.5 h-3.5" /> Dismiss
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
