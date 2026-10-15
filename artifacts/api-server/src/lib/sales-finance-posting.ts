import { registerErpnextSyncHandler } from "./erpnext/sync";
import { postAuthorizedJournal, postAuthorizedPaymentEntry, postAuthorizedSalesInvoice } from "./erpnext/entities";
import { executeRequestPosting, SALES_FINANCE_DOCTYPE, type SalesFinanceRemote } from "./sales-finance-requests";

export const defaultSalesFinanceRemote: SalesFinanceRemote = {
  postInvoice: postAuthorizedSalesInvoice,
  postPayment: postAuthorizedPaymentEntry,
  postJournal: postAuthorizedJournal,
};

let registered = false;
export function registerSalesFinancePosting(): void {
  if (registered) return;
  registered = true;
  registerErpnextSyncHandler(SALES_FINANCE_DOCTYPE, (job) => executeRequestPosting(job, defaultSalesFinanceRemote));
}
