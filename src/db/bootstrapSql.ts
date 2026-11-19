import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import type { PGlite } from "@electric-sql/pglite";

/**
 * The hand-maintained SQL layer (docs/physical-database-design.md §17) is
 * applied as 00 (Prisma-generated base DDL) followed by 01-06, in order.
 * `00_base_schema.sql` is regenerated from prisma/schema.prisma via:
 *   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/sql/00_base_schema.sql
 */
const SQL_FILES = [
  "00_base_schema.sql",
  "01_roles_and_grants.sql",
  "02_constraints_and_partial_indexes.sql",
  "03_helper_and_accounting_functions.sql",
  "04_validation_and_audit_triggers.sql",
  "05_controlled_mutation_functions.sql",
  "06_rls_policies.sql",
] as const;

const SQL_DIR = join(__dirname, "..", "..", "prisma", "sql");

/**
 * A minimal common surface over `pg.Pool` and `@electric-sql/pglite`'s
 * `PGlite`, since both already implement `.query()`; PGlite additionally
 * supports `.exec()` for true multi-statement execution (several of these
 * files define PL/pgSQL bodies containing their own internal semicolons
 * inside `$$...$$` dollar-quoting), while `pg.Pool.query()` already
 * supports multi-statement text via the simple query protocol when called
 * with no parameters, so a thin wrapper suffices for both.
 */
/** A query/exec surface available INSIDE one transaction (`run`/`runAs`). */
export interface TxHandle {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  execMulti(sql: string): Promise<void>;
}

/** Tenant/role context for one `runAs` transaction (docs/physical-database-design.md §13). */
export interface RunContext {
  /** Postgres role to `SET LOCAL ROLE` to — e.g. `steeltrace_app`, `steeltrace_identity_service`. Omit to stay the bootstrapping superuser. */
  role?: string;
  companyId?: string | null;
  userId?: string | null;
  membershipId?: string | null;
}

export interface SqlExecutor {
  execMulti(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  /**
   * Runs `fn` inside one transaction as the bootstrapping/superuser role —
   * no `SET LOCAL ROLE`, no tenant context. Used only for schema setup and
   * for assertions that need to inspect state irrespective of RLS.
   */
  run<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` inside one transaction as `context.role` (if given), with
   * `app.current_company_id`/`app.current_user_id`/`app.current_membership_id`
   * set via `SET LOCAL` (mirrors src/db/tenantContext.ts's
   * `withTenantContext`, but against the raw SQL layer directly rather
   * than through Prisma Client — this is what lets the integrity tests
   * exercise RLS and the controlled functions exactly as
   * `steeltrace_app`/`steeltrace_identity_service` would in production).
   */
  runAs<T>(context: RunContext, fn: (tx: TxHandle) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function setContext(tx: TxHandle, context: RunContext): Promise<void> {
  if (context.role) {
    // `SET LOCAL ROLE` cannot be parameterized (it's DDL-like session
    // state, not a value position) — safe here because `context.role` is
    // always a fixed literal from this codebase, never user input.
    await tx.query(`SET LOCAL ROLE "${context.role}"`);
  }
  await tx.query(
    `SELECT set_config('app.current_company_id', $1, true), ` +
      `set_config('app.current_user_id', $2, true), ` +
      `set_config('app.current_membership_id', $3, true)`,
    [context.companyId ?? "", context.userId ?? "", context.membershipId ?? ""],
  );
}

export function wrapPglite(db: PGlite): SqlExecutor {
  return {
    async execMulti(sql: string) {
      await db.exec(sql);
    },
    async query<T>(sql: string, params?: unknown[]) {
      const result = await db.query<T>(sql, params as unknown[] | undefined);
      return { rows: result.rows };
    },
    async run<T>(fn: (tx: TxHandle) => Promise<T>) {
      return db.transaction(async (tx) => {
        const handle: TxHandle = {
          query: (sql, params) => tx.query(sql, params as unknown[] | undefined),
          execMulti: async (sql) => {
            await tx.exec(sql);
          },
        };
        return fn(handle);
      });
    },
    async runAs<T>(context: RunContext, fn: (tx: TxHandle) => Promise<T>) {
      return db.transaction(async (tx) => {
        const handle: TxHandle = {
          query: (sql, params) => tx.query(sql, params as unknown[] | undefined),
          execMulti: async (sql) => {
            await tx.exec(sql);
          },
        };
        await setContext(handle, context);
        return fn(handle);
      });
    },
    async close() {
      await db.close();
    },
  };
}

export function wrapPgPool(pool: Pool): SqlExecutor {
  return {
    async execMulti(sql: string) {
      await pool.query(sql);
    },
    async query<T>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async run<T>(fn: (tx: TxHandle) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const handle: TxHandle = {
          query: async <U>(sql: string, params?: unknown[]) => {
            const result = await client.query(sql, params);
            return { rows: result.rows as U[] };
          },
          execMulti: async (sql) => {
            await client.query(sql);
          },
        };
        const result = await fn(handle);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async runAs<T>(context: RunContext, fn: (tx: TxHandle) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const handle: TxHandle = {
          query: async <U>(sql: string, params?: unknown[]) => {
            const result = await client.query(sql, params);
            return { rows: result.rows as U[] };
          },
          execMulti: async (sql) => {
            await client.query(sql);
          },
        };
        await setContext(handle, context);
        const result = await fn(handle);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Picks a real `pg.Pool` when DIRECT_URL is set, falling back to an
 * in-process PGlite instance otherwise (local dev / CI / this sandbox,
 * where neither Docker nor `psql` is available).
 */
export async function createExecutor(): Promise<SqlExecutor> {
  if (process.env.DIRECT_URL || process.env.DATABASE_URL) {
    const { Pool } = await import("pg");
    const { resolveDirectUrl } = await import("./envUrls");
    return wrapPgPool(new Pool({ connectionString: resolveDirectUrl() }));
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create();
  return wrapPglite(db);
}

/**
 * Applies 00-06, in order, against the given executor. Each file is sent
 * as ONE multi-statement command — required because splitting on `;`
 * would break PL/pgSQL function bodies.
 */
export async function bootstrapSql(
  executor: SqlExecutor,
  options: { log?: (msg: string) => void } = {},
): Promise<void> {
  const log = options.log ?? (() => {});
  for (const file of SQL_FILES) {
    const sql = readFileSync(join(SQL_DIR, file), "utf8");
    log(`applying ${file}...`);
    await executor.execMulti(sql);
  }
}
