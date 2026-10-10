"""Render the verified account setup result, without credentials or transactions."""
import csv, json
from pathlib import Path
from html import escape

p = Path("generated-artifacts/gt-coa")
result = json.loads((p / "erpnext-setup-result.json").read_text())
current = json.loads((p / "erpnext-current-accounts.json").read_text())
assert result["existingAccountsUnchanged"] and result["companyDefaultsUnchanged"]
assert all(a["verified"] for a in result["created"])
rows = []
for a in result["created"]:
    rows.append([a["account_number"], a["name"], "Created and verified", "No balance posted"])
for a in result["reused"]:
    rows.append([a["source_code"], a["existing_account"], "Existing account identified for reuse", a["note"]])
for a in result["held"]:
    rows.append([a["source_code"], a["source_name"], "Not created — on hold", a["reason"]])
with (p / "Verified-ERPNext-Account-Crosswalk.csv").open("w", newline="", encoding="utf-8-sig") as f:
    csv.writer(f).writerows([["Workflow code","ERPNext account / proposed account","Status","Notes"], *rows])
mapping = [
    ["Default warehouse","Stores - GA"],
    ["Income account — basic test only","4110 - Sales - GA"],
    ["Tax account","2030101 - VAT Output Tax Payable - GA"],
    ["Receivable account","1310 - Debtors - GA"],
    ["Settlement account — cash-only test","1010301 - Undeposited Funds - Cash Receipts - GA"],
    ["Cash payment mode","Cash"],
]
names = {a["name"] for a in current["accounts"]}
for _, name in mapping[1:5]:
    assert name in names
assert mapping[0][1] in {w["name"] for w in current["warehouses"] if not w["is_group"] and not w["disabled"]}

def table(headers, body):
    return "<table><thead><tr>"+"".join("<th>"+escape(h)+"</th>" for h in headers)+"</tr></thead><tbody>"+"".join("<tr>"+"".join("<td>"+escape(str(v))+"</td>" for v in r)+"</tr>" for r in body)+"</tbody></table>"

html = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GT AUTOMOTIVE — Verified Test Account Setup</title>
<style>body{font:15px/1.6 system-ui,sans-serif;color:#172b37;background:#f4f6f8;margin:0}main{max-width:1100px;margin:32px auto;padding:36px;background:white;border-radius:12px}h1{font-size:30px;line-height:1.2}h2{margin-top:32px}small{color:#566573}.status{padding:18px;background:#eaf6ee;border-left:4px solid #347d4e}.warning{padding:18px;background:#fff5df;border-left:4px solid #bc871d}table{border-collapse:collapse;width:100%;margin:16px 0;font-size:13px}th,td{text-align:left;vertical-align:top;padding:10px;border:1px solid #dbe2e8;overflow-wrap:anywhere}th{background:#edf2f5}tr:nth-child(even){background:#fafbfc}@media print{body{background:white}main{margin:0;padding:0}thead{display:table-header-group}tr{break-inside:avoid}}@media(max-width:640px){main{margin:0;padding:16px}table{font-size:11px}th,td{padding:5px}}</style><main>
<small>CAM Motors Dummy → GT AUTOMOTIVE • Test company • GYD</small>
<h1>Verified ERPNext account setup</h1>"""
html += f'<p>Completed: {escape(result["finishedAt"])} (UTC)<br>Site: {escape(result["site"])}</p>'
html += f'<div class="status"><strong>{len(result["created"])} accounts created and verified.</strong> {len(result["reused"])} existing accounts identified for reuse; {len(result["held"])} individual account definitions held. No pre-existing accounts or company defaults changed. No opening balances or transactions posted.</div>'
html += '<h2>AURA production mappings — not saved</h2><div class="warning">ERPNext API access does not grant an authenticated AURA session. These values still need to be saved under CAM Motors Dummy → Settings → ERPNext. Do not run Backfill. This is not a completed end-to-end integration test.</div>'
html += table(["Setting","Exact value for limited cash-only test"],mapping)
html += '<p>Only an agreed cash-only test may use this settlement default. AURA currently has one settlement-account mapping; payment-method names alone do not route each tender into separate clearing accounts. No tender-routing behavior was changed. Generic Sales does not replace model-specific GL mappings; no tax rate or exemption policy was configured.</p>'
html += '<h2>Account cross-reference</h2><p>Workflow codes and existing ERPNext codes are intentionally different where an existing account is reused. No renumbering was performed.</p>'
html += table(["Workflow code","ERPNext account / proposed account","Status","Notes"],rows)
html += '<h2>Remaining boundaries</h2><ul><li>The 19 account families in the review workbook remain unresolved; no guessed model, brand, salary, asset-class or suspense subaccounts were created.</li><li>Conditional VAT on deposits and foreign-currency setup remain on hold.</li><li>Creating the deposits and WIP accounts does not implement their posting workflows.</li><li>The ten workflows in the source document have not been validated end-to-end.</li><li>Historical balances, live-company defaults, payment-mode definitions, warehouse defaults and transactions were not modified.</li><li>Shipment BRD implementation remains outside this account setup.</li></ul></main></html>'
(p / "GT-Automotive-Test-Account-Setup.html").write_text(html)
print(f"Report verified: {len(rows)} account dispositions; exact proposed account/warehouse names checked against API read-back.")
