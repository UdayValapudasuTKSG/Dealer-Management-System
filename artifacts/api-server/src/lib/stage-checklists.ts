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
      items: row.items,
      updatedBy: row.createdBy,
      updatedAt: row.createdAt,
    };
  }
  return {
    stage,
    version: 0,
    items: DEFAULT_STAGE_CHECKLISTS[stage],
    updatedBy: null,
    updatedAt: null,
  };
}

export async function getAllActiveChecklists(dealerId: number) {
  return Promise.all(
    CHECKLIST_STAGES.map((stage) => getActiveChecklist(dealerId, stage)),
  );
}
