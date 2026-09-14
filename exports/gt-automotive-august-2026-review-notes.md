# GT Automotive — August arrival batch review

This is a review worksheet, not an executable import or a file compatible with the existing Inventory importer. No production records were modified and no messages were sent. `SUPPRESS` documents a requirement; putting this value in a CSV does not disable application email delivery.

## Scope

- Dealership: GT Automotive, dealer ID 1.
- Ten source rows; arrival date 12 August 2026. This is not a customer handover date or vehicle model year.
- Source status: Delivered for all ten. Preserve this historical assertion without fabricating inspection sign-offs, signatures, delivery dates, invoices or payment receipts.
- Preserve engine numbers exactly, including their internal space.
- Blank fields mean unknown/not supplied, not zero, false or permission to erase existing data.
- Do not infer vehicle selling prices from the LOU amounts. Values are retained under their apparent pasted column headings pending confirmation.

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
- Reuse confirmed customer/lead/deal matches; preserve existing values where this source is blank.
- For missing customers, create only with legitimate supplied data. Never manufacture email addresses or phone numbers.
- Confirm whether historical delivered sales should create closed historical pipeline entries or only customer/deal/delivery records. Do not create active sales follow-ups for already-delivered customers.
- Preserve the joint customer name in row 4 until the primary buyer/co-buyer structure is confirmed.
- Treat 625-1891 and 610-9487 as source Notes. Proposed Guyana phone normalization is shown separately and requires confirmation.

## Requirements before a safe live application

Production currently has no arrival-date/batch columns or dedicated interior-color column. The current vehicle-only importer cannot apply this complete customer/pipeline/delivery history. Do not upload this worksheet to it.

A user-applied historical import needs a dry-run review, transactional/idempotent matching, arrival metadata, explicit historical-delivery handling, and a no-communications path. That path must bypass customer email, WhatsApp/SMS and deferred follow-up/report triggers for imported history, not merely omit email addresses or temporarily stop a worker. Existing unrelated live communication must remain unaffected.

The review contains personal customer information; share only with authorized dealership staff.