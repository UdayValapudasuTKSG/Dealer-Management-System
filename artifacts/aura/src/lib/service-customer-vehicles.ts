import type { ServiceCustomerVehicle } from "@workspace/api-client-react";

export type ServiceVehicleFields = {
  vehicleInfo: string;
  vin: string;
  registrationNumber: string;
};

export function serviceVehicleLabel(vehicle: ServiceCustomerVehicle): string {
  return vehicle.label || `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
}

export function serviceVehicleFields(
  vehicle: ServiceCustomerVehicle,
): ServiceVehicleFields {
  return {
    vehicleInfo: serviceVehicleLabel(vehicle),
    vin: vehicle.vin ?? "",
    registrationNumber: vehicle.registration ?? "",
  };
}

export function shouldAutofillServiceVehicleField(
  dirtyFields: ReadonlySet<string>,
  field: string,
): boolean {
  return !dirtyFields.has(field);
}

export function isCurrentServiceVehicleLookup(input: {
  dialogOpen: boolean;
  activeCustomerId: number | null;
  responseCustomerId: number;
}): boolean {
  return (
    input.dialogOpen &&
    input.activeCustomerId != null &&
    input.activeCustomerId === input.responseCustomerId
  );
}

function normalizedIdentity(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Select a saved vehicle only when its canonical VIN or registration matches
 * the booking. This intentionally never picks the first vehicle from a
 * customer's garage when there are several.
 */
export function matchServiceCustomerVehicle(
  vehicles: ServiceCustomerVehicle[] | undefined,
  identity: Pick<ServiceVehicleFields, "vin" | "registrationNumber">,
): ServiceCustomerVehicle | null {
  if (!vehicles?.length) return null;
  const vin = normalizedIdentity(identity.vin);
  const registration = normalizedIdentity(identity.registrationNumber);
  if (vin) {
    const byVin = vehicles.find((vehicle) => normalizedIdentity(vehicle.vin) === vin);
    if (byVin) return byVin;
  }
  if (registration) {
    const byRegistration = vehicles.find(
      (vehicle) => normalizedIdentity(vehicle.registration) === registration,
    );
    if (byRegistration) return byRegistration;
  }
  return null;
}

/**
 * A single canonical association is safe to preselect. A customer with
 * several vehicles must provide a VIN/registration match or choose explicitly
 * in the form; this function deliberately does not use array order as a
 * fallback for multiple vehicles.
 */
export function selectServiceCustomerVehicle(
  vehicles: ServiceCustomerVehicle[] | undefined,
  identity: Pick<ServiceVehicleFields, "vin" | "registrationNumber">,
): ServiceCustomerVehicle | null {
  const matching = matchServiceCustomerVehicle(vehicles, identity);
  if (matching) return matching;
  return vehicles?.length === 1 ? vehicles[0] : null;
}
