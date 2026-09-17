#!/bin/bash
set -euo pipefail

# Drizzle applies the TypeScript table shape, but cannot install the
# transaction triggers/functions that make the technician segment ledger
# authoritative. This tracked, idempotent migration is deliberately run only
# against the development binding used by post-merge; production is never
# migrated by a workspace hook.
if [ "${NODE_ENV:-development}" = "production" ]; then
  echo "Refusing to apply development SQL migrations in production." >&2
  exit 1
fi
MIGRATION_DATABASE_URL="${DATABASE_URL:-${DEV_DATABASE_URL:-}}"
if [ -z "$MIGRATION_DATABASE_URL" ]; then
  echo "DATABASE_URL or DEV_DATABASE_URL is required for development migrations." >&2
  exit 1
fi
MIGRATION_DATABASE_HOST="$(node -e 'try { console.log(new URL(process.argv[1]).hostname.toLowerCase()); } catch { process.exit(1); }' "$MIGRATION_DATABASE_URL")" \
  || { echo "Development database URL is not parseable." >&2; exit 1; }
case "$MIGRATION_DATABASE_HOST" in
  helium|localhost|127.0.0.1) ;;
  *)
    echo "Refusing post-merge DB writes outside the allowlisted development hosts." >&2
    exit 1
    ;;
esac
for PRODUCTION_DATABASE_URL in "${PROD_DATABASE_URL:-}" "${EXTERNAL_DATABASE_URL:-}"; do
  if [ -n "$PRODUCTION_DATABASE_URL" ] && ! node -e '
    try {
      const candidate = new URL(process.argv[1]);
      const production = new URL(process.argv[2]);
      process.exit(candidate.hostname === production.hostname &&
        candidate.pathname === production.pathname ? 1 : 0);
    } catch { process.exit(0); }
  ' "$MIGRATION_DATABASE_URL" "$PRODUCTION_DATABASE_URL"; then
    echo "Refusing post-merge DB writes: target matches a production database URL." >&2
    exit 1
  fi
done

# The development/prod and host guards above deliberately precede push-force:
# schema synchronization itself is a database write.
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push-force
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/2026-09-30-technician-work-segment-ledger.sql
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/2026-10-01-technician-timesheet-original-job-card.sql
