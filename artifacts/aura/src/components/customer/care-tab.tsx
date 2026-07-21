import { useState } from "react";
import {
  useListReviews,
  useListCases,
  useCreateCase,
  useCreateReview,
  useUpdateCase,
  getListCasesQueryKey,
  getListReviewsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Star, MessageSquareWarning, Plus, Loader2 } from "lucide-react";
import { formatGuyanaDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const CASE_STATUS_STYLE: Record<string, string> = {
  open: "bg-red-500/15 text-red-600 ring-red-500/30",
  in_progress: "bg-amber-500/15 text-amber-600 ring-amber-500/30",
  resolved: "bg-emerald-500/15 text-emerald-600 ring-emerald-500/30",
  closed: "bg-foreground/[0.06] text-muted-foreground ring-border",
};

const SEVERITY_STYLE: Record<string, string> = {
  low: "text-muted-foreground",
  medium: "text-amber-600",
  high: "text-red-600",
};

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={cn(
            "w-3.5 h-3.5",
            i <= rating
              ? "fill-[hsl(var(--gold))] text-[hsl(var(--gold))]"
              : "text-muted-foreground/30",
          )}
        />
      ))}
    </span>
  );
}

export function CareTab({
  customerId,
  customerName,
}: {
  customerId: number;
  customerName: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: reviews, isLoading: reviewsLoading } = useListReviews({
    customerId,
  });
  const { data: cases, isLoading: casesLoading } = useListCases({ customerId });
  const createCase = useCreateCase();
  const createReview = useCreateReview();
  const updateCase = useUpdateCase();

  const [caseOpen, setCaseOpen] = useState(false);
  const [caseTitle, setCaseTitle] = useState("");
  const [caseDescription, setCaseDescription] = useState("");
  const [caseType, setCaseType] = useState<"complaint" | "exception" | "inquiry">(
    "complaint",
  );
  const [caseSeverity, setCaseSeverity] = useState<"low" | "medium" | "high">(
    "medium",
  );

  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState("");

  const [resolveId, setResolveId] = useState<number | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");

  const submitCase = async () => {
    try {
      await createCase.mutateAsync({
        data: {
          customerId,
          customerName,
          title: caseTitle,
          description: caseDescription || null,
          type: caseType,
          severity: caseSeverity,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      setCaseOpen(false);
      setCaseTitle("");
      setCaseDescription("");
      toast({ title: "Case opened" });
    } catch (err) {
      toast({
        title: "Couldn't open the case",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  const submitReview = async () => {
    try {
      await createReview.mutateAsync({
        data: {
          customerId,
          customerName,
          source: "manual",
          rating: reviewRating,
          comment: reviewComment || null,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListReviewsQueryKey() });
      setReviewOpen(false);
      setReviewComment("");
      setReviewRating(5);
      toast({ title: "Review logged" });
    } catch (err) {
      toast({
        title: "Couldn't log the review",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  const moveCase = async (
    id: number,
    status: "in_progress" | "resolved" | "closed",
    note?: string,
  ) => {
    try {
      await updateCase.mutateAsync({
        id,
        data: { status, ...(note ? { resolutionNote: note } : {}) },
      });
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      setResolveId(null);
      setResolutionNote("");
      toast({ title: `Case ${status.replace("_", " ")}` });
    } catch (err) {
      toast({
        title: "Couldn't update the case",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      {/* Cases */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-wide">Cases</h2>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setCaseOpen(true)}
          >
            <Plus className="w-3.5 h-3.5" /> Open Case
          </Button>
        </div>
        <Card className="glass-panel border-none shadow-lg">
          <CardContent className="p-4">
            {casesLoading ? (
              <div className="h-16 rounded-xl bg-foreground/[0.05] animate-pulse" />
            ) : (cases ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                No cases on record — a clean sheet.
              </div>
            ) : (
              <ul className="space-y-2">
                {(cases ?? []).map((c) => (
                  <li
                    key={c.id}
                    className="rounded-2xl bg-white/[0.03] p-3.5 space-y-1.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <MessageSquareWarning
                          className={cn(
                            "w-4 h-4 shrink-0",
                            SEVERITY_STYLE[c.severity],
                          )}
                        />
                        <span className="text-sm font-semibold truncate">
                          {c.title}
                        </span>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1",
                          CASE_STATUS_STYLE[c.status],
                        )}
                      >
                        {c.status.replace("_", " ")}
                      </span>
                    </div>
                    {c.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {c.description}
                      </p>
                    )}
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span className="capitalize">
                        {c.type} · {c.severity} severity ·{" "}
                        {formatGuyanaDate(c.createdAt)}
                      </span>
                      <span className="flex gap-1.5">
                        {c.status === "open" && (
                          <button
                            onClick={() => moveCase(c.id, "in_progress")}
                            className="font-semibold text-primary hover:underline"
                          >
                            Start
                          </button>
                        )}
                        {(c.status === "open" || c.status === "in_progress") && (
                          <button
                            onClick={() => setResolveId(c.id)}
                            className="font-semibold text-emerald-600 hover:underline"
                          >
                            Resolve
                          </button>
                        )}
                        {c.status === "resolved" && (
                          <button
                            onClick={() => moveCase(c.id, "closed")}
                            className="font-semibold text-muted-foreground hover:underline"
                          >
                            Close
                          </button>
                        )}
                      </span>
                    </div>
                    {c.resolutionNote && (
                      <p className="text-xs text-emerald-600/90">
                        Resolution: {c.resolutionNote}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Reviews */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-wide">
            Reviews &amp; CSAT
          </h2>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setReviewOpen(true)}
          >
            <Plus className="w-3.5 h-3.5" /> Log Review
          </Button>
        </div>
        <Card className="glass-panel border-none shadow-lg">
          <CardContent className="p-4">
            {reviewsLoading ? (
              <div className="h-16 rounded-xl bg-foreground/[0.05] animate-pulse" />
            ) : (reviews ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                No reviews captured yet.
              </div>
            ) : (
              <ul className="space-y-2">
                {(reviews ?? []).map((r) => (
                  <li
                    key={r.id}
                    className="rounded-2xl bg-white/[0.03] p-3.5 space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Stars rating={r.rating} />
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        {r.source.replace(/_/g, " ")}
                      </span>
                    </div>
                    {r.comment && (
                      <p className="text-sm text-foreground/90">{r.comment}</p>
                    )}
                    <div className="text-[11px] text-muted-foreground">
                      {r.vehicleLabel ? `${r.vehicleLabel} · ` : ""}
                      {formatGuyanaDate(r.createdAt)}
                      {r.capturedBy ? ` · by ${r.capturedBy}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Open case dialog */}
      <Dialog open={caseOpen} onOpenChange={setCaseOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Open a case for {customerName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Case title"
              value={caseTitle}
              onChange={(e) => setCaseTitle(e.target.value)}
            />
            <Textarea
              placeholder="What happened?"
              value={caseDescription}
              onChange={(e) => setCaseDescription(e.target.value)}
              rows={3}
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                value={caseType}
                onValueChange={(v) => setCaseType(v as typeof caseType)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="complaint">Complaint</SelectItem>
                  <SelectItem value="exception">Exception</SelectItem>
                  <SelectItem value="inquiry">Inquiry</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={caseSeverity}
                onValueChange={(v) => setCaseSeverity(v as typeof caseSeverity)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Severity" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitCase}
              disabled={caseTitle.trim().length < 3 || createCase.isPending}
            >
              {createCase.isPending && (
                <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
              )}
              Open Case
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Log review dialog */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Log a review from {customerName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              {[1, 2, 3, 4, 5].map((i) => (
                <button key={i} onClick={() => setReviewRating(i)}>
                  <Star
                    className={cn(
                      "w-6 h-6 transition-colors",
                      i <= reviewRating
                        ? "fill-[hsl(var(--gold))] text-[hsl(var(--gold))]"
                        : "text-muted-foreground/30 hover:text-muted-foreground",
                    )}
                  />
                </button>
              ))}
            </div>
            <Textarea
              placeholder="What did the customer say? (optional)"
              value={reviewComment}
              onChange={(e) => setReviewComment(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button onClick={submitReview} disabled={createReview.isPending}>
              {createReview.isPending && (
                <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
              )}
              Log Review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resolve case dialog */}
      <Dialog
        open={resolveId != null}
        onOpenChange={(o) => !o && setResolveId(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Resolve case</DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder="Resolution note (required)"
            value={resolutionNote}
            onChange={(e) => setResolutionNote(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button
              onClick={() =>
                resolveId != null &&
                moveCase(resolveId, "resolved", resolutionNote)
              }
              disabled={resolutionNote.trim().length === 0 || updateCase.isPending}
            >
              {updateCase.isPending && (
                <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
              )}
              Mark Resolved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
