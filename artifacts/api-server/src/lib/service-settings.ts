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
> & { summaryCadence: ServiceSummaryCadence };

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
  },
): Promise<ServiceSettings> {
  const current = await getServiceSettings(dealerId);
  const next = {
    serviceIntervalKm: patch.serviceIntervalKm ?? current.serviceIntervalKm,
    lateSurchargeFee: patch.lateSurchargeFee ?? current.lateSurchargeFee,
    summaryCadence: asCadence(patch.summaryCadence ?? current.summaryCadence),
    defaultJobHours: patch.defaultJobHours ?? current.defaultJobHours,
    techWorkHoursPerDay:
      patch.techWorkHoursPerDay ?? current.techWorkHoursPerDay,
  };
  await db
    .insert(dealerServiceSettingsTable)
    .values({ dealerId, ...next })
    .onConflictDoUpdate({
      target: dealerServiceSettingsTable.dealerId,
      set: next,
    });
  return next;
}
