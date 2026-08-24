import { useState } from "react";
import {
  useListTestDrives,
  useUpdateTestDrive,
  getListTestDrivesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Car, CheckCircle2, XCircle, Ban, Loader2 } from "lucide-react";
import { formatGuyanaDateTime } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<string, string> = {
  scheduled: "bg-primary/15 text-primary ring-primary/25",
  completed: "bg-emerald-500/15 text-emerald-600 ring-emerald-500/30",
  no_show: "bg-amber-500/15 text-amber-600 ring-amber-500/30",
  cancelled: "bg-foreground/[0.06] text-muted-foreground ring-border",
};

export function TestDriveCard({
  leadId,
  onBook,
  canEdit = true,
}: {
  leadId: number;
  onBook: () => void;
  /** False for view-only visitors (e.g. an advisor viewing a colleague's
   *  lead) — booking and status actions are hidden. */
  canEdit?: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: drives, isLoading } = useListTestDrives({ leadId });
  const updateDrive = useUpdateTestDrive();
  const [pendingId, setPendingId] = useState<number | null>(null);

  const act = async (
    id: number,
    status: "completed" | "no_show" | "cancelled",
    label: string,
  ) => {
    setPendingId(id);
    try {
      await updateDrive.mutateAsync({ id, data: { status } });
      queryClient.invalidateQueries({ queryKey: getListTestDrivesQueryKey() });
      queryClient.invalidateQueries({ queryKey: [`/leads/${leadId}`] });
      toast({ title: `Test drive ${label}` });
    } catch (err) {
      toast({
        title: "Couldn't update the test drive",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPendingId(null);
    }
  };

  const list = drives ?? [];
  const scheduled = list.filter((d) => d.status === "scheduled");
  const history = list.filter((d) => d.status !== "scheduled").slice(0, 3);

  return (
    <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center">
          <Car className="w-3.5 h-3.5" />
        </span>
        <span className="text-sm font-semibold tracking-tight">Test Drive</span>
      </div>

      {isLoading ? (
        <div className="h-10 rounded-lg bg-foreground/[0.05] animate-pulse" />
      ) : scheduled.length === 0 && history.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No test drive scheduled.
          {canEdit && (
            <>
              {" "}
              <button
                onClick={onBook}
                className="text-primary font-medium hover:underline"
              >
                Book one
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {scheduled.map((d) => (
            <div key={d.id} className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">
                    {formatGuyanaDateTime(d.scheduledAt)}
                  </div>
                  {d.branch && (
                    <div className="text-xs text-muted-foreground">
                      {d.branch}
                    </div>
                  )}
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1",
                    STATUS_STYLE[d.status],
                  )}
                >
                  {d.status.replace("_", " ")}
                </span>
              </div>
              {canEdit && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => act(d.id, "completed", "completed")}
                  disabled={pendingId === d.id}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-600 hover:bg-emerald-500/20 transition-colors"
                >
                  {pendingId === d.id ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-3 h-3" />
                  )}
                  Completed
                </button>
                <button
                  onClick={() => act(d.id, "no_show", "marked as a no-show")}
                  disabled={pendingId === d.id}
                  className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-600 hover:bg-amber-500/20 transition-colors"
                >
                  <XCircle className="w-3 h-3" />
                  No-show
                </button>
                <button
                  onClick={() => act(d.id, "cancelled", "cancelled")}
                  disabled={pendingId === d.id}
                  className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.05] px-2.5 py-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Ban className="w-3 h-3" />
                  Cancel
                </button>
              </div>
              )}
            </div>
          ))}
          {history.length > 0 && (
            <ul className="space-y-1.5 border-t border-white/10 pt-2.5">
              {history.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="text-muted-foreground">
                    {formatGuyanaDateTime(d.scheduledAt)}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1",
                      STATUS_STYLE[d.status] ?? STATUS_STYLE.cancelled,
                    )}
                  >
                    {d.status.replace("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
