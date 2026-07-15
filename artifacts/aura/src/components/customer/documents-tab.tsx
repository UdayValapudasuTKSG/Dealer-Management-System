import { useRef, useState } from "react";
import {
  useDeleteCustomerDocument,
  getGetCustomerOverviewQueryKey,
  type CustomerDocument,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Upload,
  FileText,
  Download,
  Trash2,
  IdCard,
  BookUser,
  Receipt,
} from "lucide-react";

const apiBase = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

const DOC_TYPES = [
  { value: "driver_license", label: "Driver License", icon: IdCard },
  { value: "passport", label: "Passport", icon: BookUser },
  { value: "tax_document", label: "Tax Document", icon: Receipt },
  { value: "other", label: "Other", icon: FileText },
] as const;

const typeMeta = (type: string) =>
  DOC_TYPES.find((t) => t.value === type) ?? DOC_TYPES[3];

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentsTab({
  customerId,
  documents,
}: {
  customerId: number;
  documents: CustomerDocument[];
}) {
  const [docType, setDocType] = useState<string>("other");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const deleteDoc = useDeleteCustomerDocument();

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getGetCustomerOverviewQueryKey(customerId),
    });

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", docType);
      const res = await fetch(`${apiBase()}/customers/${customerId}/documents`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      await invalidate();
      toast({ title: "Document uploaded", description: file.name });
    } catch {
      toast({ title: "Upload failed", variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const remove = async (doc: CustomerDocument) => {
    try {
      await deleteDoc.mutateAsync({ id: customerId, docId: doc.id });
      await invalidate();
      toast({ title: "Document removed", description: doc.fileName });
    } catch {
      toast({ title: "Could not delete document", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <Card className="glass-panel border-none shadow-lg">
        <CardContent className="p-6 flex flex-col sm:flex-row sm:items-end gap-4">
          <div className="flex flex-col gap-1.5 w-full sm:w-56">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Document Type
            </span>
            <Select value={docType} onValueChange={setDocType}>
              <SelectTrigger className="bg-white/[0.04] border-white/10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOC_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <Button
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
          >
            {uploading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
            Upload Document
          </Button>
          <p className="text-xs text-muted-foreground sm:ml-auto">
            KYC and deal paperwork stays attached to this client.
          </p>
        </CardContent>
      </Card>

      {documents.length === 0 ? (
        <Card className="glass-panel border-none shadow-lg">
          <CardContent className="p-10 text-center text-muted-foreground font-light">
            No documents on file yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {documents.map((doc) => {
            const meta = typeMeta(doc.type);
            const Icon = meta.icon;
            return (
              <Card key={doc.id} className="glass-panel border-none shadow-lg">
                <CardContent className="p-5 flex items-center gap-4">
                  <div className="w-11 h-11 rounded-2xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate">
                      {doc.fileName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {meta.label} · {formatSize(doc.sizeBytes)}
                      {doc.uploadedBy ? ` · ${doc.uploadedBy}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="rounded-full text-muted-foreground hover:text-foreground"
                    >
                      <a
                        href={`${apiBase()}/customers/${customerId}/documents/${doc.id}/download`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(doc)}
                      disabled={deleteDoc.isPending}
                      className="rounded-full text-muted-foreground hover:text-primary"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
