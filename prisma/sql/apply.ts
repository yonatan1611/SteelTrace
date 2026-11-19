/**
 * SteelTrace — hand-maintained SQL layer runner (Node/pg).
 *
 * A `psql`-free alternative to run.sql, for environments where `psql`
 * isn't installed (CI runners, some Windows dev machines — including the
 * one this file was authored on). Applies 01-06, in strict order, each as
 * ONE multi-statement command via node-postgres's simple query protocol
 * (`Client.query(string)` with no parameters sends the whole string as-is,
 * exactly like `psql -f` does — this is required here because several of
 * these files define PL/pgSQL function bodies containing their own
 * internal semicolons inside `$$...$$` dollar-quoting, which a
 * split-on-semicolon approach would break).
 *
 * Usage:
 *   DIRECT_URL=postgresql://... npx tsx prisma/sql/apply.ts
 *   (or: npm run sql:apply)
 *
 * Must run against DIRECT_URL (unpooled), as the role that owns the
 * Prisma-migrated tables — never against DATABASE_URL/steeltrace_app.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { resolveDirectUrl } from "../../src/db/envUrls";

const FILES = [
  "01_roles_and_grants.sql",
  "02_constraints_and_partial_indexes.sql",
  "03_helper_and_accounting_functions.sql",
  "04_validation_and_audit_triggers.sql",
  "05_controlled_mutation_functions.sql",
  "06_rls_policies.sql",
] as const;

async function main(): Promise<void> {
  // Falls back to deriving a direct (unpooled) URL from DATABASE_URL (by
  // stripping Neon's `-pooler` host suffix) when DIRECT_URL isn't set —
  // see src/db/envUrls.ts.
  const connectionString = resolveDirectUrl();

  const client = new Client({ connectionString });
  await client.connect();

  try {
    for (const file of FILES) {
      const sql = readFileSync(join(__dirname, file), "utf8");
      process.stdout.write(`== ${file} ==\n`);
      await client.query(sql);
    }
    process.stdout.write("== Done. ==\n");
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
