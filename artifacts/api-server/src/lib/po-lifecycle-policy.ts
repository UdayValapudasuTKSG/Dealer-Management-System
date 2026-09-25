export type ReviewAction = "submit" | "approve" | "return" | "cancel";
export function nextPoStatus(status: string, action: ReviewAction, creator: number | null, actor: number, override = false) {
  if (action === "submit" && status === "draft") return "pending_review";
  if (action === "cancel" && ["draft", "pending_review", "approved"].includes(status)) return "cancelled";
  if (status === "pending_review" && ["approve", "return"].includes(action)) {
    if (creator === actor && !override) throw new Error("The creator cannot review their own PO without Parts admin override");
    return action === "approve" ? "approved" : "draft";
  }
  throw new Error(`Cannot ${action} a ${status} purchase order`);
}
export function canEmailPo(status: string, resend: boolean, previouslySent = false) {
  return resend ? (status === "sent" || (previouslySent && ["ordered", "partially_received", "received"].includes(status))) : status === "approved";
}