import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  gatesTable,
  graFilingsTable,
  dealsTable,
  financeApplicationsTable,
  vehiclesTable,
  leadsTable,
  timelineEventsTable,
  type Gate,
} from "@workspace/db";
import {
  ADVANCE_TARGET_PHASE,
  REVIEW_STAGE_LABEL,
  type AdvanceStage,
} from "../lib/stage-review";
import { computeDraftDuty } from "../lib/gra-duty";
import { activeDealerId } from "../middlewares/rbac";
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
          const otd =
            deal.vehiclePrice -
            effectiveAmount -
            deal.tradeInValue +
            deal.accessories;
          await tx
            .update(dealsTable)
            .set({ discount: effectiveAmount, otdPrice: otd })
            .where(
              and(
                eq(dealsTable.id, gate.refId),
                eq(dealsTable.dealerId, gate.dealerId),
              ),
            );
        }
      }
      return {
        title:
          action === "adjust"
            ? "Below-floor price adjusted and approved"
            : "Below-floor price approved",
        detail: `Discount of $${effectiveAmount.toLocaleString()} authorized on the deal; pricing pushed live and the advisor notified.`,
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
      // Human gate resolved → flip the pending filing snapshot to "filed"
      // (immutable from here on). The duty pack PDF only exists after this.
      await tx
        .update(graFilingsTable)
        .set({
          status: "filed",
          filedBy: gate.resolvedBy ?? "Officer",
          filedAt: new Date(),
        })
        .where(
          and(
            eq(graFilingsTable.gateId, gate.id),
            eq(graFilingsTable.dealerId, gate.dealerId),
            eq(graFilingsTable.status, "pending_gate"),
          ),
        );
      return {
        title: "GRA filing submitted",
        detail:
          "Duty pack accepted by the responsible officer and filed to the GRA; clearance and registration steps are now unblocked.",
      };
    }
    case "refund_release": {
      let vinReturned = false;
      if (gate.refId) {
        if (gate.refType === "vehicle") {
          await tx
            .update(vehiclesTable)
            .set({ status: "available" })
            .where(
              and(
                eq(vehiclesTable.id, gate.refId),
                eq(vehiclesTable.dealerId, gate.dealerId),
              ),
            );
          vinReturned = true;
        } else if (gate.refType === "deal") {
          await tx
            .update(dealsTable)
            .set({ depositPaid: false })
            .where(
              and(
                eq(dealsTable.id, gate.refId),
                eq(dealsTable.dealerId, gate.dealerId),
              ),
            );
        }
      }
      return {
        title: "Refund released",
        detail: `Reservation deposit of $${effectiveAmount.toLocaleString()} released to the customer${
          vinReturned ? "; the VIN is back in available stock" : ""
        }.`,
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
      const duty = computeDraftDuty(
        {
          cifValue: filing.cifValue,
          engineCc: filing.engineCc,
          fuelType: filing.fuelType,
          year: filing.year,
          yearOfImport: filing.yearOfImport,
          importerType: filing.importerType,
          bodyType: filing.bodyType,
          isHybrid: filing.isHybrid,
          retailPrice: filing.retailPrice,
        },
        filing.exchangeRate,
      );
      const unmet = [...duty.missingInputs, ...duty.reviewFlags];
      if (Math.abs(duty.totalPayable - filing.totalPayable) > 0.01) {
        unmet.push("total_mismatch_with_gra_engine");
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
      .where(eq(gatesTable.id, gate.id))
      .returning();

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

  res.json(ResolveGateResponse.parse(updated));
});

export default router;
