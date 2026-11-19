-- =============================================================================
-- SteelTrace — 02: CHECK constraints & partial unique/performance indexes
--
-- Everything here is what Prisma cannot express natively
-- (docs/physical-database-design.md §17): CHECK constraints and PARTIAL
-- indexes. Idempotent: every statement either uses IF NOT EXISTS, or drops
-- the constraint/index first if it already exists, so this file can be
-- re-run safely after `prisma migrate`/`db push` recreates tables.
--
-- Depends on: prisma/schema.prisma already migrated (all 46 tables, 15
-- enums exist). Must run BEFORE 03/04/05/06 (helper functions and triggers
-- reference several of these constraints' invariants; 05's controlled
-- functions assume they hold).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper macro-ish idiom: add a CHECK constraint only if it doesn't exist yet.
-- Postgres has no native `ADD CONSTRAINT IF NOT EXISTS`, so every ADD CHECK
-- below is wrapped in a DO block that first drops any constraint of the same
-- name, then adds it — idempotent without relying on a non-existent clause.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- bundles (§4)
-- =============================================================================
ALTER TABLE bundles DROP CONSTRAINT IF EXISTS bundles_piece_count_positive_check;
ALTER TABLE bundles
  ADD CONSTRAINT bundles_piece_count_positive_check
  CHECK (
    piece_count > 0
    AND diameter_mm > 0
    AND bar_length_m > 0
    AND (actual_weight_kg IS NULL OR actual_weight_kg > 0)
  );

ALTER TABLE bundles DROP CONSTRAINT IF EXISTS bundles_grn_reference_check;
ALTER TABLE bundles
  ADD CONSTRAINT bundles_grn_reference_check
  CHECK (origin_type = 'OPENING_STOCK' OR grn_reference IS NOT NULL);

ALTER TABLE bundles DROP CONSTRAINT IF EXISTS bundles_approval_pair_check;
ALTER TABLE bundles
  ADD CONSTRAINT bundles_approval_pair_check
  CHECK ((approved_by_membership_id IS NULL) = (approved_at IS NULL));

-- Gap closed, Task 5: `bundles` approval (GRN maker-checker, CLAUDE.md
-- §2.19) is a deliberately ordinary mutable-master-data UPDATE, not routed
-- through `record_approval` (05's header comment on that function explains
-- why) — but every OTHER maker-checker table this schema has
-- (`reclassification_events`, `conservation_adjustments`, `bbs_schedules`)
-- already carries this exact self-approval CHECK alongside the pair check
-- above. `bundles` had the pair check but not this one — the same
-- structural, not-just-application-logic enforcement §2.5 demands for
-- conservation applies equally to maker != checker.
ALTER TABLE bundles DROP CONSTRAINT IF EXISTS bundles_approval_self_check;
ALTER TABLE bundles
  ADD CONSTRAINT bundles_approval_self_check
  CHECK (approved_by_membership_id IS NULL OR approved_by_membership_id <> registered_by_membership_id);

-- =============================================================================
-- material_units (§4)
-- =============================================================================
ALTER TABLE material_units DROP CONSTRAINT IF EXISTS material_units_positive_check;
ALTER TABLE material_units
  ADD CONSTRAINT material_units_positive_check
  CHECK (quantity_pieces > 0 AND total_length_m > 0);

ALTER TABLE material_units DROP CONSTRAINT IF EXISTS material_units_length_consistency_check;
ALTER TABLE material_units
  ADD CONSTRAINT material_units_length_consistency_check
  CHECK (unit_length_m IS NULL OR total_length_m = unit_length_m * quantity_pieces);

ALTER TABLE material_units DROP CONSTRAINT IF EXISTS material_units_weight_consistency_check;
ALTER TABLE material_units
  ADD CONSTRAINT material_units_weight_consistency_check
  CHECK (unit_weight_kg IS NULL OR total_weight_kg IS NULL OR total_weight_kg = unit_weight_kg * quantity_pieces);

ALTER TABLE material_units DROP CONSTRAINT IF EXISTS material_units_bundle_granularity_check;
ALTER TABLE material_units
  ADD CONSTRAINT material_units_bundle_granularity_check
  CHECK (granularity <> 'BUNDLE' OR classification = 'ORIGINAL');

ALTER TABLE material_units DROP CONSTRAINT IF EXISTS material_units_classification_status_check;
ALTER TABLE material_units
  ADD CONSTRAINT material_units_classification_status_check
  CHECK (classification NOT IN ('SCRAP', 'PENDING_RECONCILIATION') OR status NOT IN ('CONSUMED', 'INSTALLED'));

-- =============================================================================
-- bundle_attribute_values (§4)
-- =============================================================================
ALTER TABLE bundle_attribute_values DROP CONSTRAINT IF EXISTS bundle_attribute_values_one_value_check;
ALTER TABLE bundle_attribute_values
  ADD CONSTRAINT bundle_attribute_values_one_value_check
  CHECK (
    (CASE WHEN value_text IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN value_number IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN value_date IS NOT NULL THEN 1 ELSE 0 END) = 1
  );

ALTER TABLE bundle_attribute_definitions DROP CONSTRAINT IF EXISTS bundle_attribute_definitions_data_type_check;
ALTER TABLE bundle_attribute_definitions
  ADD CONSTRAINT bundle_attribute_definitions_data_type_check
  CHECK (data_type IN ('TEXT', 'NUMBER', 'DATE'));

-- =============================================================================
-- material_unit_origins & processing_output_sources — contribution_weight (§4, §9)
-- =============================================================================
ALTER TABLE material_unit_origins DROP CONSTRAINT IF EXISTS material_unit_origins_contribution_weight_check;
ALTER TABLE material_unit_origins
  ADD CONSTRAINT material_unit_origins_contribution_weight_check
  CHECK (contribution_weight IS NULL OR (contribution_weight > 0 AND contribution_weight <= 1));

ALTER TABLE processing_output_sources DROP CONSTRAINT IF EXISTS processing_output_sources_contribution_weight_check;
ALTER TABLE processing_output_sources
  ADD CONSTRAINT processing_output_sources_contribution_weight_check
  CHECK (contribution_weight IS NULL OR (contribution_weight > 0 AND contribution_weight <= 1));

-- =============================================================================
-- project_allocations (§5)
-- =============================================================================
ALTER TABLE project_allocations DROP CONSTRAINT IF EXISTS project_allocations_endpoint_check;
ALTER TABLE project_allocations
  ADD CONSTRAINT project_allocations_endpoint_check
  CHECK (from_project_id IS NOT NULL OR to_project_id IS NOT NULL);

ALTER TABLE project_allocations DROP CONSTRAINT IF EXISTS project_allocations_quantity_positive_check;
ALTER TABLE project_allocations
  ADD CONSTRAINT project_allocations_quantity_positive_check
  CHECK (quantity_pieces > 0 AND length_m > 0);

-- =============================================================================
-- processing_inputs (§9)
-- =============================================================================
ALTER TABLE processing_inputs DROP CONSTRAINT IF EXISTS processing_inputs_positive_check;
ALTER TABLE processing_inputs
  ADD CONSTRAINT processing_inputs_positive_check
  CHECK (
    quantity_consumed_pieces > 0
    AND length_consumed_m > 0
    AND (weight_consumed_kg IS NULL OR weight_consumed_kg > 0)
  );

-- =============================================================================
-- material_reservations (§9)
-- =============================================================================
ALTER TABLE material_reservations DROP CONSTRAINT IF EXISTS material_reservations_release_pair_check;
ALTER TABLE material_reservations
  ADD CONSTRAINT material_reservations_release_pair_check
  CHECK ((released_at IS NOT NULL) = (release_type IS NOT NULL));

-- =============================================================================
-- conservation_adjustments (§9) — three-way exclusive parent, non-zero amount,
-- and maker <> checker (same-row check, no trigger needed).
-- =============================================================================
ALTER TABLE conservation_adjustments DROP CONSTRAINT IF EXISTS conservation_adjustments_one_parent_check;
ALTER TABLE conservation_adjustments
  ADD CONSTRAINT conservation_adjustments_one_parent_check
  CHECK (
    (CASE WHEN processing_operation_id IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN material_transfer_line_id IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN physical_stock_count_line_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  );

ALTER TABLE conservation_adjustments DROP CONSTRAINT IF EXISTS conservation_adjustments_amount_nonzero_check;
ALTER TABLE conservation_adjustments
  ADD CONSTRAINT conservation_adjustments_amount_nonzero_check
  CHECK (amount <> 0);

ALTER TABLE conservation_adjustments DROP CONSTRAINT IF EXISTS conservation_adjustments_approval_pair_check;
ALTER TABLE conservation_adjustments
  ADD CONSTRAINT conservation_adjustments_approval_pair_check
  CHECK ((approved_by_membership_id IS NULL) = (approved_at IS NULL));

ALTER TABLE conservation_adjustments DROP CONSTRAINT IF EXISTS conservation_adjustments_maker_checker_check;
ALTER TABLE conservation_adjustments
  ADD CONSTRAINT conservation_adjustments_maker_checker_check
  CHECK (approved_by_membership_id IS NULL OR approved_by_membership_id <> recorded_by_membership_id);

-- =============================================================================
-- intended_usage_declarations (§9)
-- =============================================================================
-- BUG FIXED, Task 6: this was a strict XOR — `<>` between the two
-- NOT-NULL tests demands exactly one of processing_operation_id/
-- processing_output_id be set, meaning NEITHER could ever be null
-- simultaneously. That silently made it impossible to create the one
-- declaration CLAUDE.md §2.7 explicitly requires: a worker declaring
-- intended element/location/purpose "to a supervisor BEFORE processing"
-- — at that moment, by definition, no processing_operation or
-- processing_output row exists yet to reference. Found running Task 6's
-- own "declare intended usage, then process/install against it" flow for
-- the first time; every CHECK/trigger in this schema having been
-- exercised by at least one real write before now, this one simply never
-- was. Relaxed to "never reference both at once" (a declaration tied to
-- an operation AND its own output simultaneously is still nonsensical)
-- while allowing "references neither yet" — the early-declaration case.
ALTER TABLE intended_usage_declarations DROP CONSTRAINT IF EXISTS intended_usage_declarations_one_level_check;
ALTER TABLE intended_usage_declarations
  ADD CONSTRAINT intended_usage_declarations_one_level_check
  CHECK (NOT (processing_operation_id IS NOT NULL AND processing_output_id IS NOT NULL));

ALTER TABLE intended_usage_declarations DROP CONSTRAINT IF EXISTS intended_usage_declarations_target_check;
ALTER TABLE intended_usage_declarations
  ADD CONSTRAINT intended_usage_declarations_target_check
  CHECK (structural_element_type_id IS NOT NULL OR structural_element_instance_id IS NOT NULL);

-- =============================================================================
-- reclassification_events (§9) — approval pair + maker <> checker.
-- The (from_classification, to_classification) transition validity is
-- enforced by a trigger (04), not a CHECK, because it must also confirm the
-- unit's *current* classification matches `from_classification` — a
-- cross-row read a CHECK constraint cannot perform.
-- =============================================================================
ALTER TABLE reclassification_events DROP CONSTRAINT IF EXISTS reclassification_events_approval_pair_check;
ALTER TABLE reclassification_events
  ADD CONSTRAINT reclassification_events_approval_pair_check
  CHECK ((approved_by_membership_id IS NULL) = (approved_at IS NULL));

ALTER TABLE reclassification_events DROP CONSTRAINT IF EXISTS reclassification_events_maker_checker_check;
ALTER TABLE reclassification_events
  ADD CONSTRAINT reclassification_events_maker_checker_check
  CHECK (approved_by_membership_id IS NULL OR approved_by_membership_id <> recorded_by_membership_id);

-- =============================================================================
-- bbs_schedules (§9a) — approval pair + maker <> checker.
-- =============================================================================
ALTER TABLE bbs_schedules DROP CONSTRAINT IF EXISTS bbs_schedules_approval_pair_check;
ALTER TABLE bbs_schedules
  ADD CONSTRAINT bbs_schedules_approval_pair_check
  CHECK ((approved_by_membership_id IS NULL) = (approved_at IS NULL));

ALTER TABLE bbs_schedules DROP CONSTRAINT IF EXISTS bbs_schedules_maker_checker_check;
ALTER TABLE bbs_schedules
  ADD CONSTRAINT bbs_schedules_maker_checker_check
  CHECK (approved_by_membership_id IS NULL OR approved_by_membership_id <> prepared_by_membership_id);

-- =============================================================================
-- bbs_lines (§9a)
-- =============================================================================
ALTER TABLE bbs_lines DROP CONSTRAINT IF EXISTS bbs_lines_target_check;
ALTER TABLE bbs_lines
  ADD CONSTRAINT bbs_lines_target_check
  CHECK (structural_element_type_id IS NOT NULL OR structural_element_instance_id IS NOT NULL);

ALTER TABLE bbs_lines DROP CONSTRAINT IF EXISTS bbs_lines_quantity_check;
ALTER TABLE bbs_lines
  ADD CONSTRAINT bbs_lines_quantity_check
  CHECK (
    cut_length_m > 0
    AND bars_per_member > 0
    AND member_count > 0
    AND total_bars_required = bars_per_member * member_count
  );

-- =============================================================================
-- rebar_catalog_items (§3a)
-- =============================================================================
ALTER TABLE rebar_catalog_items DROP CONSTRAINT IF EXISTS rebar_catalog_items_positive_check;
ALTER TABLE rebar_catalog_items
  ADD CONSTRAINT rebar_catalog_items_positive_check
  CHECK (diameter_mm > 0 AND linear_density_kg_per_m > 0);

-- =============================================================================
-- physical_stock_counts / physical_stock_count_lines (§9b)
-- =============================================================================
ALTER TABLE physical_stock_counts DROP CONSTRAINT IF EXISTS physical_stock_counts_verify_pair_check;
ALTER TABLE physical_stock_counts
  ADD CONSTRAINT physical_stock_counts_verify_pair_check
  CHECK ((verified_by_membership_id IS NULL) = (verified_at IS NULL));

ALTER TABLE physical_stock_counts DROP CONSTRAINT IF EXISTS physical_stock_counts_maker_checker_check;
ALTER TABLE physical_stock_counts
  ADD CONSTRAINT physical_stock_counts_maker_checker_check
  CHECK (verified_by_membership_id IS NULL OR verified_by_membership_id <> counted_by_membership_id);

ALTER TABLE physical_stock_count_lines DROP CONSTRAINT IF EXISTS physical_stock_count_lines_variance_check;
ALTER TABLE physical_stock_count_lines
  ADD CONSTRAINT physical_stock_count_lines_variance_check
  CHECK (variance_length_m = counted_length_m - system_length_m);

-- =============================================================================
-- material_transfers (§11)
-- =============================================================================
ALTER TABLE material_transfers DROP CONSTRAINT IF EXISTS material_transfers_endpoints_distinct_check;
ALTER TABLE material_transfers
  ADD CONSTRAINT material_transfers_endpoints_distinct_check
  CHECK (from_location_id <> to_location_id);

-- =============================================================================
-- installations / installation_lines (§11a)
-- =============================================================================
ALTER TABLE installations DROP CONSTRAINT IF EXISTS installations_verify_pair_check;
ALTER TABLE installations
  ADD CONSTRAINT installations_verify_pair_check
  CHECK ((verified_by_membership_id IS NULL) = (verified_at IS NULL));

ALTER TABLE installations DROP CONSTRAINT IF EXISTS installations_maker_checker_check;
ALTER TABLE installations
  ADD CONSTRAINT installations_maker_checker_check
  CHECK (verified_by_membership_id IS NULL OR verified_by_membership_id <> installed_by_membership_id);

-- =============================================================================
-- processing_operations (§9) — maker <> checker.
-- =============================================================================
ALTER TABLE processing_operations DROP CONSTRAINT IF EXISTS processing_operations_maker_checker_check;
ALTER TABLE processing_operations
  ADD CONSTRAINT processing_operations_maker_checker_check
  CHECK (checked_by_membership_id IS NULL OR checked_by_membership_id <> performed_by_membership_id);

-- =============================================================================
-- attachments (§15)
-- =============================================================================
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_file_size_positive_check;
ALTER TABLE attachments
  ADD CONSTRAINT attachments_file_size_positive_check
  CHECK (file_size_bytes > 0);

-- =============================================================================
-- Partial unique indexes (§1, §4, §9, §11, §18) — not expressible via
-- Prisma's `@@unique`, which has no WHERE clause.
-- =============================================================================

DROP INDEX IF EXISTS users_auth_provider_subject_unique;
CREATE UNIQUE INDEX users_auth_provider_subject_unique
  ON users (auth_provider, auth_provider_subject_id)
  WHERE auth_provider_subject_id IS NOT NULL;

DROP INDEX IF EXISTS material_units_internal_reference_code_unique;
CREATE UNIQUE INDEX material_units_internal_reference_code_unique
  ON material_units (company_id, internal_reference_code)
  WHERE internal_reference_code IS NOT NULL;

DROP INDEX IF EXISTS material_units_unallocated_available_idx;
CREATE INDEX material_units_unallocated_available_idx
  ON material_units (company_id)
  WHERE project_id IS NULL AND status = 'AVAILABLE';

DROP INDEX IF EXISTS processing_operations_idempotency_key_unique;
CREATE UNIQUE INDEX processing_operations_idempotency_key_unique
  ON processing_operations (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP INDEX IF EXISTS material_transfers_idempotency_key_unique;
CREATE UNIQUE INDEX material_transfers_idempotency_key_unique
  ON material_transfers (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP INDEX IF EXISTS material_reservations_active_unique;
CREATE UNIQUE INDEX material_reservations_active_unique
  ON material_reservations (company_id, material_unit_id)
  WHERE released_at IS NULL;

-- NOTE: `installations` (§11a's canonical definition) has no
-- `idempotency_key` column — unlike `processing_operations`/
-- `material_transfers`, `install_material`'s retry-safety (§12) relies on
-- `InstallationLine`'s unique `(company_id, installation_id, material_unit_id)`
-- plus "a unit already `INSTALLED` fails `install_material`'s own
-- precondition" rather than a client-supplied idempotency key. No partial
-- index needed here.
