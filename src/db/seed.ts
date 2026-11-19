import { randomUUID } from "node:crypto";
import type { SqlExecutor, TxHandle } from "./bootstrapSql";

/**
 * Idempotent seed module for the first client's operational baseline
 * (Task 4, Step 3). Safe to re-run: every section checks for an existing
 * row (by a natural/business key) before creating one.
 *
 * Exercises the real write paths this design mandates:
 *   - `companies`/`roles`/master-data tables: ordinary `steeltrace_app`
 *     INSERTs under RLS (not controlled-function-gated, §12).
 *   - `users`/`company_memberships`: via `steeltrace_identity_service`
 *     (§6) — the registration path, not the invitation-acceptance one
 *     (seeding bypasses the invitation dance deliberately; it is a
 *     backstage/ops operation, not a real sign-up flow).
 *   - `bundles`/their root `material_units`: via `register_bundle` (§12) —
 *     never a direct INSERT, exactly as production must.
 */

export interface SeedResult {
  companyId: string;
  roleIds: Record<RoleName, string>;
  userIds: Record<RoleName, string>;
  membershipIds: Record<RoleName, string>;
  rebarCatalogItemIds: Record<string, string>; // item_code -> id
  structuralElementTypeIds: Record<string, string>; // name -> id
  reinforcementPurposeIds: Record<string, string>; // name -> id
  processingOperationTypeIds: Record<string, string>; // name -> id
  shapeCodeIds: Record<string, string>; // code -> id
  storageLocationIds: {
    mainYard: string;
    zoneA: string;
    rackA1: string;
    rackA2: string;
    centralWorkshop: string;
    hotelSiteLaydown: string;
    moringaSiteLaydown: string;
  };
  projectIds: { hotel: string; moringa: string };
  locationNodeIds: { hotelBuildingA: string; hotelLevel2: string };
  structuralElementInstanceIds: { columnC01: string; columnC12: string };
  openingStockBundleIds: string[]; // ST-BND-0001..0102, in order
}

const ROLE_NAMES = [
  "Company Admin",
  "Warehouse / Receiving Officer",
  "Quality / Approving Officer",
  "Workshop / Fabrication Operator",
  "Site Engineer / Supervisor",
  "Project Manager / Auditor",
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

const ROLE_EMAILS: Record<RoleName, string> = {
  "Company Admin": "admin@steeltrace-demo.test",
  "Warehouse / Receiving Officer": "warehouse@steeltrace-demo.test",
  "Quality / Approving Officer": "quality@steeltrace-demo.test",
  "Workshop / Fabrication Operator": "workshop@steeltrace-demo.test",
  "Site Engineer / Supervisor": "site@steeltrace-demo.test",
  "Project Manager / Auditor": "pm@steeltrace-demo.test",
};

const STRUCTURAL_ELEMENT_TYPES = [
  "Column",
  "Beam",
  "Slab",
  "Foundation / Footing",
  "Mat Foundation",
  "Shear Wall",
  "Retaining Wall",
  "Staircase",
  "Ramp",
  "Pile Cap",
  "Precast Beam",
  "RC Gutter",
];

const REINFORCEMENT_PURPOSES = [
  "Main Longitudinal Reinforcement",
  "Top Reinforcement",
  "Bottom Reinforcement",
  "Stirrups / Shear Links",
  "Lateral Ties",
  "Distribution Reinforcement",
  "Additional Reinforcement",
  "Slab / Ribbed Mesh",
  "Vertical Reinforcement",
  "Horizontal Reinforcement",
  "Precast Connection Edge",
];

const PROCESSING_OPERATION_TYPES = ["Cutting", "Bending", "Cutting and Bending"];

const SHAPE_CODES: { code: string; name: string; activeDimensions: string[] }[] = [
  { code: "00", name: "Straight", activeDimensions: [] },
  { code: "11", name: "L-bend", activeDimensions: ["dim_a_mm", "dim_b_mm"] },
  { code: "20", name: "U-bar", activeDimensions: ["dim_a_mm", "dim_b_mm", "dim_c_mm"] },
  { code: "51", name: "Closed Stirrup", activeDimensions: ["dim_a_mm", "dim_b_mm", "dim_r_mm"] },
  { code: "99", name: "Custom", activeDimensions: ["dim_a_mm", "dim_b_mm", "dim_c_mm", "dim_d_mm", "dim_e_mm", "dim_r_mm"] },
];

/**
 * Rebar catalog (CLAUDE.md §2.15): RB-06 (6mm PLAIN) + RB-08..RB-28
 * (DEFORMED, B500BWR, ES ISO 6935-2:2011). Linear density for 8-24mm from
 * the client's standard engineering lookup table (CLAUDE.md §2.15);
 * 28mm has no lookup-table entry there, so it's computed from the
 * theoretical formula d²/162 instead — both are legitimate per-item
 * sources, never a single system-imposed truth (§3a) — flagged here since
 * it's the one item mixing sources within this seed.
 */
const REBAR_CATALOG: {
  itemCode: string;
  diameterMm: number;
  surfaceType: "DEFORMED" | "PLAIN";
  defaultGrade: string | null;
  defaultStandard: string | null;
  defaultPiecesPerBundle: number | null;
  linearDensityKgPerM: number;
}[] = [
  { itemCode: "RB-06", diameterMm: 6, surfaceType: "PLAIN", defaultGrade: null, defaultStandard: null, defaultPiecesPerBundle: null, linearDensityKgPerM: 0.222 },
  { itemCode: "RB-08", diameterMm: 8, surfaceType: "DEFORMED", defaultGrade: "B500BWR", defaultStandard: "ES ISO 6935-2:2011", defaultPiecesPerBundle: 424, linearDensityKgPerM: 0.395 },
  { itemCode: "RB-10", diameterMm: 10, surfaceType: "DEFORMED", defaultGrade: "B500BWR", defaultStandard: "ES ISO 6935-2:2011", defaultPiecesPerBundle: 274, linearDensityKgPerM: 0.617 },
  { itemCode: "RB-12", diameterMm: 12, surfaceType: "DEFORMED", defaultGrade: "B500BWR", defaultStandard: "ES ISO 6935-2:2011", defaultPiecesPerBundle: 190, linearDensityKgPerM: 0.888 },
  { itemCode: "RB-14", diameterMm: 14, surfaceType: "DEFORMED", defaultGrade: "B500BWR", defaultStandard: "ES ISO 6935-2:2011", defaultPiecesPerBundle: 140, linearDensityKgPerM: 1.208 },
  { itemCode: "RB-16", diameterMm: 16, surfaceType: "DEFORMED", defaultGrade: "B500BWR", defaultStandard: "ES ISO 6935-2:2011", defaultPiecesPerBundle: 108, linearDensityKgPerM: 1.578 },
  { itemCode: "RB-20", diameterMm: 20, surfaceType: "DEFORMED", defaultGrade: "B500BWR", defaultStandard: "ES ISO 6935-2:2011", defaultPiecesPerBundle: 68, linearDensityKgPerM: 2.468 },
  { itemCode: "RB-24", diameterMm: 24, surfaceType: "DEFORMED", defaultGrade: "B500BWR", defaultStandard: "ES ISO 6935-2:2011", defaultPiecesPerBundle: 48, linearDensityKgPerM: 3.55 },
  { itemCode: "RB-28", diameterMm: 28, surfaceType: "DEFORMED", defaultGrade: "B500BWR", defaultStandard: "ES ISO 6935-2:2011", defaultPiecesPerBundle: null, linearDensityKgPerM: Math.round(((28 * 28) / 162) * 10000) / 10000 },
];

/** Opening stock (CLAUDE.md §2.13): 102 bundles / 204 MT / 21,598 bars. */
const OPENING_STOCK: { diameterMm: number; bundleCount: number; piecesPerBundle: number }[] = [
  { diameterMm: 8, bundleCount: 13, piecesPerBundle: 424 },
  { diameterMm: 10, bundleCount: 38, piecesPerBundle: 274 },
  { diameterMm: 12, bundleCount: 11, piecesPerBundle: 190 },
  { diameterMm: 14, bundleCount: 2, piecesPerBundle: 140 },
  { diameterMm: 16, bundleCount: 21, piecesPerBundle: 108 },
  { diameterMm: 20, bundleCount: 11, piecesPerBundle: 68 },
  { diameterMm: 24, bundleCount: 6, piecesPerBundle: 48 },
];

const DEFAULT_COMPANY_NAME = "First Construction Client";

async function findOne(
  tx: TxHandle,
  sql: string,
  params: unknown[],
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(sql, params);
  return rows[0]?.id ?? null;
}

/**
 * `companyName` defaults to the real client's name (`DEFAULT_COMPANY_NAME`)
 * and is looked-up-or-created idempotently either way — passing a unique
 * name (e.g. a random suffix) always creates a brand-new, fully-equipped
 * company, which is how src/db/integrity.test.ts gets an isolated test
 * tenant carrying the exact same master data/opening-stock shape as the
 * real client without ever touching the real client's own company row.
 */
export async function seed(executor: SqlExecutor, companyName: string = DEFAULT_COMPANY_NAME): Promise<SeedResult> {
  // ---------------------------------------------------------------------
  // Company (bootstrapped: RLS requires app.current_company_id = the new
  // row's own id, so the id is generated client-side first — §06's own
  // documented pattern for this exact bootstrapping case).
  // ---------------------------------------------------------------------
  let companyId = await executor.run((tx) =>
    findOne(tx, `SELECT id FROM companies WHERE name = $1`, [companyName]),
  );

  if (!companyId) {
    companyId = randomUUID();
    await executor.runAs({ role: "steeltrace_app", companyId }, async (tx) => {
      await tx.query(`INSERT INTO companies (id, name) VALUES ($1, $2)`, [companyId, companyName]);
    });
  }
  const finalCompanyId = companyId;

  return executor.runAs({ role: "steeltrace_app", companyId: finalCompanyId }, async (tx) => {
    // -------------------------------------------------------------------
    // Roles (company-scoped master data)
    // -------------------------------------------------------------------
    const roleIds = {} as Record<RoleName, string>;
    for (const name of ROLE_NAMES) {
      let id = await findOne(tx, `SELECT id FROM roles WHERE company_id = $1 AND name = $2`, [finalCompanyId, name]);
      if (!id) {
        id = await findOne(
          tx,
          `INSERT INTO roles (company_id, name) VALUES ($1, $2) RETURNING id`,
          [finalCompanyId, name],
        );
      }
      roleIds[name] = id!;
    }

    // -------------------------------------------------------------------
    // Users + memberships — via steeltrace_identity_service (§6). A
    // nested `runAs` is fine: PGlite/pg both support nested transactions
    // as savepoints, and each `runAs` here only issues `SET LOCAL`, which
    // is scoped to (and reverts with) its own savepoint/subtransaction.
    // -------------------------------------------------------------------
    const userIds = {} as Record<RoleName, string>;
    const membershipIds = {} as Record<RoleName, string>;
    for (const name of ROLE_NAMES) {
      const email = ROLE_EMAILS[name];
      const { userId, membershipId } = await seedUserAndMembership(
        tx,
        finalCompanyId,
        email,
        name,
        roleIds[name],
      );
      userIds[name] = userId;
      membershipIds[name] = membershipId;
    }
    const warehouseMembershipId = membershipIds["Warehouse / Receiving Officer"];
    const qualityMembershipId = membershipIds["Quality / Approving Officer"];

    // -------------------------------------------------------------------
    // Rebar catalog
    // -------------------------------------------------------------------
    const rebarCatalogItemIds: Record<string, string> = {};
    for (const item of REBAR_CATALOG) {
      let id = await findOne(
        tx,
        `SELECT id FROM rebar_catalog_items WHERE company_id = $1 AND item_code = $2`,
        [finalCompanyId, item.itemCode],
      );
      if (!id) {
        id = await findOne(
          tx,
          `INSERT INTO rebar_catalog_items
             (company_id, item_code, diameter_mm, surface_type, default_grade, default_standard,
              standard_bar_length_m, default_pieces_per_bundle, linear_density_kg_per_m, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true) RETURNING id`,
          [
            finalCompanyId,
            item.itemCode,
            item.diameterMm,
            item.surfaceType,
            item.defaultGrade,
            item.defaultStandard,
            12.0,
            item.defaultPiecesPerBundle,
            item.linearDensityKgPerM,
          ],
        );
      }
      rebarCatalogItemIds[item.itemCode] = id!;
    }

    // -------------------------------------------------------------------
    // Structural element types / reinforcement purposes / processing
    // operation types / shape codes
    // -------------------------------------------------------------------
    const structuralElementTypeIds: Record<string, string> = {};
    for (const name of STRUCTURAL_ELEMENT_TYPES) {
      structuralElementTypeIds[name] = await upsertByName(tx, "structural_element_types", finalCompanyId, name);
    }

    const reinforcementPurposeIds: Record<string, string> = {};
    for (const name of REINFORCEMENT_PURPOSES) {
      reinforcementPurposeIds[name] = await upsertByName(tx, "reinforcement_purposes", finalCompanyId, name);
    }

    const processingOperationTypeIds: Record<string, string> = {};
    for (const name of PROCESSING_OPERATION_TYPES) {
      let id = await findOne(
        tx,
        `SELECT id FROM processing_operation_types WHERE company_id = $1 AND name = $2`,
        [finalCompanyId, name],
      );
      if (!id) {
        id = await findOne(
          tx,
          `INSERT INTO processing_operation_types (company_id, name, requires_uniform_input_spec, is_active)
           VALUES ($1, $2, true, true) RETURNING id`,
          [finalCompanyId, name],
        );
      }
      processingOperationTypeIds[name] = id!;
    }

    const shapeCodeIds: Record<string, string> = {};
    for (const shape of SHAPE_CODES) {
      let id = await findOne(tx, `SELECT id FROM shape_codes WHERE company_id = $1 AND code = $2`, [finalCompanyId, shape.code]);
      if (!id) {
        id = await findOne(
          tx,
          `INSERT INTO shape_codes (company_id, code, name, active_dimensions, is_active)
           VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [finalCompanyId, shape.code, shape.name, shape.activeDimensions],
        );
      }
      shapeCodeIds[shape.code] = id!;
    }

    // -------------------------------------------------------------------
    // Projects
    // -------------------------------------------------------------------
    const hotelProjectId = await upsertProject(tx, finalCompanyId, "Hotel Construction Project");
    const moringaProjectId = await upsertProject(tx, finalCompanyId, "Moringa Pharmacy & Showroom Project");

    // -------------------------------------------------------------------
    // Storage locations
    // -------------------------------------------------------------------
    const mainYardId = await upsertStorageLocation(tx, finalCompanyId, "Main Yard", "WAREHOUSE", null, null);
    const zoneAId = await upsertStorageLocation(tx, finalCompanyId, "Zone A", "WAREHOUSE", null, mainYardId, { zoneCode: "A" });
    const rackA1Id = await upsertStorageLocation(tx, finalCompanyId, "Rack A1", "WAREHOUSE", null, zoneAId, { zoneCode: "A", rackCode: "A1" });
    const rackA2Id = await upsertStorageLocation(tx, finalCompanyId, "Rack A2", "WAREHOUSE", null, zoneAId, { zoneCode: "A", rackCode: "A2" });
    const centralWorkshopId = await upsertStorageLocation(tx, finalCompanyId, "Central Workshop", "PROCESSING_AREA", null, null);
    const hotelSiteLaydownId = await upsertStorageLocation(tx, finalCompanyId, "Hotel Site Laydown", "SITE", hotelProjectId, null);
    const moringaSiteLaydownId = await upsertStorageLocation(tx, finalCompanyId, "Moringa Site Laydown", "SITE", moringaProjectId, null);

    // -------------------------------------------------------------------
    // Location hierarchy (Hotel project): Building type -> Level type;
    // Building A -> Level 2. Columns C-01/C-12 are `structural_element_instances`
    // located AT "Level 2" — NOT location_nodes themselves (a column is a
    // structural element, not a place in the "where" hierarchy, §2.2 of
    // data-model.md).
    // -------------------------------------------------------------------
    const buildingTypeId = await upsertLocationNodeType(tx, finalCompanyId, "Building");
    const levelTypeId = await upsertLocationNodeType(tx, finalCompanyId, "Level");

    const hotelBuildingAId = await upsertLocationNode(tx, finalCompanyId, hotelProjectId, null, buildingTypeId, "Building A");
    const hotelLevel2Id = await upsertLocationNode(tx, finalCompanyId, hotelProjectId, hotelBuildingAId, levelTypeId, "Level 2");

    const columnTypeId = structuralElementTypeIds["Column"]!;
    const columnC01Id = await upsertStructuralElementInstance(
      tx, finalCompanyId, hotelProjectId, columnTypeId, hotelLevel2Id, "C-01",
    );
    const columnC12Id = await upsertStructuralElementInstance(
      tx, finalCompanyId, hotelProjectId, columnTypeId, hotelLevel2Id, "C-12",
    );

    // -------------------------------------------------------------------
    // Opening warehouse balance: 102 bundles / 204 MT / 21,598 bars, via
    // `register_bundle` (§12) — never a direct INSERT.
    // -------------------------------------------------------------------
    const openingStockBundleIds: string[] = [];
    let seq = 1;
    for (const group of OPENING_STOCK) {
      for (let i = 0; i < group.bundleCount; i++) {
        const referenceCode = `ST-BND-${String(seq).padStart(4, "0")}`;
        let bundleId = await findOne(
          tx,
          `SELECT id FROM bundles WHERE company_id = $1 AND internal_reference_code = $2`,
          [finalCompanyId, referenceCode],
        );
        if (!bundleId) {
          const { rows } = await tx.query<{ bundle_id: string; root_material_unit_id: string }>(
            `SELECT * FROM register_bundle(
               $1,  -- p_company_id
               NULL, -- p_project_id (unallocated, §5)
               $2,  -- p_storage_location_id
               $3,  -- p_internal_reference_code
               NULL, -- p_supplier_id
               NULL, -- p_manufacturer_id
               NULL, -- p_country_of_origin
               $4,  -- p_diameter_mm
               'B500BWR', -- p_grade
               'ES ISO 6935-2:2011', -- p_standard
               NULL, -- p_heat_number
               $5,  -- p_piece_count
               12.000, -- p_bar_length_m
               'DEFORMED', -- p_surface_type
               'OPENING_STOCK', -- p_origin_type
               NULL, NULL, NULL, NULL, NULL, NULL, -- GRN fields (not applicable to opening stock)
               2000.000, -- p_actual_weight_kg (2.00 MT/bundle flat, §18)
               'ACCEPTED', -- p_initial_disposition
               $6   -- p_registered_by_membership_id
             )`,
            [finalCompanyId, mainYardId, referenceCode, group.diameterMm, group.piecesPerBundle, warehouseMembershipId],
          );
          bundleId = rows[0]!.bundle_id;
        }
        openingStockBundleIds.push(bundleId!);
        seq++;
      }
    }

    return {
      companyId: finalCompanyId,
      roleIds,
      userIds,
      membershipIds,
      rebarCatalogItemIds,
      structuralElementTypeIds,
      reinforcementPurposeIds,
      processingOperationTypeIds,
      shapeCodeIds,
      storageLocationIds: {
        mainYard: mainYardId,
        zoneA: zoneAId,
        rackA1: rackA1Id,
        rackA2: rackA2Id,
        centralWorkshop: centralWorkshopId,
        hotelSiteLaydown: hotelSiteLaydownId,
        moringaSiteLaydown: moringaSiteLaydownId,
      },
      projectIds: { hotel: hotelProjectId, moringa: moringaProjectId },
      locationNodeIds: { hotelBuildingA: hotelBuildingAId, hotelLevel2: hotelLevel2Id },
      structuralElementInstanceIds: { columnC01: columnC01Id, columnC12: columnC12Id },
      openingStockBundleIds,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUserAndMembership(
  outerTx: TxHandle,
  companyId: string,
  email: string,
  displayName: string,
  roleId: string,
): Promise<{ userId: string; membershipId: string }> {
  // Users are global (no company_id) — looked up/created via a SEPARATE
  // identity-service-scoped SQL path (§6), issued directly here rather
  // than via a nested `executor.runAs` (TxHandle doesn't carry role-switch
  // semantics on its own) by using SET LOCAL ROLE/context within the
  // SAME outer transaction's savepoint-free statement sequence — safe
  // because every statement in this helper is immediately followed by
  // resetting back to steeltrace_app before returning to the caller.
  await outerTx.query(`SET LOCAL ROLE "steeltrace_identity_service"`);

  let userId = await findOne(outerTx, `SELECT id FROM users WHERE email = $1`, [email]);
  if (!userId) {
    userId = await findOne(
      outerTx,
      `INSERT INTO users (email, display_name, auth_provider, is_active)
       VALUES ($1, $2, 'password', true) RETURNING id`,
      [email, displayName],
    );
  }

  await outerTx.query(
    `SELECT set_config('app.current_company_id', $1, true)`,
    [companyId],
  );

  let membershipId = await findOne(
    outerTx,
    `SELECT id FROM company_memberships WHERE company_id = $1 AND user_id = $2`,
    [companyId, userId],
  );
  if (!membershipId) {
    membershipId = await findOne(
      outerTx,
      `INSERT INTO company_memberships (company_id, user_id, role_id, is_active)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [companyId, userId, roleId],
    );
  }

  await outerTx.query(`SET LOCAL ROLE "steeltrace_app"`);
  await outerTx.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);

  return { userId: userId!, membershipId: membershipId! };
}

async function upsertByName(tx: TxHandle, table: string, companyId: string, name: string): Promise<string> {
  let id = await findOne(tx, `SELECT id FROM ${table} WHERE company_id = $1 AND name = $2`, [companyId, name]);
  if (!id) {
    id = await findOne(tx, `INSERT INTO ${table} (company_id, name, is_active) VALUES ($1, $2, true) RETURNING id`, [companyId, name]);
  }
  return id!;
}

async function upsertProject(tx: TxHandle, companyId: string, name: string): Promise<string> {
  let id = await findOne(tx, `SELECT id FROM projects WHERE company_id = $1 AND name = $2`, [companyId, name]);
  if (!id) {
    id = await findOne(tx, `INSERT INTO projects (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, name]);
  }
  return id!;
}

async function upsertStorageLocation(
  tx: TxHandle,
  companyId: string,
  name: string,
  locationType: string,
  projectId: string | null,
  parentId: string | null,
  codes: { zoneCode?: string; rackCode?: string; bayCode?: string } = {},
): Promise<string> {
  let id = await findOne(tx, `SELECT id FROM storage_locations WHERE company_id = $1 AND name = $2`, [companyId, name]);
  if (!id) {
    id = await findOne(
      tx,
      `INSERT INTO storage_locations (company_id, project_id, location_type, name, parent_storage_location_id, zone_code, rack_code, bay_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [companyId, projectId, locationType, name, parentId, codes.zoneCode ?? null, codes.rackCode ?? null, codes.bayCode ?? null],
    );
  }
  return id!;
}

async function upsertLocationNodeType(tx: TxHandle, companyId: string, name: string): Promise<string> {
  let id = await findOne(tx, `SELECT id FROM location_node_types WHERE company_id = $1 AND name = $2`, [companyId, name]);
  if (!id) {
    id = await findOne(tx, `INSERT INTO location_node_types (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, name]);
  }
  return id!;
}

async function upsertLocationNode(
  tx: TxHandle,
  companyId: string,
  projectId: string,
  parentId: string | null,
  typeId: string,
  name: string,
): Promise<string> {
  let id = await findOne(
    tx,
    `SELECT id FROM location_nodes WHERE company_id = $1 AND project_id = $2 AND name = $3`,
    [companyId, projectId, name],
  );
  if (!id) {
    id = await findOne(
      tx,
      `INSERT INTO location_nodes (company_id, project_id, parent_id, location_node_type_id, name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [companyId, projectId, parentId, typeId, name],
    );
  }
  return id!;
}

async function upsertStructuralElementInstance(
  tx: TxHandle,
  companyId: string,
  projectId: string,
  typeId: string,
  locationNodeId: string,
  referenceCode: string,
): Promise<string> {
  let id = await findOne(
    tx,
    `SELECT id FROM structural_element_instances WHERE company_id = $1 AND project_id = $2 AND reference_code = $3`,
    [companyId, projectId, referenceCode],
  );
  if (!id) {
    id = await findOne(
      tx,
      `INSERT INTO structural_element_instances (company_id, project_id, structural_element_type_id, location_node_id, reference_code)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [companyId, projectId, typeId, locationNodeId, referenceCode],
    );
  }
  return id!;
}
