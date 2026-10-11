"""Produce a self-contained, clearly labelled report of the actual fixture run."""
from pathlib import Path
import json
from html import escape

p = Path("generated-artifacts/erpnext-sales-fixture")
r = json.loads((p / "verified.json").read_text())
def table(headers, rows):
    return "<table><tr>" + "".join("<th>"+escape(h)+"</th>" for h in headers) + "</tr>" + "".join("<tr>"+"".join("<td>"+escape(str(c))+"</td>" for c in row)+"</tr>" for row in rows)+"</table>"
html = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated ERPNext sales verification</title>
<style>body{font:16px/1.6 system-ui;background:#f3f5f7;color:#172b37}main{max-width:980px;margin:24px auto;padding:28px;background:white}h1{line-height:1.2}table{border-collapse:collapse;width:100%;margin:18px 0;font-size:14px}th,td{padding:10px;border:1px solid #ccd5dd;text-align:left}th{background:#edf2f5}.note{padding:16px;background:#fff0ce}.ok{padding:16px;background:#e5f4e9}code{overflow-wrap:anywhere}@media print{main{margin:0;padding:0}tr{break-inside:avoid}}</style><main>
<h1>Isolated vehicle-sales accounting test</h1>
<p><strong>GT AUTOMOTIVE — test company only.</strong> All amounts below are GYD and are artificial test values, not customer transactions.</p>
<div class="note"><strong>AURA integration is not implemented by this test.</strong> The fixture script posted these labelled transactions directly to ERPNext. AURA's production posting handlers, settings and existing queue were not changed. Do not treat this result as validation of the current AURA production flow.</div>"""
html += "<p>Fixture: <code>"+escape(r["marker"])+"</code><br>Verified at: "+escape(r["verifiedAt"])+"</p>"
html += table(["Test input","GYD"],[["Vehicle cost","3,500,000"],["Selling price excluding VAT","5,000,000"],["Illustrative VAT at delivery (14%)","700,000"],["Final invoice","5,700,000"],["Advance","500,000"],["Balance payment","5,200,000"]])
html += '<div class="ok">Verified from ERPNext: every fixture voucher balances; final customer receivable, deposits, clearing, sample stock quantity and inventory value are zero. Revenue is GYD 5,000,000; cost of sales GYD 3,500,000; VAT payable GYD 700,000; operating-bank increase GYD 5,700,000.</div>'
html += "<h2>Created / reused fixture records</h2>"+table(["Step","ERPNext reference"],[[d["step"],d["name"]] for d in r["documents"]])
html += "<h2>Net GL effects of these fixtures only</h2>"+table(["Account","Debit less credit (GYD)"],[[a,f"{v:,.2f}"] for a,v in r["netBalances"].items()])
html += """<h2>Changes and boundaries</h2><ul>
<li>One labelled sample VIN was received and sold through ERPNext perpetual inventory.</li>
<li>A sample opening-stock receipt credits opening-balance equity by GYD 3,500,000. This is artificial fixture equity, not a migration of real stock.</li>
<li>Serial/batch capability was enabled in Stock Settings after confirming the site contained only the authorised test company. Negative-stock protections were not relaxed.</li>
<li>The site's compliance extension required an HSN code. The sample electric vehicle uses the existing 870380 heading; this is not approval of live tax or customs classifications.</li>
<li>No real vehicle, existing transaction, AURA record, connection mapping or queued sync job was altered by this script.</li>
<li>The dummy VAT-at-delivery policy and illustrative rate do not establish live tax treatment.</li>
<li>Discounts, finance, trade-ins, partial/multiple deliveries, returns, card fees, and other tender paths were not tested here.</li></ul></main></html>"""
(p / "Isolated-ERPNext-Sales-Test.html").write_text(html)
print("Created fixture verification report")
