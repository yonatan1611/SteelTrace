import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTenantAuth, withAuthedTenantContext } from "../auth/middleware";
import { NotFoundError } from "../../api/errors";

const KG_PER_MT = 1000;

/**
 * §14's accounting formulas, as single-statement SQL aggregates rather
 * than one `material_unit_remaining_length_m()` round trip per row from
 * Node (the N+1 pattern Task 5 found unsafe/slow against Prisma's
 * interactive-transaction timeout) — calling the function once per
 * matching row INSIDE one query is ordinary server-side SQL execution,
 * not an extra network round trip, so this scales to the whole company's
 * inventory in one statement.
 */
export function registerReportRoutes(app: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // GET /api/reports/kpis — Module 01 executive KPIs.
  // -------------------------------------------------------------------------
  const kpisQuery = z.object({ projectId: z.string().uuid().optional() });

  app.get("/api/reports/kpis", { preHandler: requireTenantAuth }, async (request) => {
    const q = kpisQuery.parse(request.query);
    const { companyId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const projectFilter = q.projectId ? `AND project_id = $2::uuid` : "";
      const params: unknown[] = q.projectId ? [companyId, q.projectId] : [companyId];

      // total_inventory_kg is deliberately NOT a density-derived theoretical
      // figure like the other seven buckets below — a bundle's own
      // actual_weight_kg (ground truth at intake: either the flat
      // opening-stock figure or the weighbridge-measured GRN figure, §2.13)
      // IS already a real total-weight number for every bundle, with no
      // per-unit density estimate needed. Using it here is exactly why
      // "Total Inventory" matches the 204 MT opening balance precisely,
      // while the theoretical/actual gap for every OTHER bucket (where no
      // single bundle-level actual weight applies to an arbitrary
      // downstream piece/offcut) is the expected §2.15 "rolling margin" —
      // not an inconsistency to paper over.
      const totalInventoryRows = await tx.$queryRawUnsafe<{ kg: string }[]>(
        `SELECT COALESCE(SUM(actual_weight_kg), 0) AS kg FROM bundles WHERE company_id = $1::uuid ${projectFilter}`,
        ...params,
      );
      const totalInventoryKg = Number(totalInventoryRows[0]!.kg);

      // The other seven buckets (§2.15: a unit's weight is only ever
      // derived via the company's own rebar_catalog_items density, never
      // fabricated) — grouped by (diameter_mm, surface_type) first, THEN
      // joined to that size's density and summed, exactly the join
      // `reorderAlerts` below already does for "available" alone,
      // generalized here to every remaining bucket. A size with no
      // catalog entry contributes 0 kg (COALESCE), surfaced honestly
      // rather than guessed.
      const bucketRows = await tx.$queryRawUnsafe<
        {
          available_kg: string;
          reserved_kg: string;
          on_hold_kg: string;
          in_transit_kg: string;
          installed_kg: string;
          reusable_offcut_kg: string;
          scrap_kg: string;
        }[]
      >(
        `WITH per_size AS (
           SELECT diameter_mm, surface_type,
                  COALESCE(SUM(CASE WHEN status = 'AVAILABLE' THEN material_unit_remaining_length_m(company_id, id) ELSE 0 END), 0) AS available_m,
                  COALESCE(SUM(CASE WHEN status = 'RESERVED' THEN material_unit_remaining_length_m(company_id, id) ELSE 0 END), 0) AS reserved_m,
                  COALESCE(SUM(CASE WHEN status = 'ON_HOLD' THEN material_unit_remaining_length_m(company_id, id) ELSE 0 END), 0) AS on_hold_m,
                  COALESCE(SUM(CASE WHEN status = 'DISPATCHED' THEN material_unit_remaining_length_m(company_id, id) ELSE 0 END), 0) AS in_transit_m,
                  COALESCE(SUM(CASE WHEN status = 'INSTALLED' THEN total_length_m ELSE 0 END), 0) AS installed_m,
                  COALESCE(SUM(CASE WHEN classification = 'OFFCUT' AND status = 'AVAILABLE' THEN material_unit_remaining_length_m(company_id, id) ELSE 0 END), 0) AS reusable_offcut_m,
                  COALESCE(SUM(CASE WHEN classification = 'SCRAP' THEN total_length_m ELSE 0 END), 0) AS scrap_m
             FROM material_units
            WHERE company_id = $1::uuid ${projectFilter}
            GROUP BY diameter_mm, surface_type
         ),
         densities AS (
           SELECT DISTINCT ON (diameter_mm, surface_type) diameter_mm, surface_type, linear_density_kg_per_m
             FROM rebar_catalog_items WHERE company_id = $1::uuid AND is_active
            ORDER BY diameter_mm, surface_type, id
         )
         SELECT
           COALESCE(SUM(ps.available_m * COALESCE(d.linear_density_kg_per_m, 0)), 0) AS available_kg,
           COALESCE(SUM(ps.reserved_m * COALESCE(d.linear_density_kg_per_m, 0)), 0) AS reserved_kg,
           COALESCE(SUM(ps.on_hold_m * COALESCE(d.linear_density_kg_per_m, 0)), 0) AS on_hold_kg,
           COALESCE(SUM(ps.in_transit_m * COALESCE(d.linear_density_kg_per_m, 0)), 0) AS in_transit_kg,
           COALESCE(SUM(ps.installed_m * COALESCE(d.linear_density_kg_per_m, 0)), 0) AS installed_kg,
           COALESCE(SUM(ps.reusable_offcut_m * COALESCE(d.linear_density_kg_per_m, 0)), 0) AS reusable_offcut_kg,
           COALESCE(SUM(ps.scrap_m * COALESCE(d.linear_density_kg_per_m, 0)), 0) AS scrap_kg
         FROM per_size ps
         LEFT JOIN densities d ON d.diameter_mm = ps.diameter_mm AND d.surface_type = ps.surface_type`,
        ...params,
      );
      const b = bucketRows[0]!;

      // Company-wide unallocated stock is not meaningful once a project
      // filter is applied (it is, by definition, the stock belonging to
      // NO project) — only computed in the unfiltered, company-wide view.
      let unallocatedMt = 0;
      if (!q.projectId) {
        const unallocRows = await tx.$queryRawUnsafe<{ kg: string }[]>(
          `SELECT COALESCE(SUM(material_unit_remaining_length_m(mu.company_id, mu.id) * COALESCE(rci.linear_density_kg_per_m, 0)), 0) AS kg
             FROM material_units mu
             LEFT JOIN LATERAL (
               SELECT linear_density_kg_per_m FROM rebar_catalog_items
                WHERE company_id = $1::uuid AND diameter_mm = mu.diameter_mm AND surface_type = mu.surface_type AND is_active
                ORDER BY id LIMIT 1
             ) rci ON true
            WHERE mu.company_id = $1::uuid AND mu.project_id IS NULL AND mu.status = 'AVAILABLE'`,
          companyId,
        );
        unallocatedMt = Number(unallocRows[0]!.kg) / KG_PER_MT;
      }

      const stockByDiameter = await tx.$queryRawUnsafe(
        `SELECT mu.diameter_mm, mu.surface_type, mu.grade_normalized,
                COALESCE(SUM(CASE WHEN mu.status = 'AVAILABLE' THEN material_unit_remaining_length_m(mu.company_id, mu.id) ELSE 0 END), 0) AS available_length_m,
                COALESCE(SUM(CASE WHEN mu.status = 'AVAILABLE' THEN material_unit_remaining_length_m(mu.company_id, mu.id) ELSE 0 END)
                  * COALESCE(MAX(rci.linear_density_kg_per_m), 0) / 1000, 0) AS available_mt
           FROM material_units mu
           LEFT JOIN rebar_catalog_items rci
             ON rci.company_id = $1::uuid AND rci.diameter_mm = mu.diameter_mm AND rci.surface_type = mu.surface_type AND rci.is_active
          WHERE mu.company_id = $1::uuid ${projectFilter}
          GROUP BY mu.diameter_mm, mu.surface_type, mu.grade_normalized
          ORDER BY mu.diameter_mm, mu.surface_type, mu.grade_normalized`,
        ...params,
      );

      // Reorder alerts are a WEIGHT comparison (rebar_catalog_items.
      // reorder_threshold_mt) — never scoped by project (a reorder
      // decision is company-wide purchasing, §2.15).
      const reorderAlerts = await tx.$queryRawUnsafe(
        `WITH avail_by_size AS (
           SELECT diameter_mm, surface_type,
                  SUM(material_unit_remaining_length_m(company_id, id)) AS remaining_m
             FROM material_units
            WHERE company_id = $1::uuid AND status = 'AVAILABLE'
            GROUP BY diameter_mm, surface_type
         ),
         catalog_match AS (
           SELECT DISTINCT ON (a.diameter_mm, a.surface_type)
                  a.diameter_mm, a.surface_type, a.remaining_m,
                  rci.item_code, rci.linear_density_kg_per_m, rci.reorder_threshold_mt
             FROM avail_by_size a
             LEFT JOIN rebar_catalog_items rci
               ON rci.company_id = $1::uuid AND rci.diameter_mm = a.diameter_mm AND rci.surface_type = a.surface_type AND rci.is_active
            ORDER BY a.diameter_mm, a.surface_type, rci.id
         )
         SELECT diameter_mm, surface_type, item_code, reorder_threshold_mt,
                (remaining_m * COALESCE(linear_density_kg_per_m, 0) / 1000) AS available_mt
           FROM catalog_match
          WHERE reorder_threshold_mt IS NOT NULL
            AND (remaining_m * COALESCE(linear_density_kg_per_m, 0) / 1000) < reorder_threshold_mt`,
        companyId,
      );

      const unreconciledRows = await tx.$queryRawUnsafe<{ ops: string; transfers: string }[]>(
        `SELECT
           (SELECT count(*) FROM processing_operations WHERE company_id = $1::uuid AND reconciliation_status = 'UNRECONCILED') AS ops,
           (SELECT count(*) FROM material_transfers WHERE company_id = $1::uuid AND reconciliation_status = 'UNRECONCILED') AS transfers`,
        companyId,
      );

      return {
        totalInventoryMt: totalInventoryKg / KG_PER_MT,
        availableStockMt: Number(b.available_kg) / KG_PER_MT,
        reservedStockMt: Number(b.reserved_kg) / KG_PER_MT,
        onHoldMt: Number(b.on_hold_kg) / KG_PER_MT,
        inTransitMt: Number(b.in_transit_kg) / KG_PER_MT,
        installedMt: Number(b.installed_kg) / KG_PER_MT,
        reusableOffcutMt: Number(b.reusable_offcut_kg) / KG_PER_MT,
        scrapMt: Number(b.scrap_kg) / KG_PER_MT,
        unallocatedCompanyStockMt: unallocatedMt,
        scrapPercentage: totalInventoryKg > 0 ? (Number(b.scrap_kg) / totalInventoryKg) * 100 : 0,
        reusableRemnantRate: totalInventoryKg > 0 ? (Number(b.reusable_offcut_kg) / totalInventoryKg) * 100 : 0,
        stockByDiameter,
        reorderAlerts,
        unreconciledOperationsCount: Number(unreconciledRows[0]!.ops),
        unreconciledTransfersCount: Number(unreconciledRows[0]!.transfers),
      };
      // Every *Mt figure above is a genuine weight in metric tons, derived
      // from each (diameter_mm, surface_type) bucket's own
      // rebar_catalog_items.linear_density_kg_per_m (§2.15) — never a raw
      // length figure relabeled. A size with no matching, active catalog
      // entry contributes 0 kg rather than a guessed density (COALESCE),
      // so a company that hasn't fully populated its catalog sees an
      // honestly-understated total, never a fabricated one.
    });

    return result;
  });

  // -------------------------------------------------------------------------
  // GET /api/reports/genealogy/unit/:id — Backward Genealogy (§6 of
  // data-model.md): `material_unit_origins` IS the maintained cache for
  // exactly this query — no live graph walk needed, it's already
  // materialized by every controlled function that creates a unit.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/reports/genealogy/unit/:id", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const unitRows = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM material_units WHERE company_id = $1::uuid AND id = $2::uuid`, companyId, id);
      if (!unitRows[0]) return null;

      const origins = await tx.$queryRawUnsafe(
        `SELECT muo.bundle_id, muo.confidence, muo.contribution_weight, b.internal_reference_code, b.diameter_mm, b.grade, b.origin_type
           FROM material_unit_origins muo
           JOIN bundles b ON b.company_id = muo.company_id AND b.id = muo.bundle_id
          WHERE muo.company_id = $1::uuid AND muo.material_unit_id = $2::uuid
          ORDER BY b.internal_reference_code`,
        companyId,
        id,
      );
      return origins;
    });

    if (!result) throw new NotFoundError("Material unit not found");
    return { materialUnitId: id, origins: result };
  });

  // -------------------------------------------------------------------------
  // GET /api/reports/genealogy/bundle/:id — Forward Genealogy. Only units
  // EXACT/weight-1 attributed to this bundle are summed into the strict
  // conservation figure below (never fabricating a fractional share for a
  // POOLED/KNOWN_PARTIAL trace, §8 Q18) — those are surfaced separately as
  // `partiallyAttributedUnits`, outside the conservation sum.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/reports/genealogy/bundle/:id", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const bundleRows = await tx.$queryRawUnsafe<{ piece_count: number; bar_length_m: string }[]>(
        `SELECT piece_count, bar_length_m FROM bundles WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        id,
      );
      if (!bundleRows[0]) return null;
      const originalLengthM = bundleRows[0].piece_count * Number(bundleRows[0].bar_length_m);

      const exactUnits = await tx.$queryRawUnsafe<{ id: string; status: string; classification: string; total_length_m: string }[]>(
        `SELECT mu.id, mu.status, mu.classification, mu.total_length_m
           FROM material_unit_origins muo
           JOIN material_units mu ON mu.company_id = muo.company_id AND mu.id = muo.material_unit_id
          WHERE muo.company_id = $1::uuid AND muo.bundle_id = $2::uuid AND muo.confidence = 'EXACT' AND muo.contribution_weight = 1`,
        companyId,
        id,
      );

      const partialUnits = await tx.$queryRawUnsafe<{ id: string; confidence: string; contribution_weight: string | null }[]>(
        `SELECT mu.id, muo.confidence, muo.contribution_weight
           FROM material_unit_origins muo
           JOIN material_units mu ON mu.company_id = muo.company_id AND mu.id = muo.material_unit_id
          WHERE muo.company_id = $1::uuid AND muo.bundle_id = $2::uuid AND NOT (muo.confidence = 'EXACT' AND muo.contribution_weight = 1)`,
        companyId,
        id,
      );

      let remainingInStockM = 0;
      let availableOffcutM = 0;
      let installedM = 0;
      let scrapM = 0;
      const unitIds: string[] = [];

      for (const u of exactUnits) {
        unitIds.push(u.id);
        if (u.classification === "SCRAP") {
          scrapM += Number(u.total_length_m);
        } else if (u.status === "INSTALLED") {
          installedM += Number(u.total_length_m);
        } else if (u.classification === "OFFCUT" && u.status === "AVAILABLE") {
          const remRows = await tx.$queryRawUnsafe<{ r: string }[]>(`SELECT material_unit_remaining_length_m($1::uuid, $2::uuid) AS r`, companyId, u.id);
          availableOffcutM += Number(remRows[0]!.r);
        } else if (u.status === "AVAILABLE" || u.status === "RESERVED" || u.status === "ON_HOLD") {
          const remRows = await tx.$queryRawUnsafe<{ r: string }[]>(`SELECT material_unit_remaining_length_m($1::uuid, $2::uuid) AS r`, companyId, u.id);
          remainingInStockM += Number(remRows[0]!.r);
        }
        // DISPATCHED (in transit) and CONSUMED (fully turned into tracked
        // outputs already in `exactUnits`) fall through deliberately —
        // DISPATCHED is handled as its own bucket below (placeholder
        // remaining), CONSUMED contributes 0 by definition (§14).
      }

      const inTransitRows = await tx.$queryRawUnsafe<{ m: string }[]>(
        `SELECT COALESCE(SUM(material_unit_remaining_length_m(company_id, id)), 0) AS m
           FROM material_units WHERE company_id = $1::uuid AND id = ANY($2::uuid[]) AND status = 'DISPATCHED'`,
        companyId,
        unitIds,
      );
      const inTransitM = Number(inTransitRows[0]!.m);

      const adjustmentRows = await tx.$queryRawUnsafe<{ m: string }[]>(
        `SELECT COALESCE(SUM(ca.amount), 0) AS m
           FROM conservation_adjustments ca
          WHERE ca.company_id = $1::uuid AND ca.amount > 0
            AND (
              ca.processing_operation_id IN (
                SELECT DISTINCT processing_operation_id FROM processing_inputs WHERE company_id = $1::uuid AND material_unit_id = ANY($2::uuid[])
              )
              OR ca.material_transfer_line_id IN (
                SELECT id FROM material_transfer_lines WHERE company_id = $1::uuid AND material_unit_id = ANY($2::uuid[])
              )
            )`,
        companyId,
        unitIds,
      );
      const adjustmentsM = Number(adjustmentRows[0]!.m);

      const accountedForM = remainingInStockM + inTransitM + availableOffcutM + installedM + scrapM + adjustmentsM;

      return {
        originalLengthM,
        remainingInStockM,
        inTransitM,
        availableOffcutM,
        installedM,
        scrapM,
        adjustmentsM,
        accountedForM,
        fullyConserved: Math.abs(accountedForM - originalLengthM) < 0.001,
        partiallyAttributedUnits: partialUnits.map((p) => ({ materialUnitId: p.id, confidence: p.confidence, contributionWeight: p.contribution_weight })),
      };
    });

    if (!result) throw new NotFoundError("Bundle not found");
    return result;
  });

  // -------------------------------------------------------------------------
  // GET /api/reports/consumption
  // -------------------------------------------------------------------------
  const consumptionQuery = z.object({ projectId: z.string().uuid().optional() });

  app.get("/api/reports/consumption", { preHandler: requireTenantAuth }, async (request) => {
    const q = consumptionQuery.parse(request.query);
    const { companyId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const projectFilter = q.projectId ? `AND i.project_id = $2::uuid` : "";
      const params: unknown[] = q.projectId ? [companyId, q.projectId] : [companyId];

      const byGroup = await tx.$queryRawUnsafe(
        `SELECT i.project_id, set2.name AS structural_element_type, rp.name AS reinforcement_purpose,
                ln.name AS location_node, mu.diameter_mm,
                count(*)::int AS installed_units, SUM(mu.total_length_m) AS installed_length_m
           FROM installations i
           JOIN installation_lines il ON il.company_id = i.company_id AND il.installation_id = i.id
           JOIN material_units mu ON mu.company_id = il.company_id AND mu.id = il.material_unit_id
           JOIN structural_element_instances sei ON sei.company_id = i.company_id AND sei.id = i.structural_element_instance_id
           LEFT JOIN structural_element_types set2 ON set2.company_id = sei.company_id AND set2.id = sei.structural_element_type_id
           JOIN reinforcement_purposes rp ON rp.company_id = i.company_id AND rp.id = i.reinforcement_purpose_id
           LEFT JOIN location_nodes ln ON ln.company_id = sei.company_id AND ln.id = sei.location_node_id
          WHERE i.company_id = $1::uuid AND i.status = 'ACTIVE' ${projectFilter}
          GROUP BY i.project_id, set2.name, rp.name, ln.name, mu.diameter_mm
          ORDER BY i.project_id, set2.name, rp.name`,
        ...params,
      );

      const intendedVsActualDeviations = await tx.$queryRawUnsafe(
        `SELECT i.id AS installation_id, i.structural_element_instance_id AS actual_element_instance_id,
                i.reinforcement_purpose_id AS actual_purpose_id,
                iud.structural_element_instance_id AS intended_element_instance_id,
                iud.reinforcement_purpose_id AS intended_purpose_id
           FROM installations i
           JOIN intended_usage_declarations iud ON iud.company_id = i.company_id AND iud.id = i.intended_usage_declaration_id
          WHERE i.company_id = $1::uuid AND i.status = 'ACTIVE' ${projectFilter}
            AND (
              (iud.structural_element_instance_id IS NOT NULL AND iud.structural_element_instance_id <> i.structural_element_instance_id)
              OR iud.reinforcement_purpose_id <> i.reinforcement_purpose_id
            )`,
        ...params,
      );

      const bbsProgress = await tx.$queryRawUnsafe(
        `SELECT bl.id AS bbs_line_id, bl.bar_mark, bl.total_bars_required,
                bl.cut_length_m, (bl.total_bars_required * bl.cut_length_m) AS required_length_m,
                COALESCE(count(il.material_unit_id), 0)::int AS installed_bars,
                COALESCE(SUM(mu.total_length_m), 0) AS installed_length_m
           FROM bbs_lines bl
           LEFT JOIN installations i ON i.company_id = bl.company_id AND i.bbs_line_id = bl.id AND i.status = 'ACTIVE'
           LEFT JOIN installation_lines il ON il.company_id = i.company_id AND il.installation_id = i.id
           LEFT JOIN material_units mu ON mu.company_id = il.company_id AND mu.id = il.material_unit_id
          WHERE bl.company_id = $1::uuid
          GROUP BY bl.id, bl.bar_mark, bl.total_bars_required, bl.cut_length_m
          ORDER BY bl.bar_mark`,
        companyId,
      );

      return { byGroup, intendedVsActualDeviations, bbsProgress };
    });

    return result;
  });
}
