"""Build a source-traceable COA review workbook; no external writes or credentials."""
from pathlib import Path
import csv, re, zipfile
from xml.sax.saxutils import escape
import fitz

source = Path("attached_assets/GT_Automotive_-_Transaction_Workflows_v1.0_1791644493200.pdf")
out = Path("generated-artifacts/gt-coa")
out.mkdir(parents=True, exist_ok=True)
pdf = fitz.open(source)
pages = [p.get_text() for p in pdf]
pdf[4].get_pixmap(matrix=fitz.Matrix(1.3, 1.3)).save(str(out / "source-ledger-page.png"))

# Only codes with an independently identifiable purpose; range endpoints alone
# never become posting accounts. Names marked "review" are descriptive proposals.
data = """1010101|Demerara Bank - Operating A/c (DBL 321)|Asset|Bank|Bank and cash|Explicit|Confirm test bank only; do not load source balances
1010202|Petty Cash|Asset|Cash|Bank and cash|Explicit|
1010203|Registration Float|Asset||Advances and floats|Explicit|Confirm whether any fees are recharged to customers
1010301|Undeposited Funds - Cash Receipts|Asset|Cash|Tender clearing|Explicit|Reconcile after banking; Cash classification proposed
1010302|Tender Clearing - Cheques|Asset||Tender clearing|Named purpose; review wording|Confirm account type for payment-entry use
1010303|Tender Clearing - Cards|Asset||Tender clearing|Named purpose; review wording|Confirm account type for payment-entry use
1010304|Tender Clearing - Transfers|Asset||Tender clearing|Named purpose; review wording|Confirm account type for payment-entry use
1020101|Trade Receivables - Customers|Asset|Receivable|Receivables|Explicit|
1020102|Trade Receivables - Bank Financed|Asset|Receivable|Receivables|Named purpose; review wording|Confirm financed-receivable transfer design
1020103|Receivables - Manufacturer Warranty Claims|Asset|Receivable|Receivables|Explicit|
1020201|Other Receivables - Asset Disposal|Asset|Receivable|Receivables|Named purpose; review wording|Master list required for exact name and wider scope
1020202|Employee Advances|Asset||Advances and floats|Named purpose; review wording|Payroll deductions offset this account
1030901|Work-in-Progress - Open Job Cards|Asset|Stock|Workshop WIP|Explicit|ERPNext Stock classification and WIP workflow require testing
1040201|Advances to Manufacturers - Pre-shipment|Asset||Advances and floats|Explicit|Supplier currency/account design requires review
1040401|VAT Input Tax - Local Purchases|Asset|Tax|Tax assets|Explicit|Tax rules remain subject to approval
1040402|VAT Input Tax - Imports (Customs)|Asset|Tax|Tax assets|Explicit|Import VAT not capitalized as recoverable inventory cost
1040403|Corporation Tax - Advance Payments|Asset||Tax assets|Explicit|
1050301|Capital WIP / Asset Clearing|Asset|Capital Work in Progress|Capital WIP|Explicit|Reconcile to open capital projects
2010101|Accounts Payable - Local Suppliers (GYD)|Liability|Payable|Payables|Explicit|
2010102|Accounts Payable - Foreign Suppliers (USD)|Liability|Payable|Payables|Explicit|Document specifies USD; do not default this ledger to GYD without deciding multicurrency design
2010201|Accrued Expenses|Liability||Accruals and GRNI|Explicit|
2010202|Goods Received Not Invoiced (GRNI)|Liability|Stock Received But Not Billed|Accruals and GRNI|Explicit|Match against unbilled receipts
2010203|Accrued Landed Costs|Liability||Accruals and GRNI|Named purpose; conditional|Document leaves estimated accrual policy open
2020101|Customer Deposits - Vehicle Orders|Liability||Customer deposits|Explicit|Do not substitute customer AR for deposits
2030101|VAT Output Tax Payable|Liability|Tax|Tax liabilities|Explicit|
2030102|VAT on Customer Advances|Liability|Tax|Tax liabilities|Conditional; review wording|Only if tax adviser confirms VAT on advances
2030103|VAT Settlement - Net Payable / (Refundable)|Liability|Tax|Tax liabilities|Explicit|May carry debit balance; reconcile to filed return
2030201|PAYE Payable|Liability||Payroll liabilities|Explicit|
2030202|NIS Payable|Liability||Payroll liabilities|Explicit|
2030301|Corporation Tax Payable|Liability||Tax liabilities|Explicit|
2030302|Property Tax Payable|Liability||Tax liabilities|Explicit|
2030303|Withholding Tax Payable - Non-residents|Liability||Tax liabilities|Explicit|
2040101|Net Salaries Payable|Liability||Payroll liabilities|Explicit|
2040102|Other Payroll Deductions Payable|Liability||Payroll liabilities|Named purpose; review wording|
3020101|Retained Earnings|Equity||Earnings|Named purpose; review wording|Confirm ERPNext period-closing setup; no manual duplication
3020102|Current Year Earnings|Equity||Earnings|Explicit|Document calls this system account; confirm ERPNext year-end behavior
3030101|Opening Balance Equity|Equity|Temporary|Migration clearing|Explicit|No opening balances supplied or authorized
4030105|Warranty Claims Income - Manufacturers|Income|Income Account|Service income|Explicit|
4040101|Forfeited Customer Deposits|Income|Income Account|Other operating income|Named purpose; review wording|Only under approved cancellation terms
5030101|Workshop Consumables Cost|Expense|Cost of Goods Sold|Service costs|Named purpose; review wording|
5030102|Warranty Repair Costs|Expense|Cost of Goods Sold|Service costs|Explicit|
5060101|Inventory Shrinkage & Count Differences|Expense|Stock Adjustment|Inventory variances|Explicit|
5060103|Landed Cost Variance|Expense||Inventory variances|Explicit|
6010110|NIS - Employer Contribution|Expense|Expense Account|Staff costs|Explicit|
6020107|Property Tax|Expense|Expense Account|Operating expenses|Explicit|
6060112|Cash Over / (Short) - POS|Expense|Expense Account|Operating expenses|Explicit|Dr shortages / Cr surpluses
7010101|Interest Income|Income|Income Account|Other income|Explicit|
7010103|Gain / (Loss) on Asset Disposal|Income|Income Account|Other income|Named purpose; review wording|Net gain credit / loss debit; confirm master wording
8010101|Bank Charges|Expense|Expense Account|Finance costs|Explicit|
8010103|Card / Payment Processing Fees|Expense|Expense Account|Finance costs|Explicit|
8020101|FX (Gain) / Loss - Realised|Expense|Exchange Gain or Loss|Finance costs|Explicit|GYD company; foreign supplier currency setup separate
8020102|FX (Gain) / Loss - Unrealised (Revaluation)|Expense|Exchange Gain or Loss|Finance costs|Explicit|Revaluation reversal policy required
8040101|Current Tax - Corporation Tax|Expense|Expense Account|Income tax expense|Explicit|"""

accounts = []
for line in data.splitlines():
    code, name, root, typ, parent, status, note = line.split("|")
    refs = [str(i+1) for i, text in enumerate(pages) if re.search(r"\b"+code+r"\b", text)]
    assert refs, code
    currency = "USD — confirm" if code == "2010102" else "GYD — proposed"
    accounts.append([code, name, root, "Balance Sheet" if root in ("Asset","Liability","Equity") else "Profit and Loss",
                     typ, parent, 0, currency, status, ", ".join(refs), note])
assert len({a[0] for a in accounts}) == len(accounts)

families = [
("1030101–1030601","Vehicle inventory by model","Asset","Stock"),
("1030701–1030706","Parts / consumables inventory by brand or category","Asset","Stock"),
("1030801–1030808","Import and landed-cost clearing by brand / shipment","Asset",""),
("1040101–1040104","Prepaid expenses","Asset",""),
("1050101–1050105","PPE cost by asset class","Asset","Fixed Asset"),
("1050201–1050205","Accumulated depreciation by asset class","Asset","Accumulated Depreciation"),
("2050101–2050104","Credit cards","Liability",""),
("2060101–2060106","Related parties","Liability",""),
("4010101–4010706","Vehicle sales by model and duty-free category","Income","Income Account"),
("4010901–4010904","Vehicle discounts (contra revenue)","Income","Income Account"),
("4020101–4020105","Parts and accessories sales","Income","Income Account"),
("4030101–4030104","Service labour by brand","Income","Income Account"),
("5010101–5010601","Vehicle cost of sales by model","Expense","Cost of Goods Sold"),
("5020101–5020105","Parts cost of sales by brand","Expense","Cost of Goods Sold"),
("5040101 / 5040102 / 5040104","PDI, fuel and registration costs; exact code-to-name mapping missing","Expense","Cost of Goods Sold"),
("6010101–6010109","Salaries, wages and allowances","Expense","Expense Account"),
("6070101–6070105","Depreciation by asset class","Expense","Depreciation"),
("9010101–9010108","Suspense and system accounts; root types not provided","",""),
("60xxxxx","Operating expenses by department; full ledger list missing","Expense","Expense Account"),
]
family_rows = [[*f, "HOLD — master COA required; do not create every number in range"] for f in families]
groups = sorted({(a[2], a[5]) for a in accounts})
group_rows = [[root, group, 1, "Proposed grouping only; map to existing ERPNext parent names"] for root, group in groups]
evidence = []
for i, text in enumerate(pages):
    lines = text.splitlines()
    for j, line in enumerate(lines):
        if re.search(r"\b\d{7}\b|\b\d{2,6}x{1,5}\b", line):
            evidence.append([i+1, " | ".join(lines[max(0,j-1):min(len(lines),j+3)])])
decisions = [
["VAT on deposits","Confirm whether VAT is due at receipt; 2030102 is conditional."],
["Duty-free/remission sales","Confirm categories, tax codes and supporting documents; do not assume zero tax for all."],
["Registration fees","Confirm cost of sale versus separately recoverable fees."],
["POS posting","Real-time receipt GL versus summarized shift posting."],
["Landed-cost allocation","FOB-value versus per-unit allocation; estimated accruals versus actual bills."],
["Opening stock/import clearing","Reconcile by shipment before any live cut-over; no source balances loaded."],
["Opening equity","Reclassify only with authorized incorporation records; no balance migration in this pack."],
["Bank credit balance","Confirm overdraft versus uncleared items before opening balances."],
["Master COA missing","Required to supply exact model, brand, asset-class, salary and suspense ledgers."],
["ERPNext account metadata","Confirm company abbreviation, exact parent account names, account types and currency in site's import template."],
["Foreign supplier currency","Source describes USD/EUR suppliers. USD AP is not silently converted to a GYD ledger; EUR ledger code missing."],
["Integration scope","AURA's configured income/tax/AR/settlement mappings do not alone implement every posting flow in F1–F10."],
]
mapping = [
["Income account","HOLD","Resolve model-specific 40101xx / parts 40201xx / labour 40301xx; do not use warranty income as blanket default."],
["Tax account","2030101","Use exact ERPNext account document name after review; tax applicability separate."],
["Receivable account","1020101","Customer receivables, not customer deposits."],
["Settlement account","HOLD","Workflow requires tender clearing 1010301–1010304; AURA has one saved settlement default, so validate each tender path."],
["Payment modes","HOLD","Confirm existing Cash / Cheque / Card / Transfer mode names; names alone do not implement distinct clearing legs."],
["Default warehouse","HOLD","Select existing GT AUTOMOTIVE test warehouse and verify its inventory/GRNI accounts."],
["Customer deposit posting","2020101","Requires deposit-specific behavior; ordinary AR payment posting is not equivalent."],
["Workshop WIP","1030901","Parts-issue/WIP-relief logic must be reconciled independently of account creation."],
]
readme = [
["Purpose","Draft chart-of-accounts review pack for AURA CAM Motors Dummy -> ERPNext GT AUTOMOTIVE (test-only, confirmed by user)."],
["Company currency","GYD. Account-level foreign currency exceptions need explicit review."],
["Source","GT Automotive — Transaction Workflows & Ledger Mapping v1.0, 08-Oct-2026."],
["Status","NOT IMPORT-READY. No ERPNext or AURA accounting settings changed. No balances or transactions imported."],
["Coverage",f"{len(accounts)} identifiable accounts; {len(families)} unresolved account families. Not the complete master chart."],
["Authority","Exact codes retained. Descriptive names and all ERPNext classifications/groups are proposals unless marked explicit."],
["Range policy","Do not expand ranges into hundreds of accounts or guess vehicle models. Obtain ERP Master Chart of Accounts v1.0."],
["Existing company","Do not replace the chart of an existing company. Compare existing account export and map/reuse before any additive import."],
["Import process","Export the ERPNext Account import template and current chart from this site; adapt reviewed rows to its exact fields and parents. CSV here is for review, not direct upload."],
["Opening balances","None included. Historical amounts mentioned in the source are not dummy opening balances."],
["Shipment BRD","Draft/pending approval; direct ERP posting changes excluded. Does not supply missing master accounts."],
["Next step","Supply the referenced ERP Master COA plus existing ERPNext Account export/import template. Resolve Holds, then test a small agreed transaction and inspect its GL."],
]
sheets = {
    "Read me": [["Topic","Guidance"], *readme],
    "Accounts for review": [["Code","Account name","Proposed root type","Report type","Proposed ERPNext account type","Proposed parent group","Is group","Proposed account currency","Source status","PDF pages (1-based)","Review notes"], *accounts],
    "Proposed groups": [["Root","Group name","Is group","Status"], *group_rows],
    "Unresolved families": [["Code range","Purpose","Proposed root","Proposed type","Status"], *family_rows],
    "AURA mapping": [["Setting","Code / status","Guidance"], *mapping],
    "Decisions": [["Topic","Required decision"], *decisions],
    "Source evidence": [["PDF page","Extracted source context (not an account definition)"], *evidence],
}

# Standard-library XLSX writer: all data are inline strings, preventing formula injection.
def col(n):
    s = ""
    while n:
        n, r = divmod(n-1,26)
        s = chr(65+r)+s
    return s
ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
dest = out / "CAM-Motors-Dummy-GT-COA-Review.xlsx"
with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
    overrides = "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1,len(sheets)+1))
    z.writestr("[Content_Types].xml", f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>{overrides}</Types>')
    z.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    z.writestr("xl/workbook.xml", f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+ "".join(f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>' for i,name in enumerate(sheets,1)) + '</sheets></workbook>')
    z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+ "".join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1,len(sheets)+1)) + '</Relationships>')
    for i,(name, rows) in enumerate(sheets.items(),1):
        body = "".join('<row r="'+str(r)+'">'+ "".join(f'<c r="{col(c)}{r}" t="inlineStr"><is><t xml:space="preserve">{escape(str(v))}</t></is></c>' for c,v in enumerate(row,1))+'</row>' for r,row in enumerate(rows,1))
        cols = "".join(f'<col min="{c}" max="{c}" width="{20 if c==1 else 45}" customWidth="1"/>' for c in range(1,len(rows[0])+1))
        z.writestr(f"xl/worksheets/sheet{i}.xml", f'<worksheet xmlns="{ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>{cols}</cols><sheetData>{body}</sheetData><autoFilter ref="A1:{col(len(rows[0]))}{len(rows)}"/></worksheet>')
with open(out / "Accounts-for-review-NOT-FOR-IMPORT.csv", "w", newline="", encoding="utf-8-sig") as f:
    csv.writer(f).writerows(sheets["Accounts for review"])
# Validate every XML member and source coverage.
import xml.etree.ElementTree as ET
with zipfile.ZipFile(dest) as z:
    assert z.testzip() is None
    for name in z.namelist():
        ET.fromstring(z.read(name))
print(f"Created {dest}: {len(accounts)} accounts, {len(families)} unresolved families, {len(evidence)} evidence rows; {len(pages)} source pages.")
