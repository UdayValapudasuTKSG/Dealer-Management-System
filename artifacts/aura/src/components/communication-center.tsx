import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCustomerCommunications,
  useEnqueueEmail,
  useCreateCommNote,
  useListEmailTemplates,
  getGetCustomerCommunicationsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Mail,
  Phone,
  Users,
  Loader2,
  Send,
  PlusCircle,
} from "lucide-react";

const EMAIL_STATUS_STYLE: Record<string, string> = {
  sent: "border-emerald-500/40 text-emerald-400",
  queued: "border-amber-500/40 text-amber-400",
  sending: "border-sky-500/40 text-sky-400",
  failed: "border-red-500/50 text-red-400",
};

export function CommunicationCenter({
  customerId,
  customerEmail,
  customerName,
}: {
  customerId: number;
  customerEmail?: string | null;
  customerName: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useGetCustomerCommunications(customerId);
  const [emailOpen, setEmailOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState<"call" | "meeting" | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({
      queryKey: getGetCustomerCommunicationsQueryKey(customerId),
    });

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const emails = data?.emails ?? [];
  const notes = data?.notes ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="gap-2" onClick={() => setEmailOpen(true)}>
          <Mail className="h-4 w-4" /> Send Email
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-2 border-white/15"
          onClick={() => setNoteOpen("call")}
        >
          <Phone className="h-4 w-4" /> Log Call
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-2 border-white/15"
          onClick={() => setNoteOpen("meeting")}
        >
          <Users className="h-4 w-4" /> Log Meeting
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Emails */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 space-y-3">
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Emails
          </div>
          {emails.length === 0 ? (
            <p className="text-sm text-muted-foreground/60 py-6 text-center">
              No emails sent to this client yet.
            </p>
          ) : (
            <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
              {emails.map((e) => (
                <div
                  key={e.id}
                  className="rounded-xl bg-foreground/[0.03] px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium leading-snug">
                      {e.subject}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "shrink-0 text-[10px] uppercase",
                        EMAIL_STATUS_STYLE[e.status],
                      )}
                      title={e.lastError ?? undefined}
                    >
                      {e.status}
                    </Badge>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {e.template} · {new Date(e.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Call / meeting notes */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 space-y-3">
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Calls & Meetings
          </div>
          {notes.length === 0 ? (
            <p className="text-sm text-muted-foreground/60 py-6 text-center">
              No calls or meetings logged.
            </p>
          ) : (
            <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
              {notes.map((n) => (
                <div key={n.id} className="rounded-xl bg-foreground/[0.03] px-4 py-3">
                  <div className="flex items-center gap-2">
                    {n.kind === "call" ? (
                      <Phone className="h-3.5 w-3.5 text-primary" />
                    ) : (
                      <Users className="h-3.5 w-3.5 text-primary" />
                    )}
                    <span className="text-sm font-medium">{n.subject}</span>
                    {n.outcome && (
                      <Badge
                        variant="outline"
                        className="ml-auto text-[10px] border-white/15 text-muted-foreground"
                      >
                        {n.outcome}
                      </Badge>
                    )}
                  </div>
                  {n.notes && (
                    <p className="mt-1.5 text-xs text-muted-foreground">{n.notes}</p>
                  )}
                  <div className="mt-1.5 text-[11px] text-muted-foreground/60">
                    {n.loggedBy} · {new Date(n.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <SendEmailDialog
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        customerId={customerId}
        customerEmail={customerEmail}
        customerName={customerName}
        onSent={invalidate}
      />
      <LogNoteDialog
        kind={noteOpen}
        onClose={() => setNoteOpen(null)}
        customerId={customerId}
        onLogged={invalidate}
      />
    </div>
  );
}

function SendEmailDialog({
  open,
  onClose,
  customerId,
  customerEmail,
  customerName,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  customerId: number;
  customerEmail?: string | null;
  customerName: string;
  onSent: () => void;
}) {
  const { toast } = useToast();
  const { data: templates } = useListEmailTemplates();
  const [template, setTemplate] = useState("");
  const [to, setTo] = useState(customerEmail ?? "");

  const enqueue = useEnqueueEmail({
    mutation: {
      onSuccess: () => {
        toast({ title: "Email queued", description: "It will be delivered shortly." });
        onSent();
        onClose();
      },
      onError: (e) =>
        toast({
          title: "Could not queue email",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send Email</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            placeholder="Recipient email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <Select value={template} onValueChange={setTemplate}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            <SelectContent>
              {(templates ?? []).map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="w-full gap-2"
            disabled={!template || to.trim().length < 3 || enqueue.isPending}
            onClick={() =>
              enqueue.mutate({
                data: {
                  template,
                  to: to.trim(),
                  customerId,
                  data: { name: customerName.split(" ")[0] ?? customerName },
                },
              })
            }
          >
            {enqueue.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Queue Email
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LogNoteDialog({
  kind,
  onClose,
  customerId,
  onLogged,
}: {
  kind: "call" | "meeting" | null;
  onClose: () => void;
  customerId: number;
  onLogged: () => void;
}) {
  const { toast } = useToast();
  const [subject, setSubject] = useState("");
  const [notes, setNotes] = useState("");
  const [outcome, setOutcome] = useState("");

  const create = useCreateCommNote({
    mutation: {
      onSuccess: () => {
        toast({ title: kind === "call" ? "Call logged" : "Meeting logged" });
        onLogged();
        setSubject("");
        setNotes("");
        setOutcome("");
        onClose();
      },
      onError: (e) =>
        toast({
          title: "Could not log",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });

  return (
    <Dialog open={!!kind} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{kind === "call" ? "Log a Call" : "Log a Meeting"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            placeholder="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          <Textarea
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
          <Input
            placeholder="Outcome (optional, e.g. Follow up Friday)"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          />
          <Button
            className="w-full gap-2"
            disabled={!subject.trim() || create.isPending || !kind}
            onClick={() =>
              kind &&
              create.mutate({
                id: customerId,
                data: {
                  kind,
                  subject: subject.trim(),
                  notes: notes.trim() || undefined,
                  outcome: outcome.trim() || undefined,
                },
              })
            }
          >
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlusCircle className="h-4 w-4" />
            )}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
