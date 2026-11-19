/**
 * Shared connection-string fallback logic (Task 4, Step 2).
 *
 * `DIRECT_URL` (unpooled) is required for Prisma Migrate and for
 * `prisma/sql/apply.ts`'s DDL/role/function script, which must not run
 * through Neon's pgbouncer transaction-pooling endpoint (advisory locks
 * and multi-statement DDL sequences are not reliable across a connection
 * that transaction-mode pooling may hand to a different backend between
 * statements). If `DIRECT_URL` is not set at all, it is derived from
 * `DATABASE_URL` by stripping the `-pooler` suffix Neon adds to its pooled
 * hostname — the direct endpoint otherwise differs only by that suffix.
 * If `DATABASE_URL` itself has no `-pooler` segment (already a direct
 * connection), it is used as-is.
 */
export function resolveDirectUrl(): string {
  if (process.env.DIRECT_URL) {
    return process.env.DIRECT_URL;
  }

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "Neither DIRECT_URL nor DATABASE_URL is set. One of them must point at a Postgres connection.",
    );
  }

  return base.replace(/^(postgres(?:ql)?:\/\/[^@]+@)([^.]+)-pooler\./, "$1$2.");
}

/**
 * `IDENTITY_SERVICE_DATABASE_URL` is a holdover from an earlier design
 * where `steeltrace_identity_service` was a separate LOGIN role with its
 * own connection string (.env.example). The current design (01) makes it
 * NOLOGIN and reached via `SET LOCAL ROLE` from the same connection
 * `DATABASE_URL` already authenticates (`withIdentityServiceContext`,
 * tenantContext.ts) — so this simply falls back to `DATABASE_URL` when no
 * dedicated identity-service connection string is configured.
 */
export function resolveIdentityServiceUrl(): string {
  if (process.env.IDENTITY_SERVICE_DATABASE_URL) {
    return process.env.IDENTITY_SERVICE_DATABASE_URL;
  }

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "Neither IDENTITY_SERVICE_DATABASE_URL nor DATABASE_URL is set.",
    );
  }

  return base;
}
