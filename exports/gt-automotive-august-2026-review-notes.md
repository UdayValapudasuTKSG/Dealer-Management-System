# GT Automotive — August arrival batch review

This approved CSV is for Deliveries → Import reviewed history after publishing the new workflow. Do not edit or resave the CSV: the importer verifies the exact approved file. It is not compatible with the Inventory importer. No production records were modified and no messages were sent. Suppression is enforced by the new workflow, not by a CSV value alone.

## Scope

- Dealership: GT Automotive, dealer ID 1.
- Ten source rows; arrival date 12 August 2026. This is not a customer handover date or vehicle model year.
- Source status: Delivered for all ten. Preserve this raw historical assertion as provenance only; the target is an ordinary pending/in-progress delivery workflow, not a completed historical handover.
- Preserve engine numbers exactly, including their internal space.
- Blank fields mean unknown/not supplied, not zero, false or permission to erase existing data.
- `Source LOU AMT GYD` is confirmed to be the full quoted vehicle selling price. It must be used for the linked full-price invoice, but it is not evidence of payment.
- The one source deposit is provenance metadata only. Do not create a payment, receipt, deposit allocation, or paid flag from it.

## Read-only production matching

- No matching vehicle VINs, including deleted inventory rows.
- No matching customers found using supplied names, name fragments, the supplied email and the two possible phone numbers. Similar-name people were not treated as matches.
- Euyette Cameron has an exact-name lead candidate, ID 8383, currently in proposal and assigned to Joublon Beaton. It has no customer link and placeholder-looking contact information. Confirm it is the same person before updating; do not create a second lead.
- No other matching leads were found.
- No matching deals or deliveries were found. No deal is linked to lead 8383.
- Advisors: Sheri Rodrigues (208), Joublon Beaton (206), and Eion's active account (200). Eion's account display name is an email, while existing lead assignments also use Eion Narine.
- Name-only absence is not proof a differently named record does not exist. Recheck matching in the live application immediately before applying anything. Never merge by surname alone.

## Proposed handling after review

- Create missing physical vehicle records only after rechecking normalized VIN uniqueness within this dealership.
- Match inventory by normalized VIN only and link a lead only by an explicitly confirmed ID. Never auto-merge a customer by name; missing customers may be created with only supplied legitimate fields.
- For missing customers, create only with legitimate supplied data. Never manufacture email addresses or phone numbers.
- Create missing pipeline leads as Won/converted confirmed sales; keep delivery workflows pending. Reuse eligible existing leads, customers and committed deals only after explicit identity confirmation. Conflicting or paid finance records block the import rather than being overwritten.
- Create a committed deal and pending ordinary delivery workflow with normal PDI, registration, insurance, invoice, appointment, handover and warranty steps. Do not set an appointment or handover date from the arrival date.
- Preserve the joint customer name in row 4 until the primary buyer/co-buyer structure is confirmed.
- Treat 625-1891 and 610-9487 as source Notes. Proposed Guyana phone normalization is shown separately and requires confirmation.

## Applying in the live app

Publish the updated app and its additive import-metadata schema first. As GT Automotive's General Manager, open Deliveries → Import reviewed history, upload this exact CSV, and supply the actual model year, make, powertrain and body type. Review all ten rows and explicitly confirm the existing lead candidate only if it is the correct person. Apply is blocked if live records conflict.

The action creates pending delivery workflows and full-price settlement invoices with no recorded payments. Arrival/interior/source facts are retained as import metadata. Staff can use the existing handover and warranty document actions and proceed through the ordinary steps. Customer delivery communications stay suppressed; unrelated communications are unaffected. Finance must enter the actual payments before final handover can pass its settlement gate.

The review contains personal customer information; share only with authorized dealership staff.