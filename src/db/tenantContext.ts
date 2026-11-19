import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prismaClient";

/**
 * The three pieces of session context every tenant-scoped request must
 * establish before issuing a single query against a tenant-scoped table
 * (docs/physical-database-design.md §13, §17):
 *
 *   - companyId:   resolved RLS boundary — `app.current_company_id`. Every
 *                  tenant table's `tenant_isolation` policy (06) compares
 *                  `company_id` against this; a session with it unset sees
 *                  (and can write) nothing, fail-closed.
 *   - userId:      the authenticated person — `app.current_user_id`. Used
 *                  by `users_self_update` (06) to let someone edit only
 *                  their own global profile row.
 *   - membershipId: the `company_memberships.id` for this person WITHIN
 *                  this company (§6a's "currently selected company") —
 *                  `app.current_membership_id`. Written into every
 *                  `*_by_membership_id` column the controlled functions
 *                  (05) and the generic audit trigger (04) touch.
 */
export interface TenantContext {
  companyId: string;
  userId: string;
  membershipId: string;
}

// ---------------------------------------------------------------------------
// Retry on transient PostgreSQL concurrency errors (Task 5, §12).
//
// `40001` (serialization_failure) and `40P01` (deadlock_detected) are not
// bugs — they are Postgres telling an otherwise-correct transaction "retry
// me," normal under concurrent writers against the same row-locked material
// units/transfer lines the controlled functions (05) deliberately
// `SELECT ... FOR UPDATE`. Retrying the WHOLE interactive transaction from
// the top (not just the failing statement) is required: every `SET LOCAL`
// GUC and any prior statement in the same attempt were rolled back with it.
// ---------------------------------------------------------------------------
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 25;

function retryableSqlState(err: unknown): string | null {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2010" &&
    typeof err.meta?.code === "string" &&
    RETRYABLE_SQLSTATES.has(err.meta.code)
  ) {
    return err.meta.code;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Prisma's own default for an interactive transaction's `timeout` option is
// 5000ms — fine for a single controlled-function call, too short for a
// route that makes several SEQUENTIAL round trips inside one transaction
// (e.g. GET /api/inventory enriching N rows with their own
// material_unit_remaining_length_m/theoretical_weight_kg calls each).
// Confirmed firsthand against live Neon: a transaction that outlives this
// window doesn't surface as a timeout error on the slow query itself — the
// engine has already silently discarded the transaction, and the NEXT
// query against the same `tx` fails with a confusing, unrelated-looking
// `P2028 Transaction not found`. Raised generously rather than tuned
// per-route, since "a write took unexpectedly long" should fail loudly on
// its own terms (a real DB problem), not be masked by an overly-short
// transaction window.
const TRANSACTION_OPTIONS = { timeout: 20_000 };

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const sqlState = retryableSqlState(err);
      if (!sqlState || attempt >= MAX_RETRIES) {
        throw err;
      }
      attempt += 1;
      // Capped exponential backoff with jitter, so a burst of sessions
      // retrying the same conflicting rows don't immediately collide again
      // in lockstep.
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
      await sleep(delay);
    }
  }
}

/**
 * Runs `fn` inside one Prisma **interactive** transaction, issuing
 * `SET LOCAL app.current_company_id`/`app.current_user_id`/
 * `app.current_membership_id` as its first statements. Automatically
 * retries the entire transaction (capped exponential backoff, max 3
 * retries) on `40001`/`40P01` (§12 above).
 *
 * `SET LOCAL` (not session-level `SET`) is required under Neon's pooled
 * connections (§13): it auto-reverts at COMMIT/ROLLBACK regardless of what
 * the connection pooler does with the physical connection afterward,
 * preventing tenant-context leakage across requests that happen to share
 * one pooled connection.
 *
 * Every query issued through `tx` inside `fn` — including every call into
 * the controlled database functions (05) via `tx.$queryRaw`/`$executeRaw`
 * — runs with this tenant context active, and therefore under RLS (06).
 * No query against a tenant-scoped table should ever be issued through the
 * plain `prisma` client exported from `../prismaClient` directly; always
 * go through `withTenantContext`.
 */
export async function withTenantContext<T>(
  context: TenantContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  client: PrismaClient = prisma,
): Promise<T> {
  return withRetry(() =>
    client.$transaction(async (tx) => {
      // NEON NOTE (01_roles_and_grants.sql): the role Prisma's DATABASE_URL
      // actually connects as is Neon's database-owner role, which carries
      // BYPASSRLS — a role-level override that defeats RLS (including
      // FORCE ROW LEVEL SECURITY, 06) regardless of table ownership. Tenant
      // isolation is only real once every statement in this transaction
      // runs as `steeltrace_app`, which has neither BYPASSRLS nor any direct
      // INSERT/UPDATE/DELETE grant on controlled/immutable tables. `SET
      // LOCAL ROLE` must be the first statement — it, and every `SET LOCAL`
      // GUC below, reverts automatically at COMMIT/ROLLBACK, so it can never
      // leak onto a pooled physical connection reused by a later, differently-
      // scoped request (§13).
      await tx.$executeRawUnsafe(`SET LOCAL ROLE steeltrace_app`);

      // Parameterized via `set_config` (not string-interpolated SET LOCAL)
      // so a malicious/malformed id can never become SQL injection — these
      // three values still end up as session GUCs `SET LOCAL` would produce
      // (the `true` third argument to `set_config` is "is_local", the exact
      // equivalent of the `LOCAL` keyword).
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${context.companyId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${context.userId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_membership_id', ${context.membershipId}, true)`;

      return fn(tx);
    }, TRANSACTION_OPTIONS),
  );
}

/**
 * Identity-service counterpart to `withTenantContext` (§6): registration
 * and invitation acceptance run as `steeltrace_identity_service` — the
 * only role holding INSERT on the global `users` table — never as
 * `steeltrace_app`. Still subject to RLS (NOBYPASSRLS, 01); where the
 * identity-service's work is company-scoped (e.g. inserting a
 * `company_memberships` row for a specific invitation's company), the
 * caller must additionally `SET LOCAL app.current_company_id` itself via
 * the same `set_config` pattern — this helper only establishes the role
 * and, optionally, `app.current_user_id` for self-referential checks
 * (`users_self_update`, 06), since a brand-new registrant has no
 * membership/company context yet (06's `users_identity_service_*`
 * policies are what make that possible). Retries on `40001`/`40P01` exactly
 * like `withTenantContext`.
 */
export async function withIdentityServiceContext<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  client: PrismaClient = prisma,
  context: Partial<TenantContext> = {},
): Promise<T> {
  return withRetry(() =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE steeltrace_identity_service`);

      if (context.companyId) {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${context.companyId}, true)`;
      }
      if (context.userId) {
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${context.userId}, true)`;
      }
      if (context.membershipId) {
        await tx.$executeRaw`SELECT set_config('app.current_membership_id', ${context.membershipId}, true)`;
      }

      return fn(tx);
    }, TRANSACTION_OPTIONS),
  );
}
