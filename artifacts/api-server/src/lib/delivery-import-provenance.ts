import { and, eq } from "drizzle-orm";
import { db, deliveriesTable, type Delivery } from "@workspace/db";

/**
 * Historical import suppression is scoped to the imported workflow record.
 * It intentionally does not alter customer consent or any other delivery.
 */
export function suppressesCustomerCommunications(
  delivery: Pick<Delivery, "importMetadata"> | { importMetadata?: unknown },
): boolean {
  const metadata = delivery.importMetadata;
  return (
    !!metadata &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>).suppressCustomerCommunications === true
  );
}

export async function deliverySuppressesCustomerCommunications(
  deliveryId: number,
  dealerId: number,
): Promise<boolean> {
  const [delivery] = await db
    .select({ importMetadata: deliveriesTable.importMetadata })
    .from(deliveriesTable)
    .where(
      and(
        eq(deliveriesTable.id, deliveryId),
        eq(deliveriesTable.dealerId, dealerId),
      ),
    );
  return suppressesCustomerCommunications(delivery ?? {});
}