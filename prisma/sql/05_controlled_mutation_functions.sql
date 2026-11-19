-- =============================================================================
-- SteelTrace — 05: Controlled mutation functions
--
-- The only sanctioned write path for every multi-row mutation (§12).
-- Each function:
--   1. Acquires every lock it needs FIRST, in the global order (§12): (a)
--      the parent event row, if updating an existing one; (b) then every
--      directly-referenced material_units row, sorted by id ASC.
--   2. Validates against the locked state (calling the helpers in 03).
--   3. Performs its inserts/updates atomically.
--
-- SECURITY DEFINER: every function here is SECURITY DEFINER so that
-- `steeltrace_app` — which (01) holds NO direct INSERT/UPDATE grant on the
-- tables these functions touch — can still write through EXECUTE alone.
-- Run this file as the table-owning role (the same role that ran the Prisma
-- migration); these functions will run as THAT owner regardless of who
-- calls them.
--
-- Depends on: 02 (constraints), 03 (spec_compare, material_unit_remaining_length_m),
-- 04 (triggers — every insert below still passes through 04's validation
-- triggers; this file does not duplicate those checks, only the checks that
-- need to happen BEFORE a lock is safe to release, i.e. before the insert).
--
-- Idempotency: `processing_operations`/`material_transfers` carry a
-- client-supplied `idempotency_key` (partial-unique, 02). A retried call
-- with the same key hits that unique constraint and the caller's retry
-- logic (§12) treats the resulting unique-violation as "already applied."
-- This file does not re-implement that check procedurally — the unique
-- index IS the mechanism.
-- =============================================================================

SET search_path TO public;

-- =============================================================================
-- register_bundle
-- =============================================================================
--
-- Creates a `bundles` row and its paired root `material_units` row
-- atomically (§4, §12). The root unit's starting `status` is derived from
-- `p_initial_disposition`: 'ACCEPTED' -> 'AVAILABLE'; 'ON_HOLD' or
-- 'DAMAGED_DISCREPANT' -> 'ON_HOLD' (quarantined, §18). Also records the
-- root unit's own backward-genealogy cache row (EXACT, weight 1 — a bundle
-- root traces to itself with total certainty).
--
-- GAP NOTE (flagged, not silently invented): neither the `bundles` table
-- definition (§4) nor §12's prose description of `register_bundle` gives
-- the new root `material_units` row a starting `current_storage_location_id`
-- — yet every other place a `material_units` row is created (processing
-- outputs, transfer receipts, splits) does set one, and a physically
-- received bundle obviously sits somewhere. `p_storage_location_id` is
-- added here as a required parameter to close that gap; confirm with the
-- client/product owner whether a bundle can ever legitimately be
-- registered with no location (e.g. "unallocated, no physical receipt
-- location yet") before loosening this to nullable.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION register_bundle(
  p_company_id                 uuid,
  p_project_id                 uuid,              -- nullable: NULL = unallocated company-wide stock (§5)
  p_storage_location_id        uuid,               -- see GAP NOTE above
  p_internal_reference_code    text,
  p_supplier_id                uuid,
  p_manufacturer_id             uuid,
  p_country_of_origin           text,
  p_diameter_mm                 numeric,
  p_grade                        text,
  p_standard                      text,
  p_heat_number                    text,
  p_piece_count                     integer,
  p_bar_length_m                    numeric,
  p_surface_type                     rebar_surface_type_enum,
  p_origin_type                       bundle_origin_type_enum,
  p_grn_reference                      text,
  p_po_reference                        text,
  p_delivery_note_number                 text,
  p_vehicle_info                          text,
  p_weighbridge_ticket_number               text,
  p_mtc_reference                            text,
  p_actual_weight_kg                          numeric,
  p_initial_disposition                        receipt_disposition_enum,
  p_registered_by_membership_id                 uuid
) RETURNS TABLE(bundle_id uuid, root_material_unit_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bundle_id uuid;
  v_unit_id   uuid;
  v_status    material_status_enum;
BEGIN
  -- Brand-new insert — nothing to lock yet (§12).
  v_status := CASE WHEN p_initial_disposition = 'ACCEPTED' THEN 'AVAILABLE'::material_status_enum
                    ELSE 'ON_HOLD'::material_status_enum END;

  INSERT INTO bundles (
    company_id, project_id, internal_reference_code, supplier_id, manufacturer_id,
    country_of_origin, diameter_mm, grade, standard, heat_number, piece_count, bar_length_m,
    surface_type, origin_type, grn_reference, po_reference, delivery_note_number, vehicle_info,
    weighbridge_ticket_number, mtc_reference, actual_weight_kg, initial_disposition,
    registered_by_membership_id, registered_at
  ) VALUES (
    p_company_id, p_project_id, p_internal_reference_code, p_supplier_id, p_manufacturer_id,
    p_country_of_origin, p_diameter_mm, p_grade, p_standard, p_heat_number, p_piece_count, p_bar_length_m,
    p_surface_type, p_origin_type, p_grn_reference, p_po_reference, p_delivery_note_number, p_vehicle_info,
    p_weighbridge_ticket_number, p_mtc_reference, p_actual_weight_kg, p_initial_disposition,
    p_registered_by_membership_id, now()
  )
  RETURNING id INTO v_bundle_id;

  INSERT INTO material_units (
    company_id, project_id, source_bundle_id, granularity, classification, status,
    diameter_mm, grade, standard, surface_type,
    quantity_pieces, unit_length_m, total_length_m,
    current_storage_location_id, created_at, updated_at
  ) VALUES (
    p_company_id, p_project_id, v_bundle_id, 'BUNDLE', 'ORIGINAL', v_status,
    p_diameter_mm, p_grade, p_standard, p_surface_type,
    p_piece_count, p_bar_length_m, p_piece_count * p_bar_length_m,
    p_storage_location_id, now(), now()
  )
  RETURNING id INTO v_unit_id;
  -- grade_normalized/standard_normalized are filled by trg_normalize_material_unit_spec (04).

  INSERT INTO material_unit_origins (company_id, material_unit_id, bundle_id, contribution_weight, confidence, computed_at)
  VALUES (p_company_id, v_unit_id, v_bundle_id, 1, 'EXACT', now());

  RETURN QUERY SELECT v_bundle_id, v_unit_id;
END;
$$;

-- =============================================================================
-- split_material_unit
-- =============================================================================
--
-- Locks the source unit, verifies `material_unit_remaining_length_m(...) >=`
-- the requested length, inserts the child `material_units` row and the
-- `material_splits` row, and copies the source's `material_unit_origins`
-- rows onto the child unchanged (a split is a 1:1 pass-through — it never
-- introduces new mixing, so it never changes attribution precision, §6 of
-- data-model.md).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION split_material_unit(
  p_company_id              uuid,
  p_source_material_unit_id uuid,
  p_quantity_pieces         integer,
  p_unit_length_m           numeric,   -- nullable: NULL if the split-off portion is itself mixed-length
  p_total_length_m          numeric,
  p_unit_weight_kg          numeric,
  p_total_weight_kg         numeric,
  p_granularity             material_granularity_enum, -- may be finer than the source's (§5 of data-model.md); never coarser
  p_reason                  text,
  p_recorded_by_membership_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_source       material_units%ROWTYPE;
  v_remaining    numeric(10,3);
  v_child_id     uuid;
BEGIN
  SELECT * INTO v_source
    FROM material_units
   WHERE company_id = p_company_id AND id = p_source_material_unit_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'split_material_unit: source material_unit % not found for company %', p_source_material_unit_id, p_company_id;
  END IF;

  v_remaining := material_unit_remaining_length_m(p_company_id, p_source_material_unit_id);
  IF v_remaining < p_total_length_m THEN
    RAISE EXCEPTION 'split_material_unit: requested % m exceeds remaining % m on source material_unit %',
      p_total_length_m, v_remaining, p_source_material_unit_id;
  END IF;

  INSERT INTO material_units (
    company_id, project_id, source_bundle_id, granularity, classification, status,
    diameter_mm, grade, standard, surface_type,
    quantity_pieces, unit_length_m, total_length_m, unit_weight_kg, total_weight_kg,
    current_storage_location_id, created_at, updated_at
  ) VALUES (
    p_company_id, v_source.project_id, v_source.source_bundle_id, p_granularity, v_source.classification, v_source.status,
    v_source.diameter_mm, v_source.grade, v_source.standard, v_source.surface_type,
    p_quantity_pieces, p_unit_length_m, p_total_length_m, p_unit_weight_kg, p_total_weight_kg,
    v_source.current_storage_location_id, now(), now()
  )
  RETURNING id INTO v_child_id;

  INSERT INTO material_splits (company_id, source_material_unit_id, resulting_material_unit_id, reason, recorded_by_membership_id, created_at)
  VALUES (p_company_id, p_source_material_unit_id, v_child_id, p_reason, p_recorded_by_membership_id, now());

  -- Pass-through genealogy (§6 of data-model.md): copy, don't recompute.
  INSERT INTO material_unit_origins (company_id, material_unit_id, bundle_id, contribution_weight, confidence, computed_at)
  SELECT p_company_id, v_child_id, bundle_id, contribution_weight, confidence, now()
    FROM material_unit_origins
   WHERE company_id = p_company_id AND material_unit_id = p_source_material_unit_id;

  RETURN v_child_id;
END;
$$;

-- =============================================================================
-- record_processing_operation / finalize_processing_operation
-- =============================================================================
--
-- `record_processing_operation` creates (or adds to) one processing
-- operation: locks the operation row if it already exists, then every
-- referenced material_units row sorted by id ASC, verifies each input's
-- `remaining() >=` the amount being consumed, inserts the operation (if
-- new)/inputs/outputs/output-sources/adjustments, updates each fully-
-- consumed input's `status -> 'CONSUMED'`, and refreshes
-- `material_unit_origins` for every new output with sticky weakest-link
-- confidence (§6 of data-model.md).
--
-- Portions are passed as JSONB arrays so one call can atomically record a
-- multi-input, multi-output operation (§2.5 of CLAUDE.md: "a single
-- processing operation must support multiple source inputs").
--
-- BUG AVOIDED (found while writing the Task 4 integrity tests — the exact
-- reason this real-execution pass exists): earlier, `p_outputs` carried a
-- pre-existing `material_unit_id` as if the caller had already created
-- that row — but nothing ever did. Every other "creates a child unit"
-- controlling function (`register_bundle`, `split_material_unit`,
-- `dispatch_material_transfer`) creates its OWN new `material_units` row
-- internally; this function now does the same for each output: it takes
-- the output's raw quantity/length/weight figures and creates the row
-- itself (classification `PENDING_RECONCILIATION`, status `AVAILABLE`,
-- at the operation's own `storage_location_id`, §9's trigger), inheriting
-- diameter/grade/standard/surface_type from a source unit rather than
-- from a value the caller invented — exactly the "output inherits the
-- shared spec of its inputs" rule (§10). Return type changed from a bare
-- `uuid` to a row set so the caller can learn the id(s) this function
-- itself generated.
--
-- p_inputs shape:  [{"material_unit_id": "...", "quantity_consumed_pieces": N, "length_consumed_m": N, "weight_consumed_kg": N|null}, ...]
-- p_outputs shape: [{"attribution_mode": "EXACT|KNOWN_PARTIAL|POOLED",
--                     "granularity": "BUNDLE|BATCH|PIECE" (optional, default "BATCH"),
--                     "quantity_pieces": N, "unit_length_m": N|null, "total_length_m": N,
--                     "unit_weight_kg": N|null, "total_weight_kg": N|null,
--                     "sources": [{"source_input_material_unit_id": "...", "contribution_weight": N|null}, ...]}, ...]
--   (`source_input_material_unit_id` is resolved to this operation's own
--   `processing_inputs.id` for that unit — looked up internally, since the
--   caller only ever has unit ids on hand before this call creates the
--   `processing_inputs` rows. For EXACT, exactly one source is required —
--   its unit is what the output's spec is copied from. For KNOWN_PARTIAL/
--   POOLED, the output's spec is copied from the first qualifying input,
--   sorted by id for determinism — safe because every candidate for
--   either mode is already required to be `CONFIRMED_MATCH` with
--   whatever spec is chosen, by the §8 rules this function and 04's
--   triggers both enforce.)
-- p_adjustments shape (optional): [{"measurement_basis": "LENGTH|WEIGHT", "amount": N,
--                                    "adjustment_type": "TOLERANCE|CORRECTION", "reason": "..."}]
-- -----------------------------------------------------------------------------
-- `CREATE OR REPLACE FUNCTION` cannot change a function's return TYPE
-- (only its body) — required here since this revision changes `RETURNS
-- uuid` to `RETURNS TABLE(...)`. Dropped first for idempotency across
-- re-applications of this file against a database that already has the
-- prior signature (exactly what happened applying this fix to Neon).
DROP FUNCTION IF EXISTS record_processing_operation(uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, jsonb, jsonb, jsonb);

CREATE OR REPLACE FUNCTION record_processing_operation(
  p_company_id                uuid,
  p_existing_operation_id      uuid,   -- NULL to create a new operation
  p_project_id                  uuid,
  p_work_order_id                uuid,
  p_reference_code                 text,
  p_operation_type_id               uuid,
  p_storage_location_id              uuid,
  p_performed_by_membership_id        uuid,
  p_idempotency_key                    text,
  p_inputs                              jsonb,
  p_outputs                              jsonb,
  p_adjustments                           jsonb
) RETURNS TABLE(operation_id uuid, output_index integer, output_material_unit_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_operation_id    uuid;
  v_input           jsonb;
  v_output          jsonb;
  v_source           jsonb;
  v_adjustment         jsonb;
  v_unit_id             uuid;
  v_remaining            numeric(10,3);
  v_new_input_id           uuid;
  v_new_output_id            uuid;
  v_new_output_unit_id         uuid;
  v_source_input_id           uuid;
  v_sorted_unit_ids             uuid[];
  v_output_idx                   integer := 0;
  v_spec_unit_id                   uuid;
  v_spec                             RECORD;
  v_named_source_count                 integer;
BEGIN
  -- (a) Lock the parent event row first, if it already exists.
  IF p_existing_operation_id IS NOT NULL THEN
    SELECT id INTO v_operation_id
      FROM processing_operations
     WHERE company_id = p_company_id AND id = p_existing_operation_id
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_processing_operation: operation % not found for company %', p_existing_operation_id, p_company_id;
    END IF;
  ELSE
    INSERT INTO processing_operations (
      company_id, project_id, work_order_id, reference_code, operation_type_id, storage_location_id,
      performed_by_membership_id, performed_at, idempotency_key, reconciliation_status, is_finalized
    ) VALUES (
      p_company_id, p_project_id, p_work_order_id, p_reference_code, p_operation_type_id, p_storage_location_id,
      p_performed_by_membership_id, now(), p_idempotency_key, 'UNRECONCILED', false
    )
    RETURNING id INTO v_operation_id;
  END IF;

  -- (b) Lock every directly-referenced material_units row, sorted by id ASC.
  SELECT array_agg(DISTINCT (elem ->> 'material_unit_id')::uuid ORDER BY (elem ->> 'material_unit_id')::uuid)
    INTO v_sorted_unit_ids
    FROM jsonb_array_elements(p_inputs) elem;

  IF v_sorted_unit_ids IS NOT NULL THEN
    PERFORM 1 FROM material_units
     WHERE company_id = p_company_id AND id = ANY (v_sorted_unit_ids)
     ORDER BY id
       FOR UPDATE;
  END IF;

  -- Validate and insert each input.
  FOR v_input IN SELECT * FROM jsonb_array_elements(p_inputs) LOOP
    v_unit_id := (v_input ->> 'material_unit_id')::uuid;
    v_remaining := material_unit_remaining_length_m(p_company_id, v_unit_id);

    IF v_remaining < (v_input ->> 'length_consumed_m')::numeric THEN
      RAISE EXCEPTION 'record_processing_operation: input material_unit % requests % m, only % m remaining',
        v_unit_id, (v_input ->> 'length_consumed_m')::numeric, v_remaining;
    END IF;

    INSERT INTO processing_inputs (
      company_id, processing_operation_id, material_unit_id,
      quantity_consumed_pieces, length_consumed_m, weight_consumed_kg, created_at
    ) VALUES (
      p_company_id, v_operation_id, v_unit_id,
      (v_input ->> 'quantity_consumed_pieces')::integer,
      (v_input ->> 'length_consumed_m')::numeric,
      (v_input ->> 'weight_consumed_kg')::numeric,
      now()
    )
    RETURNING id INTO v_new_input_id;

    -- Fully consumed? -> status CONSUMED (re-evaluated AFTER this input's
    -- own insert, under the lock already held on this unit).
    IF material_unit_remaining_length_m(p_company_id, v_unit_id) = 0 THEN
      UPDATE material_units SET status = 'CONSUMED', updated_at = now()
       WHERE company_id = p_company_id AND id = v_unit_id;
    END IF;
  END LOOP;

  -- Insert each output: first the NEW material_units row itself (this
  -- function's own responsibility, per the BUG AVOIDED note above), then
  -- processing_outputs, its sources, and its genealogy-cache refresh.
  FOR v_output IN SELECT * FROM jsonb_array_elements(p_outputs) LOOP
    v_output_idx := v_output_idx + 1;

    -- Determine which existing unit to copy diameter/grade/standard/
    -- surface_type from. EXACT requires exactly one named source; for
    -- KNOWN_PARTIAL/POOLED, any already-validated candidate works — the
    -- first operation input, sorted by id, is the deterministic choice.
    IF (v_output ->> 'attribution_mode') = 'EXACT' THEN
      SELECT count(*) INTO v_named_source_count FROM jsonb_array_elements(COALESCE(v_output -> 'sources', '[]'::jsonb));
      IF v_named_source_count <> 1 THEN
        RAISE EXCEPTION 'record_processing_operation: EXACT output (index %) requires exactly 1 named source, got %', v_output_idx, v_named_source_count;
      END IF;
      SELECT (elem ->> 'source_input_material_unit_id')::uuid INTO v_spec_unit_id
        FROM jsonb_array_elements(v_output -> 'sources') elem LIMIT 1;
    ELSIF v_output -> 'sources' IS NOT NULL AND jsonb_array_length(v_output -> 'sources') > 0 THEN
      SELECT (elem ->> 'source_input_material_unit_id')::uuid INTO v_spec_unit_id
        FROM jsonb_array_elements(v_output -> 'sources') elem ORDER BY (elem ->> 'source_input_material_unit_id')::uuid LIMIT 1;
    ELSE
      SELECT pi.material_unit_id INTO v_spec_unit_id
        FROM processing_inputs pi
       WHERE pi.company_id = p_company_id AND pi.processing_operation_id = v_operation_id
       ORDER BY pi.material_unit_id LIMIT 1;
    END IF;

    SELECT diameter_mm, grade, standard, surface_type INTO v_spec
      FROM material_units WHERE company_id = p_company_id AND id = v_spec_unit_id;

    INSERT INTO material_units (
      company_id, project_id, source_bundle_id, granularity, classification, status,
      diameter_mm, grade, standard, surface_type,
      quantity_pieces, unit_length_m, total_length_m, unit_weight_kg, total_weight_kg,
      current_storage_location_id, created_at, updated_at
    ) VALUES (
      p_company_id, p_project_id, NULL,
      COALESCE((v_output ->> 'granularity')::material_granularity_enum, 'BATCH'::material_granularity_enum),
      'PENDING_RECONCILIATION', 'AVAILABLE',
      v_spec.diameter_mm, v_spec.grade, v_spec.standard, v_spec.surface_type,
      (v_output ->> 'quantity_pieces')::integer, (v_output ->> 'unit_length_m')::numeric, (v_output ->> 'total_length_m')::numeric,
      (v_output ->> 'unit_weight_kg')::numeric, (v_output ->> 'total_weight_kg')::numeric,
      p_storage_location_id, now(), now()
    )
    RETURNING id INTO v_new_output_unit_id;

    INSERT INTO processing_outputs (company_id, processing_operation_id, material_unit_id, attribution_mode, created_at)
    VALUES (p_company_id, v_operation_id, v_new_output_unit_id, (v_output ->> 'attribution_mode')::attribution_mode_enum, now())
    RETURNING id INTO v_new_output_id;

    IF v_output -> 'sources' IS NOT NULL THEN
      FOR v_source IN SELECT * FROM jsonb_array_elements(v_output -> 'sources') LOOP
        SELECT pi.id INTO v_source_input_id
          FROM processing_inputs pi
         WHERE pi.company_id = p_company_id
           AND pi.processing_operation_id = v_operation_id
           AND pi.material_unit_id = (v_source ->> 'source_input_material_unit_id')::uuid;

        IF v_source_input_id IS NULL THEN
          RAISE EXCEPTION 'record_processing_operation: output source material_unit % is not a processing_input of operation %',
            (v_source ->> 'source_input_material_unit_id')::uuid, v_operation_id;
        END IF;

        INSERT INTO processing_output_sources (company_id, processing_output_id, processing_input_id, contribution_weight, created_at)
        VALUES (p_company_id, v_new_output_id, v_source_input_id, (v_source ->> 'contribution_weight')::numeric, now());
      END LOOP;
    END IF;

    -- `RETURNS TABLE(...)` columns are implicit OUT parameters in plpgsql
    -- — they must be explicitly assigned before RETURN NEXT uses their
    -- current values; this is NOT automatic just because the names echo
    -- this function's own local `v_...` variables.
    operation_id := v_operation_id;
    output_index := v_output_idx;
    output_material_unit_id := v_new_output_unit_id;
    RETURN NEXT;

    -- Refresh material_unit_origins for the new output — "sticky weakest
    -- link" (§6 of data-model.md, §10): EXACT only if every source traced
    -- EXACT; POOLED the instant any source is POOLED or an unweighted
    -- KNOWN_PARTIAL; contribution_weight NULL on that same condition.
    --
    -- `MIN(origin.contribution_weight)` below is NOT a precision-losing
    -- aggregate choice — it's required because `bundle_id` can repeat
    -- across the UNION ALL'd origin rows (multiple named sources, or every
    -- POOLED-fallback input, can each trace to the same bundle), so a bare
    -- un-aggregated column is invalid under GROUP BY regardless. The CASE
    -- below nulls it out in every case except a clean single-source EXACT
    -- trace, where exactly one row per bundle_id exists in the first
    -- place (material_unit_origins' own `(company_id, material_unit_id,
    -- bundle_id)` uniqueness), so MIN just returns that one value — this
    -- function never attempts to combine/reweight multiple sources'
    -- contributions into one number (the design doc does not specify that
    -- math precisely enough to implement with confidence; leaving the
    -- weight NULL in every case it can't trivially prove unambiguous is
    -- the conservative, "never fabricated" (§9/§10) choice).
    -- BUG AVOIDED (found running this against real Postgres, Task 4): the
    -- CASE expressions below originally considered only the UPSTREAM
    -- confidence of each traced-through source, never THIS step's own
    -- `attribution_mode` — so a KNOWN_PARTIAL output combining two
    -- individually-EXACT sources (e.g. two untouched bundle roots) was
    -- wrongly computed as EXACT, since neither upstream source was itself
    -- POOLED or KNOWN_PARTIAL. "Sticky weakest link" (§6/§10) must treat
    -- THIS step's own mode as a floor, not just propagate what came
    -- before it — fixed by checking `(v_output ->> 'attribution_mode') =
    -- 'KNOWN_PARTIAL'` explicitly, same as the pre-existing POOLED check.
    INSERT INTO material_unit_origins (company_id, material_unit_id, bundle_id, contribution_weight, confidence, computed_at)
    SELECT
      p_company_id,
      v_new_output_unit_id,
      origin.bundle_id,
      CASE
        WHEN (v_output ->> 'attribution_mode') IN ('POOLED', 'KNOWN_PARTIAL') THEN NULL
        WHEN bool_or(origin.confidence <> 'EXACT') THEN NULL
        WHEN count(*) > 1 THEN NULL
        ELSE MIN(origin.contribution_weight)
      END,
      CASE
        WHEN (v_output ->> 'attribution_mode') = 'POOLED' THEN 'POOLED'::attribution_mode_enum
        WHEN bool_or(origin.confidence = 'POOLED') THEN 'POOLED'::attribution_mode_enum
        WHEN (v_output ->> 'attribution_mode') = 'KNOWN_PARTIAL' THEN 'KNOWN_PARTIAL'::attribution_mode_enum
        WHEN bool_or(origin.confidence = 'KNOWN_PARTIAL') THEN 'KNOWN_PARTIAL'::attribution_mode_enum
        ELSE 'EXACT'::attribution_mode_enum
      END,
      now()
    FROM (
      -- Named sources (EXACT/KNOWN_PARTIAL): trace through each named input's unit.
      SELECT muo.bundle_id, muo.contribution_weight, muo.confidence
        FROM jsonb_array_elements(COALESCE(v_output -> 'sources', '[]'::jsonb)) s
        JOIN processing_inputs pi
          ON pi.company_id = p_company_id
         AND pi.processing_operation_id = v_operation_id
         AND pi.material_unit_id = (s ->> 'source_input_material_unit_id')::uuid
        JOIN material_unit_origins muo
          ON muo.company_id = p_company_id AND muo.material_unit_id = pi.material_unit_id
      UNION ALL
      -- POOLED fallback: every spec-matching input of the operation (§8's
      -- candidate-set definition — the trigger layer, 04, already
      -- confirmed this set is non-empty before this statement would ever
      -- legally run).
      SELECT muo.bundle_id, muo.contribution_weight, muo.confidence
        FROM processing_inputs pi
        JOIN material_units su ON su.company_id = pi.company_id AND su.id = pi.material_unit_id
        JOIN material_units ou ON ou.company_id = p_company_id AND ou.id = v_new_output_unit_id
        JOIN material_unit_origins muo
          ON muo.company_id = p_company_id AND muo.material_unit_id = pi.material_unit_id
       WHERE pi.company_id = p_company_id
         AND pi.processing_operation_id = v_operation_id
         AND (v_output ->> 'attribution_mode') = 'POOLED'
         AND spec_compare(su.diameter_mm, su.surface_type, su.grade_normalized, su.standard_normalized,
                           ou.diameter_mm, ou.surface_type, ou.grade_normalized, ou.standard_normalized) = 'CONFIRMED_MATCH'
    ) origin
    GROUP BY origin.bundle_id;
  END LOOP;

  -- An operation recorded with no outputs yet (e.g. inputs captured first,
  -- outputs added in a later call before finalizing, §12) must still
  -- return its operation_id — otherwise the caller has no way to refer to
  -- it again.
  IF v_output_idx = 0 THEN
    operation_id := v_operation_id;
    output_index := NULL;
    output_material_unit_id := NULL;
    RETURN NEXT;
  END IF;

  -- Adjustments (optional, e.g. a documented correction recorded in the
  -- same breath as the outputs that needed it).
  IF p_adjustments IS NOT NULL THEN
    FOR v_adjustment IN SELECT * FROM jsonb_array_elements(p_adjustments) LOOP
      INSERT INTO conservation_adjustments (
        company_id, processing_operation_id, measurement_basis, amount, adjustment_type,
        reason, recorded_by_membership_id, created_at
      ) VALUES (
        p_company_id, v_operation_id,
        (v_adjustment ->> 'measurement_basis')::measurement_basis_enum,
        (v_adjustment ->> 'amount')::numeric,
        (v_adjustment ->> 'adjustment_type')::adjustment_type_enum,
        v_adjustment ->> 'reason',
        p_performed_by_membership_id,
        now()
      );
    END LOOP;
  END IF;

  -- reconciliation_status is finalized by finalize_processing_operation,
  -- below — recorded here only as a cheap, immediate best-effort guess so
  -- it never reads stale/empty; the deferred constraint triggers (04) are
  -- what actually BLOCK an over-output, independent of this projection.
  UPDATE processing_operations po
     SET reconciliation_status = (
           SELECT CASE
             WHEN COALESCE(SUM(mu.total_length_m), 0) = COALESCE((SELECT SUM(pi.length_consumed_m) FROM processing_inputs pi WHERE pi.company_id = p_company_id AND pi.processing_operation_id = v_operation_id), 0)
               THEN 'BALANCED'::reconciliation_status_enum
             WHEN EXISTS (SELECT 1 FROM conservation_adjustments ca WHERE ca.company_id = p_company_id AND ca.processing_operation_id = v_operation_id)
               THEN 'ADJUSTED'::reconciliation_status_enum
             ELSE 'UNRECONCILED'::reconciliation_status_enum
           END
           FROM processing_outputs po2
           JOIN material_units mu ON mu.company_id = po2.company_id AND mu.id = po2.material_unit_id
          WHERE po2.company_id = p_company_id AND po2.processing_operation_id = v_operation_id
         )
         -- BUG AVOIDED (found running this against real Postgres, Task 4):
         -- `processing_operations` has no `updated_at` column at all (§9's
         -- table definition never gave it one — unlike `material_units`,
         -- which does) — this UPDATE used to also try to set one.
   WHERE po.company_id = p_company_id AND po.id = v_operation_id;

  RETURN;
END;
$$;

-- -----------------------------------------------------------------------------
-- finalize_processing_operation — sets is_finalized = true, after which
-- no further processing_inputs/outputs may be added (§9/§10: "is_finalized"
-- finalization gate). Separated out so a multi-step operation (inputs
-- recorded first, outputs recorded once cutting is physically done) can
-- call record_processing_operation more than once before finalizing.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finalize_processing_operation(
  p_company_id   uuid,
  p_operation_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM 1 FROM processing_operations
   WHERE company_id = p_company_id AND id = p_operation_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_processing_operation: operation % not found for company %', p_operation_id, p_company_id;
  END IF;

  UPDATE processing_operations
     SET is_finalized = true
   WHERE company_id = p_company_id AND id = p_operation_id;
END;
$$;

-- =============================================================================
-- dispatch_material_transfer
-- =============================================================================
--
-- Locks the source unit(s) (sorted), splits off a dedicated placeholder
-- unit per source (dispatch ALWAYS splits, §2 — no "whole row relocates"
-- shortcut), inserts the transfer and its lines.
--
-- p_lines shape: [{"source_material_unit_id": "...", "quantity_pieces": N,
--                   "unit_length_m": N|null, "total_length_m": N,
--                   "unit_weight_kg": N|null, "total_weight_kg": N|null}, ...]
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_material_transfer(
  p_company_id                  uuid,
  p_project_id                   uuid,
  p_from_location_id               uuid,
  p_to_location_id                  uuid,
  p_dispatched_by_membership_id      uuid,
  p_vehicle_info                       text,
  p_idempotency_key                     text,
  p_lines                                 jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_transfer_id      uuid;
  v_line             jsonb;
  v_source_unit_id   uuid;
  v_source           material_units%ROWTYPE;
  v_remaining        numeric(10,3);
  v_placeholder_id    uuid;
  v_sorted_unit_ids     uuid[];
BEGIN
  INSERT INTO material_transfers (
    company_id, project_id, from_location_id, to_location_id, status,
    dispatched_by_membership_id, dispatched_at, vehicle_info, idempotency_key, reconciliation_status
  ) VALUES (
    p_company_id, p_project_id, p_from_location_id, p_to_location_id, 'DISPATCHED',
    p_dispatched_by_membership_id, now(), p_vehicle_info, p_idempotency_key, 'UNRECONCILED'
  )
  RETURNING id INTO v_transfer_id;

  SELECT array_agg(DISTINCT (elem ->> 'source_material_unit_id')::uuid ORDER BY (elem ->> 'source_material_unit_id')::uuid)
    INTO v_sorted_unit_ids
    FROM jsonb_array_elements(p_lines) elem;

  PERFORM 1 FROM material_units
   WHERE company_id = p_company_id AND id = ANY (v_sorted_unit_ids)
   ORDER BY id
     FOR UPDATE;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_source_unit_id := (v_line ->> 'source_material_unit_id')::uuid;

    SELECT * INTO v_source FROM material_units WHERE company_id = p_company_id AND id = v_source_unit_id;

    v_remaining := material_unit_remaining_length_m(p_company_id, v_source_unit_id);
    IF v_remaining < (v_line ->> 'total_length_m')::numeric THEN
      RAISE EXCEPTION 'dispatch_material_transfer: material_unit % requests % m, only % m remaining',
        v_source_unit_id, (v_line ->> 'total_length_m')::numeric, v_remaining;
    END IF;

    -- Dispatch always splits (§2) — even when the entire remaining
    -- quantity is moving, no "same row relocates" shortcut.
    INSERT INTO material_units (
      company_id, project_id, source_bundle_id, granularity, classification, status,
      diameter_mm, grade, standard, surface_type,
      quantity_pieces, unit_length_m, total_length_m, unit_weight_kg, total_weight_kg,
      current_storage_location_id, created_at, updated_at
    ) VALUES (
      p_company_id, v_source.project_id, v_source.source_bundle_id, v_source.granularity, v_source.classification, 'DISPATCHED',
      v_source.diameter_mm, v_source.grade, v_source.standard, v_source.surface_type,
      (v_line ->> 'quantity_pieces')::integer, (v_line ->> 'unit_length_m')::numeric, (v_line ->> 'total_length_m')::numeric,
      (v_line ->> 'unit_weight_kg')::numeric, (v_line ->> 'total_weight_kg')::numeric,
      v_source.current_storage_location_id, now(), now()
    )
    RETURNING id INTO v_placeholder_id;

    INSERT INTO material_splits (company_id, source_material_unit_id, resulting_material_unit_id, reason, recorded_by_membership_id, created_at)
    VALUES (p_company_id, v_source_unit_id, v_placeholder_id, 'dispatch placeholder split', p_dispatched_by_membership_id, now());

    INSERT INTO material_unit_origins (company_id, material_unit_id, bundle_id, contribution_weight, confidence, computed_at)
    SELECT p_company_id, v_placeholder_id, bundle_id, contribution_weight, confidence, now()
      FROM material_unit_origins
     WHERE company_id = p_company_id AND material_unit_id = v_source_unit_id;

    INSERT INTO material_transfer_lines (company_id, material_transfer_id, material_unit_id, split_from_material_unit_id, created_at)
    VALUES (p_company_id, v_transfer_id, v_placeholder_id, v_source_unit_id, now());
  END LOOP;

  RETURN v_transfer_id;
END;
$$;

-- =============================================================================
-- receive_transfer_line
-- =============================================================================
--
-- Locks the placeholder unit, recomputes its cumulative received-so-far
-- UNDER THAT LOCK, validates the new portion(s) won't exceed it, creates
-- one `material_transfer_receipts` event with one `material_transfer_receipt_lines`
-- row (and one freshly materialized `material_units` row) per portion —
-- this is what makes one receipt event cover several differently-
-- dispositioned portions of the same line at once (§11).
--
-- p_portions shape: [{"quantity_pieces": N, "unit_length_m": N|null,
--                       "total_length_m": N, "unit_weight_kg": N|null,
--                       "total_weight_kg": N|null, "disposition": "ACCEPTED|ON_HOLD|DAMAGED_DISCREPANT"}, ...]
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION receive_transfer_line(
  p_company_id                uuid,
  p_material_transfer_line_id  uuid,
  p_received_by_membership_id   uuid,
  p_notes                         text,
  p_portions                       jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_line               material_transfer_lines%ROWTYPE;
  v_placeholder         material_units%ROWTYPE;
  v_to_location_id        uuid;
  v_transfer_id            uuid;
  v_receipt_id              uuid;
  v_portion                  jsonb;
  v_new_unit_id                uuid;
  v_status                      material_status_enum;
BEGIN
  SELECT * INTO v_line
    FROM material_transfer_lines
   WHERE company_id = p_company_id AND id = p_material_transfer_line_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'receive_transfer_line: line % not found for company %', p_material_transfer_line_id, p_company_id;
  END IF;

  -- Lock the placeholder unit itself too (it's a material_units row).
  SELECT * INTO v_placeholder
    FROM material_units
   WHERE company_id = p_company_id AND id = v_line.material_unit_id
     FOR UPDATE;

  SELECT to_location_id, id INTO v_to_location_id, v_transfer_id
    FROM material_transfers
   WHERE company_id = p_company_id AND id = v_line.material_transfer_id;

  -- Validate the WHOLE batch of portions against the placeholder's
  -- remaining capacity before creating anything (re-reading remaining()
  -- under the lock already held, per §12).
  IF (
    SELECT COALESCE(SUM((p ->> 'total_length_m')::numeric), 0)
      FROM jsonb_array_elements(p_portions) p
  ) > material_unit_remaining_length_m(p_company_id, v_placeholder.id) THEN
    RAISE EXCEPTION 'receive_transfer_line: portions sum to more than line %''s remaining dispatched length', p_material_transfer_line_id;
  END IF;

  INSERT INTO material_transfer_receipts (company_id, material_transfer_id, received_by_membership_id, received_at, notes)
  VALUES (p_company_id, v_transfer_id, p_received_by_membership_id, now(), p_notes)
  RETURNING id INTO v_receipt_id;

  FOR v_portion IN SELECT * FROM jsonb_array_elements(p_portions) LOOP
    v_status := CASE WHEN (v_portion ->> 'disposition') = 'ACCEPTED' THEN 'AVAILABLE'::material_status_enum
                      ELSE 'ON_HOLD'::material_status_enum END;

    INSERT INTO material_units (
      company_id, project_id, source_bundle_id, granularity, classification, status,
      diameter_mm, grade, standard, surface_type,
      quantity_pieces, unit_length_m, total_length_m, unit_weight_kg, total_weight_kg,
      current_storage_location_id, created_at, updated_at
    ) VALUES (
      p_company_id, v_placeholder.project_id, v_placeholder.source_bundle_id, v_placeholder.granularity, v_placeholder.classification, v_status,
      v_placeholder.diameter_mm, v_placeholder.grade, v_placeholder.standard, v_placeholder.surface_type,
      (v_portion ->> 'quantity_pieces')::integer, (v_portion ->> 'unit_length_m')::numeric, (v_portion ->> 'total_length_m')::numeric,
      (v_portion ->> 'unit_weight_kg')::numeric, (v_portion ->> 'total_weight_kg')::numeric,
      v_to_location_id, now(), now()
    )
    RETURNING id INTO v_new_unit_id;

    INSERT INTO material_transfer_receipt_lines (
      company_id, material_transfer_receipt_id, material_transfer_line_id, resulting_material_unit_id, disposition, created_at
    ) VALUES (
      p_company_id, v_receipt_id, p_material_transfer_line_id, v_new_unit_id, (v_portion ->> 'disposition')::receipt_disposition_enum, now()
    );

    INSERT INTO material_unit_origins (company_id, material_unit_id, bundle_id, contribution_weight, confidence, computed_at)
    SELECT p_company_id, v_new_unit_id, bundle_id, contribution_weight, confidence, now()
      FROM material_unit_origins
     WHERE company_id = p_company_id AND material_unit_id = v_placeholder.id;
  END LOOP;

  -- Projection updates: this line's placeholder may now be fully drawn
  -- down; if every line of the transfer is, the transfer reaches RECEIVED
  -- (otherwise PARTIALLY_RECEIVED); reconciliation_status mirrors whether
  -- every line balances exactly or needed a recorded adjustment.
  UPDATE material_transfers t
     SET status = CASE
                     WHEN NOT EXISTS (
                       SELECT 1 FROM material_transfer_lines l
                        WHERE l.company_id = p_company_id AND l.material_transfer_id = t.id
                          AND material_unit_remaining_length_m(p_company_id, l.material_unit_id) > 0
                     ) THEN 'RECEIVED'::transfer_status_enum
                     ELSE 'PARTIALLY_RECEIVED'::transfer_status_enum
                   END,
         reconciliation_status = CASE
                     WHEN EXISTS (
                       SELECT 1 FROM conservation_adjustments ca
                        JOIN material_transfer_lines l2
                          ON l2.company_id = ca.company_id AND l2.id = ca.material_transfer_line_id
                        WHERE l2.company_id = p_company_id AND l2.material_transfer_id = t.id
                     ) THEN 'ADJUSTED'::reconciliation_status_enum
                     WHEN NOT EXISTS (
                       SELECT 1 FROM material_transfer_lines l3
                        WHERE l3.company_id = p_company_id AND l3.material_transfer_id = t.id
                          AND material_unit_remaining_length_m(p_company_id, l3.material_unit_id) > 0
                     ) THEN 'BALANCED'::reconciliation_status_enum
                     ELSE 'UNRECONCILED'::reconciliation_status_enum
                   END
   WHERE t.company_id = p_company_id AND t.id = v_transfer_id;

  RETURN v_receipt_id;
END;
$$;

-- =============================================================================
-- reallocate_project
-- =============================================================================
CREATE OR REPLACE FUNCTION reallocate_project(
  p_company_id                uuid,
  p_material_unit_id           uuid,
  p_to_project_id                uuid,   -- NULL = return to the unallocated pool
  p_allocated_by_membership_id     uuid,
  p_reason                           text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_unit          material_units%ROWTYPE;
  v_allocation_id uuid;
BEGIN
  SELECT * INTO v_unit
    FROM material_units
   WHERE company_id = p_company_id AND id = p_material_unit_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reallocate_project: material_unit % not found for company %', p_material_unit_id, p_company_id;
  END IF;

  INSERT INTO project_allocations (
    company_id, material_unit_id, from_project_id, to_project_id,
    quantity_pieces, length_m, allocated_by_membership_id, allocated_at, reason
  ) VALUES (
    p_company_id, p_material_unit_id, v_unit.project_id, p_to_project_id,
    v_unit.quantity_pieces, v_unit.total_length_m, p_allocated_by_membership_id, now(), p_reason
  )
  RETURNING id INTO v_allocation_id;

  UPDATE material_units
     SET project_id = p_to_project_id, updated_at = now()
   WHERE company_id = p_company_id AND id = p_material_unit_id;

  RETURN v_allocation_id;
END;
$$;

-- =============================================================================
-- release_hold
-- =============================================================================
CREATE OR REPLACE FUNCTION release_hold(
  p_company_id                uuid,
  p_material_unit_id           uuid,
  p_released_by_membership_id   uuid,
  p_reason                        text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_status   material_status_enum;
  v_release_id uuid;
BEGIN
  SELECT status INTO v_status
    FROM material_units
   WHERE company_id = p_company_id AND id = p_material_unit_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'release_hold: material_unit % not found for company %', p_material_unit_id, p_company_id;
  END IF;

  IF v_status <> 'ON_HOLD' THEN
    RAISE EXCEPTION 'release_hold: material_unit % is not ON_HOLD (status = %)', p_material_unit_id, v_status;
  END IF;

  INSERT INTO material_hold_releases (company_id, material_unit_id, released_by_membership_id, released_at, reason)
  VALUES (p_company_id, p_material_unit_id, p_released_by_membership_id, now(), p_reason)
  RETURNING id INTO v_release_id;

  UPDATE material_units
     SET status = 'AVAILABLE', updated_at = now()
   WHERE company_id = p_company_id AND id = p_material_unit_id;

  RETURN v_release_id;
END;
$$;

-- =============================================================================
-- reclassify_material_unit
-- =============================================================================
-- Adding a new trailing DEFAULTed parameter changes this function's
-- identity for Postgres's own overload resolution (it is NOT the "same
-- signature" `CREATE OR REPLACE` can replace in place) — without
-- dropping the old 5-argument overload first, both would coexist and a
-- plain 5-argument positional call (e.g. src/db/integrity.test.ts's) would
-- become ambiguous between them. Same pattern this file already uses for
-- `record_processing_operation`'s own signature change, above.
DROP FUNCTION IF EXISTS reclassify_material_unit(uuid, uuid, material_classification_enum, text, uuid);

-- `p_internal_reference_code` — GAP CLOSED, Task 6 (§2.18's human-readable
-- remnant codes, e.g. "ST-REM-0084"): added as a NEW TRAILING parameter
-- with a default, so every pre-existing 5-argument positional call (e.g.
-- src/db/integrity.test.ts) keeps working unchanged. `material_units` has
-- no direct UPDATE grant for `steeltrace_app` (01) — reclassification was
-- already the one moment this function legitimately touches that row, so
-- folding the (optional, idempotent, never-overwrites-an-existing-code)
-- reference-code assignment into the SAME call avoids inventing a second,
-- narrower function just to set one column. Only applied when the column
-- is currently NULL — assigning a human-readable code is a one-time
-- event, never a silent rename.
CREATE OR REPLACE FUNCTION reclassify_material_unit(
  p_company_id               uuid,
  p_material_unit_id          uuid,
  p_to_classification          material_classification_enum,
  p_reason                       text,
  p_recorded_by_membership_id      uuid,
  p_internal_reference_code         text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_from_classification material_classification_enum;
  v_event_id            uuid;
BEGIN
  SELECT classification INTO v_from_classification
    FROM material_units
   WHERE company_id = p_company_id AND id = p_material_unit_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reclassify_material_unit: material_unit % not found for company %', p_material_unit_id, p_company_id;
  END IF;

  -- trg_validate_reclassification_transition (04) independently re-checks
  -- this transition under its own self-lock at INSERT time.
  INSERT INTO reclassification_events (company_id, material_unit_id, from_classification, to_classification, reason, recorded_by_membership_id, created_at)
  VALUES (p_company_id, p_material_unit_id, v_from_classification, p_to_classification, p_reason, p_recorded_by_membership_id, now())
  RETURNING id INTO v_event_id;

  UPDATE material_units
     SET classification = p_to_classification,
         internal_reference_code = COALESCE(internal_reference_code, p_internal_reference_code),
         updated_at = now()
   WHERE company_id = p_company_id AND id = p_material_unit_id;

  RETURN v_event_id;
END;
$$;

-- =============================================================================
-- install_material / supersede_installation
-- =============================================================================
--
-- Locks every referenced unit (sorted by id ASC), requires each
-- `status IN ('AVAILABLE','RESERVED')` and `classification IN ('PREPARED','ORIGINAL')`,
-- sets each unit's `status -> 'INSTALLED'` and `current_storage_location_id -> NULL`
-- (§4: "null while INSTALLED"), then inserts one `installations` row
-- (§11a) and one `installation_lines` row per referenced unit. NO quantity
-- parameter exists anywhere in this signature — installation always
-- consumes however much each referenced unit currently holds, in full.
--
-- p_material_unit_ids: uuid[] — one or more units, all feeding this single
-- installation (one element + one purpose), per CLAUDE.md §2.11.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION install_material(
  p_company_id                       uuid,
  p_project_id                        uuid,
  p_structural_element_instance_id     uuid,
  p_reinforcement_purpose_id            uuid,
  p_intended_usage_declaration_id         uuid,  -- nullable
  p_bbs_line_id                            uuid,  -- nullable
  p_installed_by_membership_id              uuid,
  p_notes                                     text,
  p_material_unit_ids                          uuid[]
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_installation_id uuid;
  v_unit_id         uuid;
  v_status          material_status_enum;
  v_classification  material_classification_enum;
BEGIN
  PERFORM 1 FROM material_units
   WHERE company_id = p_company_id AND id = ANY (p_material_unit_ids)
   ORDER BY id
     FOR UPDATE;

  INSERT INTO installations (
    company_id, project_id, structural_element_instance_id, reinforcement_purpose_id,
    intended_usage_declaration_id, bbs_line_id, installed_by_membership_id, installed_at,
    status, notes
  ) VALUES (
    p_company_id, p_project_id, p_structural_element_instance_id, p_reinforcement_purpose_id,
    p_intended_usage_declaration_id, p_bbs_line_id, p_installed_by_membership_id, now(),
    'ACTIVE', p_notes
  )
  RETURNING id INTO v_installation_id;

  FOREACH v_unit_id IN ARRAY p_material_unit_ids LOOP
    SELECT status, classification INTO v_status, v_classification
      FROM material_units
     WHERE company_id = p_company_id AND id = v_unit_id;

    IF v_status NOT IN ('AVAILABLE', 'RESERVED') THEN
      RAISE EXCEPTION 'install_material: material_unit % has status % (must be AVAILABLE or RESERVED)', v_unit_id, v_status;
    END IF;
    IF v_classification NOT IN ('PREPARED', 'ORIGINAL') THEN
      RAISE EXCEPTION 'install_material: material_unit % has classification % (must be PREPARED or ORIGINAL)', v_unit_id, v_classification;
    END IF;

    -- BUG AVOIDED (found running this against real Postgres, Task 4):
    -- `trg_block_invalid_unit_reference` (04) rejects any
    -- `installation_lines` insert against a unit whose status is already
    -- `INSTALLED` — correct for blocking a *different*, later attempt to
    -- reuse an already-installed unit, but it was firing against THIS
    -- call's own insert, because the status UPDATE used to run first.
    -- The insert must happen BEFORE the status transition — exactly the
    -- same ordering `record_processing_operation` already uses for
    -- `processing_inputs` (insert the reference while still consumable,
    -- only then flip the unit to `CONSUMED`).
    INSERT INTO installation_lines (company_id, installation_id, material_unit_id, created_at)
    VALUES (p_company_id, v_installation_id, v_unit_id, now());

    UPDATE material_units
       SET status = 'INSTALLED', current_storage_location_id = NULL, updated_at = now()
     WHERE company_id = p_company_id AND id = v_unit_id;
  END LOOP;

  RETURN v_installation_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- supersede_installation — a correction after the fact (e.g. the wrong
-- reinforcement purpose was recorded). Flips the existing installations row
-- to SUPERSEDED, then creates a new, correcting one referencing the SAME
-- material_unit_ids, with supersedes_id set (§11a, §15's supersede-chain
-- pattern).
--
-- BUG AVOIDED (found while writing this): this does NOT delegate to
-- `install_material` — that function requires each referenced unit's
-- `status IN ('AVAILABLE','RESERVED')`, but a unit being corrected here is
-- already `INSTALLED` (that's the whole point of a correction) and would
-- fail that precondition immediately. Correcting the installation RECORD
-- (which element/purpose/declaration/BBS-line it's attributed to) is a
-- different operation from installing material for the first time, so it
-- gets its own, simpler body: verify each unit is currently `INSTALLED`
-- (via THIS installation specifically — see the check below), then just
-- insert the new installations/installation_lines rows. No
-- `material_units` row is touched at all — correct, since the physical
-- fact "this unit is installed" hasn't changed, only which element/purpose
-- record it's attributed to.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION supersede_installation(
  p_company_id                       uuid,
  p_installation_id_to_supersede        uuid,
  p_structural_element_instance_id     uuid,
  p_reinforcement_purpose_id            uuid,
  p_intended_usage_declaration_id         uuid,
  p_bbs_line_id                            uuid,
  p_installed_by_membership_id              uuid,
  p_notes                                     text,
  p_material_unit_ids                          uuid[]
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_old            installations%ROWTYPE;
  v_new_id         uuid;
  v_unit_id        uuid;
  v_already_lined  boolean;
BEGIN
  SELECT * INTO v_old
    FROM installations
   WHERE company_id = p_company_id AND id = p_installation_id_to_supersede
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'supersede_installation: installation % not found for company %', p_installation_id_to_supersede, p_company_id;
  END IF;

  IF v_old.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'supersede_installation: installation % is already % (must be ACTIVE)', p_installation_id_to_supersede, v_old.status;
  END IF;

  PERFORM 1 FROM material_units
   WHERE company_id = p_company_id AND id = ANY (p_material_unit_ids)
   ORDER BY id
     FOR UPDATE;

  -- Every corrected unit must actually have been part of the installation
  -- being superseded — a correction re-attributes, it never silently pulls
  -- in a unit that was never installed under this record in the first place.
  FOREACH v_unit_id IN ARRAY p_material_unit_ids LOOP
    SELECT EXISTS (
      SELECT 1 FROM installation_lines
       WHERE company_id = p_company_id AND installation_id = p_installation_id_to_supersede AND material_unit_id = v_unit_id
    ) INTO v_already_lined;

    IF NOT v_already_lined THEN
      RAISE EXCEPTION 'supersede_installation: material_unit % was not part of installation % — cannot supersede with a different unit set',
        v_unit_id, p_installation_id_to_supersede;
    END IF;
  END LOOP;

  UPDATE installations
     SET status = 'SUPERSEDED'
   WHERE company_id = p_company_id AND id = p_installation_id_to_supersede;

  INSERT INTO installations (
    company_id, project_id, structural_element_instance_id, reinforcement_purpose_id,
    intended_usage_declaration_id, bbs_line_id, installed_by_membership_id, installed_at,
    status, supersedes_id, notes
  ) VALUES (
    p_company_id, v_old.project_id, p_structural_element_instance_id, p_reinforcement_purpose_id,
    p_intended_usage_declaration_id, p_bbs_line_id, p_installed_by_membership_id, now(),
    'ACTIVE', p_installation_id_to_supersede, p_notes
  )
  RETURNING id INTO v_new_id;

  FOREACH v_unit_id IN ARRAY p_material_unit_ids LOOP
    INSERT INTO installation_lines (company_id, installation_id, material_unit_id, created_at)
    VALUES (p_company_id, v_new_id, v_unit_id, now());
  END LOOP;

  RETURN v_new_id;
END;
$$;

-- =============================================================================
-- record_physical_stock_count
-- =============================================================================
--
-- Locks the referenced material_units rows (sorted), snapshots each one's
-- current quantity_pieces/remaining() into system_pieces/system_length_m
-- UNDER THAT LOCK, inserts the physical_stock_counts/physical_stock_count_lines
-- rows. Creating a conservation_adjustments row against a resulting
-- variance line is a SEPARATE, later step (§9b) — not part of this
-- function.
--
-- p_lines shape: [{"material_unit_id": "...", "counted_pieces": N, "counted_length_m": N, "investigation_notes": "..."|null}, ...]
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_physical_stock_count(
  p_company_id               uuid,
  p_storage_location_id        uuid,
  p_reference_code               text,
  p_count_date                     date,
  p_counted_by_membership_id         uuid,
  p_notes                               text,
  p_lines                                 jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count_id   uuid;
  v_line       jsonb;
  v_unit_id    uuid;
  v_sorted_unit_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT (elem ->> 'material_unit_id')::uuid ORDER BY (elem ->> 'material_unit_id')::uuid)
    INTO v_sorted_unit_ids
    FROM jsonb_array_elements(p_lines) elem;

  PERFORM 1 FROM material_units
   WHERE company_id = p_company_id AND id = ANY (v_sorted_unit_ids)
   ORDER BY id
     FOR UPDATE;

  INSERT INTO physical_stock_counts (company_id, storage_location_id, reference_code, count_date, status, counted_by_membership_id, notes, created_at)
  VALUES (p_company_id, p_storage_location_id, p_reference_code, p_count_date, 'ACTIVE', p_counted_by_membership_id, p_notes, now())
  RETURNING id INTO v_count_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_unit_id := (v_line ->> 'material_unit_id')::uuid;

    INSERT INTO physical_stock_count_lines (
      company_id, physical_stock_count_id, material_unit_id,
      system_pieces, system_length_m, counted_pieces, counted_length_m, variance_length_m, investigation_notes
    )
    SELECT
      p_company_id, v_count_id, v_unit_id,
      mu.quantity_pieces, material_unit_remaining_length_m(p_company_id, v_unit_id),
      (v_line ->> 'counted_pieces')::integer, (v_line ->> 'counted_length_m')::numeric,
      (v_line ->> 'counted_length_m')::numeric - material_unit_remaining_length_m(p_company_id, v_unit_id),
      v_line ->> 'investigation_notes'
    FROM material_units mu
    WHERE mu.company_id = p_company_id AND mu.id = v_unit_id;
  END LOOP;

  RETURN v_count_id;
END;
$$;

-- =============================================================================
-- record_approval
-- =============================================================================
--
-- The single, generalized maker-checker function (CLAUDE.md §2.19) for the
-- tables that are otherwise pure immutable event logs: `processing_operations`
-- (checked_by/checked_at), `reclassification_events`, `conservation_adjustments`,
-- `bbs_schedules`, `physical_stock_counts` (verified_by/verified_at),
-- `installations` (verified_by/verified_at). `bundles.approved_by_membership_id`
-- does NOT go through this function — see 02/12's note (ordinary mutable
-- master-data correction instead).
--
-- p_target_table is validated against a fixed allow-list — never an
-- arbitrary, caller-supplied table name.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_approval(
  p_company_id               uuid,
  p_target_table               text,
  p_target_id                    uuid,
  p_approving_membership_id        uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_maker_membership_id uuid;
BEGIN
  IF p_target_table NOT IN (
    'processing_operations', 'reclassification_events', 'conservation_adjustments',
    'bbs_schedules', 'physical_stock_counts', 'installations'
  ) THEN
    RAISE EXCEPTION 'record_approval: % is not an approvable table', p_target_table;
  END IF;

  IF p_target_table = 'processing_operations' THEN
    SELECT performed_by_membership_id INTO v_maker_membership_id
      FROM processing_operations WHERE company_id = p_company_id AND id = p_target_id FOR UPDATE;
  ELSIF p_target_table = 'reclassification_events' THEN
    SELECT recorded_by_membership_id INTO v_maker_membership_id
      FROM reclassification_events WHERE company_id = p_company_id AND id = p_target_id FOR UPDATE;
  ELSIF p_target_table = 'conservation_adjustments' THEN
    SELECT recorded_by_membership_id INTO v_maker_membership_id
      FROM conservation_adjustments WHERE company_id = p_company_id AND id = p_target_id FOR UPDATE;
  ELSIF p_target_table = 'bbs_schedules' THEN
    SELECT prepared_by_membership_id INTO v_maker_membership_id
      FROM bbs_schedules WHERE company_id = p_company_id AND id = p_target_id FOR UPDATE;
  ELSIF p_target_table = 'physical_stock_counts' THEN
    SELECT counted_by_membership_id INTO v_maker_membership_id
      FROM physical_stock_counts WHERE company_id = p_company_id AND id = p_target_id FOR UPDATE;
  ELSIF p_target_table = 'installations' THEN
    SELECT installed_by_membership_id INTO v_maker_membership_id
      FROM installations WHERE company_id = p_company_id AND id = p_target_id FOR UPDATE;
  END IF;

  IF v_maker_membership_id IS NULL THEN
    RAISE EXCEPTION 'record_approval: % % not found for company %', p_target_table, p_target_id, p_company_id;
  END IF;

  IF p_approving_membership_id = v_maker_membership_id THEN
    RAISE EXCEPTION 'record_approval: approving membership % cannot equal the recording/maker membership on % %', p_approving_membership_id, p_target_table, p_target_id;
  END IF;

  IF p_target_table = 'processing_operations' THEN
    UPDATE processing_operations SET checked_by_membership_id = p_approving_membership_id, checked_at = now()
     WHERE company_id = p_company_id AND id = p_target_id AND checked_by_membership_id IS NULL;
  ELSIF p_target_table = 'reclassification_events' THEN
    UPDATE reclassification_events SET approved_by_membership_id = p_approving_membership_id, approved_at = now()
     WHERE company_id = p_company_id AND id = p_target_id AND approved_by_membership_id IS NULL;
  ELSIF p_target_table = 'conservation_adjustments' THEN
    UPDATE conservation_adjustments SET approved_by_membership_id = p_approving_membership_id, approved_at = now()
     WHERE company_id = p_company_id AND id = p_target_id AND approved_by_membership_id IS NULL;
  ELSIF p_target_table = 'bbs_schedules' THEN
    UPDATE bbs_schedules SET approved_by_membership_id = p_approving_membership_id, approved_at = now()
     WHERE company_id = p_company_id AND id = p_target_id AND approved_by_membership_id IS NULL;
  ELSIF p_target_table = 'physical_stock_counts' THEN
    UPDATE physical_stock_counts SET verified_by_membership_id = p_approving_membership_id, verified_at = now()
     WHERE company_id = p_company_id AND id = p_target_id AND verified_by_membership_id IS NULL;
  ELSIF p_target_table = 'installations' THEN
    UPDATE installations SET verified_by_membership_id = p_approving_membership_id, verified_at = now()
     WHERE company_id = p_company_id AND id = p_target_id AND verified_by_membership_id IS NULL;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_approval: % % was already approved/checked/verified — single-fill, never reset', p_target_table, p_target_id;
  END IF;
END;
$$;

-- =============================================================================
-- record_conservation_adjustment
-- =============================================================================
--
-- GAP CLOSED, Task 5: `record_physical_stock_count`'s own comment above
-- flagged this as "a SEPARATE, later step (§9b) — not part of this
-- function," and `conservation_adjustments` already carries the full
-- three-way-parent/non-zero-amount/maker-checker CHECK shape (02) and its
-- own deferred conservation-recheck triggers (04,
-- `fn_trg_transfer_line_conservation_from_adjustment` /
-- `fn_trg_processing_conservation_from_adjustment`) — but no controlled
-- function ever existed to actually INSERT one. `steeltrace_app` has no
-- direct INSERT grant on this table (01), so without this function Task
-- 5's "receive a transfer line, optionally with a conservation adjustment"
-- flow (CLAUDE.md §2.10/§2.17) had no legal write path at all. Generalized
-- over all three parent kinds (processing/transfer-line/stock-count-line)
-- rather than one-per-kind, since the row shape and lock-then-insert
-- discipline (§12) are identical for all three — only which single parent
-- column is populated differs.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_conservation_adjustment(
  p_company_id                  uuid,
  p_processing_operation_id      uuid,   -- exactly one of these three must be non-NULL
  p_material_transfer_line_id     uuid,
  p_physical_stock_count_line_id   uuid,
  p_measurement_basis               measurement_basis_enum,
  p_amount                            numeric,
  p_adjustment_type                    adjustment_type_enum,
  p_reason                               text,
  p_recorded_by_membership_id              uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF (CASE WHEN p_processing_operation_id IS NOT NULL THEN 1 ELSE 0 END)
   + (CASE WHEN p_material_transfer_line_id IS NOT NULL THEN 1 ELSE 0 END)
   + (CASE WHEN p_physical_stock_count_line_id IS NOT NULL THEN 1 ELSE 0 END) <> 1 THEN
    RAISE EXCEPTION 'record_conservation_adjustment: exactly one of processing_operation_id/material_transfer_line_id/physical_stock_count_line_id must be set';
  END IF;

  -- Lock whichever parent row is referenced first (§12) — a concurrent
  -- receive/dispatch/count against the same parent must not race this.
  IF p_processing_operation_id IS NOT NULL THEN
    PERFORM 1 FROM processing_operations WHERE company_id = p_company_id AND id = p_processing_operation_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_conservation_adjustment: processing_operation % not found for company %', p_processing_operation_id, p_company_id;
    END IF;
  ELSIF p_material_transfer_line_id IS NOT NULL THEN
    PERFORM 1 FROM material_transfer_lines WHERE company_id = p_company_id AND id = p_material_transfer_line_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_conservation_adjustment: material_transfer_line % not found for company %', p_material_transfer_line_id, p_company_id;
    END IF;
  ELSE
    PERFORM 1 FROM physical_stock_count_lines WHERE company_id = p_company_id AND id = p_physical_stock_count_line_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_conservation_adjustment: physical_stock_count_line % not found for company %', p_physical_stock_count_line_id, p_company_id;
    END IF;
  END IF;

  INSERT INTO conservation_adjustments (
    company_id, processing_operation_id, material_transfer_line_id, physical_stock_count_line_id,
    measurement_basis, amount, adjustment_type, reason, recorded_by_membership_id, created_at
  ) VALUES (
    p_company_id, p_processing_operation_id, p_material_transfer_line_id, p_physical_stock_count_line_id,
    p_measurement_basis, p_amount, p_adjustment_type, p_reason, p_recorded_by_membership_id, now()
  )
  RETURNING id INTO v_id;
  -- 04's deferred constraint triggers re-validate the conservation
  -- invariant for whichever parent this targets before COMMIT.

  RETURN v_id;
END;
$$;

-- =============================================================================
-- reserve_material_unit / release_reservation
-- =============================================================================
--
-- GAP CLOSED, Task 6: `material_reservations` itself has an ordinary
-- `GRANT INSERT, UPDATE ... TO steeltrace_app` (01 — "no dedicated
-- controlled function in this design"), but the whole point of a
-- reservation is to also flip the referenced unit's `material_units.status
-- -> 'RESERVED'` (CLAUDE.md's reservation model, §14 of the physical
-- design doc's "Reserved" rollup row) — and `material_units` is itself a
-- controlled-function-only table (01's REVOKE list), so `steeltrace_app`
-- had no legal way to make that status transition at all. Mirrors
-- `record_conservation_adjustment`'s Task 5 fix: the surrounding row
-- (`material_reservations`) was always writable, but the one column that
-- actually matters (`material_units.status`) was not, with no function to
-- bridge the two. Whole-unit only (§14 of the physical design doc — a
-- partial reservation is "split it first, then reserve the child"), so
-- there is no quantity parameter here, matching `install_material`'s own
-- "no quantity parameter, acts on the whole unit" shape.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reserve_material_unit(
  p_company_id                     uuid,
  p_material_unit_id                uuid,
  p_intended_usage_declaration_id     uuid,  -- nullable
  p_bbs_line_id                         uuid,  -- nullable
  p_reserved_by_membership_id             uuid,
  p_expires_at                               timestamptz  -- nullable
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_status         material_status_enum;
  v_reservation_id uuid;
BEGIN
  SELECT status INTO v_status
    FROM material_units
   WHERE company_id = p_company_id AND id = p_material_unit_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reserve_material_unit: material_unit % not found for company %', p_material_unit_id, p_company_id;
  END IF;

  IF v_status <> 'AVAILABLE' THEN
    RAISE EXCEPTION 'reserve_material_unit: material_unit % is not AVAILABLE (status = %)', p_material_unit_id, v_status;
  END IF;

  INSERT INTO material_reservations (
    company_id, material_unit_id, intended_usage_declaration_id, bbs_line_id,
    reserved_by_membership_id, reserved_at, expires_at
  ) VALUES (
    p_company_id, p_material_unit_id, p_intended_usage_declaration_id, p_bbs_line_id,
    p_reserved_by_membership_id, now(), p_expires_at
  )
  RETURNING id INTO v_reservation_id;

  UPDATE material_units
     SET status = 'RESERVED', updated_at = now()
   WHERE company_id = p_company_id AND id = p_material_unit_id;

  RETURN v_reservation_id;
END;
$$;

-- `p_release_type = 'FULFILLED'` means the reservation's own unit was
-- ALREADY consumed through its ordinary path (`install_material`/
-- `record_processing_operation`, both of which accept status `RESERVED`
-- as a valid precondition) — by the time this is called, the unit's
-- status is already `INSTALLED`/`CONSUMED`, not `RESERVED`, so this
-- function must NOT touch it (doing so would overwrite a later, correct
-- state with a wrong earlier one). Only `CANCELLED`/`EXPIRED` — "nothing
-- happened, give the material back to the pool" — revert the unit to
-- `AVAILABLE`, and only if it is still actually `RESERVED` (defensive:
-- never silently stomp on a status this reservation no longer owns).
CREATE OR REPLACE FUNCTION release_reservation(
  p_company_id                uuid,
  p_reservation_id             uuid,
  p_release_type                release_type_enum,
  p_release_reason                text,
  p_released_by_membership_id       uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_unit_id uuid;
  v_status  material_status_enum;
BEGIN
  SELECT material_unit_id INTO v_unit_id
    FROM material_reservations
   WHERE company_id = p_company_id AND id = p_reservation_id AND released_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'release_reservation: reservation % not found for company % (or already released)', p_reservation_id, p_company_id;
  END IF;

  SELECT status INTO v_status
    FROM material_units
   WHERE company_id = p_company_id AND id = v_unit_id
     FOR UPDATE;

  UPDATE material_reservations
     SET released_at = now(), released_by_membership_id = p_released_by_membership_id,
         release_type = p_release_type, release_reason = p_release_reason
   WHERE company_id = p_company_id AND id = p_reservation_id;

  IF p_release_type IN ('CANCELLED', 'EXPIRED') AND v_status = 'RESERVED' THEN
    UPDATE material_units
       SET status = 'AVAILABLE', updated_at = now()
     WHERE company_id = p_company_id AND id = v_unit_id;
  END IF;
END;
$$;

-- =============================================================================
-- Grant EXECUTE to steeltrace_app (deferred to here from 01 — see that
-- file's header note: these functions must exist before they can be
-- granted).
-- =============================================================================
GRANT EXECUTE ON FUNCTION
  register_bundle(uuid, uuid, uuid, text, uuid, uuid, text, numeric, text, text, text, integer, numeric, rebar_surface_type_enum, bundle_origin_type_enum, text, text, text, text, text, text, numeric, receipt_disposition_enum, uuid),
  split_material_unit(uuid, uuid, integer, numeric, numeric, numeric, numeric, material_granularity_enum, text, uuid),
  record_processing_operation(uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, jsonb, jsonb, jsonb),
  finalize_processing_operation(uuid, uuid),
  dispatch_material_transfer(uuid, uuid, uuid, uuid, uuid, text, text, jsonb),
  receive_transfer_line(uuid, uuid, uuid, text, jsonb),
  reallocate_project(uuid, uuid, uuid, uuid, text),
  release_hold(uuid, uuid, uuid, text),
  reclassify_material_unit(uuid, uuid, material_classification_enum, text, uuid, text),
  install_material(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid[]),
  supersede_installation(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid[]),
  record_physical_stock_count(uuid, uuid, text, date, uuid, text, jsonb),
  record_approval(uuid, text, uuid, uuid),
  record_conservation_adjustment(uuid, uuid, uuid, uuid, measurement_basis_enum, numeric, adjustment_type_enum, text, uuid),
  reserve_material_unit(uuid, uuid, uuid, uuid, uuid, timestamptz),
  release_reservation(uuid, uuid, release_type_enum, text, uuid)
TO steeltrace_app;
