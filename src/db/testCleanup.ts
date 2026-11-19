import type { SqlExecutor } from "./bootstrapSql";

/**
 * Shared test-tenant teardown (originally written for src/db/integrity.test.ts,
 * Task 4; extracted here, Task 5, so src/api/__tests__/task5.test.ts can
 * reuse it rather than re-implementing the same FK-topological-sort logic).
 */

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Deletes every row belonging to the given test company id(s) across the
 * whole schema, then the `companies` row(s) themselves — run as the
 * connecting (table-owning) role via `executor.run()`, i.e. with neither a
 * `SET LOCAL ROLE` nor RLS in effect (Neon's owner role carries BYPASSRLS,
 * 01_roles_and_grants.sql), so this is an admin-only operation never
 * available to `steeltrace_app`.
 *
 * Every FK in this schema is `onDelete: Restrict` (no cascades, §15's
 * "nothing is ever deleted" posture for the 44 real tenant tables), so
 * deletion must happen in dependency order: a row referencing another
 * table must be deleted before the row it references. Rather than hand-
 * maintain that order (and have it silently drift from schema.prisma as
 * tables are added), it is computed here via `pg_constraint` and a
 * standard Kahn topological sort. The global `users` table is
 * deliberately excluded — seed.ts looks up/reuses the SAME global user
 * rows by email across every company it seeds (including the real client
 * company), so deleting `users` here would risk deleting identity rows a
 * non-test company still depends on; only `company_memberships` (company-
 * scoped, safe to delete) ties a user to this test company, and removing
 * those rows is sufficient cleanup. Callers that created their OWN,
 * test-specific (never-shared) user rows should delete them explicitly
 * via `deleteTestUsers` below, after this function has removed the
 * `company_memberships` rows referencing them.
 */
export async function cleanupTestCompanies(executor: SqlExecutor, companyIds: string[]): Promise<void> {
  const ids = [...new Set(companyIds.filter(Boolean))];
  if (ids.length === 0) return;

  await executor.run(async (tx) => {
    const { rows: fkRows } = await tx.query<{ dependent: string; referenced: string }>(
      `SELECT DISTINCT conrelid::regclass::text AS dependent, confrelid::regclass::text AS referenced
         FROM pg_constraint
        WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
    );
    const { rows: tableRows } = await tx.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const { rows: companyIdColRows } = await tx.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'company_id'`,
    );
    const hasCompanyId = new Set(companyIdColRows.map((r) => r.table_name));

    const allTables = tableRows.map((r) => r.table_name).filter((n) => n !== "_prisma_migrations");
    const inDegree = new Map<string, number>(allTables.map((n) => [n, 0]));
    const edgesFrom = new Map<string, string[]>(allTables.map((n) => [n, []]));
    for (const { dependent, referenced } of fkRows) {
      if (dependent === referenced) continue;
      if (!edgesFrom.has(dependent) || !inDegree.has(referenced)) continue;
      edgesFrom.get(dependent)!.push(referenced);
      inDegree.set(referenced, (inDegree.get(referenced) ?? 0) + 1);
    }

    // Kahn's algorithm: a table with in-degree 0 has nothing still-
    // unprocessed depending on it, so it is safe to delete next; deleting
    // it "removes" its outgoing edges, which can drop a table it
    // references down to in-degree 0 in turn.
    const order: string[] = [];
    const queue = allTables.filter((n) => (inDegree.get(n) ?? 0) === 0);
    const remaining = new Map(inDegree);
    while (queue.length > 0) {
      const n = queue.shift()!;
      order.push(n);
      for (const ref of edgesFrom.get(n) ?? []) {
        const d = (remaining.get(ref) ?? 0) - 1;
        remaining.set(ref, d);
        if (d === 0) queue.push(ref);
      }
    }
    for (const n of allTables) if (!order.includes(n)) order.push(n); // defensive only — this schema has no FK cycles

    for (const table of order) {
      if (table === "users") continue; // global, intentionally never touched — see note above
      if (table === "companies") {
        await tx.query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [ids]);
      } else if (hasCompanyId.has(table)) {
        await tx.query(`DELETE FROM ${quoteIdent(table)} WHERE company_id = ANY($1::uuid[])`, [ids]);
      }
    }
  });
}

/**
 * Deletes specific `users` rows by id — ONLY safe for user rows a test
 * created itself with a test-specific, never-shared email (never for
 * `seed.ts`'s fixed `ROLE_EMAILS`, which are deliberately reused across
 * every company `seed()` populates). Call AFTER `cleanupTestCompanies`
 * has already removed the `company_memberships` rows referencing them.
 */
export async function deleteTestUsers(executor: SqlExecutor, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return;
  await executor.run((tx) => tx.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]));
}
