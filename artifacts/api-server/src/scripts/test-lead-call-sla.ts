import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import { callLogsTable, db, leadsTable } from "@workspace/db";
import {
  markLeadContactFromCall,
  withEffectiveContactDates,
} from "../lib/lead-contact";

async function main(): Promise<void> {
  const dealerId = 2_147_480_001;
  const leadIds: number[] = [];

  try {
    const [historicalLead] = await db
      .insert(leadsTable)
      .values({
        dealerId,
        name: "SLA historical-call regression",
        status: "assigned",
        phase: "contacted",
      })
      .returning();
    assert.ok(historicalLead);
    leadIds.push(historicalLead.id);

    const [historicalCall] = await db
      .insert(callLogsTable)
      .values({
        dealerId,
        leadId: historicalLead.id,
        direction: "outbound",
        status: "completed",
        actor: "Regression Test",
      })
      .returning();
    assert.ok(historicalCall);

    const [effectiveHistorical] = await withEffectiveContactDates(dealerId, [
      historicalLead,
    ]);
    assert.equal(
      effectiveHistorical?.contactedDate?.getTime(),
      historicalCall.createdAt.getTime(),
      "a historical finished call must stop SLA even without a lead stamp",
    );

    const [activeLead] = await db
      .insert(leadsTable)
      .values({
        dealerId,
        name: "SLA new-call regression",
        status: "assigned",
        phase: "new",
      })
      .returning();
    assert.ok(activeLead);
    leadIds.push(activeLead.id);

    const [inProgressCall] = await db
      .insert(callLogsTable)
      .values({
        dealerId,
        leadId: activeLead.id,
        direction: "outbound",
        status: "in_progress",
        actor: "Regression Test",
      })
      .returning();
    assert.ok(inProgressCall);

    assert.equal(
      await markLeadContactFromCall(inProgressCall),
      null,
      "an in-progress browser call must not stop SLA",
    );
    const [stillActive] = await withEffectiveContactDates(dealerId, [activeLead]);
    assert.equal(stillActive?.contactedDate, null);

    const [finishedCall] = await db
      .update(callLogsTable)
      .set({ status: "no_answer" })
      .where(eq(callLogsTable.id, inProgressCall.id))
      .returning();
    assert.ok(finishedCall);

    const stampedLead = await markLeadContactFromCall(finishedCall);
    assert.ok(stampedLead?.contactedDate);
    assert.equal(stampedLead.status, "contacted");
    assert.equal(stampedLead.phase, "contacted");
    assert.equal(
      stampedLead.contactedDate?.getTime(),
      finishedCall.createdAt.getTime(),
    );

    console.info("Lead call/SLA regression passed (8 assertions).");
  } finally {
    if (leadIds.length > 0) {
      await db
        .delete(callLogsTable)
        .where(
          and(
            eq(callLogsTable.dealerId, dealerId),
            inArray(callLogsTable.leadId, leadIds),
          ),
        );
      await db
        .delete(leadsTable)
        .where(
          and(
            eq(leadsTable.dealerId, dealerId),
            inArray(leadsTable.id, leadIds),
          ),
        );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});