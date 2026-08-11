import { eq } from "drizzle-orm";
import {
  db,
  dealerServiceSettingsTable,
  DEFAULT_SERVICE_INTERVAL_KM,
  DEFAULT_LATE_SURCHARGE_FEE,
  type DealerServiceSettings,
} from "@workspace/db";

/**
 * Per-dealer service settings (FR-SR-07): service interval (km) and the flat
 * late-service surcharge fee. Reads fall back to defaults without writing;
 * updates upsert the row.
 */
export async function getServiceSettings(
  dealerId: number,
): Promise<Pick<DealerServiceSettings, "serviceIntervalKm" | "lateSurchargeFee">> {
  const [row] = await db
    .select()
    .from(dealerServiceSettingsTable)
    .where(eq(dealerServiceSettingsTable.dealerId, dealerId));
  return {
    serviceIntervalKm: row?.serviceIntervalKm ?? DEFAULT_SERVICE_INTERVAL_KM,
    lateSurchargeFee: row?.lateSurchargeFee ?? DEFAULT_LATE_SURCHARGE_FEE,
  };
}

export async function updateServiceSettings(
  dealerId: number,
  patch: { serviceIntervalKm?: number; lateSurchargeFee?: number },
): Promise<Pick<DealerServiceSettings, "serviceIntervalKm" | "lateSurchargeFee">> {
  const current = await getServiceSettings(dealerId);
  const next = {
    serviceIntervalKm: patch.serviceIntervalKm ?? current.serviceIntervalKm,
    lateSurchargeFee: patch.lateSurchargeFee ?? current.lateSurchargeFee,
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
