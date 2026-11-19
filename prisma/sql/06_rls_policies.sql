-- =============================================================================
-- SteelTrace — 06: Row-Level Security
--
-- Depends on: all 46 tables exist (Prisma migration), roles exist (01).
-- Run this LAST in the sequence — RLS applies the instant it's enabled, and
-- every other script in this directory expects to run with full visibility
-- (as the migration-owning role, which transparently bypasses RLS on
-- tables it owns UNLESS `FORCE ROW LEVEL SECURITY` is also set, §13 — which
-- is exactly why this file is last: nothing upstream of it depends on RLS
-- being active yet).
--
-- Tenant boundary (every one of the 44 tenant-CHILD tables; `companies`,
-- the one remaining tenant table, uses the analogous `id = ...` form
-- instead, just below the generic loop — see the note there):
--   USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
--   WITH CHECK — the same expression.
-- `NULLIF(..., true), '')` makes an unset session variable resolve to NULL
-- rather than erroring (`current_setting(..., true)` already returns NULL
-- for a missing GUC; the NULLIF additionally covers the "set to empty
-- string" case) — and `company_id = NULL` is never true, so a session with
-- no tenant context set sees (and can write) nothing, fail-closed by
-- construction, never fail-open.
--
-- Permission boundary (role/permission checks within a company) is
-- layered separately at the application level (§13) — RLS answers only
-- "can this session touch company X's rows at all."
-- =============================================================================

-- BUG AVOIDED (found while writing this): `companies` was originally in
-- the generic loop below, but `companies` has no `company_id` column at
-- all — it's the tenant ROOT; its own `id` IS the tenant key (every other
-- table's `company_id` is a FK to `companies.id`, §1). Running the generic
-- `company_id = ...` policy expression against it would fail outright
-- ("column company_id does not exist"). It gets its own policy, just
-- below the generic loop, comparing `id` instead.
DO $$
DECLARE
  v_table text;
  v_tenant_tables text[] := ARRAY[
    'attachments', 'audit_log', 'bbs_lines', 'bbs_schedules',
    'bundle_attribute_definitions', 'bundle_attribute_values', 'bundles',
    'company_invitations', 'company_memberships',
    'conservation_adjustments', 'installation_lines', 'installations',
    'intended_usage_declarations', 'location_node_types', 'location_nodes',
    'manufacturers', 'material_hold_releases', 'material_reservations',
    'material_splits', 'material_transfer_lines', 'material_transfer_receipt_lines',
    'material_transfer_receipts', 'material_transfers', 'material_unit_origins',
    'material_units', 'physical_stock_count_lines', 'physical_stock_counts',
    'processing_inputs', 'processing_operation_types', 'processing_operations',
    'processing_output_sources', 'processing_outputs', 'project_allocations',
    'projects', 'rebar_catalog_items', 'reclassification_events',
    'reinforcement_purposes', 'roles', 'shape_codes', 'storage_locations',
    'structural_element_instances', 'structural_element_types', 'suppliers',
    'work_orders'
  ];
BEGIN
  -- Sanity check: exactly 44 tenant-CHILD tables (every one of the 46
  -- models in prisma/schema.prisma except the global `users` table and
  -- `companies`, the tenant root, handled separately below — 44 + 1 + 1 = 46).
  IF array_length(v_tenant_tables, 1) <> 44 THEN
    RAISE EXCEPTION '06_rls_policies.sql: expected 44 tenant-child tables, got %  — update this list to match prisma/schema.prisma before proceeding', array_length(v_tenant_tables, 1);
  END IF;

  FOREACH v_table IN ARRAY v_tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_table);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', v_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I ' ||
      'USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid) ' ||
      'WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid)',
      v_table
    );
  END LOOP;
END;
$$;

-- =============================================================================
-- `companies` — the tenant root (see the BUG AVOIDED note above): a session
-- may see/touch only the one company row matching its OWN `id`, not a
-- `company_id` column (which doesn't exist on this table).
-- =============================================================================

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON companies;
CREATE POLICY tenant_isolation ON companies
  USING (id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- =============================================================================
-- The global `users` table (§6b) — membership-gated SELECT, self-only
-- UPDATE, no INSERT policy at all for the ordinary app role (it holds no
-- INSERT grant on `users` in the first place, 01).
-- =============================================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_visible_via_membership ON users;
CREATE POLICY users_visible_via_membership ON users
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM company_memberships cm
       WHERE cm.user_id = users.id
         AND cm.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS users_self_update ON users;
CREATE POLICY users_self_update ON users
  FOR UPDATE
  USING (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- `users_visible_via_membership` above requires an EXISTING membership in
-- the caller's current company — which is exactly backwards for the
-- identity-service's own job: resolving an email to an account BEFORE any
-- membership exists (a brand-new registrant has none at all, §6). Needs
-- its own, unrestricted-by-membership SELECT policy.
DROP POLICY IF EXISTS users_identity_service_select ON users;
CREATE POLICY users_identity_service_select ON users
  FOR SELECT TO steeltrace_identity_service
  USING (true);

-- BUG AVOIDED (found while writing this): RLS defaults to DENY, not ALLOW,
-- for any command with zero applicable policies — "no INSERT policy" does
-- NOT mean "INSERT is ungated," it means INSERT is BLOCKED FOR EVERYONE,
-- including `steeltrace_identity_service` despite its GRANT from 01 (the
-- grant and RLS are two independent gates; passing one does not bypass the
-- other). `steeltrace_app` never reaches RLS for INSERT on `users` at all
-- — it fails at the grant check first, since 01 gives it no INSERT grant
-- here — but `steeltrace_identity_service` DOES hold that grant, so it
-- needs an explicit policy or it would be denied by RLS right after
-- passing the grant check. Scoped with `TO steeltrace_identity_service`
-- so it grants nothing to any other role (`steeltrace_app` still has no
-- INSERT grant to even reach this policy).
DROP POLICY IF EXISTS users_identity_service_insert ON users;
CREATE POLICY users_identity_service_insert ON users
  FOR INSERT TO steeltrace_identity_service
  WITH CHECK (true);

-- Same reasoning for UPDATE: `users_self_update` above only ever matches
-- the *caller's own* `app.current_user_id` — useless for the
-- identity-service updating a *different* person's row during
-- registration/acceptance (e.g. toggling `is_active`). A second,
-- role-scoped UPDATE policy is required, independent of the self-update
-- one (Postgres ORs multiple permissive policies for the same command
-- together, so this does not narrow `users_self_update`'s effect for
-- `steeltrace_app` — it only adds a path for a different role).
DROP POLICY IF EXISTS users_identity_service_update ON users;
CREATE POLICY users_identity_service_update ON users
  FOR UPDATE TO steeltrace_identity_service
  USING (true)
  WITH CHECK (true);

-- NOTE on `company_memberships`/`company_invitations`/`companies`/`roles`
-- (tenant-scoped tables covered by the generic `tenant_isolation` policy
-- above, not a `users`-specific one): `steeltrace_identity_service` is NOT
-- given a bypass policy for any of these — instead, the identity-service
-- code path MUST `SET LOCAL app.current_company_id` to the specific
-- company it is reading/inserting/updating for (the invitation's
-- `company_id`) before that work, exactly like `withTenantContext` does
-- for ordinary requests (src/db/tenantContext.ts). This keeps the
-- identity-service's company-scoped reads/writes inside the SAME
-- tenant-isolation mechanism as everything else, rather than opening a
-- second, broader exception surface for a role that already has unusually
-- wide table-level grants. Only `users` — which has no `company_id`/`id`-
-- as-tenant-key concept to set a context against — needed the three
-- dedicated policies above.
--
-- ONE exception, added in Task 5 (§6a login): `POST /api/auth/login` must
-- return the caller's ACTIVE `company_memberships` ACROSS EVERY company
-- they belong to, before the login request itself can know which single
-- `company_id` to scope a context to — a chicken-and-egg the NOTE above's
-- "set the context to the specific company first" approach cannot solve,
-- since discovering those company ids IS the query being run. The single
-- exception below is scoped by `user_id`, not thrown open company-wide:
-- `steeltrace_identity_service` may SELECT a `company_memberships` row
-- only when it matches `app.current_user_id` (set by
-- `withIdentityServiceContext`'s optional `userId` context, exactly like
-- `app.current_company_id` elsewhere) — it still cannot see any OTHER
-- user's memberships, in any company. Once login has this row set (one
-- row per company the user belongs to), it resolves each membership's role
-- name/company name with a normal per-company-scoped query exactly as the
-- NOTE above describes — `roles`/`companies` get no equivalent exception.
DROP POLICY IF EXISTS company_memberships_identity_service_self ON company_memberships;
CREATE POLICY company_memberships_identity_service_self ON company_memberships
  FOR SELECT TO steeltrace_identity_service
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- A second exception, found running Task 5's own invitation-acceptance
-- endpoint against this schema for the first time: `POST /api/invitations
-- /accept` must look up a `company_invitations` row by `token_hash` ALONE
-- — exactly like login (above), it cannot know which `company_id` to
-- scope a context to until this very lookup tells it. Unlike the
-- `company_memberships` case, there is no caller identity to scope by
-- either (the invitee may not even have an account yet, §6) — the only
-- thing standing in for authorization here is possession of the
-- unguessable, cryptographically-random invite token itself, exactly as
-- it already is for `users_identity_service_select` above (identity-
-- service's whole job is cross-company identity resolution; the row-level
-- security boundary for its own narrow, trusted operations is "knows the
-- right token/email," not company membership). So this one policy is
-- unrestricted, same shape as `users_identity_service_select` — every
-- OTHER identity-service read/write against this table (e.g. marking an
-- invitation ACCEPTED once its company_id is known) still goes through
-- the ordinary per-company-scoped path the NOTE above describes.
DROP POLICY IF EXISTS company_invitations_identity_service_select ON company_invitations;
CREATE POLICY company_invitations_identity_service_select ON company_invitations
  FOR SELECT TO steeltrace_identity_service
  USING (true);
