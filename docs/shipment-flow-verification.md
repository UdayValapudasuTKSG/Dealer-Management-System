# Shipment flow verification and release boundary

## Executed checks

- Workspace typecheck passed after the initial implementation; backend typecheck
  passed again after the final safety changes.
- Eleven shipment rule tests passed, including dealer-local ETA boundaries.
- Browser checks passed for catalogue create/approve, shipment/line persistence,
  partial row import, duplicate rejection, desktop/mobile rendering, no-lease
  write refusal, unauthenticated refusal and cross-dealer 404.
- Concurrent development API requests for one remaining unit returned one 201
  and one 409; tracking showed one allocation and a withheld initial email.
  The test allocation was released and synthetic leads soft-deleted afterwards.
- Rollback-only development claim tests passed: unpaid refusal, recall refusal,
  specification mismatch refusal, paid hold through the existing ledger with
  invoice provenance, duplicate refusal, and foreign-dealer refusal. All claim
  test records were rolled back.
- Final API restart/build succeeded and the Shipments screen rendered.
- Not exercised: distinct-second-user browser lease session; a full real-factory
  manifest-to-delivery browser journey; actual customer email delivery (not
  connected); production schema application/publication.

The following is a broader checklist, not a statement that every test has passed.
Use the supplied revised shipment BRD and manager-maintained catalogue decision.
Do not use the separate ERP accounting fixtures as operational shipment VINs.

## Required evidence

1. **Catalogue**: unapproved specifications cannot be allocated; approval
   is restricted to authorised managers. Exact matching includes interior colour.
   Explicit “not applicable” is a real value, not a wildcard.
2. **Capacity**: two simultaneous claims for one available unit yield exactly one
   success. Retrying a confirmed operation does not consume capacity twice.
3. **Tenant and role boundaries**: reads, imports, mutations, error exports and
   notification histories cannot expose or change another dealer's records.
4. **Editor leases**: another editor sees a read-only view with holder/expiry;
   expired leases are reclaimable. Server writes reject stale lease ownership,
   even if the browser still displays an editable form.
5. **Allocation**: preserve sales stage, baseline ETA and original priority.
   Reassignment is all-or-nothing; failed target validation keeps the old place.
6. **Imports**: preview is non-mutating. Confirmation accepts valid rows and
   reports invalid row numbers/reasons. Re-upload cannot duplicate shipment
   capacity, VINs, claims or notifications. Escape spreadsheet formula cells
   in downloadable error exports.
7. **Matching**: oldest eligible demand takes priority within exact specification
   groups. Randomness distributes VIN identities only. Persist proposal results;
   retries must not reshuffle winners. Whole-line quantity requests cannot be
   silently split or leapfrogged by smaller, newer requests.
8. **Physical claim boundary**: confirmation must use the established claim
   authority and shared locking with reservation/deal commitment. A proposal is
   not itself a hold. Existing held, sold or committed vehicles must remain with
   their claimant. No placeholder VINs or guessed stock attributes.
9. **Notifications**: initial allocation, effective ETA revisions, supersession
   and failures have visible outcomes. Queued/withheld is never labelled sent.
   Real delivery is off during development/UAT; no live customer contact.
10. **Persistence**: completed writes survive reload; a second browser sees
    changes. Forms show server errors and do not pretend a failed save succeeded.

## Release prerequisites

- Explain exact implemented ETA threshold, partial-fulfilment policy and
  pre-book prerequisites to the business owner.
- Confirm approved catalogue contents and customer wording.
- Review tracked additive migrations and historical reconciliation separately.
- No automatic historical backfill or existing hold reassignment.
- Test finance/PDI/registration/handover gates remain authoritative.
- Record which checks passed and which are blocked; do not describe a partial
  implementation as the full shipment workflow.
