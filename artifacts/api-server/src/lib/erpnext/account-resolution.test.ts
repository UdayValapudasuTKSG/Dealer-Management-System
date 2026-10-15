import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAccount } from "./account-resolution";

function fixture(matches = ["2020101 - Customer Deposits - GA"], company = "GT AUTOMOTIVE", number = "2020101") {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      async listDocs<T>(doctype: string, options: unknown): Promise<T[]> {
        calls.push({ doctype, options });
        return matches.map(name => ({ name })) as T[];
      },
      async getDoc<T>(_doctype: string, name: string): Promise<T> {
        calls.push({ name });
        return { name, company, account_number: number } as T;
      },
    },
  };
}

test("numeric codes resolve uniquely inside the selected company", async () => {
  const f = fixture();
  const doc = await resolveAccount(f.client, "GT AUTOMOTIVE", "2020101");
  assert.equal(doc.name, "2020101 - Customer Deposits - GA");
  assert.deepEqual(f.calls[0], { doctype: "Account", options: {
    filters: [["company", "=", "GT AUTOMOTIVE"], ["account_number", "=", "2020101"]],
    fields: ["name"], limit: 2,
  } });
});
test("full account names are used exactly, without a fuzzy search", async () => {
  const f = fixture();
  await resolveAccount(f.client, "GT AUTOMOTIVE", "2020101 - Customer Deposits - GA");
  assert.equal(f.calls.length, 1);
});
test("missing and ambiguous codes fail closed", async () => {
  for (const names of [[], ["One", "Two"]]) {
    await assert.rejects(resolveAccount(fixture(names).client, "GT AUTOMOTIVE", "2020101"));
  }
});
test("cross-company documents and changed numbers fail closed", async () => {
  await assert.rejects(resolveAccount(fixture(undefined, "OTHER").client, "GT AUTOMOTIVE", "2020101"), /connected company/);
  await assert.rejects(resolveAccount(fixture(undefined, undefined, "999").client, "GT AUTOMOTIVE", "2020101"), /changed/);
});
