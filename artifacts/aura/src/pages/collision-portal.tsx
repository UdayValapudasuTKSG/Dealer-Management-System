import React, { useState, useRef } from "react";
import { useParams } from "wouter";
import {
  useGetCollisionPortal,
  getGetCollisionPortalQueryKey,
  useCreateCollisionPortalUploadRequest,
  useFinalizeCollisionPortalUpload,
  useCreateCollisionPortalNote,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useMoney } from "@/lib/format";
import { formatGuyanaDateTime, formatGuyanaDate } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  CarFront,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  MessageSquare,
  ShieldAlert,
  Upload,
  XCircle,
} from "lucide-react";

export default function CollisionPortal() {
  const params = useParams();
  const token = params.token ?? "";
  const { data: portal, isLoading, isError, refetch } = useGetCollisionPortal(token, {
    query: {
      queryKey: getGetCollisionPortalQueryKey(token),
      enabled: !!token,
      retry: false,
    },
  });

  const { toast } = useToast();
  const { gyd } = useMoney();

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin mr-2" />
        Loading your claim...
      </div>
    );
  }

  if (isError || !portal) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background p-4 text-center">
        <div className="max-w-md w-full space-y-4">
          <ShieldAlert className="w-12 h-12 text-muted-foreground/50 mx-auto" />
          <h1 className="text-xl font-semibold">Link Expired or Invalid</h1>
          <p className="text-muted-foreground">
            This claim link is no longer active. Please contact the dealership
            for a new link.
          </p>
        </div>
      </div>
    );
  }

  const { claim, checklist } = portal;
  const cycleDays = Math.max(1, Math.ceil(claim.cycleSeconds / 86400));

  const neededChecklist = checklist.filter((c) => c.status === "requested" || c.status === "missing");
  const providedChecklist = checklist.filter((c) => ["uploaded", "verified", "waived"].includes(c.status));

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col font-sans">
      {/* Header */}
      <header className="px-6 py-8 border-b border-border/40 bg-muted/5 flex flex-col items-center text-center">
        <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4 text-primary">
          <CarFront className="w-6 h-6" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">
          {claim.vehicle}
        </h1>
        <p className="text-lg text-muted-foreground mb-4">
          {claim.customerFirstName
            ? `Hi ${claim.customerFirstName}, here is your repair timeline.`
            : "Here is your repair timeline."}
        </p>
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-background border shadow-sm">
          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span className="font-semibold text-sm uppercase tracking-wider text-primary">
            {claim.stageLabel}
          </span>
        </div>
      </header>

      <main className="flex-1 max-w-2xl w-full mx-auto p-6 space-y-12">
        {/* Next Action / Value prop */}
        <div className="text-center space-y-2">
          <h2 className="text-xl font-semibold">What happens next?</h2>
          <p className="text-muted-foreground">
            {claim.nextAction}
          </p>
        </div>

        {/* Action Required: Checklist */}
        {neededChecklist.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Action Required
            </h3>
            <div className="grid gap-3">
              {neededChecklist.map((item) => (
                <ChecklistUploader
                  key={item.id}
                  item={item}
                  token={token}
                  onSuccess={refetch}
                />
              ))}
            </div>
          </div>
        )}

        {/* Provided Documents */}
        {providedChecklist.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              Documents Provided
            </h3>
            <div className="grid gap-3">
              {providedChecklist.map((item) => (
                <div
                  key={item.id}
                  className="p-4 rounded-xl border border-border/40 bg-muted/5 flex items-start gap-3"
                >
                  <div className="mt-0.5 text-emerald-500">
                    <CheckCircle2 className="w-5 h-5" />
                  </div>
                   <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">{item.label}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {item.status === "verified"
                        ? "Verified by dealership."
                        : item.status === "uploaded"
                        ? "Uploaded, awaiting dealership verification."
                        : "Waived by dealership."}
                    </div>
                     <div className="mt-2 flex flex-col items-start gap-1">
                       {(item.documents?.length ? item.documents : item.document ? [item.document] : []).map((document) => (
                         <a
                           key={document.id}
                           href={document.viewUrl}
                           target="_blank"
                           rel="noreferrer"
                           className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                         >
                           <FileText className="h-3.5 w-3.5" />
                           View {document.fileName}
                         </a>
                       ))}
                     </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Financials */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Your Balance
          </h3>
          <Card className="border-border/40 shadow-sm bg-muted/5">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-muted-foreground mb-1">
                    Deductible / Customer Due
                  </div>
                  <div className="text-3xl font-mono font-medium">
                    {claim.financial.customerDue != null
                      ? gyd(claim.financial.customerDue)
                      : gyd(claim.financial.customerDeductible)}
                  </div>
                </div>
                <div className="w-12 h-12 bg-sky-500/10 text-sky-600 dark:text-sky-400 rounded-full flex items-center justify-center">
                  <FileText className="w-5 h-5" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Milestones */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Timeline (Day {cycleDays})
          </h3>
          <div className="space-y-6 relative before:absolute before:inset-0 before:ml-[11px] before:w-[2px] before:bg-border/50 pl-2">
            {claim.milestones.map((ms, i) => (
              <div key={i} className="relative flex items-start gap-4">
                <div className="w-6 h-6 rounded-full bg-background border-2 border-primary flex items-center justify-center shrink-0 z-10">
                  <div className="w-2 h-2 rounded-full bg-primary" />
                </div>
                <div className="pt-0.5">
                  <div className="font-medium text-sm">{ms.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatGuyanaDateTime(ms.at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Send Note */}
        <SendNote token={token} />
      </main>

      <footer className="py-8 text-center text-xs text-muted-foreground border-t border-border/40">
        Secure claim portal · Powered by AURA
      </footer>
    </div>
  );
}

import { AlertTriangle } from "lucide-react";
import type { CollisionPortalChecklistItem } from "@workspace/api-client-react";

function ChecklistUploader({
  item,
  token,
  onSuccess,
}: {
  item: CollisionPortalChecklistItem;
  token: string;
  onSuccess: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createReq = useCreateCollisionPortalUploadRequest();
  const finalizeReq = useFinalizeCollisionPortalUpload();
  const { toast } = useToast();

  const handleUpload = async (files: File[]) => {
    setBusy(true);
    const failures: string[] = [];
    let uploadedCount = 0;
    try {
      const validMimes = [
        "application/pdf",
        "image/jpeg",
        "image/png",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ];
      for (const file of files) {
        try {
          const mime = file.type;
          if (!validMimes.includes(mime)) {
            throw new Error("unsupported file type");
          }
          const reqRes = await createReq.mutateAsync({
            token,
            data: {
              fileName: file.name,
              mimeType: mime as any,
              checklistItemId: item.id,
            },
          });
          const putRes = await fetch(reqRes.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": mime },
            body: file,
          });
          if (!putRes.ok) throw new Error("storage upload failed");
          await finalizeReq.mutateAsync({
            token,
            uploadId: reqRes.uploadId,
          } as any);
          uploadedCount++;
        } catch (error) {
          failures.push(
            `${file.name}: ${error instanceof Error ? error.message : "upload failed"}`,
          );
        }
      }
      if (uploadedCount > 0) onSuccess();
      toast({
        title: failures.length === 0 ? "Uploads complete" : "Some files could not be uploaded",
        description: failures.length === 0
          ? `${uploadedCount} file${uploadedCount === 1 ? "" : "s"} securely uploaded.`
          : `${uploadedCount} uploaded; ${failures.length} failed. ${failures.join(" · ")}`,
        variant: failures.length > 0 ? "destructive" : "default",
      });
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="p-4 rounded-xl border-2 border-amber-500/20 bg-amber-500/5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <div className="font-semibold text-sm">{item.label}</div>
        <div className="text-xs text-muted-foreground mt-1">
          {item.description}
        </div>
      </div>
      <div className="shrink-0">
        <input
          type="file"
          multiple
          className="hidden"
          ref={fileInputRef}
          onChange={(e) => {
            if (e.target.files?.length) {
              void handleUpload(Array.from(e.target.files));
            }
          }}
          accept=".pdf,.jpg,.jpeg,.png,.docx"
        />
        <Button
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          className="w-full sm:w-auto bg-amber-600 hover:bg-amber-700 text-white shadow-sm"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Upload className="w-4 h-4 mr-2" />
          )}
          Upload Files
        </Button>
      </div>
    </div>
  );
}

function SendNote({ token }: { token: string }) {
  const [note, setNote] = useState("");
  const { toast } = useToast();
  const send = useCreateCollisionPortalNote();

  return (
    <div className="space-y-4 pt-6 border-t border-border/40">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        <MessageSquare className="w-4 h-4" />
        Send a Message
      </h3>
      <Card className="border-border/40 shadow-sm bg-muted/5">
        <CardContent className="p-4 space-y-3">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Have a question or update for the service team?"
            className="bg-background resize-none h-24"
          />
          <div className="flex justify-end">
            <Button
              disabled={!note.trim() || send.isPending}
              onClick={() => {
                send.mutate(
                  { token, data: { note: note.trim() } },
                  {
                    onSuccess: () => {
                      toast({
                        title: "Message sent",
                        description: "The dealership has received your note.",
                      });
                      setNote("");
                    },
                    onError: (err: any) => {
                      toast({
                        title: "Could not send",
                        description: err.message || "Failed to send.",
                        variant: "destructive",
                      });
                    },
                  }
                );
              }}
            >
              {send.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Send Note
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
