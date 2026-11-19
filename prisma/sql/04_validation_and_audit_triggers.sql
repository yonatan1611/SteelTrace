-- =============================================================================
-- SteelTrace — 04: Self-locking validation triggers & audit log
--
-- Depends on: 02 (CHECK constraints — maker<>checker and approval-pair
-- checks are implemented there as plain same-row CHECKs, NOT as triggers,
-- since they need no cross-row context; see the note before §5 below), 03
-- (spec_compare, spec_compare_units).
--
-- Ownership note: every function below that must write to a table the
-- ordinary `steeltrace_app` role has no grant on (audit_log inserts; the
-- conservation/shape "validate-only" triggers never write, so this applies
-- only to `fn_audit_log_row_update`) is declared SECURITY DEFINER. It will
-- run as whatever role actually executes this migration script (the owner
-- of the tables it touches) — run this file as that owning role, never as
-- `steeltrace_app` itself.
-- =============================================================================

-- =============================================================================
-- §1 — Normalization triggers (grade_normalized / standard_normalized)
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_normalize_bundle_spec() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.grade_normalized := upper(trim(NEW.grade));
  NEW.standard_normalized := NULLIF(upper(trim(COALESCE(NEW.standard, ''))), '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_bundle_spec ON bundles;
CREATE TRIGGER trg_normalize_bundle_spec
  BEFORE INSERT OR UPDATE ON bundles
  FOR EACH ROW
  EXECUTE FUNCTION fn_normalize_bundle_spec();

CREATE OR REPLACE FUNCTION fn_normalize_material_unit_spec() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.grade_normalized := upper(trim(NEW.grade));
  NEW.standard_normalized := NULLIF(upper(trim(COALESCE(NEW.standard, ''))), '');
  RETURN NEW;
END;
$$;

-- BEFORE INSERT only (not UPDATE) — grade/standard are inherited at
-- creation and immutable thereafter (§4, §10 of data-model.md).
DROP TRIGGER IF EXISTS trg_normalize_material_unit_spec ON material_units;
CREATE TRIGGER trg_normalize_material_unit_spec
  BEFORE INSERT ON material_units
  FOR EACH ROW
  EXECUTE FUNCTION fn_normalize_material_unit_spec();

-- `bbs_lines` has only a `grade_normalized` column (no separate raw
-- `grade` field, §9a) — this trigger self-normalizes whatever value was
-- entered into that one column, in place.
CREATE OR REPLACE FUNCTION fn_normalize_bbs_line_grade() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.grade_normalized := upper(trim(NEW.grade_normalized));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_bbs_line_grade ON bbs_lines;
CREATE TRIGGER trg_normalize_bbs_line_grade
  BEFORE INSERT ON bbs_lines
  FOR EACH ROW
  EXECUTE FUNCTION fn_normalize_bbs_line_grade();

-- `rebar_catalog_items.default_grade`/`default_standard` have no separate
-- normalized pair either — unlike `bundles`/`material_units`, this is
-- company-authored reference data, not a verbatim-preserved supplier label
-- transcription (§8's "original label values are always preserved"
-- principle applies to *labels*, not to a company's own catalog), so
-- normalizing in place (rather than preserving a second "as typed" copy)
-- is the right tradeoff here.
CREATE OR REPLACE FUNCTION fn_normalize_rebar_catalog_item_spec() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.default_grade IS NOT NULL THEN
    NEW.default_grade := upper(trim(NEW.default_grade));
  END IF;
  IF NEW.default_standard IS NOT NULL THEN
    NEW.default_standard := NULLIF(upper(trim(NEW.default_standard)), '');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_rebar_catalog_item_spec ON rebar_catalog_items;
CREATE TRIGGER trg_normalize_rebar_catalog_item_spec
  BEFORE INSERT ON rebar_catalog_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_normalize_rebar_catalog_item_spec();

-- =============================================================================
-- §2 — Block invalid material_unit references (self-locking)
--
-- material_reservations and installation_lines both use the column name
-- `material_unit_id`, so one generic trigger function covers both. (
-- `processing_inputs` gets its OWN, richer validation function in §3 below
-- — it additionally needs the location-match and spec-uniformity checks,
-- which the other two tables don't.)
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_block_invalid_unit_reference() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status         material_status_enum;
  v_classification material_classification_enum;
BEGIN
  -- Self-lock first (§12's defense-in-depth: a validation trigger locks the
  -- row it is about to validate as its own first action).
  SELECT status, classification
    INTO v_status, v_classification
    FROM material_units
   WHERE company_id = NEW.company_id AND id = NEW.material_unit_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '% references material_unit % which does not exist for company %',
      TG_TABLE_NAME, NEW.material_unit_id, NEW.company_id;
  END IF;

  IF v_status IN ('ON_HOLD', 'CONSUMED', 'INSTALLED') THEN
    -- GAP CLOSED, Task 6: `supersede_installation` (05) legitimately
    -- inserts a NEW `installation_lines` row referencing a unit that is
    -- ALREADY `INSTALLED` — correcting which element/purpose record a
    -- unit is attributed to never touches `material_units.status` at
    -- all (05's own header comment on that function explains why), so
    -- the blanket "never reference an INSTALLED unit" rule below —
    -- correct for blocking `install_material` from re-installing
    -- something already spoken-for — must not ALSO block this case.
    -- Scoped narrowly: only when the new row's own installation is a
    -- supersede of a prior installation that this EXACT unit was
    -- already part of (never a blanket bypass for any INSTALLED unit).
    IF TG_TABLE_NAME = 'installation_lines' AND v_status = 'INSTALLED' THEN
      PERFORM 1
        FROM installations new_i
        JOIN installation_lines old_il
          ON old_il.company_id = new_i.company_id AND old_il.installation_id = new_i.supersedes_id
       WHERE new_i.company_id = NEW.company_id AND new_i.id = NEW.installation_id
         AND new_i.supersedes_id IS NOT NULL
         AND old_il.material_unit_id = NEW.material_unit_id;
      IF FOUND THEN
        RETURN NEW;
      END IF;
    END IF;

    RAISE EXCEPTION '% cannot reference material_unit % — status is %',
      TG_TABLE_NAME, NEW.material_unit_id, v_status;
  END IF;

  IF v_classification IN ('SCRAP', 'PENDING_RECONCILIATION') THEN
    RAISE EXCEPTION '% cannot reference material_unit % — classification is %',
      TG_TABLE_NAME, NEW.material_unit_id, v_classification;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_invalid_unit_reference ON material_reservations;
CREATE TRIGGER trg_block_invalid_unit_reference
  BEFORE INSERT ON material_reservations
  FOR EACH ROW
  EXECUTE FUNCTION fn_block_invalid_unit_reference();

DROP TRIGGER IF EXISTS trg_block_invalid_unit_reference ON installation_lines;
CREATE TRIGGER trg_block_invalid_unit_reference
  BEFORE INSERT ON installation_lines
  FOR EACH ROW
  EXECUTE FUNCTION fn_block_invalid_unit_reference();

-- =============================================================================
-- §3 — processing_inputs validation: status/classification block, location
-- match, and (when the operation type requires it) spec uniformity against
-- every sibling input already recorded for the same operation.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_validate_processing_input() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status                     material_status_enum;
  v_classification             material_classification_enum;
  v_unit_location               uuid;
  v_operation_location          uuid;
  v_requires_uniform_input_spec boolean;
  v_mismatch_count               integer;
BEGIN
  -- Self-lock the unit first.
  SELECT status, classification, current_storage_location_id
    INTO v_status, v_classification, v_unit_location
    FROM material_units
   WHERE company_id = NEW.company_id AND id = NEW.material_unit_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'processing_inputs references material_unit % which does not exist for company %',
      NEW.material_unit_id, NEW.company_id;
  END IF;

  IF v_status IN ('ON_HOLD', 'CONSUMED', 'INSTALLED') THEN
    RAISE EXCEPTION 'processing_inputs cannot reference material_unit % — status is %', NEW.material_unit_id, v_status;
  END IF;

  IF v_classification IN ('SCRAP', 'PENDING_RECONCILIATION') THEN
    RAISE EXCEPTION 'processing_inputs cannot reference material_unit % — classification is %', NEW.material_unit_id, v_classification;
  END IF;

  -- Location match: material must already be at the operation's processing
  -- area (brought there by a prior MaterialTransfer, §9/§11).
  SELECT po.storage_location_id, pot.requires_uniform_input_spec
    INTO v_operation_location, v_requires_uniform_input_spec
    FROM processing_operations po
    JOIN processing_operation_types pot
      ON pot.company_id = po.company_id AND pot.id = po.operation_type_id
   WHERE po.company_id = NEW.company_id AND po.id = NEW.processing_operation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'processing_inputs references processing_operation % which does not exist for company %',
      NEW.processing_operation_id, NEW.company_id;
  END IF;

  IF v_unit_location IS DISTINCT FROM v_operation_location THEN
    RAISE EXCEPTION 'processing_inputs: material_unit % is not at the operation''s storage_location %',
      NEW.material_unit_id, v_operation_location;
  END IF;

  -- Operation input-uniformity (§8): every pair of processing_inputs in the
  -- operation must be spec_compare(...) = CONFIRMED_MATCH. Checked
  -- incrementally against every sibling already recorded for this
  -- operation — transitively covers all pairs as inputs accumulate.
  IF v_requires_uniform_input_spec THEN
    SELECT count(*) INTO v_mismatch_count
      FROM processing_inputs pi
     WHERE pi.company_id = NEW.company_id
       AND pi.processing_operation_id = NEW.processing_operation_id
       AND pi.id <> NEW.id
       AND spec_compare_units(NEW.company_id, NEW.material_unit_id, pi.material_unit_id) <> 'CONFIRMED_MATCH';

    IF v_mismatch_count > 0 THEN
      RAISE EXCEPTION 'processing_inputs: material_unit % is not spec-compatible with % existing input(s) already on processing_operation % (requires_uniform_input_spec = true)',
        NEW.material_unit_id, v_mismatch_count, NEW.processing_operation_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_processing_input ON processing_inputs;
CREATE TRIGGER trg_validate_processing_input
  BEFORE INSERT ON processing_inputs
  FOR EACH ROW
  EXECUTE FUNCTION fn_validate_processing_input();

-- Operation's storage_location must itself be a PROCESSING_AREA.
CREATE OR REPLACE FUNCTION fn_validate_processing_operation_location() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_location_type location_type_enum;
BEGIN
  SELECT location_type INTO v_location_type
    FROM storage_locations
   WHERE company_id = NEW.company_id AND id = NEW.storage_location_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'processing_operations references storage_location % which does not exist for company %',
      NEW.storage_location_id, NEW.company_id;
  END IF;

  IF v_location_type <> 'PROCESSING_AREA' THEN
    RAISE EXCEPTION 'processing_operations.storage_location_id % must be a PROCESSING_AREA, got %',
      NEW.storage_location_id, v_location_type;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_processing_operation_location ON processing_operations;
CREATE TRIGGER trg_validate_processing_operation_location
  BEFORE INSERT OR UPDATE OF storage_location_id ON processing_operations
  FOR EACH ROW
  EXECUTE FUNCTION fn_validate_processing_operation_location();

-- =============================================================================
-- §4 — processing_outputs: the 4 valid (attribution_mode,
-- processing_output_sources) shapes, plus named-source spec consistency and
-- the POOLED non-empty-candidate-set rule (§8, §10).
--
-- Deferred constraint trigger: fires at COMMIT (or an explicit
-- `SET CONSTRAINTS ... IMMEDIATE`), by which point every
-- processing_output_sources row the same transaction will ever insert for
-- this output already exists — the only way to correctly validate the
-- POOLED shape too (zero source rows is itself a valid, checkable state).
--
-- Named-source consistency note: for the "named sources must be spec-
-- consistent with the output" check, this uses a plain equality comparison
-- (treating NULL standard = NULL standard as consistent) rather than the
-- policy-gated `spec_compare()`. Reason found while implementing this:
-- `spec_compare()` returns 'UNKNOWN' — never 'CONFIRMED_MATCH' — whenever
-- EITHER side's standard is NULL, by design (§8's "a missing standard must
-- not be treated as evidence of compatibility" policy, for deciding whether
-- to COMBINE two independently-arrived-at records). But a processing
-- output's spec is always copied verbatim from its own source(s) by the
-- creating function (`record_processing_operation`, §12) — so comparing a
-- source to the output it itself produced is not "should we combine two
-- unrelated things," it is "does the output's spec actually match where it
-- came from," where two NULLs on both sides legitimately means the same
-- thing (the standard was never known, consistently). Applying the
-- policy-gated function here would incorrectly reject the ordinary,
-- single-source EXACT case whenever `standard` is simply unrecorded. The
-- POOLED candidate-set check below is the opposite case (deciding whether
-- an independent input should be treated as compatible with the pooled
-- output) and correctly DOES use the policy-gated `spec_compare()`, per
-- §8's literal statement.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_validate_output_shape() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_count     integer;
  v_null_weight_count integer;
  v_weight_sum        numeric;
  v_candidate_count    integer;
  v_inconsistent_count  integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE contribution_weight IS NULL),
         COALESCE(SUM(contribution_weight), 0)
    INTO v_source_count, v_null_weight_count, v_weight_sum
    FROM processing_output_sources
   WHERE company_id = NEW.company_id AND processing_output_id = NEW.id;

  IF NEW.attribution_mode = 'EXACT' THEN
    IF v_source_count <> 1 THEN
      RAISE EXCEPTION 'processing_output %: EXACT attribution requires exactly 1 source row, found %', NEW.id, v_source_count;
    END IF;
    IF v_weight_sum <> 1 THEN
      RAISE EXCEPTION 'processing_output %: EXACT attribution requires contribution_weight = 1', NEW.id;
    END IF;

  ELSIF NEW.attribution_mode = 'KNOWN_PARTIAL' THEN
    IF v_source_count < 1 THEN
      RAISE EXCEPTION 'processing_output %: KNOWN_PARTIAL attribution requires at least 1 source row', NEW.id;
    END IF;
    IF v_null_weight_count NOT IN (0, v_source_count) THEN
      RAISE EXCEPTION 'processing_output %: KNOWN_PARTIAL attribution requires all source weights populated or all null, not a mix', NEW.id;
    END IF;
    IF v_null_weight_count = 0 AND v_weight_sum <> 1 THEN
      RAISE EXCEPTION 'processing_output %: KNOWN_PARTIAL weighted attribution must sum to 1, got %', NEW.id, v_weight_sum;
    END IF;

  ELSIF NEW.attribution_mode = 'POOLED' THEN
    IF v_source_count <> 0 THEN
      RAISE EXCEPTION 'processing_output %: POOLED attribution must have zero processing_output_sources rows, found %', NEW.id, v_source_count;
    END IF;

    SELECT count(*) INTO v_candidate_count
      FROM processing_inputs pi
      JOIN material_units su ON su.company_id = pi.company_id AND su.id = pi.material_unit_id
      JOIN material_units ou ON ou.company_id = NEW.company_id AND ou.id = NEW.material_unit_id
     WHERE pi.company_id = NEW.company_id
       AND pi.processing_operation_id = NEW.processing_operation_id
       AND spec_compare(su.diameter_mm, su.surface_type, su.grade_normalized, su.standard_normalized,
                         ou.diameter_mm, ou.surface_type, ou.grade_normalized, ou.standard_normalized) = 'CONFIRMED_MATCH';

    IF v_candidate_count = 0 THEN
      RAISE EXCEPTION 'processing_output %: POOLED attribution candidate set (spec-matching operation inputs) is empty', NEW.id;
    END IF;

  ELSE
    RAISE EXCEPTION 'processing_output %: unknown attribution_mode %', NEW.id, NEW.attribution_mode;
  END IF;

  -- Named-source spec consistency (EXACT/KNOWN_PARTIAL only) — see the
  -- header comment above for why this is a plain, null-tolerant equality
  -- check rather than a call to the policy-gated spec_compare().
  IF NEW.attribution_mode IN ('EXACT', 'KNOWN_PARTIAL') THEN
    SELECT count(*) INTO v_inconsistent_count
      FROM processing_output_sources pos
      JOIN processing_inputs pi ON pi.company_id = pos.company_id AND pi.id = pos.processing_input_id
      JOIN material_units su ON su.company_id = pi.company_id AND su.id = pi.material_unit_id
      JOIN material_units ou ON ou.company_id = NEW.company_id AND ou.id = NEW.material_unit_id
     WHERE pos.company_id = NEW.company_id
       AND pos.processing_output_id = NEW.id
       AND NOT (
         su.diameter_mm = ou.diameter_mm
         AND su.surface_type = ou.surface_type
         AND su.grade_normalized = ou.grade_normalized
         AND su.standard_normalized IS NOT DISTINCT FROM ou.standard_normalized
       );

    IF v_inconsistent_count > 0 THEN
      RAISE EXCEPTION 'processing_output %: % named source(s) are spec-inconsistent with the output they produced', NEW.id, v_inconsistent_count;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_output_shape ON processing_outputs;
CREATE CONSTRAINT TRIGGER trg_validate_output_shape
  AFTER INSERT ON processing_outputs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION fn_validate_output_shape();

-- =============================================================================
-- §5 — Conservation ceilings (§10, §11): Σoutputs <= Σinputs + Σadjustments
-- for a processing_operation; Σ(received, any disposition) + Σ(positive
-- adjustments) <= dispatched for a material_transfer_line. Both deferred,
-- for the same reason as §4 above (adjustments and the thing they adjust
-- can be inserted in either order within one atomic controlled-function
-- call).
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_check_processing_conservation(p_company_id uuid, p_operation_id uuid) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_inputs      numeric(10,3);
  v_outputs     numeric(10,3);
  v_adjustments numeric(10,3);
BEGIN
  SELECT COALESCE(SUM(length_consumed_m), 0) INTO v_inputs
    FROM processing_inputs
   WHERE company_id = p_company_id AND processing_operation_id = p_operation_id;

  SELECT COALESCE(SUM(mu.total_length_m), 0) INTO v_outputs
    FROM processing_outputs po
    JOIN material_units mu ON mu.company_id = po.company_id AND mu.id = po.material_unit_id
   WHERE po.company_id = p_company_id AND po.processing_operation_id = p_operation_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_adjustments
    FROM conservation_adjustments
   WHERE company_id = p_company_id AND processing_operation_id = p_operation_id;

  IF v_outputs > v_inputs + v_adjustments THEN
    RAISE EXCEPTION 'processing_operation %: outputs (%) exceed inputs (%) plus adjustments (%)',
      p_operation_id, v_outputs, v_inputs, v_adjustments;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION fn_trg_processing_conservation_from_output() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM fn_check_processing_conservation(NEW.company_id, NEW.processing_operation_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_processing_conservation_from_output ON processing_outputs;
CREATE CONSTRAINT TRIGGER trg_processing_conservation_from_output
  AFTER INSERT ON processing_outputs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_processing_conservation_from_output();

CREATE OR REPLACE FUNCTION fn_trg_processing_conservation_from_adjustment() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.processing_operation_id IS NOT NULL THEN
    PERFORM fn_check_processing_conservation(NEW.company_id, NEW.processing_operation_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_processing_conservation_from_adjustment ON conservation_adjustments;
CREATE CONSTRAINT TRIGGER trg_processing_conservation_from_adjustment
  AFTER INSERT ON conservation_adjustments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_processing_conservation_from_adjustment();

CREATE OR REPLACE FUNCTION fn_check_transfer_line_conservation(p_company_id uuid, p_transfer_line_id uuid) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_placeholder_total    numeric(10,3);
  v_received_total        numeric(10,3);
  v_positive_adjustments   numeric(10,3);
BEGIN
  SELECT mu.total_length_m INTO v_placeholder_total
    FROM material_transfer_lines mtl
    JOIN material_units mu ON mu.company_id = mtl.company_id AND mu.id = mtl.material_unit_id
   WHERE mtl.company_id = p_company_id AND mtl.id = p_transfer_line_id;

  IF v_placeholder_total IS NULL THEN
    RAISE EXCEPTION 'material_transfer_line % not found for company %', p_transfer_line_id, p_company_id;
  END IF;

  -- Summed across every disposition indiscriminately (§11) — a damaged or
  -- held portion still physically arrived and is still accounted for.
  SELECT COALESCE(SUM(mu.total_length_m), 0) INTO v_received_total
    FROM material_transfer_receipt_lines mtrl
    JOIN material_units mu ON mu.company_id = mtrl.company_id AND mu.id = mtrl.resulting_material_unit_id
   WHERE mtrl.company_id = p_company_id AND mtrl.material_transfer_line_id = p_transfer_line_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_positive_adjustments
    FROM conservation_adjustments
   WHERE company_id = p_company_id AND material_transfer_line_id = p_transfer_line_id AND amount > 0;

  IF v_received_total + v_positive_adjustments > v_placeholder_total THEN
    RAISE EXCEPTION 'material_transfer_line %: received (%) plus positive adjustments (%) exceed dispatched (%)',
      p_transfer_line_id, v_received_total, v_positive_adjustments, v_placeholder_total;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION fn_trg_transfer_line_conservation_from_receipt() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM fn_check_transfer_line_conservation(NEW.company_id, NEW.material_transfer_line_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_transfer_line_conservation_from_receipt ON material_transfer_receipt_lines;
CREATE CONSTRAINT TRIGGER trg_transfer_line_conservation_from_receipt
  AFTER INSERT ON material_transfer_receipt_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_transfer_line_conservation_from_receipt();

CREATE OR REPLACE FUNCTION fn_trg_transfer_line_conservation_from_adjustment() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.material_transfer_line_id IS NOT NULL THEN
    PERFORM fn_check_transfer_line_conservation(NEW.company_id, NEW.material_transfer_line_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_transfer_line_conservation_from_adjustment ON conservation_adjustments;
CREATE CONSTRAINT TRIGGER trg_transfer_line_conservation_from_adjustment
  AFTER INSERT ON conservation_adjustments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_transfer_line_conservation_from_adjustment();

-- =============================================================================
-- §6 — reclassification_events: valid (from, to) transitions (§7 of
-- data-model.md). Validation only — self-locks and re-checks independently,
-- but the actual `material_units.classification` UPDATE is performed by the
-- `reclassify_material_unit` controlled function (§12/05), not here.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_validate_reclassification_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_classification material_classification_enum;
BEGIN
  SELECT classification INTO v_current_classification
    FROM material_units
   WHERE company_id = NEW.company_id AND id = NEW.material_unit_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reclassification_events references material_unit % which does not exist for company %',
      NEW.material_unit_id, NEW.company_id;
  END IF;

  IF v_current_classification <> NEW.from_classification THEN
    RAISE EXCEPTION 'reclassification_events.from_classification (%) does not match material_unit %''s current classification (%)',
      NEW.from_classification, NEW.material_unit_id, v_current_classification;
  END IF;

  IF NOT (
    (NEW.from_classification = 'PENDING_RECONCILIATION' AND NEW.to_classification IN ('PREPARED', 'OFFCUT', 'SCRAP'))
    OR (NEW.from_classification = 'OFFCUT' AND NEW.to_classification = 'SCRAP')
  ) THEN
    RAISE EXCEPTION 'reclassification_events: invalid transition % -> %', NEW.from_classification, NEW.to_classification;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_reclassification_transition ON reclassification_events;
CREATE TRIGGER trg_validate_reclassification_transition
  BEFORE INSERT ON reclassification_events
  FOR EACH ROW
  EXECUTE FUNCTION fn_validate_reclassification_transition();

-- =============================================================================
-- §7 — Maker <> checker
--
-- Implemented as plain same-row CHECK constraints in 02 (e.g.
-- `conservation_adjustments_maker_checker_check`), not as triggers: every
-- instance of this rule compares two columns on the SAME row being written
-- (`approved_by_membership_id <> recorded_by_membership_id`, etc.), which a
-- CHECK constraint expresses directly with no cross-row read — simpler and
-- at least as strong as a trigger for this particular rule. See 02 for the
-- six constraints (reclassification_events, conservation_adjustments,
-- processing_operations, bbs_schedules, physical_stock_counts,
-- installations). `record_approval` (05) additionally validates this in
-- procedural code before attempting the UPDATE, so the rule is enforced
-- twice independently either way — the same defense-in-depth posture as
-- every other safety-critical rule in this design (§12).
-- =============================================================================

-- =============================================================================
-- §8 — Generic audit_log trigger for mutable master-data tables (§15)
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_audit_log_row_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  v_key text;
  v_old_val text;
  v_new_val text;
  v_membership_id uuid;
  v_audit_company_id uuid;
  v_record_id uuid;
BEGIN
  v_membership_id := NULLIF(current_setting('app.current_membership_id', true), '')::uuid;
  IF v_membership_id IS NULL THEN
    RAISE EXCEPTION 'app.current_membership_id must be set (via SET LOCAL, §13) for an audited write on %', TG_TABLE_NAME;
  END IF;

  -- BUG AVOIDED (found while writing this): direct field access
  -- (`NEW.company_id`) would raise "record NEW has no field company_id" at
  -- runtime for `companies` — the one audited table (04 §8's attach list)
  -- that has no `company_id` column at all (it's the tenant root; its own
  -- `id` IS the tenant key, same reasoning as 06's `companies` RLS policy).
  -- Extracting through the already-built `v_new` jsonb instead makes the
  -- lookup safely return NULL (never error) when the key is absent, and
  -- COALESCE falls back to `id` for exactly that one table.
  v_record_id := (v_new ->> 'id')::uuid;
  v_audit_company_id := COALESCE((v_new ->> 'company_id')::uuid, v_record_id);

  FOR v_key IN SELECT jsonb_object_keys(v_new) LOOP
    v_old_val := v_old ->> v_key;
    v_new_val := v_new ->> v_key;
    IF v_old_val IS DISTINCT FROM v_new_val THEN
      INSERT INTO audit_log (company_id, table_name, record_id, field_name, old_value, new_value, changed_by_membership_id)
      VALUES (v_audit_company_id, TG_TABLE_NAME, v_record_id, v_key, v_old_val, v_new_val, v_membership_id);
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- Attached to every mutable-master-data table (§15's "Mutable master data +
-- external audit trail" row, plus the other master-data-shaped tables that
-- share the pattern). Deliberately NOT attached to `users` (global, no
-- `company_id` — see §6b's own, separate RLS-based protection instead) nor
-- to any table already covered by a more specific single-fill/immutable
-- pattern (those are never updated outside the controlled functions, which
-- can log explicitly if ever needed — not required by this task).
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'companies', 'roles', 'projects', 'storage_locations', 'location_node_types',
    'suppliers', 'manufacturers', 'structural_element_types', 'reinforcement_purposes',
    'processing_operation_types', 'structural_element_instances', 'rebar_catalog_items',
    'shape_codes', 'bundles', 'bundle_attribute_definitions', 'work_orders', 'bbs_schedules'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_log ON %I', v_table);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_log AFTER UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fn_audit_log_row_update()',
      v_table
    );
  END LOOP;
END;
$$;
