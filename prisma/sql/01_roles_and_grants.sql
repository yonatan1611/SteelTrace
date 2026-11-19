-- =============================================================================
-- SteelTrace — 01: Roles & table-level grants
--
-- Run this file AFTER `prisma migrate`/`db push` has created all 46 tables,
-- and BEFORE 02-06 (02's constraints reference these tables; 04/05's
-- SECURITY DEFINER functions must be owned by whichever role runs this
-- whole prisma/sql/ sequence — typically the DIRECT_URL role).
--
-- NOTE on ordering vs. the task's literal instruction: function EXECUTE
-- grants are issued at the END of 05_controlled_mutation_functions.sql, not
-- here — `GRANT EXECUTE ON FUNCTION x` requires `x` to already exist, and
-- those functions aren't created until 05 runs. Table-level grants/revokes
-- (this file's actual subject) have no such ordering dependency, since
-- every table already exists once Prisma's migration has run.
--
-- Two roles (§6, §13):
--   - steeltrace_app: the ordinary application role, used by Prisma Client
--     at runtime (DATABASE_URL). Operates under RLS (06). Has NO direct
--     INSERT/UPDATE/DELETE on any controlled/immutable table — only
--     EXECUTE on the controlled functions (05) and ordinary CRUD on true
--     master data.
--   - steeltrace_identity_service: the narrow role that is the ONLY one
--     ever granted INSERT on the global `users` table (§6). Used
--     exclusively by the identity-service code path (registration,
--     invitation acceptance) — never for ordinary, company-scoped requests.
-- =============================================================================

-- NEON NOTE: Neon's database-owner role (e.g. `neondb_owner`, whatever
-- role actually runs this migration — `current_user` below) is granted the
-- BYPASSRLS attribute by Neon itself, and is NOT a true cluster superuser.
-- BYPASSRLS is a role-level override that defeats RLS on EVERY table for
-- that role, including ones with `FORCE ROW LEVEL SECURITY` (06) — FORCE
-- only neutralizes the separate, weaker "table owner bypasses RLS on
-- tables it owns" behavior; it does nothing against a role that holds
-- BYPASSRLS outright. So the connected Neon role must never be the one
-- `tenantContext.ts`/`bootstrapSql.ts` issue tenant-scoped queries as —
-- every request must `SET LOCAL ROLE` into one of these two roles first,
-- neither of which has BYPASSRLS (explicit below, though it is already
-- Postgres's default for a freshly created role — spelled out so this
-- invariant can never be silently lost to a future default change).
-- Both are `NOLOGIN`: they are never connected to directly (no password is
-- ever issued for either) — only ever assumed via `SET LOCAL ROLE` by a
-- role that holds membership in them (granted below).
-- `ALTER ROLE ... NOLOGIN NOBYPASSRLS` runs unconditionally, not just in
-- the `CREATE` branch — this file is re-applied on every `sql:apply` run
-- (idempotent by design), and an earlier pass on this very database
-- created both roles as `LOGIN` (the prior edition's attribute, before the
-- Neon BYPASSRLS gap above was found); re-applying must correct that
-- drift, not just no-op because the role already exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steeltrace_app') THEN
    CREATE ROLE steeltrace_app;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steeltrace_identity_service') THEN
    CREATE ROLE steeltrace_identity_service;
  END IF;
  ALTER ROLE steeltrace_app NOLOGIN NOBYPASSRLS;
  ALTER ROLE steeltrace_identity_service NOLOGIN NOBYPASSRLS;
END;
$$;

-- BUG AVOIDED (found while setting up integration testing against a real
-- managed Postgres, Task 4): hosted providers (Neon included) do NOT give
-- their project-owner role true Postgres superuser, and `CREATE ROLE`
-- does not automatically grant the creator membership in the role it just
-- created — `SET ROLE steeltrace_app` from the deploying/admin role
-- failed outright with "permission denied to set role" until this grant
-- was added. Without it, nothing that needs to switch into these roles
-- for testing/diagnostics (including src/db/seed.ts and the integrity
-- test suite) can do so. Granted to `current_user` (whichever role is
-- running this migration) rather than a hardcoded name, for the same
-- reason the database name is resolved dynamically above.
DO $$
BEGIN
  EXECUTE format('GRANT steeltrace_app TO %I', current_user);
  EXECUTE format('GRANT steeltrace_identity_service TO %I', current_user);
END;
$$;

-- `GRANT ... ON DATABASE` takes a literal identifier, not an expression, so
-- this is done via dynamic SQL against `current_database()` — avoids
-- hardcoding Neon's per-project database name while still running cleanly
-- as-is (no manual edit required before applying this file).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO steeltrace_app, steeltrace_identity_service', current_database());
END;
$$;

GRANT USAGE ON SCHEMA public TO steeltrace_app, steeltrace_identity_service;

-- =============================================================================
-- Baseline: no privileges by default. Grant SELECT on every table (every
-- read goes through RLS, 06, regardless of role) ...
-- =============================================================================
GRANT SELECT ON ALL TABLES IN SCHEMA public TO steeltrace_app;

-- ... then REVOKE INSERT/UPDATE/DELETE from steeltrace_app on every table
-- that is controlled-function-only or otherwise restricted, even though no
-- such grant was ever given above — defensive/explicit, so a future
-- `GRANT ALL` elsewhere can never silently widen access here.
REVOKE INSERT, UPDATE, DELETE ON
  bundles,                            -- INSERT only via register_bundle; UPDATE (label corrections) IS allowed, re-granted below
  material_units,
  processing_operations,
  processing_inputs,
  processing_outputs,
  processing_output_sources,
  material_splits,
  material_hold_releases,
  conservation_adjustments,
  reclassification_events,
  project_allocations,
  material_transfers,
  material_transfer_lines,
  material_transfer_receipts,
  material_transfer_receipt_lines,
  physical_stock_counts,
  physical_stock_count_lines,
  installations,
  installation_lines,
  company_memberships,               -- INSERT only via identity-service; UPDATE (deactivation) re-granted below
  users                                -- INSERT/UPDATE handled entirely by RLS policies (06) + identity-service; see below
FROM steeltrace_app;

-- `bundles` is mutable master data (§15) EXCEPT for its creation — ordinary
-- label corrections remain an app-role UPDATE.
GRANT UPDATE ON bundles TO steeltrace_app;

-- `company_memberships.is_active`/`deactivated_*` toggled by an ordinary,
-- company-scoped admin UPDATE (§6) — `user_id`/`role_id`/`company_id` are
-- never touched again post-creation, but Postgres grants are table-level,
-- not column-level, for this one (kept simple; the §12 "never deleted,
-- never re-pointed" invariant is already enforced by there being no
-- controlled function that would ever do so, not by a column grant).
GRANT UPDATE ON company_memberships TO steeltrace_app;

-- `users`: no INSERT ever for steeltrace_app (§6's whole point). UPDATE is
-- granted at the table level but constrained to "my own row only" by the
-- `users_self_update` RLS policy (06) — the grant alone would allow any
-- row, RLS is what narrows it.
GRANT UPDATE ON users TO steeltrace_app;

-- `material_reservations` has no dedicated controlled function in this
-- design (§12's explicit no-grant list never names it) — creating a
-- reservation and later filling its `released_*` columns are both ordinary,
-- company-scoped app-role writes, validated by `trg_block_invalid_unit_reference`
-- (04) and the partial-unique/CHECK constraints (02).
GRANT INSERT, UPDATE ON material_reservations TO steeltrace_app;

-- Ordinary master data and engineering-takeoff tables: full CRUD except
-- DELETE (nothing in this schema is ever hard-deleted, §15).
--
-- GAP CLOSED, Task 6: `intended_usage_declarations` was in NEITHER this
-- list NOR the REVOKE list above — meaning `steeltrace_app` held only the
-- blanket baseline SELECT and had no legal way to INSERT a declaration or
-- UPDATE one to SUPERSEDED at all. Unlike `installations`'s supersede
-- chain (which touches `material_units.status`, and therefore genuinely
-- needs `supersede_installation`'s locking discipline), a declaration is
-- pure stated intent — it never locks or mutates any `material_units`
-- row — so an ordinary app-role INSERT/UPDATE (superseding = insert the
-- new row, then update the old row's `status`) is the correct write
-- path, exactly like `work_orders` beside it, not a new controlled
-- function.
GRANT INSERT, UPDATE ON
  companies, roles, projects, storage_locations, location_node_types, location_nodes,
  suppliers, manufacturers, structural_element_types, reinforcement_purposes,
  processing_operation_types, structural_element_instances,
  rebar_catalog_items, shape_codes,
  bundle_attribute_definitions, bundle_attribute_values,
  work_orders, bbs_schedules, bbs_lines, intended_usage_declarations,
  attachments
TO steeltrace_app;

-- `company_invitations`: created by an authorized member of the inviting
-- company (an ordinary request, §6) — INSERT granted. UPDATE is
-- column-restricted to `status` only (e.g. revoking an invitation);
-- `accepted_user_id`/`accepted_at`/the ACCEPTED transition are written
-- exclusively by the identity-service role during acceptance (§6).
GRANT INSERT ON company_invitations TO steeltrace_app;
GRANT UPDATE (status) ON company_invitations TO steeltrace_app;

-- `audit_log`: written only by `fn_audit_log_row_update` (04), which is
-- SECURITY DEFINER — steeltrace_app never writes here directly, SELECT only.

-- =============================================================================
-- steeltrace_identity_service (§6) — the one role with INSERT on `users`.
-- =============================================================================
GRANT SELECT, INSERT, UPDATE ON users TO steeltrace_identity_service;
GRANT SELECT, UPDATE ON company_memberships TO steeltrace_identity_service;
GRANT INSERT ON company_memberships TO steeltrace_identity_service;
GRANT SELECT, UPDATE ON company_invitations TO steeltrace_identity_service;
GRANT SELECT ON companies, roles TO steeltrace_identity_service;

-- No sequence/DELETE grants anywhere for either role — this schema uses
-- `gen_random_uuid()` defaults (no sequences), and nothing is ever deleted
-- (§15's "never deleted" posture, enforced here by simply never granting
-- DELETE at all, on any table, to either role).
