// One-off backfill (task: slug-style Meta form answers): re-match leads whose
// interested_model_text never linked to inventory, using the normalized
// matcher. Only touches leads with no interestedVehicleId. Set-based: matches
// once per distinct text, then a single UPDATE per text.
//
// Usage: [DATABASE_URL=...] npx tsx src/scripts/backfill-lead-vehicle-match.ts [dealerId] [--apply]
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { db, leadsTable } from "@workspace/db";
import { matchVehicleByText } from "../lib/lead-intake";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dealerId = Number(args.find((a) => !a.startsWith("--")) ?? 1);

  const rows = await db
    .select({
      text: leadsTable.interestedModelText,
      count: sql<number>`count(*)`,
    })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.dealerId, dealerId),
        isNull(leadsTable.interestedVehicleId),
        isNotNull(leadsTable.interestedModelText),
      ),
    )
    .groupBy(leadsTable.interestedModelText);

  let matchedLeads = 0;
  let total = 0;
  for (const row of rows) {
    total += Number(row.count);
    const vehicle = await matchVehicleByText(row.text, dealerId);
    if (!vehicle) {
      console.log(`SKIP  (${row.count}) "${row.text}" — no confident match`);
      continue;
    }
    console.log(
      `MATCH (${row.count}) "${row.text}" -> vehicle ${vehicle.id} (${vehicle.label}${vehicle.variant ? `, ${vehicle.variant}` : ""})`,
    );
    if (!apply) continue;
    await db
      .update(leadsTable)
      .set({
        interestedVehicleId: vehicle.id,
        interestedModelText: null,
        variant: vehicle.variant,
        color: vehicle.color,
      })
      .where(
        and(
          eq(leadsTable.dealerId, dealerId),
          isNull(leadsTable.interestedVehicleId),
          eq(leadsTable.interestedModelText, row.text!),
        ),
      );
    matchedLeads += Number(row.count);
  }
  console.log(
    `${apply ? "Applied" : "Dry run"}: ${matchedLeads}/${total} leads re-matched across ${rows.length} distinct texts.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
