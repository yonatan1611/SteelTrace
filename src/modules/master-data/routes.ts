import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireTenantAuth, withAuthedTenantContext } from "../auth/middleware";
import { BadRequestError, NotFoundError } from "../../api/errors";

/**
 * Every endpoint here is tenant-scoped master data (CLAUDE.md §2.6, §2.15,
 * §2.16, Development Rule §5.11 — no hardcoded structural-element/
 * reinforcement-purpose lists, everything company-configurable). All
 * reads/writes go through `withAuthedTenantContext` (steeltrace_app under
 * RLS, 06) — these tables hold ordinary `GRANT INSERT, UPDATE` for that
 * role (01), so no controlled function is needed here, unlike bundles/
 * transfers/processing.
 */

async function listTable(tx: Prisma.TransactionClient, companyId: string, table: string, orderBy: string): Promise<unknown[]> {
  return tx.$queryRawUnsafe(`SELECT * FROM ${table} WHERE company_id = $1::uuid ORDER BY ${orderBy}`, companyId);
}

export function registerMasterDataRoutes(app: FastifyInstance): void {
  // ---------------------------------------------------------------------
  // rebar_catalog_items (§2.15)
  // ---------------------------------------------------------------------
  const rebarCatalogItemBody = z.object({
    itemCode: z.string().trim().min(1),
    diameterMm: z.number().positive(),
    surfaceType: z.enum(["DEFORMED", "PLAIN"]).default("DEFORMED"),
    defaultGrade: z.string().trim().min(1).optional(),
    defaultStandard: z.string().trim().min(1).optional(),
    standardBarLengthM: z.number().positive().optional(),
    defaultPiecesPerBundle: z.number().int().positive().optional(),
    linearDensityKgPerM: z.number().positive(),
    reorderThresholdMt: z.number().positive().optional(),
  });

  app.get("/api/rebar-catalog-items", { preHandler: requireTenantAuth }, async (request) =>
    withAuthedTenantContext(request, (tx) => listTable(tx, request.tenantContext!.companyId, "rebar_catalog_items", "item_code")),
  );

  app.post("/api/rebar-catalog-items", { preHandler: requireTenantAuth }, async (request) => {
    const b = rebarCatalogItemBody.parse(request.body);
    const { companyId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `INSERT INTO rebar_catalog_items (company_id, item_code, diameter_mm, surface_type, default_grade, default_standard,
           standard_bar_length_m, default_pieces_per_bundle, linear_density_kg_per_m, reorder_threshold_mt, is_active)
         VALUES ($1::uuid,$2::text,$3::numeric,$4::rebar_surface_type_enum,$5::text,$6::text,$7::numeric,$8::integer,$9::numeric,$10::numeric,true) RETURNING *`,
        companyId, b.itemCode, b.diameterMm, b.surfaceType, b.defaultGrade ?? null, b.defaultStandard ?? null,
        b.standardBarLengthM ?? null, b.defaultPiecesPerBundle ?? null, b.linearDensityKgPerM, b.reorderThresholdMt ?? null,
      ),
    );
    return (rows as unknown[])[0];
  });

  app.patch<{ Params: { id: string } }>("/api/rebar-catalog-items/:id", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const b = rebarCatalogItemBody.partial().parse(request.body);
    const { companyId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `UPDATE rebar_catalog_items SET
           item_code = COALESCE($3::text, item_code), diameter_mm = COALESCE($4::numeric, diameter_mm),
           surface_type = COALESCE($5::rebar_surface_type_enum, surface_type), default_grade = COALESCE($6::text, default_grade),
           default_standard = COALESCE($7::text, default_standard), standard_bar_length_m = COALESCE($8::numeric, standard_bar_length_m),
           default_pieces_per_bundle = COALESCE($9::integer, default_pieces_per_bundle),
           linear_density_kg_per_m = COALESCE($10::numeric, linear_density_kg_per_m),
           reorder_threshold_mt = COALESCE($11::numeric, reorder_threshold_mt)
         WHERE company_id = $1::uuid AND id = $2::uuid RETURNING *`,
        companyId, id, b.itemCode ?? null, b.diameterMm ?? null, b.surfaceType ?? null, b.defaultGrade ?? null,
        b.defaultStandard ?? null, b.standardBarLengthM ?? null, b.defaultPiecesPerBundle ?? null,
        b.linearDensityKgPerM ?? null, b.reorderThresholdMt ?? null,
      ),
    );
    const row = (rows as unknown[])[0];
    if (!row) throw new NotFoundError("Rebar catalog item not found");
    return row;
  });

  // ---------------------------------------------------------------------
  // projects
  // ---------------------------------------------------------------------
  const projectBody = z.object({ name: z.string().trim().min(1), buildingType: z.string().trim().min(1).optional() });

  app.get("/api/projects", { preHandler: requireTenantAuth }, async (request) =>
    withAuthedTenantContext(request, (tx) => listTable(tx, request.tenantContext!.companyId, "projects", "name")),
  );

  app.post("/api/projects", { preHandler: requireTenantAuth }, async (request) => {
    const b = projectBody.parse(request.body);
    const { companyId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `INSERT INTO projects (company_id, name, building_type) VALUES ($1::uuid,$2::text,$3::text) RETURNING *`,
        companyId,
        b.name,
        b.buildingType ?? null,
      ),
    );
    return (rows as unknown[])[0];
  });

  // ---------------------------------------------------------------------
  // storage_locations (§2.18: zone/rack/bay sub-locations, optional parent)
  // ---------------------------------------------------------------------
  const storageLocationBody = z.object({
    name: z.string().trim().min(1),
    locationType: z.enum(["WAREHOUSE", "PROCESSING_AREA", "SITE", "OTHER"]),
    projectId: z.string().uuid().optional(),
    parentStorageLocationId: z.string().uuid().optional(),
    zoneCode: z.string().trim().min(1).optional(),
    rackCode: z.string().trim().min(1).optional(),
    bayCode: z.string().trim().min(1).optional(),
  });

  app.get("/api/storage-locations", { preHandler: requireTenantAuth }, async (request) =>
    withAuthedTenantContext(request, (tx) => listTable(tx, request.tenantContext!.companyId, "storage_locations", "name")),
  );

  app.post("/api/storage-locations", { preHandler: requireTenantAuth }, async (request) => {
    const b = storageLocationBody.parse(request.body);
    const { companyId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `INSERT INTO storage_locations (company_id, project_id, location_type, name, parent_storage_location_id, zone_code, rack_code, bay_code)
         VALUES ($1::uuid,$2::uuid,$3::location_type_enum,$4::text,$5::uuid,$6::text,$7::text,$8::text) RETURNING *`,
        companyId, b.projectId ?? null, b.locationType, b.name, b.parentStorageLocationId ?? null,
        b.zoneCode ?? null, b.rackCode ?? null, b.bayCode ?? null,
      ),
    );
    return (rows as unknown[])[0];
  });

  app.patch<{ Params: { id: string } }>("/api/storage-locations/:id", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const b = storageLocationBody.partial().parse(request.body);
    const { companyId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `UPDATE storage_locations SET
           name = COALESCE($3::text, name), location_type = COALESCE($4::location_type_enum, location_type),
           parent_storage_location_id = COALESCE($5::uuid, parent_storage_location_id),
           zone_code = COALESCE($6::text, zone_code), rack_code = COALESCE($7::text, rack_code), bay_code = COALESCE($8::text, bay_code)
         WHERE company_id = $1::uuid AND id = $2::uuid RETURNING *`,
        companyId, id, b.name ?? null, b.locationType ?? null, b.parentStorageLocationId ?? null,
        b.zoneCode ?? null, b.rackCode ?? null, b.bayCode ?? null,
      ),
    );
    const row = (rows as unknown[])[0];
    if (!row) throw new NotFoundError("Storage location not found");
    return row;
  });

  // ---------------------------------------------------------------------
  // location_node_types & location_nodes — the *installation* hierarchy
  // (§2.11/§2.18), distinct from storage_locations' physical sub-locations.
  // Cycle-freedom on location_nodes.parentId is application-enforced
  // (docs/physical-database-design.md §3/§17 — not a DB constraint): a walk
  // up from the proposed parent must never reach the node being created/
  // updated.
  // ---------------------------------------------------------------------
  const locationNodeTypeBody = z.object({ name: z.string().trim().min(1) });

  app.get("/api/location-node-types", { preHandler: requireTenantAuth }, async (request) =>
    withAuthedTenantContext(request, (tx) => listTable(tx, request.tenantContext!.companyId, "location_node_types", "name")),
  );

  app.post("/api/location-node-types", { preHandler: requireTenantAuth }, async (request) => {
    const b = locationNodeTypeBody.parse(request.body);
    const { companyId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(`INSERT INTO location_node_types (company_id, name) VALUES ($1::uuid,$2::text) RETURNING *`, companyId, b.name),
    );
    return (rows as unknown[])[0];
  });

  const locationNodeBody = z.object({
    projectId: z.string().uuid(),
    parentId: z.string().uuid().optional(),
    locationNodeTypeId: z.string().uuid(),
    name: z.string().trim().min(1),
  });

  app.get("/api/location-nodes", { preHandler: requireTenantAuth }, async (request) =>
    withAuthedTenantContext(request, (tx) => listTable(tx, request.tenantContext!.companyId, "location_nodes", "name")),
  );

  /** Walks `parentId` upward; throws if `candidateAncestorId` (or the node itself) is reached — a cycle. */
  async function assertNoCycle(
    tx: Prisma.TransactionClient,
    companyId: string,
    nodeId: string | null,
    candidateParentId: string | undefined,
  ): Promise<void> {
    if (!candidateParentId) return;
    if (nodeId && candidateParentId === nodeId) {
      throw new BadRequestError("A location node cannot be its own parent");
    }
    let current: string | null = candidateParentId;
    const visited = new Set<string>();
    while (current) {
      if (nodeId && current === nodeId) {
        throw new BadRequestError("This parent assignment would make the node its own ancestor (cycle)");
      }
      if (visited.has(current)) {
        // A cycle already exists upstream of candidateParentId, unrelated
        // to this write — stop walking rather than loop forever.
        break;
      }
      visited.add(current);
      const rows: { parent_id: string | null }[] = await tx.$queryRawUnsafe(
        `SELECT parent_id FROM location_nodes WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        current,
      );
      current = rows[0]?.parent_id ?? null;
    }
  }

  app.post("/api/location-nodes", { preHandler: requireTenantAuth }, async (request) => {
    const b = locationNodeBody.parse(request.body);
    const { companyId } = request.tenantContext!;
    const row = await withAuthedTenantContext(request, async (tx) => {
      await assertNoCycle(tx, companyId, null, b.parentId);
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO location_nodes (company_id, project_id, parent_id, location_node_type_id, name)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text) RETURNING *`,
        companyId, b.projectId, b.parentId ?? null, b.locationNodeTypeId, b.name,
      );
      return (rows as unknown[])[0];
    });
    return row;
  });

  app.patch<{ Params: { id: string } }>("/api/location-nodes/:id", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const b = locationNodeBody.partial().parse(request.body);
    const { companyId } = request.tenantContext!;
    const row = await withAuthedTenantContext(request, async (tx) => {
      if (b.parentId !== undefined) {
        await assertNoCycle(tx, companyId, id, b.parentId);
      }
      const rows = await tx.$queryRawUnsafe(
        `UPDATE location_nodes SET
           name = COALESCE($3::text, name), parent_id = COALESCE($4::uuid, parent_id),
           location_node_type_id = COALESCE($5::uuid, location_node_type_id)
         WHERE company_id = $1::uuid AND id = $2::uuid RETURNING *`,
        companyId, id, b.name ?? null, b.parentId ?? null, b.locationNodeTypeId ?? null,
      );
      return (rows as unknown[])[0];
    });
    if (!row) throw new NotFoundError("Location node not found");
    return row;
  });

  // ---------------------------------------------------------------------
  // suppliers & manufacturers
  // ---------------------------------------------------------------------
  const partyBody = z.object({ name: z.string().trim().min(1), country: z.string().trim().min(1).optional() });

  for (const [path, table] of [["/api/suppliers", "suppliers"], ["/api/manufacturers", "manufacturers"]] as const) {
    app.get(path, { preHandler: requireTenantAuth }, async (request) =>
      withAuthedTenantContext(request, (tx) => listTable(tx, request.tenantContext!.companyId, table, "name")),
    );
    app.post(path, { preHandler: requireTenantAuth }, async (request) => {
      const b = partyBody.parse(request.body);
      const { companyId } = request.tenantContext!;
      const rows = await withAuthedTenantContext(request, (tx) =>
        tx.$queryRawUnsafe(`INSERT INTO ${table} (company_id, name, country) VALUES ($1::uuid,$2::text,$3::text) RETURNING *`, companyId, b.name, b.country ?? null),
      );
      return (rows as unknown[])[0];
    });
  }

  // ---------------------------------------------------------------------
  // structural_element_types, reinforcement_purposes, processing_operation_types
  // — company-scoped configurable master data (CLAUDE.md §2.6, Dev Rule §5.11).
  // ---------------------------------------------------------------------
  const namedActiveBody = z.object({ name: z.string().trim().min(1), isActive: z.boolean().default(true) });

  for (const [path, table] of [
    ["/api/structural-element-types", "structural_element_types"],
    ["/api/reinforcement-purposes", "reinforcement_purposes"],
  ] as const) {
    app.get(path, { preHandler: requireTenantAuth }, async (request) =>
      withAuthedTenantContext(request, (tx) => listTable(tx, request.tenantContext!.companyId, table, "name")),
    );
    app.post(path, { preHandler: requireTenantAuth }, async (request) => {
      const b = namedActiveBody.parse(request.body);
      const { companyId } = request.tenantContext!;
      const rows = await withAuthedTenantContext(request, (tx) =>
        tx.$queryRawUnsafe(`INSERT INTO ${table} (company_id, name, is_active) VALUES ($1::uuid,$2::text,$3::boolean) RETURNING *`, companyId, b.name, b.isActive),
      );
      return (rows as unknown[])[0];
    });
  }

  const processingOperationTypeBody = z.object({
    name: z.string().trim().min(1),
    requiresUniformInputSpec: z.boolean().default(true),
    isActive: z.boolean().default(true),
  });

  app.get("/api/processing-operation-types", { preHandler: requireTenantAuth }, async (request) =>
    withAuthedTenantContext(request, (tx) => listTable(tx, request.tenantContext!.companyId, "processing_operation_types", "name")),
  );
  app.post("/api/processing-operation-types", { preHandler: requireTenantAuth }, async (request) => {
    const b = processingOperationTypeBody.parse(request.body);
    const { companyId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `INSERT INTO processing_operation_types (company_id, name, requires_uniform_input_spec, is_active) VALUES ($1::uuid,$2::text,$3::boolean,$4::boolean) RETURNING *`,
        companyId, b.name, b.requiresUniformInputSpec, b.isActive,
      ),
    );
    return (rows as unknown[])[0];
  });

  // ---------------------------------------------------------------------
  // structural_element_instances
  // ---------------------------------------------------------------------
  const structuralElementInstanceBody = z.object({
    projectId: z.string().uuid(),
    structuralElementTypeId: z.string().uuid(),
    locationNodeId: z.string().uuid(),
    referenceCode: z.string().trim().min(1),
  });

  app.get("/api/structural-element-instances", { preHandler: requireTenantAuth }, async (request) =>
    withAuthedTenantContext(request, (tx) => listTable(tx, request.tenantContext!.companyId, "structural_element_instances", "reference_code")),
  );
  app.post("/api/structural-element-instances", { preHandler: requireTenantAuth }, async (request) => {
    const b = structuralElementInstanceBody.parse(request.body);
    const { companyId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `INSERT INTO structural_element_instances (company_id, project_id, structural_element_type_id, location_node_id, reference_code)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text) RETURNING *`,
        companyId, b.projectId, b.structuralElementTypeId, b.locationNodeId, b.referenceCode,
      ),
    );
    return (rows as unknown[])[0];
  });

  // ---------------------------------------------------------------------
  // roles — for assigning memberships/invitations (auth module references
  // these by id; this endpoint lets a Company Admin see/create them).
  // ---------------------------------------------------------------------
  const roleBody = z.object({ name: z.string().trim().min(1) });

  app.get("/api/roles", { preHandler: requireTenantAuth }, async (request) =>
    withAuthedTenantContext(request, (tx) => listTable(tx, request.tenantContext!.companyId, "roles", "name")),
  );
  app.post("/api/roles", { preHandler: requireTenantAuth }, async (request) => {
    const b = roleBody.parse(request.body);
    const { companyId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(`INSERT INTO roles (company_id, name) VALUES ($1::uuid,$2::text) RETURNING *`, companyId, b.name),
    );
    return (rows as unknown[])[0];
  });
}
