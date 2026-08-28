import { and, desc, eq } from "drizzle-orm";
import {
  db,
  deliveriesTable,
  dealsTable,
  dealersTable,
  leadsTable,
  vehiclesTable,
  customersTable,
  invoicesTable,
  paymentsTable,
} from "@workspace/db";
import { getDealerPdfBranding } from "./dealer-branding";
import { buildWarrantyPdf } from "./warranty-pdf";
import { resolveDeliveryOwnerContact } from "./delivery-owner-contact";
import { dealerTimezone, formatDealerDate } from "./timezone";

/**
 * Assembles the autofilled BYD warranty booklet for a delivery. Shared by the
 * download route (GET /deliveries/:id/warranty.pdf) and the outbound email
 * queue ("warranty.document" attachments), so both always render the same
 * document.
 */
export async function buildWarrantyBookletForDelivery(
  deliveryId: number,
  dealerId: number,
): Promise<{
  pdf: Buffer;
  ownerName: string | null;
  ownerEmail: string | null;
  vehicleLabel: string | null;
} | null> {
  const [delivery] = await db
    .select()
    .from(deliveriesTable)
    .where(
      and(
        eq(deliveriesTable.id, deliveryId),
        eq(deliveriesTable.dealerId, dealerId),
      ),
    );
  if (!delivery) return null;
  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, delivery.vehicleId),
        eq(vehiclesTable.dealerId, delivery.dealerId),
      ),
    );
  // Owner details: prefer the delivery's linked customer, then the deal's
  // customer, then the deal's lead — many deals only carry a lead record.
  let warrantyCustomerId = delivery.customerId;
  let warrantyLeadId: number | null = null;
  {
    const [deal] = await db
      .select({
        customerId: dealsTable.customerId,
        leadId: dealsTable.leadId,
      })
      .from(dealsTable)
      .where(
        and(
          eq(dealsTable.id, delivery.dealId),
          eq(dealsTable.dealerId, delivery.dealerId),
        ),
      );
    warrantyCustomerId = warrantyCustomerId ?? deal?.customerId ?? null;
    warrantyLeadId = deal?.leadId ?? null;
  }
  const [customer] = warrantyCustomerId
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
            eq(customersTable.id, warrantyCustomerId),
            eq(customersTable.dealerId, delivery.dealerId),
          ),
        )
    : [];
  const [dealer] = await db
    .select({
      name: dealersTable.name,
      city: dealersTable.city,
      country: dealersTable.country,
      address: dealersTable.address,
      servicePhone: dealersTable.servicePhone,
      emergencyPhone: dealersTable.emergencyPhone,
    })
    .from(dealersTable)
    .where(eq(dealersTable.id, delivery.dealerId));
  // Lead fallback for owner contact details — many deals carry only a lead.
  const [lead] =
    warrantyLeadId
      ? await db
          .select({
            name: leadsTable.name,
            email: leadsTable.email,
            phone: leadsTable.phone,
            address: leadsTable.address,
          })
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.id, warrantyLeadId),
              eq(leadsTable.dealerId, delivery.dealerId),
            ),
          )
      : [];
  let invoiceNumber: string | null = null;
  // Date of sale = the day the final payment settled the invoice.
  let dateOfSale: Date | null = null;
  if (delivery.invoiceId) {
    const [inv] = await db
      .select({
        invoiceNumber: invoicesTable.invoiceNumber,
        status: invoicesTable.status,
      })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.id, delivery.invoiceId),
          eq(invoicesTable.dealerId, delivery.dealerId),
        ),
      );
    invoiceNumber = inv?.invoiceNumber ?? null;
    if (inv?.status === "paid") {
      const [lastPayment] = await db
        .select({ createdAt: paymentsTable.createdAt })
        .from(paymentsTable)
        .where(
          and(
            eq(paymentsTable.invoiceId, delivery.invoiceId),
            eq(paymentsTable.dealerId, delivery.dealerId),
          ),
        )
        .orderBy(desc(paymentsTable.createdAt))
        .limit(1);
      dateOfSale = lastPayment?.createdAt ?? null;
    }
  }
  const branding = await getDealerPdfBranding(delivery.dealerId);
  const tz = await dealerTimezone(delivery.dealerId);
  const fmt = (d: Date | null | undefined) =>
    d ? formatDealerDate(d, tz) : null;
  const ownerContact = resolveDeliveryOwnerContact(customer, lead);
  const address = ownerContact.address;
  const ownerPhone = ownerContact.phone;
  const ownerName = customer?.name ?? delivery.customerName ?? lead?.name ?? null;
  const ownerEmail = ownerContact.email;
  const pdf = await buildWarrantyPdf({
    ownerName,
    ownerEmail,
    ownerAddressContact:
      [address, ownerPhone].filter(Boolean).join(" · ") || null,
    vehicleModel: vehicle ? `${vehicle.make} ${vehicle.model}` : null,
    color: vehicle?.exteriorColor,
    // Odometer reading at delivery is recorded by hand during handover.
    odometer: null,
    manufactureYear: vehicle?.year ? String(vehicle.year) : null,
    vin: vehicle?.vin,
    motorNumber: vehicle?.engineNumber,
    dealerName: branding.displayName ?? dealer?.name ?? null,
    servicePhone: dealer?.servicePhone,
    emergencyContact: dealer?.emergencyPhone,
    dealerAddress:
      dealer?.address ??
      ([dealer?.city, dealer?.country].filter(Boolean).join(", ") || null),
    dateOfSale: fmt(dateOfSale),
    invoiceNumber,
    // Warranty is completed AFTER Vehicle Delivery, so the recorded handover
    // date autofills here; the appointment date is only a pre-handover
    // fallback.
    dateOfDelivery: fmt(delivery.deliveredAt ?? delivery.appointmentAt),
    // The Customer Signature step precedes Warranty — fall back to that
    // signature so downloads/emails always carry the customer's signature.
    signatureDataUrl: delivery.warrantySignatureData ?? delivery.signatureData,
  });
  return {
    pdf,
    ownerName,
    ownerEmail,
    vehicleLabel: vehicle
      ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
      : null,
  };
}
