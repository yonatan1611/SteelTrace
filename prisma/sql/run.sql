-- =============================================================================
-- SteelTrace — hand-maintained SQL layer runner (psql)
--
-- Applies 01-06, in order, on top of an already-migrated schema
-- (`npx prisma migrate dev` / `npx prisma db push` must have run first —
-- this layer only ADDS what Prisma cannot express, §17; it never creates a
-- table or column itself).
--
-- Usage (run as the role that owns the migrated tables — typically the
-- DIRECT_URL role, NOT steeltrace_app):
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/sql/run.sql
--
-- Every script in this directory is idempotent (DROP-then-CREATE /
-- IF NOT EXISTS / IF EXISTS throughout), so re-running this file after a
-- schema change is always safe.
-- =============================================================================

\set ON_ERROR_STOP on

\echo '== 01: roles & grants (tables only — function EXECUTE grants are at the end of 05) =='
\ir 01_roles_and_grants.sql

\echo '== 02: CHECK constraints & partial indexes =='
\ir 02_constraints_and_partial_indexes.sql

\echo '== 03: helper & accounting functions =='
\ir 03_helper_and_accounting_functions.sql

\echo '== 04: validation & audit triggers =='
\ir 04_validation_and_audit_triggers.sql

\echo '== 05: controlled mutation functions (+ their EXECUTE grants) =='
\ir 05_controlled_mutation_functions.sql

\echo '== 06: Row-Level Security =='
\ir 06_rls_policies.sql

\echo '== Done. =='
