import { ErpnextError, type ErpnextClient } from "./client";

export type ResolvedAccount = {
  name: string; company: string; account_number?: string; account_currency?: string;
  is_group?: number; disabled?: number; root_type?: string; account_type?: string;
};

/** Resolve only exact document names or unique, company-scoped account numbers.
 * Never fuzzy-match financial accounts or infer them from another model.
 */
export async function resolveAccount(
  client: Pick<ErpnextClient, "getDoc" | "listDocs">, company: string, value: string,
): Promise<ResolvedAccount> {
  const input = value.trim();
  if (!input) throw new ErpnextError("No account configured.", 422, "http");
  let doc: ResolvedAccount;
  if (/^\d+$/.test(input)) {
    const matches = await client.listDocs<{ name: string }>("Account", {
      filters: [["company", "=", company], ["account_number", "=", input]],
      fields: ["name"], limit: 2,
    });
    if (matches.length !== 1) throw new ErpnextError(
      matches.length ? "Account number is ambiguous in the connected company; use the exact document name."
        : "Account number was not found in the connected company.", 422, "http");
    doc = await client.getDoc<ResolvedAccount>("Account", matches[0].name);
    if (doc.account_number !== input) throw new ErpnextError("Account number changed during validation; retry.", 422, "http");
  } else {
    doc = await client.getDoc<ResolvedAccount>("Account", input);
  }
  if (!doc.name || doc.company !== company) throw new ErpnextError("Account does not belong to the connected company.", 422, "http");
  return doc;
}
