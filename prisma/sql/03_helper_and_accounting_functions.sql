-- =============================================================================
-- SteelTrace — 03: Helper & accounting functions
--
-- Pure/stable read-only functions used by both the trigger layer (04) and
-- the controlled mutation functions (05). None of these write anything.
-- Depends on: 01 (enums/tables already exist via Prisma), 02 (constraints
-- these formulas assume hold, e.g. total_length_m consistency).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- spec_compare — the three-valued specification-compatibility function
-- (docs/physical-database-design.md §8). Returns 'CONFIRMED_MATCH',
-- 'CONFIRMED_INCOMPATIBLE', or 'UNKNOWN'.
--
-- IMPORTANT: g1/g2 and std1/std2 are expected to be the already-*normalized*
-- values (`grade_normalized`/`standard_normalized`) — this function does not
-- re-normalize. Callers must pass normalized columns, never the verbatim
-- `grade`/`standard` label text (§8: "original label values are always
-- preserved... alongside the normalized comparison columns").
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION spec_compare(
  d1   numeric,
  s1   rebar_surface_type_enum,
  g1   text,
  std1 text,
  d2   numeric,
  s2   rebar_surface_type_enum,
  g2   text,
  std2 text
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF d1 IS DISTINCT FROM d2 OR g1 IS DISTINCT FROM g2 OR s1 IS DISTINCT FROM s2 THEN
    RETURN 'CONFIRMED_INCOMPATIBLE';
  ELSIF std1 IS NOT NULL AND std2 IS NOT NULL THEN
    IF std1 = std2 THEN
      RETURN 'CONFIRMED_MATCH';
    ELSE
      RETURN 'CONFIRMED_INCOMPATIBLE';
    END IF;
  ELSE
    -- at least one side's standard is simply not known — never read as
    -- agreement, never read as disagreement (§8).
    RETURN 'UNKNOWN';
  END IF;
END;
$$;

COMMENT ON FUNCTION spec_compare(numeric, rebar_surface_type_enum, text, text, numeric, rebar_surface_type_enum, text, text)
  IS 'Three-valued spec comparison (§8). Default policy applied by every caller: only CONFIRMED_MATCH counts as compatible; UNKNOWN is treated the same as CONFIRMED_INCOMPATIBLE for every automated/trigger-enforced purpose.';

-- -----------------------------------------------------------------------------
-- spec_compare_units — convenience overload comparing two material_units
-- rows directly by id, for trigger code that only has unit ids on hand.
-- Not explicitly requested by name, but a thin, obviously-correct wrapper
-- around spec_compare(), added to avoid repeating the 8-argument call (and
-- the normalized-column lookup) in every trigger that needs it (04).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION spec_compare_units(
  p_company_id uuid,
  p_unit_id_1  uuid,
  p_unit_id_2  uuid
) RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_result text;
BEGIN
  SELECT spec_compare(a.diameter_mm, a.surface_type, a.grade_normalized, a.standard_normalized,
                       b.diameter_mm, b.surface_type, b.grade_normalized, b.standard_normalized)
    INTO v_result
    FROM material_units a, material_units b
   WHERE a.company_id = p_company_id AND a.id = p_unit_id_1
     AND b.company_id = p_company_id AND b.id = p_unit_id_2;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'spec_compare_units: one or both material_units (%, %) not found for company %',
      p_unit_id_1, p_unit_id_2, p_company_id;
  END IF;

  RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- material_unit_remaining_length_m — the §14 remaining(unit) formula.
--
-- remaining(unit) = total_length_m(unit)
--    − Σ(processing_inputs.length_consumed_m WHERE material_unit_id = unit)
--    − Σ(material_splits rows split off this unit, via each resulting
--        child's own total_length_m)   -- gap closed, Task 3: see §14's note
--    − Σ(material_transfer_receipt_lines rows drawn against a line WHOSE
--        OWN PLACEHOLDER IS this unit, via the created unit's own
--        total_length_m)   -- corrected, this pass: see note below
--    − Σ(conservation_adjustments.amount WHERE amount > 0 AND the
--        referenced material_transfer_line's OWN PLACEHOLDER IS this unit)
--    − Σ(conservation_adjustments.amount WHERE amount > 0 AND
--        physical_stock_count_line_id references a count line for unit,
--        AND approved_by_membership_id IS NOT NULL)   -- Edition 2 addition
--    − total_length_m(unit) if status IN ('INSTALLED','CONSUMED')
--
-- The `material_splits` term above was ABSENT from every prior edition of
-- this formula in docs/physical-database-design.md §14 — found while
-- implementing this function (Task 3). Without it, a unit split via
-- `material_splits` (the mechanism `project_allocations`/
-- `material_reservations` rely on for "split it first") would never have
-- its remaining() reduced by the split-off child's length, so the parent
-- and the child would both claim the same length simultaneously — the
-- double-counting §2.5 of CLAUDE.md calls the system's single most
-- safety-critical rule.
--
-- SECOND BUG, found and fixed THIS pass: the two transfer-receipt/
-- transfer-adjustment terms used to key off `material_transfer_lines.
-- split_from_material_unit_id = unit` — i.e. they fired against the
-- DISPATCH SOURCE (e.g. U0 in §20's worked example), not the IN-TRANSIT
-- PLACEHOLDER (U0a). Combined with the `material_splits` term above
-- (which already, correctly, subtracts the placeholder's full length from
-- the source the INSTANT it is split off at dispatch — a permanent,
-- one-time departure), that made receiving the placeholder subtract the
-- SAME length from the source A SECOND TIME, well after it had already
-- left. The fix: these two terms now key off `material_transfer_lines.
-- material_unit_id = unit` instead — i.e. they fire against the
-- PLACEHOLDER ITSELF, modeling what every receipt event draws down FROM
-- the placeholder's own 12 m, not what it (incorrectly, twice) removed
-- from the original source. Worked through against §20/§14's example:
--   - Before dispatch:            remaining(U0)  = 5088, U0a doesn't exist yet.
--   - Immediately after dispatch: remaining(U0)  = 5088 − 12 = 5076 (material_splits term, permanent).
--                                 remaining(U0a) = 12 − 0 = 12 (no receipts against U0a's line yet).
--   - After receiving 12 m into U1: remaining(U0) unchanged, still 5076 (the split term never re-fires).
--                                 remaining(U0a) = 12 − 12 = 0 (the receipt term, now correctly keyed to U0a).
--                                 remaining(U1)  = 12 (newly created, untouched so far).
-- `U0a` reaching `remaining() = 0` is exactly §11's trigger condition for
-- a transfer line — and therefore the whole transfer — to reach `RECEIVED`.
--
-- Once INSTALLED/CONSUMED, remaining() is frozen at 0 forever (§14) — this
-- is implemented as an explicit short-circuit, not merely a consequence of
-- the subtraction terms happening to net to zero, so it stays correct even
-- if a future caller finds a path that doesn't record consumption that way.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION material_unit_remaining_length_m(
  p_company_id uuid,
  p_unit_id    uuid
) RETURNS numeric(10,3)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_total        numeric(10,3);
  v_status       material_status_enum;
  v_consumed     numeric(10,3);
  v_split_off    numeric(10,3);
  v_transferred  numeric(10,3);
  v_transfer_adj numeric(10,3);
  v_count_adj    numeric(10,3);
BEGIN
  SELECT total_length_m, status
    INTO v_total, v_status
    FROM material_units
   WHERE company_id = p_company_id AND id = p_unit_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'material_unit % not found for company %', p_unit_id, p_company_id;
  END IF;

  IF v_status IN ('INSTALLED', 'CONSUMED') THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(SUM(length_consumed_m), 0)
    INTO v_consumed
    FROM processing_inputs
   WHERE company_id = p_company_id AND material_unit_id = p_unit_id;

  -- Departure: something was split OFF this unit (dispatch always splits,
  -- §2 — this is where a dispatch source's length permanently leaves it).
  SELECT COALESCE(SUM(mu.total_length_m), 0)
    INTO v_split_off
    FROM material_splits ms
    JOIN material_units mu
      ON mu.company_id = ms.company_id AND mu.id = ms.resulting_material_unit_id
   WHERE ms.company_id = p_company_id
     AND ms.source_material_unit_id = p_unit_id;

  -- Drawdown: THIS unit is itself an in-transit placeholder being received
  -- against (corrected — was `split_from_material_unit_id`, see note above).
  SELECT COALESCE(SUM(mu.total_length_m), 0)
    INTO v_transferred
    FROM material_transfer_receipt_lines mtrl
    JOIN material_transfer_lines mtl
      ON mtl.company_id = mtrl.company_id AND mtl.id = mtrl.material_transfer_line_id
    JOIN material_units mu
      ON mu.company_id = mtrl.company_id AND mu.id = mtrl.resulting_material_unit_id
   WHERE mtrl.company_id = p_company_id
     AND mtl.material_unit_id = p_unit_id;

  SELECT COALESCE(SUM(ca.amount), 0)
    INTO v_transfer_adj
    FROM conservation_adjustments ca
    JOIN material_transfer_lines mtl
      ON mtl.company_id = ca.company_id AND mtl.id = ca.material_transfer_line_id
   WHERE ca.company_id = p_company_id
     AND ca.amount > 0
     AND mtl.material_unit_id = p_unit_id;

  SELECT COALESCE(SUM(ca.amount), 0)
    INTO v_count_adj
    FROM conservation_adjustments ca
    JOIN physical_stock_count_lines pscl
      ON pscl.company_id = ca.company_id AND pscl.id = ca.physical_stock_count_line_id
   WHERE ca.company_id = p_company_id
     AND ca.amount > 0
     AND ca.approved_by_membership_id IS NOT NULL
     AND pscl.material_unit_id = p_unit_id;

  RETURN v_total - v_consumed - v_split_off - v_transferred - v_transfer_adj - v_count_adj;
END;
$$;

COMMENT ON FUNCTION material_unit_remaining_length_m(uuid, uuid)
  IS 'The §14 remaining(unit) formula. STABLE, read-only — every controlling function (§12) calls this under the row lock it already holds before validating a new consumption/dispatch/count against it.';

-- -----------------------------------------------------------------------------
-- theoretical_weight_kg — §14/§20: theoretical_weight_kg(unit) =
-- total_length_m(unit) * linear_density_kg_per_m(catalog item matching the
-- unit's diameter_mm + surface_type). Reporting/QA only — NEVER written
-- back onto material_units/bundles (§3a, §14).
--
-- The design doc matches a catalog item by diameter_mm + surface_type alone
-- (grade is not part of the stated matching key). Where more than one
-- active catalog item shares a (diameter_mm, surface_type) pair (e.g. two
-- grades of the same size), this implementation prefers one whose
-- `default_grade` matches the unit's `grade_normalized`, falling back to
-- the lowest-id match otherwise — a documented, deterministic tie-break,
-- not a silent/arbitrary one.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION theoretical_weight_kg(
  p_company_id uuid,
  p_unit_id    uuid
) RETURNS numeric(10,3)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_total_length numeric(10,3);
  v_diameter     numeric(6,2);
  v_surface      rebar_surface_type_enum;
  v_grade_norm   text;
  v_density      numeric(8,4);
BEGIN
  SELECT total_length_m, diameter_mm, surface_type, grade_normalized
    INTO v_total_length, v_diameter, v_surface, v_grade_norm
    FROM material_units
   WHERE company_id = p_company_id AND id = p_unit_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'material_unit % not found for company %', p_unit_id, p_company_id;
  END IF;

  SELECT rci.linear_density_kg_per_m
    INTO v_density
    FROM rebar_catalog_items rci
   WHERE rci.company_id = p_company_id
     AND rci.diameter_mm = v_diameter
     AND rci.surface_type = v_surface
     AND rci.is_active
   ORDER BY (rci.default_grade IS NOT NULL AND upper(trim(rci.default_grade)) = v_grade_norm) DESC,
            rci.id
   LIMIT 1;

  IF v_density IS NULL THEN
    RETURN NULL; -- no matching catalog item; never fabricated (§3a)
  END IF;

  RETURN v_total_length * v_density;
END;
$$;

-- -----------------------------------------------------------------------------
-- rolling_margin_kg — §14/§20: rolling_margin_kg(bundle) = actual_weight_kg
-- - (piece_count * bar_length_m * linear_density_kg_per_m(matching catalog
-- item)). NULL (not zero, not fabricated) when the bundle was never
-- weighbridge-measured or no matching catalog item exists.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rolling_margin_kg(
  p_company_id uuid,
  p_bundle_id  uuid
) RETURNS numeric(10,3)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_actual_weight numeric(10,3);
  v_piece_count   integer;
  v_bar_length    numeric(10,3);
  v_diameter      numeric(6,2);
  v_surface       rebar_surface_type_enum;
  v_grade_norm    text;
  v_density       numeric(8,4);
BEGIN
  SELECT actual_weight_kg, piece_count, bar_length_m, diameter_mm, surface_type, grade_normalized
    INTO v_actual_weight, v_piece_count, v_bar_length, v_diameter, v_surface, v_grade_norm
    FROM bundles
   WHERE company_id = p_company_id AND id = p_bundle_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bundle % not found for company %', p_bundle_id, p_company_id;
  END IF;

  IF v_actual_weight IS NULL THEN
    RETURN NULL; -- never weighbridge-measured (e.g. OPENING_STOCK, §18)
  END IF;

  SELECT rci.linear_density_kg_per_m
    INTO v_density
    FROM rebar_catalog_items rci
   WHERE rci.company_id = p_company_id
     AND rci.diameter_mm = v_diameter
     AND rci.surface_type = v_surface
     AND rci.is_active
   ORDER BY (rci.default_grade IS NOT NULL AND upper(trim(rci.default_grade)) = v_grade_norm) DESC,
            rci.id
   LIMIT 1;

  IF v_density IS NULL THEN
    RETURN NULL; -- no matching catalog item; never fabricated (§3a)
  END IF;

  RETURN v_actual_weight - (v_piece_count * v_bar_length * v_density);
END;
$$;
