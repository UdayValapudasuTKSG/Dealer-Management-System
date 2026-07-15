import type { LosConnector } from "./types";
import { DemeraraLosConnector } from "./demerara";

export type { LosConnector, LosMode, LosSubmitResult, LosStatusResult } from "./types";

const connectors: Record<string, LosConnector> = {
  demerara: new DemeraraLosConnector(),
};

/**
 * Resolve the active LOS connector. Defaults to Demerara Bank; switchable via
 * the LOS_CONNECTOR env var once more lenders are registered.
 */
export function getLosConnector(): LosConnector {
  const name = process.env.LOS_CONNECTOR ?? "demerara";
  return connectors[name] ?? connectors.demerara!;
}
