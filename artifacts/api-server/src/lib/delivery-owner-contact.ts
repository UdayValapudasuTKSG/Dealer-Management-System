export interface DeliveryOwnerContactSource {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  location?: string | null;
  city?: string | null;
  country?: string | null;
}

export interface DeliveryOwnerContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function locality(
  city: string | null | undefined,
  country: string | null | undefined,
): string | null {
  const values = [nonEmpty(city), nonEmpty(country)].filter(
    (value): value is string => value !== null,
  );
  const distinct = values.filter(
    (value, index) =>
      values.findIndex(
        (candidate) => candidate.toLowerCase() === value.toLowerCase(),
      ) === index,
  );
  return distinct.length > 0 ? distinct.join(", ") : null;
}

/**
 * Resolves one field at a time so a partially populated customer record does
 * not hide richer contact details still stored on the originating lead.
 */
export function resolveDeliveryOwnerContact(
  customer: DeliveryOwnerContactSource | null | undefined,
  lead: DeliveryOwnerContactSource | null | undefined,
): DeliveryOwnerContact {
  return {
    name: nonEmpty(customer?.name) ?? nonEmpty(lead?.name),
    email: nonEmpty(customer?.email) ?? nonEmpty(lead?.email),
    phone: nonEmpty(customer?.phone) ?? nonEmpty(lead?.phone),
    address:
      nonEmpty(customer?.address) ??
      nonEmpty(customer?.location) ??
      locality(customer?.city, customer?.country) ??
      nonEmpty(lead?.address),
  };
}