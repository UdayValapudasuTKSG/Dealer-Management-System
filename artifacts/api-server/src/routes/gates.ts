import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  gatesTable,
  graFilingsTable,
  dealsTable,
  financeApplicationsTable,
  vehiclesTable,
  leadsTable,
  bookingsTable,
  deliveriesTable,
  timelineEventsTable,
  paymentsTable,
  type Gate,
} from "@workspace/db";
import {
  ensureFinalInvoiceForDeal,
  approvedFinanceAppForDeal,
  applyPayment,
  PaymentGuardError,
} from "../lib/invoicing";
import {
  ADVANCE_TARGET_PHASE,
  REVIEW_STAGE_LABEL,
  type AdvanceStage,
} from "../lib/stage-review";
import { computeDraftDuty, taxLinesMatch } from "../lib/gra-duty";
import { computeTaxes, ensureDealerTaxes } from "../lib/taxes";
import { activeDealerId } from "../middlewares/rbac";
import { notifyRefundApproved } from "../lib/notify-triggers";
import {
  ListGatesQueryParams,
  ListGatesResponse,
  ResolveGateParams,
  ResolveGateBody,
  ResolveGateResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

router.get("/gates", async (req, res): Promise<void> => {
  const query = ListGatesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const rows = await db
    .select()
    .from(gatesTable)
    .where(
      query.data.status
        ? and(
            eq(gatesTable.dealerId, dealerId),
            eq(gatesTable.status, query.data.status),
          )
        : eq(gatesTable.dealerId, dealerId),
    )
    .orderBy(desc(gatesTable.createdAt));

  res.json(ListGatesResponse.parse(rows));
});

async function writeReceipt(
  tx: Tx,
  gate: Gate,
  title: string,
  detail: string,
) {
  await tx.insert(timelineEventsTable).values({
    dealerId: gate.dealerId,
    customerId: gate.customerId ?? null,
    domain: "gate",
    kind: `gate_${gate.type}`,
    title,
    detail,
    actor: gate.resolvedBy ?? "Manager",
    isAgent: false,
    cause: gate.title,
    refType: gate.refType ?? null,
    refId: gate.refId ?? null,
  });
}

// Applies the connected downstream effect of approving/adjusting a gate.
async function applyCascade(
  tx: Tx,
  gate: Gate,
  action: "approve" | "adjust",
  adjustedAmount: number | undefined,
): Promise<{ title: string; detail: string }> {
  const effectiveAmount =
    action === "adjust" && adjustedAmount !== undefined
      ? adjustedAmount
      : (gate.amount ?? 0);

  switch (gate.type) {
    case "below_floor_price": {
      // gate.amount stores the EFFECTIVE selling price snapshot (vehiclePrice
      // − discount), NOT the discount. Approve authorizes the deal's current
      // numbers as-is; adjust sets a NEW discount (adjustedAmount) and
      // recomputes OTD deterministically via the dealer tax engine. Either
      // way the gate's amount snapshot is refreshed so commit-time staleness
      // checks compare against the authorized effective price.
      let authorizedDiscount = 0;
      if (gate.refId) {
        const [deal] = await tx
          .select()
          .from(dealsTable)
          .where(
            and(
              eq(dealsTable.id, gate.refId),
              eq(dealsTable.dealerId, gate.dealerId),
            ),
          );
        if (deal) {
          const newDiscount =
            action === "adjust" && adjustedAmount !== undefined
              ? Math.min(Math.max(adjustedAmount, 0), deal.vehiclePrice)
              : deal.discount;
          authorizedDiscount = newDiscount;
          if (newDiscount !== deal.discount) {
            const [vehicle] = await tx
              .select({ powertrain: vehiclesTable.powertrain })
              .from(vehiclesTable)
              .where(
                and(
                  eq(vehiclesTable.id, deal.vehicleId),
                  eq(vehiclesTable.dealerId, deal.dealerId),
                ),
              );
            const taxBase = Math.max(
              deal.vehiclePrice - newDiscount + deal.accessories,
              0,
            );
            const taxRules = await ensureDealerTaxes(deal.dealerId);
            const { totalWithTax } = computeTaxes(taxBase, taxRules, {
              powertrain: vehicle?.powertrain ?? null,
            });
            await tx
              .update(dealsTable)
              .set({ discount: newDiscount, otdPrice: totalWithTax })
              .where(
                and(
                  eq(dealsTable.id, gate.refId),
                  eq(dealsTable.dealerId, gate.dealerId),
                ),
              );
          }
          // Refresh the snapshot to the authorized effective price.
          await tx
            .update(gatesTable)
            .set({ amount: deal.vehiclePrice - newDiscount })
            .where(eq(gatesTable.id, gate.id));
        }
      }
      return {
        title:
          action === "adjust"
            ? "Below-floor price adjusted and approved"
            : "Below-floor price approved",
        detail: `Discount of $${authorizedDiscount.toLocaleString()} authorized on the deal; pricing pushed live and the advisor notified.`,
      };
    }
    case "credit_decline": {
      if (gate.refId) {
        await tx
          .update(financeApplicationsTable)
          .set({ status: action === "adjust" ? "under_review" : "declined" })
          .where(
            and(
              eq(financeApplicationsTable.id, gate.refId),
              eq(financeApplicationsTable.dealerId, gate.dealerId),
            ),
          );
      }
      return action === "adjust"
        ? {
            title: "Credit decision re-routed",
            detail:
              "Application returned for restructured terms; concierge is preparing a revised offer with a co-signer path.",
          }
        : {
            title: "Adverse credit decision confirmed",
            detail:
              "Application declined; concierge is drafting the adverse-action notice and an alternate-lender option.",
          };
    }
    case "capital_order": {
      if (gate.refId) {
        await tx
          .update(vehiclesTable)
          .set({ status: "in_transit" })
          .where(
            and(
              eq(vehiclesTable.id, gate.refId),
              eq(vehiclesTable.dealerId, gate.dealerId),
            ),
          );
      }
      return {
        title: "Capital order approved",
        detail: `Stock order committed for $${effectiveAmount.toLocaleString()}; logistics opened the inbound shipment and the unit is now in transit.`,
      };
    }
    case "gra_filing": {
      // Approval AUTHORISES the filing but does not file it — the snapshot
      // stays pending_gate until staff explicitly POST /gra/filings with this
      // resolved gate (17-mB step 8). The duty pack PDF only exists after that.
      return {
        title: "GRA duty sheet approved",
        detail:
          "Officer confirmed the duty computation. The filing can now be submitted to the GRA to generate the duty pack.",
      };
    }
    case "refund_release": {
      // L9 cancellation approval: releases the vehicle hold (honoring other
      // active bookings), cancels linked bookings, and voids the delivery
      // workflow. Money does NOT move here — finance executes the refund as
      // a negative payment referencing this gate (422 until it's approved).
      let vinReturned = false;
      const releaseUnit = async (vehicleId: number) => {
        const [otherHold] = await tx
          .select({ id: bookingsTable.id })
          .from(bookingsTable)
          .where(
            and(
              eq(bookingsTable.vehicleId, vehicleId),
              eq(bookingsTable.dealerId, gate.dealerId),
              eq(bookingsTable.status, "active"),
            ),
          );
        if (otherHold) return false;
        const [updated] = await tx
          .update(vehiclesTable)
          .set({ status: "available", holdUntil: null, holdReason: null })
          .where(
            and(
              eq(vehiclesTable.id, vehicleId),
              eq(vehiclesTable.dealerId, gate.dealerId),
              inArray(vehiclesTable.status, ["reserved", "booked"]),
            ),
          )
          .returning({ id: vehiclesTable.id });
        return Boolean(updated);
      };

      if (gate.refId) {
        if (gate.refType === "vehicle") {
          await tx
            .update(vehiclesTable)
            .set({ status: "available", holdUntil: null, holdReason: null })
            .where(
              and(
                eq(vehiclesTable.id, gate.refId),
                eq(vehiclesTable.dealerId, gate.dealerId),
              ),
            );
          vinReturned = true;
        } else if (gate.refType === "deal") {
          const [deal] = await tx
            .select()
            .from(dealsTable)
            .where(
              and(
                eq(dealsTable.id, gate.refId),
                eq(dealsTable.dealerId, gate.dealerId),
              ),
            );
          if (deal) {
            await tx
              .update(bookingsTable)
              .set({
                status: "cancelled",
                cancellationReason: deal.cancellationReason ?? "other",
              })
              .where(
                and(
                  eq(bookingsTable.dealId, deal.id),
                  eq(bookingsTable.dealerId, gate.dealerId),
                  eq(bookingsTable.status, "active"),
                ),
              );
            await tx
              .update(deliveriesTable)
              .set({ status: "cancelled" })
              .where(
                and(
                  eq(deliveriesTable.dealId, deal.id),
                  eq(deliveriesTable.dealerId, gate.dealerId),
                  eq(deliveriesTable.status, "in_progress"),
                ),
              );
            vinReturned = await releaseUnit(deal.vehicleId);
          }
        } else if (gate.refType === "booking") {
          const [booking] = await tx
            .select()
            .from(bookingsTable)
            .where(
              and(
                eq(bookingsTable.id, gate.refId),
                eq(bookingsTable.dealerId, gate.dealerId),
              ),
            );
          if (booking) {
            vinReturned = await releaseUnit(booking.vehicleId);
          }
        }
      }
      return {
        title: "Refund release approved",
        detail: `Refund of $${effectiveAmount.toLocaleString()} authorized for finance to execute${
          vinReturned ? "; the VIN is back in available stock" : ""
        }. The customer will be notified once the refund is recorded.`,
      };
    }
    case "stage_advance": {
      // One-click pipeline progression proposed by the Pipeline agent: the
      // target stage is carried in the gate's evidence.
      const stage = gate.evidence.find((e) => e.label === "targetStage")
        ?.value as AdvanceStage | undefined;
      const targetPhase = stage ? ADVANCE_TARGET_PHASE[stage] : undefined;
      if (gate.refType === "lead" && gate.refId && stage && targetPhase) {
        const [lead] = await tx
          .select()
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.id, gate.refId),
              eq(leadsTable.dealerId, gate.dealerId),
            ),
          );
        if (lead) {
          await tx
            .update(leadsTable)
            .set({
              phase: targetPhase,
              stageEnteredAt: new Date(),
              ...(stage === "sold" ? { status: "converted" } : {}),
            })
            .where(eq(leadsTable.id, lead.id));
          // Sold locks the VIN — mirror the manual advance endpoint.
          if (stage === "sold" && lead.interestedVehicleId) {
            await tx
              .update(vehiclesTable)
              .set({ status: "reserved" })
              .where(
                and(
                  eq(vehiclesTable.id, lead.interestedVehicleId),
                  eq(vehiclesTable.dealerId, gate.dealerId),
                  eq(vehiclesTable.status, "available"),
                ),
              );
          }
        }
      }
      const stageLabel = stage ? (REVIEW_STAGE_LABEL[stage] ?? stage) : "next stage";
      return {
        title: `Stage advance approved — ${stageLabel}`,
        detail: `${gate.customerName ?? "The lead"} moved forward to ${stageLabel}; every checklist criterion had been verified by the Pipeline agent.`,
      };
    }
    case "recall_damage": {
      // Approving the hold clears the recall/damage flags on the unit so
      // the blocked deal commit can be retried (advisory monitor, L5).
      if (gate.refType === "vehicle" && gate.refId) {
        await tx
          .update(vehiclesTable)
          .set({ recallFlag: false, damageFlag: false })
          .where(
            and(
              eq(vehiclesTable.id, gate.refId),
              eq(vehiclesTable.dealerId, gate.dealerId),
            ),
          );
      }
      return {
        title: "Recall/damage hold cleared",
        detail:
          "The unit was inspected and cleared; its recall/damage flags are lifted and the blocked deal commit can be retried.",
      };
    }
    case "bank_funds_received": {
      // Manager confirmed the bank's undertaken funds actually arrived.
      // Post the payment against the deal's settlement invoice (capped at
      // the outstanding balance — applyPayment's overpayment/duplicate
      // guards also hold), then record the financing facility as disbursed
      // so the bank-financed commit check passes.
      if (gate.refType !== "deal" || !gate.refId) {
        return { title: "Bank funds confirmed", detail: "" };
      }
      const [deal] = await tx
        .select()
        .from(dealsTable)
        .where(
          and(eq(dealsTable.id, gate.refId), eq(dealsTable.dealerId, gate.dealerId)),
        );
      if (!deal) {
        return { title: "Bank funds confirmed", detail: "Deal no longer exists." };
      }
      // Ensure the settlement invoice BEFORE any finance app exists so its
      // amount is NOT netted by the facility — the bank's money arrives as a
      // visible ledger payment instead, driving Remaining to zero.
      const invoice = await ensureFinalInvoiceForDeal(deal);
      let posted = 0;
      if (invoice && invoice.status !== "void") {
        const [{ paid }] = await tx
          .select({
            paid: sql<number>`coalesce(sum(${paymentsTable.amount}), 0)::float`,
          })
          .from(paymentsTable)
          .where(
            and(
              eq(paymentsTable.invoiceId, invoice.id),
              eq(paymentsTable.dealerId, gate.dealerId),
            ),
          );
        const outstanding =
          Math.round((invoice.amount - (paid ?? 0)) * 100) / 100;
        const confirmed = effectiveAmount > 0 ? effectiveAmount : outstanding;
        posted = Math.min(confirmed, outstanding);
        if (posted > 0.005) {
          try {
            await applyPayment({
              invoice,
              amount: posted,
              method: "financing",
              reference: `bank-letter-gate-${gate.id}`,
              receivedBy: "Bank funds confirmation",
            });
          } catch (err) {
            // A duplicate reference means a previous approval attempt already
            // posted this gate's payment — safe to continue idempotently.
            if (
              !(err instanceof PaymentGuardError && err.code === "duplicate_reference")
            ) {
              throw err;
            }
            posted = 0;
          }
        } else {
          posted = 0;
        }
      }
      // Record the disbursed facility so the financed-commit check passes.
      const existingApp = await approvedFinanceAppForDeal(deal);
      const nowIso = new Date().toISOString();
      if (existingApp) {
        if (existingApp.status !== "disbursed") {
          await tx
            .update(financeApplicationsTable)
            .set({
              status: "disbursed",
              disbursedAt: new Date(),
              statusHistory: [
                ...existingApp.statusHistory,
                {
                  status: "disbursed",
                  note: `Bank letter approved (gate #${gate.id}) — funds received`,
                  at: nowIso,
                },
              ],
            })
            .where(eq(financeApplicationsTable.id, existingApp.id));
        }
      } else {
        const lender =
          gate.evidence.find((e) => e.label === "Bank")?.value ?? "Bank (letter)";
        // Clamp to the deal's OTD price: the letter content is untrusted, so
        // a fabricated undertaking amount must never inflate the recorded
        // facility beyond what the deal is actually worth.
        const facilityAmount = Math.min(
          effectiveAmount > 0 ? effectiveAmount : posted,
          deal.otdPrice,
        );
        await tx.insert(financeApplicationsTable).values({
          dealerId: gate.dealerId,
          dealId: deal.id,
          leadId: deal.leadId,
          customerId: deal.customerId,
          customerName: deal.customerName ?? "Customer",
          amount: facilityAmount,
          downPayment: 0,
          termMonths: 0,
          apr: 0,
          lender,
          status: "disbursed",
          submittedAt: new Date(),
          decisionAt: new Date(),
          disbursedAt: new Date(),
          statusHistory: [
            {
              status: "disbursed",
              note: `Created from approved bank letter (gate #${gate.id})`,
              at: nowIso,
            },
          ],
        });
      }
      return {
        title: "Bank funds confirmed",
        detail:
          posted > 0
            ? `GY$${posted.toLocaleString("en-US", { maximumFractionDigits: 0 })} posted to the settlement invoice from the bank's letter of undertaking; the financing facility is recorded as disbursed and the deal can now commit.`
            : "Funds confirmation recorded; the settlement invoice was already covered and the financing facility is recorded as disbursed.",
      };
    }
    default:
      return { title: "Gate resolved", detail: "" };
  }
}

router.post("/gates/:id/resolve", async (req, res): Promise<void> => {
  const params = ResolveGateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = ResolveGateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const [gate] = await db
    .select()
    .from(gatesTable)
    .where(
      and(eq(gatesTable.id, params.data.id), eq(gatesTable.dealerId, dealerId)),
    );

  if (!gate) {
    res.status(404).json({ error: "Gate not found" });
    return;
  }
  if (gate.status !== "pending") {
    res.status(400).json({ error: "Gate already resolved" });
    return;
  }

  const { action, note, adjustedAmount, resolvedBy } = parsed.data;

  // GRA filings can only be approved when the snapshot still passes the real
  // GRA rule engine: no missing inputs, no unresolved rule-gap flags, and the
  // stored total matches a fresh recompute (fail-closed, never rubber-stamp).
  if (gate.type === "gra_filing" && action !== "dismiss") {
    const [filing] = await db
      .select()
      .from(graFilingsTable)
      .where(
        and(
          eq(graFilingsTable.gateId, gate.id),
          eq(graFilingsTable.dealerId, gate.dealerId),
          eq(graFilingsTable.status, "pending_gate"),
        ),
      );
    if (filing) {
      const duty = await computeDraftDuty(gate.dealerId, {
        cifValue: filing.cifValue,
        engineCc: filing.engineCc,
        fuelType: filing.fuelType,
        year: filing.year,
        yearOfImport: filing.yearOfImport,
      });
      const unmet = [...duty.missingInputs, ...duty.reviewFlags];
      if (Math.abs(duty.totalPayable - filing.totalPayable) > 0.01) {
        unmet.push("total_mismatch_with_gra_engine");
      } else if (!taxLinesMatch(duty.taxLines, filing.taxLines)) {
        unmet.push("tax_lines_mismatch_with_gra_engine");
      }
      if (unmet.length > 0) {
        res.status(422).json({
          error:
            "This GRA filing cannot be approved — the duty computation is incomplete or no longer matches the GRA rules. Resubmit the draft.",
          unmet,
        });
        return;
      }
    }
  }

  const status =
    action === "approve"
      ? "approved"
      : action === "adjust"
        ? "adjusted"
        : "dismissed";

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(gatesTable)
      .set({
        status,
        resolution: note ?? null,
        resolvedBy: resolvedBy ?? "Manager",
        resolvedAt: new Date(),
        ...(action === "adjust" && adjustedAmount !== undefined
          ? { amount: adjustedAmount }
          : {}),
      })
      .where(
        and(eq(gatesTable.id, gate.id), eq(gatesTable.status, "pending")),
      )
      .returning();
    if (!row) {
      // Another request resolved this gate concurrently — compare-and-set
      // failed; skip the cascade entirely.
      return null;
    }

    if (action !== "dismiss") {
      const receipt = await applyCascade(tx, row, action, adjustedAmount);
      await writeReceipt(tx, row, receipt.title, receipt.detail);
    } else {
      if (row.type === "gra_filing") {
        // Officer declined the filing — the snapshot is rejected, never filed.
        await tx
          .update(graFilingsTable)
          .set({ status: "rejected" })
          .where(
            and(
              eq(graFilingsTable.gateId, row.id),
              eq(graFilingsTable.dealerId, row.dealerId),
              eq(graFilingsTable.status, "pending_gate"),
            ),
          );
      }
      await writeReceipt(
        tx,
        row,
        "Gate dismissed",
        note ?? "Decision deferred by the manager.",
      );
    }

    return row;
  });

  if (!updated) {
    res.status(400).json({ error: "Gate already resolved" });
    return;
  }

  // R6.2 #10 Approved-for-Refund → finance/AP users (In-App + Email).
  if (updated.type === "refund_release" && action !== "dismiss") {
    notifyRefundApproved({
      dealerId: updated.dealerId,
      gateId: updated.id,
      label: updated.customerName ?? updated.title,
      amount:
        updated.amount != null
          ? updated.amount.toLocaleString("en-US", {
              style: "currency",
              currency: "GYD",
            })
          : undefined,
    });
  }

  res.json(ResolveGateResponse.parse(updated));
});

export default router;
