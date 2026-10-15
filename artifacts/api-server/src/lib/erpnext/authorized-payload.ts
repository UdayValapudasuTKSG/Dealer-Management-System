/**
 * Pure payload builders for Finance-authorized sales-finance postings. The
 * `AuthorizedPosting` value is produced ONLY by the guarded lookup in
 * sales-finance-requests (claimed request, pilot dealer, owned entity, no
 * hold) from the immutable approval snapshot — never from job payloads.
 */
export type AuthorizedPosting = {
  requestId: number;
  /** Approved request date (YYYY-MM-DD), trusted. */
  date: string;
  receivable: string;
  vatOutput: string | null;
  /** Income account for the specific invoice being posted, if any. */
  incomeAccount: string | null;
  paidTo: string | null;
  journalLines: { account: string; debit: number; credit: number; purpose: string }[];
};

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

export function authorizedPostingDate(auth: AuthorizedPosting | undefined, createdAt: Date): string {
  if (!auth) return createdAt.toISOString().slice(0, 10); // legacy behaviour unchanged
  if (!isDate(auth.date)) throw new Error(`Approved request date "${auth.date}" is not YYYY-MM-DD`);
  return auth.date;
}

/** Fields merged into an authorized Sales Invoice (vehicle or customer charge). */
export function authorizedSalesInvoiceFields(auth: AuthorizedPosting) {
  if (!auth.receivable) throw new Error("Approved snapshot has no receivables account; refusing to let ERPNext default debit_to");
  return { debit_to: auth.receivable, set_posting_time: 1, posting_date: authorizedPostingDate(auth, new Date(0)) };
}

/** Journal Entry rows for an authorized expense, each with the company cost center. */
export function authorizedJournalAccounts(auth: AuthorizedPosting, costCenter: string | null | undefined) {
  if (!costCenter || !costCenter.trim()) {
    throw new Error("ERPNext company has no default cost center; set Company.cost_center before expense journals can post");
  }
  if (auth.journalLines.length < 2) throw new Error("Approved snapshot has no balanced journal lines");
  return auth.journalLines.map((l) => ({
    account: l.account, debit_in_account_currency: l.debit, credit_in_account_currency: l.credit,
    cost_center: costCenter, user_remark: l.purpose,
  }));
}
