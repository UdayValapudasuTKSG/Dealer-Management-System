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
type Selected = { id: string; title: string; fileName: string } | null;

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
  const { can } = useAuthz();
  const editable = can("settings", "edit");
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
    setFile(null);
    setError("");
    setEditor(item);
  };
  const save = async () => {
    if (!title.trim() || !fileName.trim()) { setError("Enter a display name and PDF filename."); return; }
    if (editor === "new" && !file) { setError("Choose a PDF file."); return; }
    if (file && (file.type !== "application/pdf" || file.size < 8 || file.size > LIMIT)) {
      setError("Choose a PDF smaller than 20 MB."); return;
    }
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
          objectPath: objectPath! } });
      } else if (editor) {
        await update.mutateAsync({ brochureId: editor.id, data: {
          title: title.trim(), fileName: fileName.trim(),
          ...(objectPath ? { objectPath } : {}),
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
          <DialogDescription>Choose a PDF. Replacing it won't change attachments in emails already queued.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1"><Label htmlFor="brochure-title">Display name</Label><Input id="brochure-title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. New model brochure" /></div>
          <div className="space-y-1"><Label htmlFor="brochure-filename">Attachment filename</Label><Input id="brochure-filename" maxLength={120} value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="New-Model-Brochure.pdf" /></div>
          <div className="space-y-1"><Label htmlFor="brochure-file">PDF {editor !== "new" && "(optional replacement)"}</Label><Input id="brochure-file" type="file" accept="application/pdf,.pdf" onChange={(e) => { const selected = e.target.files?.[0] ?? null; setFile(selected); if (selected && !fileName) setFileName(selected.name); }} /></div>
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