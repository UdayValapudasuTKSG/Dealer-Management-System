export const GT_AUTOMOTIVE_DEALER_ID = 1;
export const GT_AUTOMOTIVE_DEFAULT_YEAR = 2026;

export type ModelYearBulkVehicle = {
  dealerId: number;
  deletedAt: Date | null;
  year: number;
  status?: string;
};

export function modelYearBulkScope() {
  return {
    dealerId: GT_AUTOMOTIVE_DEALER_ID,
    statuses: "all" as const,
    includeDeleted: false as const,
  };
}

/** The bulk action's exact predicate: dealer 1, non-deleted, non-target year. */
export function isModelYearBulkAffected(
  vehicle: ModelYearBulkVehicle,
): boolean {
  return (
    vehicle.dealerId === GT_AUTOMOTIVE_DEALER_ID &&
    vehicle.deletedAt === null &&
    vehicle.year !== GT_AUTOMOTIVE_DEFAULT_YEAR
  );
}

export function countModelYearBulkAffected(
  vehicles: readonly ModelYearBulkVehicle[],
): number {
  return vehicles.filter(isModelYearBulkAffected).length;
}

/**
 * Missing years default only for newly-created GT Automotive inventory.
 * Explicit years, including a non-2026 year, are always preserved.
 */
export function defaultVehicleYearForDealer(
  dealerId: number,
  requestedYear: number | undefined,
): number | undefined {
  if (requestedYear !== undefined) return requestedYear;
  return dealerId === GT_AUTOMOTIVE_DEALER_ID
    ? GT_AUTOMOTIVE_DEFAULT_YEAR
    : undefined;
}

export function vehicleYearRequirementError(
  dealerId: number,
  requestedYear: number | undefined,
): string | null {
  return defaultVehicleYearForDealer(dealerId, requestedYear) === undefined
    ? "Year is required for this dealership."
    : null;
}

export function canNormalizeGtAutomotiveModelYears(
  dealerId: number,
  inventoryEditGranted: boolean,
): boolean {
  return dealerId === GT_AUTOMOTIVE_DEALER_ID && inventoryEditGranted;
}