import type { FinanceApplication } from "@workspace/db";
import type {
  LosConnector,
  LosMode,
  LosStatusResult,
  LosSubmitResult,
} from "./types";
import { logger } from "../logger";

/**
 * Demerara Bank LOS connector.
 *
 * Live mode requires DEMERARA_LOS_API_URL + DEMERARA_LOS_API_KEY secrets and
 * calls the Demerara LOS REST API. When credentials are absent the connector
 * runs a clearly-labeled SANDBOX (mock) underwriting simulation so the whole
 * finance journey stays demonstrable end-to-end.
 */

function liveConfig(): { url: string; key: string } | null {
  const url = process.env.DEMERARA_LOS_API_URL;
  const key = process.env.DEMERARA_LOS_API_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

async function losFetch<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const cfg = liveConfig();
  if (!cfg) throw new Error("Demerara LOS credentials are not configured");
  const res = await fetch(`${cfg.url}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.key}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Demerara LOS ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

function toLosPayload(app: FinanceApplication): Record<string, unknown> {
  return {
    externalId: String(app.id),
    applicant: {
      fullName: app.customerName,
      employerName: app.employerName,
      jobTitle: app.jobTitle,
      employmentType: app.employmentType,
      employmentYears: app.employmentYears,
      monthlyIncome: app.monthlyIncome,
      otherIncome: app.otherIncome,
    },
    loan: {
      amount: app.amount,
      downPayment: app.downPayment,
      termMonths: app.termMonths,
      apr: app.apr,
    },
  };
}

const STATUS_MAP: Record<string, LosStatusResult["status"]> = {
  received: "submitted",
  submitted: "submitted",
  processing: "under_review",
  under_review: "under_review",
  in_review: "under_review",
  approved: "approved",
  rejected: "declined",
  declined: "declined",
  disbursed: "disbursed",
  funded: "disbursed",
};

// ---------------------------------------------------------------------------
// Sandbox underwriting simulation (deterministic, income-based)
// ---------------------------------------------------------------------------

function monthlyPayment(app: FinanceApplication): number {
  const principal = Math.max(app.amount - app.downPayment, 0);
  const r = app.apr / 100 / 12;
  if (r === 0) return principal / Math.max(app.termMonths, 1);
  const n = app.termMonths;
  return (principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

function mockDecision(app: FinanceApplication): {
  approved: boolean;
  reason: string;
} {
  const income = (app.monthlyIncome ?? 0) + (app.otherIncome ?? 0);
  if (income <= 0) {
    return {
      approved: false,
      reason: "No verifiable income was provided on the application.",
    };
  }
  const payment = monthlyPayment(app);
  const dti = payment / income;
  if (dti > 0.45) {
    return {
      approved: false,
      reason: `Debt-to-income ratio ${(dti * 100).toFixed(0)}% exceeds the 45% sandbox underwriting ceiling.`,
    };
  }
  return {
    approved: true,
    reason: `Debt-to-income ratio ${(dti * 100).toFixed(0)}% is within policy; sandbox underwriting approved the facility.`,
  };
}

export class DemeraraLosConnector implements LosConnector {
  readonly name = "demerara";

  get mode(): LosMode {
    return liveConfig() ? "live" : "mock";
  }

  async submit(app: FinanceApplication): Promise<LosSubmitResult> {
    if (this.mode === "live") {
      const data = await losFetch<{
        reference: string;
        status?: string;
        message?: string;
      }>("/v1/applications", {
        method: "POST",
        body: JSON.stringify(toLosPayload(app)),
      });
      return {
        reference: data.reference,
        status: STATUS_MAP[data.status ?? "received"] === "under_review"
          ? "under_review"
          : "submitted",
        message:
          data.message ?? "Application received by Demerara Bank LOS.",
        raw: data as Record<string, unknown>,
      };
    }
    logger.info(
      { applicationId: app.id },
      "Demerara LOS sandbox: simulated submission",
    );
    return {
      reference: `DEM-SBX-${String(app.id).padStart(5, "0")}`,
      status: "submitted",
      message:
        "SANDBOX — application accepted by the simulated Demerara LOS intake queue.",
    };
  }

  async getStatus(app: FinanceApplication): Promise<LosStatusResult> {
    if (this.mode === "live") {
      const data = await losFetch<{ status: string; message?: string }>(
        `/v1/applications/${encodeURIComponent(app.losReference ?? "")}`,
        { method: "GET" },
      );
      const status = STATUS_MAP[data.status] ?? "under_review";
      return {
        status,
        message: data.message ?? `Demerara LOS reports status "${data.status}".`,
        raw: data as Record<string, unknown>,
      };
    }

    // Sandbox: advance one stage per poll — submitted → under_review →
    // approved/declined → (approved) disbursed.
    switch (app.status) {
      case "submitted":
        return {
          status: "under_review",
          message:
            "SANDBOX — the credit committee has picked up the file for review.",
        };
      case "under_review": {
        const d = mockDecision(app);
        return d.approved
          ? { status: "approved", message: `SANDBOX — ${d.reason}` }
          : { status: "declined", message: `SANDBOX — ${d.reason}` };
      }
      case "approved":
        return {
          status: "disbursed",
          message:
            "SANDBOX — funds released to the dealership settlement account.",
        };
      default:
        return {
          status: app.status as LosStatusResult["status"],
          message: "SANDBOX — no further movement on the file.",
        };
    }
  }
}
