import { eq } from "drizzle-orm";
import { db, dealersTable } from "@workspace/db";

export const TEST_DRIVES_DISABLED =
  "We cannot facilitate test drives at this dealership at the moment.";

export type DealerCustomerPolicy = {
  testDrivesEnabled: boolean;
  showroomAddress: string | null;
  serviceAddress?: string | null;
};

/** The supplied correction belongs to GT Automotive's verified address only.
 * Never apply it to another dealer, or override an explicitly edited setting. */
export function resolveShowroomAddress(dealer: {
  id: number;
  name: string;
  address: string | null;
  whatsappShowroomAddress: string | null;
}): string | null {
  if (dealer.whatsappShowroomAddress?.trim())
    return dealer.whatsappShowroomAddress.trim();
  if (
    dealer.id === 1 &&
    dealer.name === "GT Automotive" &&
    dealer.address?.trim() === "220 Camp Street, Georgetown, Guyana."
  ) return "220 Camp St, Georgetown";
  return dealer.address?.trim() || null;
}

/** Deliberately uncached: each interaction/tool/booking sees the current gate. */
export async function dealerCustomerPolicy(
  dealerId: number,
  query: Pick<typeof db, "select"> = db,
  lock = false,
): Promise<DealerCustomerPolicy> {
  const statement = query.select({
    id: dealersTable.id,
    name: dealersTable.name,
    address: dealersTable.address,
    whatsappShowroomAddress: dealersTable.whatsappShowroomAddress,
    whatsappServiceAddress: dealersTable.whatsappServiceAddress,
    testDrivesEnabled: dealersTable.testDrivesEnabled,
  }).from(dealersTable).where(eq(dealersTable.id, dealerId));
  const [dealer] = await (lock ? statement.for("share") : statement);
  if (!dealer) throw new Error("Dealership customer policy not found");
  return {
    testDrivesEnabled: dealer.testDrivesEnabled,
    showroomAddress: resolveShowroomAddress(dealer),
    serviceAddress: dealer.whatsappServiceAddress?.trim() || null,
  };
}