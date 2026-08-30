/**
 * Amber Connect provider adapter boundary.
 *
 * AURA must NOT invent Amber Connect API URLs, payloads, authentication,
 * signatures or rate limits — official partner documentation is pending.
 * This module defines the TYPED seam the rest of the system codes against;
 * a concrete adapter is registered only once a verified contract exists.
 *
 * Until then `resolveAmberProvider()` returns null and every caller treats
 * that as "contract pending": scheduled sync parks quietly, connection tests
 * report pending_contract, and no outbound request is ever fabricated.
 */
import type { AmberConnection } from "@workspace/db";

/** Normalized telemetry event as AURA ingests it (webhook or pull). */
export type AmberProviderEvent = {
  /** Provider-unique event id — the idempotency key. */
  externalId: string;
  /** Provider device identity (IMEI / serial). */
  deviceId: string;
  type:
    | "location"
    | "odometer"
    | "ignition_on"
    | "ignition_off"
    | "device_health"
    | "other";
  /** Provider event timestamp (ISO 8601 or Date). */
  occurredAt: Date;
  latitude?: number;
  longitude?: number;
  odometerKm?: number;
  /** e.g. "ok" | "low_battery" | "offline" | "tamper" */
  deviceHealth?: string;
  raw?: Record<string, unknown>;
};

/** Device/vehicle identity as supplied by the provider. */
export type AmberProviderDevice = {
  deviceId: string;
  vin?: string | null;
  label?: string | null;
  metadata?: Record<string, unknown>;
};

/** Result of a live credential/connectivity test. */
export type AmberProviderTestResult = {
  ok: boolean;
  detail: string;
};

/**
 * The typed boundary a real Amber Connect adapter must implement. Concrete
 * request construction (URLs, auth headers, signatures) lives ONLY inside
 * an adapter built from verified Amber documentation.
 */
export interface AmberProvider {
  /** Verify stored credentials against the provider. */
  test(conn: AmberConnection, apiKey: string): Promise<AmberProviderTestResult>;
  /** List devices/vehicle identities registered to the dealer's account. */
  listDevices(
    conn: AmberConnection,
    apiKey: string,
  ): Promise<AmberProviderDevice[]>;
  /** Pull events newer than the given watermark (scheduled sync). */
  pullEvents(
    conn: AmberConnection,
    apiKey: string,
    since: Date | null,
  ): Promise<AmberProviderEvent[]>;
}

let registeredProvider: AmberProvider | null = null;

/**
 * Register the concrete Amber adapter. Call this ONLY from an implementation
 * derived from official Amber Connect partner documentation (or an approved
 * export contract). Nothing registers a provider today — the module ships
 * with the seam alone.
 */
export function registerAmberProvider(provider: AmberProvider): void {
  registeredProvider = provider;
}

/** Test-only: clear the registered adapter. */
export function unregisterAmberProvider(): void {
  registeredProvider = null;
}

/**
 * Resolve the active provider adapter for a connection. Returns null while
 * the partner API contract is pending (no adapter registered) or the dealer
 * hasn't stored a base URL/credential yet.
 */
export function resolveAmberProvider(
  conn: AmberConnection,
): AmberProvider | null {
  if (!registeredProvider) return null;
  if (!conn.apiBaseUrl || !conn.apiKeyCiphertext) return null;
  return registeredProvider;
}

export const AMBER_CONTRACT_PENDING_MESSAGE =
  "Amber Connect partner API documentation is pending — live provider calls are disabled until a verified contract is configured.";
