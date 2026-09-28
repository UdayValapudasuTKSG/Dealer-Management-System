import {
  getListLeadAdvisorsQueryKey,
  useListLeadAdvisors,
} from "@workspace/api-client-react";
import type { Lead } from "@workspace/api-client-react";
import { Headset } from "lucide-react";
import { formatGuyanaDate, formatGuyanaDateTime } from "@/lib/format";

function Detail({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium break-words" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/** Rep attribution stays on the lead even when its sales owner changes. */
export function CallCentreRepresentativeDetails({ lead }: { lead: Lead }) {
  const repId = lead.callCentreRepId;
  const { data: staff, isLoading, isError } = useListLeadAdvisors(
    { callCentre: true },
    {
      query: {
        queryKey: getListLeadAdvisorsQueryKey({ callCentre: true }),
        enabled: repId != null,
      },
    },
  );
  const rep = repId == null ? undefined : staff?.find((person) => person.id === repId);
  const hasHandover = lead.callCentreStatus === "transferred" || !!lead.callCentreTransferredAt;
  const currentSalesOwner =
    lead.ownerUserId != null &&
    lead.ownerUserId !== repId &&
    lead.assignedTo?.trim();

  return (
    <section
      className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5"
      aria-labelledby="call-centre-representative-heading"
      data-testid="card-call-centre-representative"
    >
      <h3
        id="call-centre-representative-heading"
        className="flex items-center gap-2 text-sm font-semibold"
      >
        <Headset className="h-4 w-4 text-primary" aria-hidden="true" />
        Call-centre representative
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Representative of record, separate from the current sales owner.
      </p>
      <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <Detail label="Name" testId="text-call-centre-rep-name">
          {repId == null
            ? "Unassigned"
            : isError
              ? "Staff lookup unavailable"
              : isLoading
                ? "Loading representative…"
                : rep?.name || "Representative unavailable in staff directory"}
        </Detail>
        <Detail label="Role" testId="text-call-centre-rep-role">
          {repId == null ? "Not assigned" : rep?.roleName || "Unavailable"}
        </Detail>
        <Detail label="Work email" testId="text-call-centre-rep-email">
          {rep?.email ? (
            <a
              href={`mailto:${rep.email}`}
              className="text-primary hover:underline break-all"
              data-testid="link-call-centre-rep-email"
            >
              {rep.email}
            </a>
          ) : repId == null ? "Not assigned" : "Not available"}
        </Detail>
        <Detail label="Work phone" testId="text-call-centre-rep-phone">
          Not available in staff directory
        </Detail>
        <Detail label="Assigned to call centre" testId="text-call-centre-assigned-at">
          {lead.callCentreAssignedAt
            ? formatGuyanaDateTime(lead.callCentreAssignedAt)
            : "Date unavailable"}
        </Detail>
        <Detail label="Follow-up date" testId="text-call-centre-follow-up">
          {lead.callCentreFollowUpDate
            ? formatGuyanaDate(lead.callCentreFollowUpDate)
            : "No follow-up scheduled"}
        </Detail>
        <Detail label="Sales handover" testId="text-call-centre-handover">
          {hasHandover
            ? lead.callCentreTransferredAt
              ? formatGuyanaDateTime(lead.callCentreTransferredAt)
              : "Transferred; date unavailable"
            : "Not handed over"}
        </Detail>
        {hasHandover && (
          <Detail label="Current sales owner" testId="text-call-centre-sales-owner">
            {currentSalesOwner || "Unavailable"}
          </Detail>
        )}
      </dl>
      {hasHandover && (
        <p className="mt-3 text-xs text-muted-foreground">
          Current sales owner may differ from the original handover recipient.
        </p>
      )}
      {isError && repId != null && (
        <p className="mt-3 text-xs text-destructive" role="alert" data-testid="status-call-centre-staff-error">
          Staff details could not be loaded. Try again later.
        </p>
      )}
    </section>
  );
}