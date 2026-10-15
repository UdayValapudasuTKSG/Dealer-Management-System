import { and, eq } from "drizzle-orm";
import { db, salesAccountingSettingsTable as settings, auditLogsTable } from "@workspace/db";
import { getErpnextConnection, clientFor } from "./connection";
import { registerErpnextSyncHandler } from "./sync";
import { ACCOUNT_ROLES } from "../sales-accounting-policy";
import { ErpnextError } from "./client";
import { resolveAccount, type ResolvedAccount } from "./account-resolution";

export function registerSalesGlValidation() {
  registerErpnextSyncHandler("AURA Sales GL Validation", async job => {
    const revision = Number(job.payload.revision);
    const [row] = await db.select().from(settings).where(and(eq(settings.dealerId, job.dealerId), eq(settings.revision, revision)));
    if (!row) return { docName: null }; // An obsolete validation may not bless a newer config.
    const errors: string[] = [];
    const conn = await getErpnextConnection(job.dealerId);
    try {
      if (!conn?.enabled || !conn.companyName) throw new Error("Run the dealership's ERPNext connection test first.");
      const company = conn.companyName;
      const client = clientFor(conn);
      const checks: { label: string; name: string; root: string; type?: string }[] = [];
      for (const role of ACCOUNT_ROLES) {
        checks.push({ label: role.label, name: row.config.accounts.find(a => a.key === role.key)?.account ?? "", root: role.rootType,
          ...(["receivables", "financierReceivables"].includes(role.key) ? { type: "Receivable" } : {}) });
      }
      for (const source of row.config.sources) checks.push({
        label: source.label, name: source.account, root: source.kind === "supplier" ? "Liability" : "Asset",
        ...(source.kind === "bank" ? { type: "Bank" } : source.kind === "cash" ? { type: "Cash" } : source.kind === "supplier" ? { type: "Payable" } : {}),
      });
      if (!row.config.sources.length) errors.push("Configure at least one payment source.");
      if (!row.config.models.length) errors.push("Configure the vehicle model accounts.");
      for (const model of row.config.models) {
        for (const [key, root] of [["income", "Income"], ["dutyFreeIncome", "Income"], ["inventory", "Asset"], ["cogs", "Expense"], ["discount", "Income"]] as const) {
          // A normal-sale mapping must not require an invented duty-free ledger.
          // The preview still blocks duty-free sales without this explicit mapping.
          if (key === "dutyFreeIncome" && !model[key]) continue;
          checks.push({ label: `${model.make} ${model.model}: ${key}`, name: model[key], root });
        }
      }
      const cache = new Map<string, ResolvedAccount>();
      const resolvedNames = new Map<string, string>();
      for (const rule of row.config.customerCharges ?? []) {
        if (rule.incomeAccount) checks.push({ label: `${rule.category} customer-charge income`, name: rule.incomeAccount, root: "Income" });
      }
      for (const check of checks) {
        if (!check.name) { errors.push(`${check.label}: no account configured.`); continue; }
        try {
          let doc = cache.get(check.name);
          if (!doc) {
            doc = await resolveAccount(client, conn.companyName, check.name);
            cache.set(check.name, doc!);
          }
          if (!doc || doc.company !== conn.companyName || doc.is_group || doc.disabled ||
            (doc.account_currency && doc.account_currency !== "GYD") || doc.root_type !== check.root ||
            (check.type && doc.account_type !== check.type)) {
            errors.push(`${check.label}: must be an enabled GYD ${check.root}${check.type ? ` / ${check.type}` : ""} leaf account in ${conn.companyName}.`);
          } else resolvedNames.set(check.name, doc.name);
        } catch (err) {
          if (err instanceof ErpnextError && err.kind === "not_found") errors.push(`${check.label}: account document not found. Use its full ERPNext name.`);
          else if (err instanceof ErpnextError && err.status === 422) errors.push(`${check.label}: ${err.message}`);
          else throw err;
        }
      }
      const config = structuredClone(row.config);
      const name = (value: string) => resolvedNames.get(value) ?? value;
      config.accounts.forEach(a => { a.account = name(a.account); });
      config.sources.forEach(s => { s.account = name(s.account); });
      config.models.forEach(m => {
        for (const key of ["income", "dutyFreeIncome", "inventory", "cogs", "discount"] as const) m[key] = name(m[key]);
      });
      config.customerCharges?.forEach(r => { r.incomeAccount = name(r.incomeAccount); });
      const changed = JSON.stringify(config) !== JSON.stringify(row.config);
      await db.transaction(async tx => {
        const updated = await tx.update(settings).set({
          ...(changed ? { config, revision: revision + 1, updatedAt: new Date() } : {}),
          validation: { state: errors.length ? "invalid" : "valid", errors, checkedAt: new Date().toISOString(), company },
        }).where(and(eq(settings.dealerId, job.dealerId), eq(settings.revision, revision))).returning({ dealerId: settings.dealerId });
        if (changed && updated.length) await tx.insert(auditLogsTable).values({
          dealerId: job.dealerId, action: "update", module: "finance", entityType: "sales_accounting_settings",
          entityId: String(job.dealerId), summary: "ERP validation resolved exact company account numbers to document names",
          details: { before: row.config, after: config, revision: revision + 1 },
        });
      });
      return { docName: null };
    } catch {
      await db.update(settings).set({ validation: { state: "error", errors: ["ERPNext account validation could not finish. Check this dealership's connection and try again."], checkedAt: new Date().toISOString() } })
        .where(and(eq(settings.dealerId, job.dealerId), eq(settings.revision, revision)));
      // Configuration UI reflects the explicit error; another validation is a
      // new job. No financial documents are ever created by this handler.
      return { docName: null };
    }
  });
}
