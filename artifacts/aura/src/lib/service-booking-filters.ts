import type { ServiceOrder } from "@workspace/api-client-react";

export type ServiceBookingFilters = {
  search: string;
  status: string;
  serviceType: string;
};

export const emptyServiceBookingFilters: ServiceBookingFilters = {
  search: "",
  status: "all",
  serviceType: "all",
};

function normalized(value: unknown) {
  return String(value ?? "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function compact(value: unknown) {
  return normalized(value).replace(/[^a-z0-9]/g, "");
}

export function hasServiceBookingFilters(filters: ServiceBookingFilters) {
  return Boolean(
    filters.search.trim() ||
      filters.status !== "all" ||
      filters.serviceType !== "all",
  );
}

export function filterServiceBookings(
  orders: readonly ServiceOrder[],
  filters: ServiceBookingFilters,
) {
  const query = normalized(filters.search);
  const compactQuery = compact(filters.search);

  return orders.filter((order) => {
    if (filters.status !== "all" && order.status !== filters.status) return false;
    if (filters.serviceType !== "all" && order.type !== filters.serviceType) return false;
    if (!query) return true;

    const repairOrder = `RO ${order.id.toString().padStart(5, "0")}`;
    const searchable = [
      repairOrder,
      order.id,
      order.customerName,
      order.customerEmail,
      order.customerPhoneSnapshot,
      order.vehicleInfo,
      order.vin,
      order.registrationNumber,
      order.complaint,
      ...(order.jobs ?? []),
      order.technician,
    ];
    const text = searchable.map(normalized).join(" ");
    const compactText = searchable.map(compact).join(" ");

    return text.includes(query) || Boolean(compactQuery && compactText.includes(compactQuery));
  });
}