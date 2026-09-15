import {
  FIELD_GROUPS,
  type FieldAccessLevel,
} from "@workspace/db/schema";

export function blockedEditFieldFromGrants(
  grants: { group: (typeof FIELD_GROUPS)[number]; access: FieldAccessLevel }[],
  body: Record<string, unknown>,
): { field: string; groupLabel: string } | null {
  for (const { group, access } of grants) {
    if (access === "edit") continue;
    for (const field of group.fields) {
      if (body[field] !== undefined) {
        return { field, groupLabel: group.label };
      }
    }
  }
  return null;
}