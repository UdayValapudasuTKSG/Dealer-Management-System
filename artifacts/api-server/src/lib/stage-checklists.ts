import { and, desc, eq } from "drizzle-orm";
import {
  db,
  stageChecklistsTable,
  DEFAULT_STAGE_CHECKLISTS,
  CHECKLIST_STAGES,
  type ChecklistStage,
  type StageChecklistItem,
} from "@workspace/db";

export type ActiveChecklist = {
  stage: ChecklistStage;
  version: number;
  items: StageChecklistItem[];
  updatedBy: string | null;
  updatedAt: Date | null;
};

const RETIRED_CHECKLIST_KEYS = new Set(["vin_allocated", "finance_approved"]);

/** Keep retired checks out of current configuration without rewriting the
 * immutable version history stored for prior stage advances. */
export function currentChecklistItems(
  items: StageChecklistItem[],
): StageChecklistItem[] {
  return items.filter((item) => !RETIRED_CHECKLIST_KEYS.has(item.key));
}

/**
 * The active checklist for a stage is the highest saved version, falling back
 * to the built-in defaults (version 0) when a dealer has never customized it.
 */
export async function getActiveChecklist(
  dealerId: number,
  stage: ChecklistStage,
): Promise<ActiveChecklist> {
  const [row] = await db
    .select()
    .from(stageChecklistsTable)
    .where(
      and(
        eq(stageChecklistsTable.dealerId, dealerId),
        eq(stageChecklistsTable.stage, stage),
      ),
    )
    .orderBy(desc(stageChecklistsTable.version))
    .limit(1);
  if (row) {
    return {
      stage,
      version: row.version,
      items: currentChecklistItems(row.items),
      updatedBy: row.createdBy,
      updatedAt: row.createdAt,
    };
  }
  return {
    stage,
    version: 0,
    items: currentChecklistItems(DEFAULT_STAGE_CHECKLISTS[stage]),
    updatedBy: null,
    updatedAt: null,
  };
}

export async function getAllActiveChecklists(dealerId: number) {
  return Promise.all(
    CHECKLIST_STAGES.map((stage) => getActiveChecklist(dealerId, stage)),
  );
}
