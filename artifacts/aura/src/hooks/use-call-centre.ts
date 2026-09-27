// Call-centre qualification helpers built on the generated API client.
import { useQueryClient } from "@tanstack/react-query";
import {
  useRecordCallCentreDisposition,
  useGetCallCentreReport,
  getGetCallCentreReportQueryKey,
  getGetLeadQueryKey,
  getGetLeadReviewQueryKey,
  getGetLeadTimelineQueryKey,
  getListLeadCallsQueryKey,
  getListLeadsQueryKey,
  getListTasksQueryKey,
  getGetReportQueryKey,
  type CallCentreDispositionInputOutcome,
  type Lead,
} from "@workspace/api-client-react";

export type CallCentreOutcome = CallCentreDispositionInputOutcome;

/** Held = awaiting qualification by the call centre while phase is new/contacted. */
export function isHeldByCallCentre(lead: Pick<Lead, "phase" | "callCentreStatus"> | null | undefined): boolean {
  if (!lead) return false;
  const s = lead.callCentreStatus;
  return (
    (s === "pending" || s === "follow_up") &&
    (lead.phase === "new" || lead.phase === "contacted")
  );
}

export function useCallCentreDisposition(leadId: number) {
  const qc = useQueryClient();
  return useRecordCallCentreDisposition({
    mutation: {
      onSuccess: (lead) => {
        qc.setQueryData(getGetLeadQueryKey(leadId), lead);
        qc.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
        qc.invalidateQueries({ queryKey: getGetLeadReviewQueryKey(leadId) });
        qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(leadId) });
        qc.invalidateQueries({ queryKey: getListLeadCallsQueryKey(leadId) });
        qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
        qc.invalidateQueries({ queryKey: getListTasksQueryKey() });
        qc.invalidateQueries({ queryKey: getGetReportQueryKey() });
        qc.invalidateQueries({ queryKey: getGetCallCentreReportQueryKey() });
      },
    },
  });
}

export function useCallCentreReport() {
  return useGetCallCentreReport();
}

/** Human message for a failed disposition, incl. the "no active Sales Advisor" case. */
export function dispositionErrorMessage(err: unknown): string {
  const e = err as { data?: { error?: string; message?: string } | null; message?: string };
  const raw = e?.data?.error ?? e?.data?.message ?? e?.message ?? "";
  if (/sales advisor/i.test(raw)) {
    return "No active Sales Advisor is available to receive this lead. Ask a manager to activate a Sales Advisor, then try again. The lead stays with the call centre.";
  }
  return raw || "Please try again.";
}
