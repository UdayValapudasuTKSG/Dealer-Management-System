import { and, eq } from "drizzle-orm";
import {
  db,
  dealsTable,
  customersTable,
  invoicesTable,
  leadsTable,
  usersTable,
  vehiclesTable,
  type Delivery,
  type Vehicle,
} from "@workspace/db";
import { resolveDeliveryOwnerContact } from "./delivery-owner-contact";
import { formatDealerDate } from "./timezone";

export type HandoverFieldKey =
  | "customerName"
  | "customerAddress"
  | "customerEmail"
  | "customerPhone"
  | "registrationNumber"
  | "insuranceProvider"
  | "insurancePolicy"
  | "salesperson"
  | "date"
  | "invoiceNumber"
  | "make"
  | "model"
  | "vin"
  | "mileage"
  | "keyNumber"
  | "stockNumber";

export type HandoverFieldValues = Record<HandoverFieldKey, string>;

export interface ResolvedHandoverData {
  vehicle: Vehicle | undefined;
  advisorName: string | null;
  ownerContact: ReturnType<typeof resolveDeliveryOwnerContact>;
  invoiceNumber: string | null;
  suppressAutoHandoverDate: boolean;
  mileageKnown: boolean;
  /** System values with non-empty stored overrides applied. */
  values: HandoverFieldValues;
}

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function overrideOrFallback(
  override: string | undefined,
  fallback: string | null | undefined,
): string {
  return nonEmpty(override) ?? nonEmpty(fallback) ?? "";
}

function fullHandoverDate(
  value: Date | string | null | undefined,
  tz: string,
): string {
  if (!value) return "";
  const short = formatDealerDate(value, tz);
  return short.replace(
    /^([A-Z][a-z]{2}) /,
    (prefix) =>
      ({
        Jan: "January ",
        Feb: "February ",
        Mar: "March ",
        Apr: "April ",
        May: "May ",
        Jun: "June ",
        Jul: "July ",
        Aug: "August ",
        Sep: "September ",
        Oct: "October ",
        Nov: "November ",
        Dec: "December ",
      })[prefix.trim()] ?? prefix,
  );
}

export function resolveHandoverFieldValues(
  delivery: Delivery,
  vehicle: Vehicle | undefined,
  advisorName: string | null,
  salesAdvisorName: string | null,
  ownerContact: ReturnType<typeof resolveDeliveryOwnerContact>,
  invoiceNumber: string | null,
  tz: string,
  now = new Date(),
): {
  values: HandoverFieldValues;
  suppressAutoHandoverDate: boolean;
  mileageKnown: boolean;
} {
  const importProvenance = delivery.importMetadata as Record<string, unknown> | null;
  const suppressAutoHandoverDate =
    importProvenance?.kind === "reviewed_delivery_history";
  const mileageKnown = importProvenance?.mileageKnown !== false;
  const systemDate = suppressAutoHandoverDate
    ? delivery.deliveredAt
      ? fullHandoverDate(delivery.deliveredAt, tz)
      : ""
    : fullHandoverDate(
        delivery.deliveredAt ?? delivery.appointmentAt ?? now,
        tz,
      );
  const overrides = delivery.handoverOverrides ?? {};
  const values: HandoverFieldValues = {
    customerName: nonEmpty(delivery.customerName) ?? ownerContact.name ?? "",
    customerAddress: overrideOrFallback(
      overrides.customerAddress,
      ownerContact.address,
    ),
    customerEmail: overrideOrFallback(overrides.customerEmail, ownerContact.email),
    customerPhone: overrideOrFallback(overrides.customerPhone, ownerContact.phone),
    registrationNumber:
      nonEmpty(delivery.registrationNumber) ??
      nonEmpty(vehicle?.registration) ??
      "",
    insuranceProvider: nonEmpty(delivery.insuranceProvider) ?? "",
    insurancePolicy: nonEmpty(delivery.insurancePolicy) ?? "",
    salesperson: overrideOrFallback(
      overrides.salesperson,
      nonEmpty(salesAdvisorName) ?? advisorName,
    ),
    date: overrideOrFallback(overrides.date, systemDate),
    invoiceNumber: overrideOrFallback(overrides.invoiceNumber, invoiceNumber),
    make: overrideOrFallback(overrides.make, vehicle?.make),
    model: overrideOrFallback(overrides.model, vehicle?.model),
    vin: overrideOrFallback(overrides.vin, vehicle?.vin),
    mileage: overrideOrFallback(
      overrides.mileage,
      mileageKnown && vehicle?.mileageKm != null
        ? `${vehicle.mileageKm.toLocaleString("en-US")} km`
        : "",
    ),
    keyNumber: overrideOrFallback(overrides.keyNumber, ""),
    stockNumber: overrideOrFallback(
      overrides.stockNumber,
      vehicle ? `V-${String(vehicle.id).padStart(5, "0")}` : "",
    ),
  };
  return { values, suppressAutoHandoverDate, mileageKnown };
}

/**
 * Resolve every value printed by the handover form from the same records used
 * by the PDF route. Empty overrides deliberately fall through to these values:
 * PATCH treats an empty value as "clear this override".
 */
export async function resolveHandoverData(
  delivery: Delivery,
  dealerId: number,
  tz: string,
): Promise<ResolvedHandoverData> {
  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, delivery.vehicleId),
        eq(vehiclesTable.dealerId, dealerId),
      ),
    );

  let advisorName: string | null = null;
  if (delivery.advisorUserId) {
    const [advisor] = await db
      .select({ name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, delivery.advisorUserId));
    advisorName = advisor?.name ?? advisor?.email ?? null;
  }

  const [deal] = await db
    .select({
      salesAdvisor: dealsTable.salesAdvisor,
      customerId: dealsTable.customerId,
      leadId: dealsTable.leadId,
    })
    .from(dealsTable)
    .where(
      and(eq(dealsTable.id, delivery.dealId), eq(dealsTable.dealerId, dealerId)),
    );
  const handoverCustomerId = delivery.customerId ?? deal?.customerId ?? null;
  const [customer] = handoverCustomerId
    ? await db
        .select({
          name: customersTable.name,
          email: customersTable.email,
          phone: customersTable.phone,
          address: customersTable.address,
          location: customersTable.location,
          city: customersTable.city,
          country: customersTable.country,
        })
        .from(customersTable)
        .where(
          and(
            eq(customersTable.id, handoverCustomerId),
            eq(customersTable.dealerId, dealerId),
          ),
        )
    : [];
  const [lead] = deal?.leadId
    ? await db
        .select({
          name: leadsTable.name,
          email: leadsTable.email,
          phone: leadsTable.phone,
          address: leadsTable.address,
        })
        .from(leadsTable)
        .where(
          and(eq(leadsTable.id, deal.leadId), eq(leadsTable.dealerId, dealerId)),
        )
    : [];
  const ownerContact = resolveDeliveryOwnerContact(customer, lead);

  let invoiceNumber: string | null = null;
  if (delivery.invoiceId) {
    const [invoice] = await db
      .select({ invoiceNumber: invoicesTable.invoiceNumber })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.id, delivery.invoiceId),
          eq(invoicesTable.dealerId, dealerId),
        ),
      );
    invoiceNumber = invoice?.invoiceNumber ?? null;
  }

  const {
    values,
    suppressAutoHandoverDate,
    mileageKnown,
  } = resolveHandoverFieldValues(
    delivery,
    vehicle,
    advisorName,
    deal?.salesAdvisor ?? null,
    ownerContact,
    invoiceNumber,
    tz,
  );

  return {
    vehicle,
    advisorName,
    ownerContact,
    invoiceNumber,
    suppressAutoHandoverDate,
    mileageKnown,
    values,
  };
}