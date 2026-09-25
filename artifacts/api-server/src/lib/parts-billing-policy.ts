export function assertBillableRequisition(req: {
  serviceOrderId: number | null; jobCardId: number | null; collisionClaimId: number | null; status: string;
}) {
  if (!req.serviceOrderId || !req.jobCardId) throw Object.assign(new Error("Internal inventory restock is not customer-billable."), { status: 422 });
  if (req.collisionClaimId) throw Object.assign(new Error("Collision requisitions must use the insurer-approved service invoice."), { status: 422 });
  if (req.status !== "fulfilled") throw Object.assign(new Error("Fulfill this customer requisition before invoicing its parts."), { status: 422 });
}

export function assertBillingCustomer(expectedId: number | null, actualId: number | null | undefined) {
  if (!expectedId || actualId !== expectedId) {
    throw Object.assign(new Error("Special-order customer does not own the linked repair order."), { status: 422 });
  }
}