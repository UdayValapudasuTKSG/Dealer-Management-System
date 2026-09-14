/**
 * Compatibility helpers for vehicle powertrain values.
 *
 * The API contract uses "EV", while a reviewed historical import written
 * before that contract was tightened persisted "electric".  Keep the stored
 * value untouched and canonicalize only at intake/output boundaries.
 */
export const VEHICLE_POWERTRAINS = ["EV", "Hybrid", "Petrol", "Diesel"] as const;
export type VehiclePowertrain = (typeof VEHICLE_POWERTRAINS)[number];

const POWERTRAIN_ALIASES: Record<string, VehiclePowertrain> = {
  ev: "EV",
  electric: "EV",
  bev: "EV",
  hybrid: "Hybrid",
  phev: "Hybrid",
  petrol: "Petrol",
  gas: "Petrol",
  gasoline: "Petrol",
  diesel: "Diesel",
};

/**
 * Normalize a user/import supplied powertrain without accepting unknown
 * values. Unknown values are returned trimmed so the canonical request schema
 * can reject them with its normal validation error.
 */
export function normalizePowertrain(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return POWERTRAIN_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Normalize the powertrain field of a request object without mutating the
 * Express body object.
 */
export function normalizeVehiclePowertrainInput<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "powertrain")) return value;
  return {
    ...record,
    powertrain: normalizePowertrain(record.powertrain),
  } as T;
}

/**
 * Canonicalize one vehicle-shaped output object.  Deliberately leaves unknown
 * powertrain values alone so the response schema still fails loudly for a
 * genuinely corrupt value instead of silently relabelling it.
 */
export function canonicalizeVehiclePowertrain<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "powertrain")) return value;
  const powertrain = normalizePowertrain(record.powertrain);
  return powertrain === record.powertrain
    ? value
    : ({ ...record, powertrain } as T);
}
