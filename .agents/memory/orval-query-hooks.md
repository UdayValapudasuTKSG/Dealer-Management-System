---
name: Orval query-hook options
description: How the generated React Query hooks accept options and why passing only enabled fails typecheck
---

The Orval-generated `useGet*` hooks in `@workspace/api-client-react` take `(id, options?)` where `options.query` is typed as the FULL `UseQueryOptions<...>` (NOT `Partial`). That type requires `queryKey`.

**Symptom:** `error TS2741: Property 'queryKey' is missing ... but required in type 'UseQueryOptions<...>'` when you write `useGetX(id, { query: { enabled: ... } })`.

**How to apply:**
- If you don't need extra query options, just call `useGetX(id)` — the hook builds and attaches the queryKey internally.
- If you must pass options and still need the default key, spread it: `{ query: { enabled, queryKey: getGetXQueryKey(id) } }` (each hook has a matching `getGet<Name>QueryKey` export).
- For cache invalidation after mutations, use those same `getGet<Name>QueryKey` / `getList<Name>QueryKey` exports with `queryClient.invalidateQueries`.
