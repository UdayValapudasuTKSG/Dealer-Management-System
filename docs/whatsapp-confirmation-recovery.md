# WhatsApp confirmation recovery — production evidence

Checked 2026-09-16. No production writes, template changes, or customer sends were performed.

## Confirmed rejection

Dealer 1, RO 00118, outbox 13902022 remains failed after three recorded attempts, without provider ID, sent timestamp, delivered timestamp, or read timestamp. Its stable key is `svc:118:appointment-confirmed:1789650000000`.

The production log at 2026-09-16T02:59:12.543Z records HTTP 404, Meta code 132001: the `service_appointment_confirmed` template was unavailable in `en`. Provider trace: `AqxgNC0SYRf9RMOktVXSgxi`. This establishes a template lookup rejection, not a broken Graph endpoint or universally invalid sender.

Recent production rows also contain 37 ordinary-message 404 failures alongside delivered/read messages. Historical provider logs for those failures were unavailable in the queried interval; their underlying Meta codes have not been established and must not be assumed identical.

## Current read-only Meta evidence

- Dealer channel enabled; phone CONNECTED and CLOUD_API.
- Token can read the phone, WABA and templates; sender belongs to the WABA.
- Template `service_appointment_confirmed`, language `en`, currently APPROVED.
- Header matches, one body component, eight unique parameters.
- Expected parameter occurrences: `[1,2,3,4,5,6,7,8]`; live occurrences: `[1,2,3,4,5,6,7,8]`.
- The approved body uses labelled lines and closes with `Thank you. We look forward to welcoming you for your vehicle care.` The app now uses that exact copy.
- Development sender comparison was inaccessible; no environment equivalence is claimed.

The original rejection and current approval describe different observation times. There is insufficient evidence to establish when the template became available.

## Recovery after deployment

The application readiness checks now match the currently approved template and
will permit delivery only after the deployed code performs a fresh read-only
diagnostic. A timeout, HTTP 429, or HTTP 5xx while reading Meta is treated as a
temporary preflight failure: the worker backs off the same deduped row without
consuming the authorized provider handoff. A successful read that finds a
missing, unapproved, or mismatched template remains a terminal configuration
failure. No production send has been performed as part of this comparison.

After deploying the verified code, rerun the GET-only diagnostic, revalidate
the appointment and contact, then use the authenticated one-time retry in the
service confirmation workflow. Do not reset SQL queue rows or send directly to
Meta.

RO 00118 was acknowledged and dated 2026-09-17 at inspection. This alone does not authorize replay later: the retry and worker must revalidate the full current schedule and eligibility.

Only a persisted provider acceptance ID establishes acceptance; delivery/read require receipts. No recovered acceptance or receipt is claimed.

The retry rebuilds the saved customer-visible transcript from the validated
original body parameters, so a legacy failed row does not replay the old
closing copy.

## Verification

API and AURA typechecks, template contract, mocked diagnostics, retry safety
(including concurrent/sequential retries and uncertainty), and the worker's
mocked transient-preflight coverage must pass before deployment. No independent
code-review approval, workflow restart, or live send is claimed by this
document.