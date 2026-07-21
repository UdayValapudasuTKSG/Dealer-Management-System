import { sql, eq } from "drizzle-orm";
import {
  db,
  leadsTable,
  documentsTable,
  agentsTable,
  dealersTable,
} from "@workspace/db";
import { DOCUMENT_AGENT_KEY } from "./document-extract";
import { logger } from "./logger";

/**
 * One-time boot migration for the Documents module:
 * 1. Ensure every dealer has the A5 "Documents" agent row (kill switch).
 * 2. Move legacy pasted-link lead attachments (leads.attachments JSONB) into
 *    the documents table as externalUrl rows, then clear the JSONB list so
 *    the migration is idempotent.
 */
export async function migrateLegacyAttachments(): Promise<void> {
  try {
    const dealers = await db
      .select({ id: dealersTable.id })
      .from(dealersTable);
    for (const dealer of dealers) {
      const existing = await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(
          sql`${agentsTable.dealerId} = ${dealer.id} and ${agentsTable.key} = ${DOCUMENT_AGENT_KEY}`,
        );
      if (existing.length === 0) {
        await db.insert(agentsTable).values({
          dealerId: dealer.id,
          key: DOCUMENT_AGENT_KEY,
          name: "Documents",
          domain: "leads",
          description:
            "A5 — reads uploaded documents and proposes editable lead pre-fills for advisor review. Never applies anything without confirmation.",
          status: "active",
        });
      }
    }

    const leads = await db
      .select({
        id: leadsTable.id,
        dealerId: leadsTable.dealerId,
        attachments: leadsTable.attachments,
      })
      .from(leadsTable)
      .where(sql`jsonb_array_length(${leadsTable.attachments}) > 0`);

    for (const lead of leads) {
      let version = 0;
      for (const att of lead.attachments) {
        if (!att?.url) continue;
        version += 1;
        await db.insert(documentsTable).values({
          dealerId: lead.dealerId,
          entityType: "lead",
          entityId: lead.id,
          type: "other",
          version,
          fileName: att.name || "Attachment",
          storageKey: null,
          externalUrl: att.url,
          mimeType: "application/octet-stream",
          sizeBytes: 0,
          comments: "Migrated from legacy lead attachments",
          uploadedBy: null,
        });
      }
      await db
        .update(leadsTable)
        .set({ attachments: [] })
        .where(eq(leadsTable.id, lead.id));
    }
    if (leads.length > 0) {
      logger.info(
        { leads: leads.length },
        "Migrated legacy lead attachments into documents",
      );
    }
  } catch (err) {
    logger.error({ err }, "Legacy attachment migration failed");
  }
}
