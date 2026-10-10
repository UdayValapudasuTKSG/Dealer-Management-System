"""Reconcile reviewed source accounts to the live test-company snapshot."""
import csv, json
from pathlib import Path
p = Path("generated-artifacts/gt-coa")
snapshot = json.loads((p / "erpnext-current-accounts.json").read_text())
accounts = snapshot["accounts"]
by_code = {a["account_number"]: a for a in accounts}
reuse = {
    "1020101": "1310", "1050301": "1790", "2010101": "2110",
    "2010202": "2210", "2040101": "2120", "3020101": "3400",
    "3030101": "3300", "7010101": "4210", "8010101": "5221",
}
accrued = next(a for a in accounts if a["account_name"] == "Accrued Expenses")
reuse["2010201"] = accrued["account_number"]
parent_codes = {
    "Bank and cash": "1100", "Advances and floats": "1600",
    "Tender clearing": "1100-1600", "Receivables": "1300",
    "Workshop WIP": "1400", "Tax assets": "1500",
    "Payables": "2100", "Accruals and GRNI": "2100-2400",
    "Customer deposits": "2100-2400", "Tax liabilities": "2300",
    "Payroll liabilities": "2100-2400", "Service income": "4100",
    "Service costs": "5100", "Inventory variances": "5110",
    "Staff costs": "5200", "Operating expenses": "5200",
    "Finance costs": "5200", "Income tax expense": "5200",
}
plan = {"site": snapshot["site"], "company": snapshot["company"]["name"], "currency": "GYD",
        "create": [], "reuse": [], "hold": []}
for row in csv.DictReader((p / "Accounts-for-review-NOT-FOR-IMPORT.csv").open(encoding="utf-8-sig")):
    code, name = row["Code"], row["Account name"]
    if code in reuse:
        existing = by_code[reuse[code]]
        assert not existing["is_group"] and not existing["disabled"]
        assert existing["root_type"] == row["Proposed root type"], code
        plan["reuse"].append({"source_code": code, "source_name": name, "existing_account": existing["name"],
                              "note": "Existing ERPNext number retained; source code is a cross-reference, not a renumbering."})
        continue
    allowed = row["Source status"] == "Explicit" or code in ("1010302","1010303","1010304")
    if not allowed or code in ("2010102","3020102","8020101","8020102"):
        plan["hold"].append({"source_code": code, "source_name": name,
                             "reason": row["Review notes"] or "Exact master-account definition is pending."})
        continue
    parent = by_code["1200" if code == "1010101" else parent_codes[row["Proposed parent group"]]]
    assert parent["is_group"] and parent["root_type"] == row["Proposed root type"]
    typ = row["Proposed ERPNext account type"]
    if code in ("1010302","1010303","1010304"):
        typ = "Bank"
    plan["create"].append({
        "doctype": "Account", "company": plan["company"],
        "account_name": name, "account_number": code,
        "parent_account": parent["name"], "is_group": 0,
        "account_type": typ, "account_currency": "GYD",
        "root_type": row["Proposed root type"], "report_type": row["Report type"],
    })
(p / "account-setup-plan.json").write_text(json.dumps(plan, indent=2))
print(json.dumps({k: len(plan[k]) for k in ("create","reuse","hold")}))
for a in plan["create"]:
    print("CREATE", a["account_number"], a["account_name"])
