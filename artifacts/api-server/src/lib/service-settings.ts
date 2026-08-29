import { eq } from "drizzle-orm";
import {
  db,
  dealerServiceSettingsTable,
  DEFAULT_SERVICE_INTERVAL_KM,
  DEFAULT_LATE_SURCHARGE_FEE,
  DEFAULT_SERVICE_SUMMARY_CADENCE,
  DEFAULT_JOB_HOURS,
  DEFAULT_TECH_WORK_HOURS_PER_DAY,
  SERVICE_SUMMARY_CADENCES,
  type DealerServiceSettings,
  type ServiceSummaryCadence,
} from "@workspace/db";

/**
 * Per-dealer service settings (FR-SR-07 + FR-COM-03): service interval (km),
 * the flat late-service surcharge fee, the management scheduled-services
 * summary cadence, and GM-configurable technician capacity planning (default
 * hours per vehicle + working hours per day). Reads fall back to defaults
 * without writing; updates upsert the row.
 */

type ServiceSettings = Pick<
  DealerServiceSettings,
  | "serviceIntervalKm"
  | "lateSurchargeFee"
  | "defaultJobHours"
  | "techWorkHoursPerDay"
  | "leadSourceReportEnabled"
  | "leadSourceReportSendTime"
> & { summaryCadence: ServiceSummaryCadence };

const DEFAULT_LEAD_SOURCE_REPORT_SEND_TIME = "06:00";
const SEND_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Canonical 24h "HH:MM"; anything malformed falls back to 06:00. */
function asSendTime(value: string | undefined | null): string {
  return value && SEND_TIME_RE.test(value)
    ? value
    : DEFAULT_LEAD_SOURCE_REPORT_SEND_TIME;
}

function asCadence(value: string | undefined | null): ServiceSummaryCadence {
  return (SERVICE_SUMMARY_CADENCES as readonly string[]).includes(value ?? "")
    ? (value as ServiceSummaryCadence)
    : DEFAULT_SERVICE_SUMMARY_CADENCE;
}

export async function getServiceSettings(
  dealerId: number,
): Promise<ServiceSettings> {
  const [row] = await db
    .select()
    .from(dealerServiceSettingsTable)
    .where(eq(dealerServiceSettingsTable.dealerId, dealerId));
  return {
    serviceIntervalKm: row?.serviceIntervalKm ?? DEFAULT_SERVICE_INTERVAL_KM,
    lateSurchargeFee: row?.lateSurchargeFee ?? DEFAULT_LATE_SURCHARGE_FEE,
    summaryCadence: asCadence(row?.summaryCadence),
    defaultJobHours: row?.defaultJobHours ?? DEFAULT_JOB_HOURS,
    techWorkHoursPerDay:
      row?.techWorkHoursPerDay ?? DEFAULT_TECH_WORK_HOURS_PER_DAY,
    leadSourceReportEnabled: row?.leadSourceReportEnabled ?? false,
    leadSourceReportSendTime: asSendTime(row?.leadSourceReportSendTime),
  };
}

export async function updateServiceSettings(
  dealerId: number,
  patch: {
    serviceIntervalKm?: number;
    lateSurchargeFee?: number;
    summaryCadence?: ServiceSummaryCadence;
    defaultJobHours?: number;
    techWorkHoursPerDay?: number;
    leadSourceReportEnabled?: boolean;
    leadSourceReportSendTime?: string;
  },
): Promise<ServiceSettings> {
  // Normalize only the fields actually supplied so concurrent partial
  // updates can't clobber each other: on conflict we SET just the patched
  // columns, never a full snapshot from a possibly-stale read.
  const supplied: Partial<ServiceSettings> = {};
  if (patch.serviceIntervalKm !== undefined)
    supplied.serviceIntervalKm = patch.serviceIntervalKm;
  if (patch.lateSurchargeFee !== undefined)
    supplied.lateSurchargeFee = patch.lateSurchargeFee;
  if (patch.summaryCadence !== undefined)
    supplied.summaryCadence = asCadence(patch.summaryCadence);
  if (patch.defaultJobHours !== undefined)
    supplied.defaultJobHours = patch.defaultJobHours;
  if (patch.techWorkHoursPerDay !== undefined)
    supplied.techWorkHoursPerDay = patch.techWorkHoursPerDay;
  if (patch.leadSourceReportEnabled !== undefined)
    supplied.leadSourceReportEnabled = patch.leadSourceReportEnabled;
  if (patch.leadSourceReportSendTime !== undefined)
    supplied.leadSourceReportSendTime = asSendTime(
      patch.leadSourceReportSendTime,
    );

  if (Object.keys(supplied).length > 0) {
    const current = await getServiceSettings(dealerId);
    await db
      .insert(dealerServiceSettingsTable)
      .values({ dealerId, ...current, ...supplied })
      .onConflictDoUpdate({
        target: dealerServiceSettingsTable.dealerId,
        set: supplied,
      });
  }
  return getServiceSettings(dealerId);
}
