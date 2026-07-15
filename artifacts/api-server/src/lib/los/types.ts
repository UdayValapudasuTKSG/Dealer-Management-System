import type { FinanceApplication } from "@workspace/db";

/**
 * Loan Origination System connector abstraction.
 *
 * Every lender integration implements this interface. The active connector is
 * resolved by `getLosConnector()` — routes never talk to a lender directly, so
 * new lenders (or an aggregator) plug in without touching workflow code.
 */
export type LosMode = "live" | "mock";

export type LosSubmitResult = {
  /** Lender-side application reference */
  reference: string;
  /** Normalized status right after submission */
  status: "submitted" | "under_review";
  message: string;
  raw?: Record<string, unknown>;
};

export type LosStatusResult = {
  status: "submitted" | "under_review" | "approved" | "declined" | "disbursed";
  message: string;
  raw?: Record<string, unknown>;
};

export interface LosConnector {
  /** Machine name, e.g. "demerara" */
  readonly name: string;
  /** Whether real credentials are configured */
  readonly mode: LosMode;
  submit(application: FinanceApplication): Promise<LosSubmitResult>;
  getStatus(application: FinanceApplication): Promise<LosStatusResult>;
}
