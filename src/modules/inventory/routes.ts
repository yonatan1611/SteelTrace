import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireTenantAuth, withAuthedTenantContext } from "../auth/middleware";

interface MaterialUnitRow {
  id: string;
  company_id: string;
  project_id: string | null;
  status: string;
  classification: string;
  granularity: string;
  surface_type: string;
  diameter_mm: string;
  grade: string;
  current_storage_location_id: string | null;
  [key: string]: unknown;
}

const inventoryQuery = z.object({
  projectId: z.string().uuid().optional(),
  storageLocationId: z.string().uuid().optional(),
  status: z.enum(["AVAILABLE", "RESERVED", "CONSUMED", "DISPATCHED", "INSTALLED", "ON_HOLD"]).optional(),
  classification: z.enum(["ORIGINAL", "PENDING_RECONCILIATION", "PREPARED", "OFFCUT", "SCRAP"]).optional(),
  diameterMm: z.coerce.number().positive().optional(),
  unallocatedOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().nonnegative().default(0),
});

/**
 * GET /api/inventory — §2.3/§14 live stock query. `remaining_length_m`/
 * `theoretical_weight_kg` are always computed on demand (material_unit_
 * remaining_length_m/theoretical_weight_kg, 03) — never a stored column —
 * consistent with the "no competing quantity column" rule everywhere else
 * in this schema.
 */
export function registerInventoryRoutes(app: FastifyInstance): void {
  app.get("/api/inventory", { preHandler: requireTenantAuth }, async (request) => {
    const q = inventoryQuery.parse(request.query);
    const { companyId } = request.tenantContext!;

    const conditions: string[] = ["company_id = $1::uuid"];
    const params: unknown[] = [companyId];
    let n = 1;

    function addCondition(sql: string, value: unknown): void {
      n += 1;
      conditions.push(sql.replace("$$", `$${n}`));
      params.push(value);
    }

    if (q.unallocatedOnly) {
      conditions.push("project_id IS NULL", "status = 'AVAILABLE'");
    } else {
      if (q.projectId !== undefined) addCondition("project_id = $$::uuid", q.projectId);
      if (q.status !== undefined) addCondition("status = $$::material_status_enum", q.status);
    }
    if (q.storageLocationId !== undefined) addCondition("current_storage_location_id = $$::uuid", q.storageLocationId);
    if (q.classification !== undefined) addCondition("classification = $$::material_classification_enum", q.classification);
    if (q.diameterMm !== undefined) addCondition("diameter_mm = $$::numeric", q.diameterMm);

    const limitParamIndex = n + 1;
    const offsetParamIndex = n + 2;
    params.push(q.limit, q.offset);

    return withAuthedTenantContext(request, async (tx: Prisma.TransactionClient) => {
      const rows = await tx.$queryRawUnsafe<MaterialUnitRow[]>(
        `SELECT * FROM material_units WHERE ${conditions.join(" AND ")}
          ORDER BY created_at DESC
          LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
        ...params,
      );

      // Sequential, not Promise.all: a Prisma interactive-transaction
      // client holds one physical connection for the whole transaction —
      // concurrent queries racing over it are not a safe pattern
      // (observed firsthand: intermittent "Transaction not found" P2028
      // errors under concurrent $queryRawUnsafe calls sharing one `tx`).
      const enriched: Record<string, unknown>[] = [];
      for (const u of rows) {
        const remRows = await tx.$queryRawUnsafe<{ r: string }[]>(`SELECT material_unit_remaining_length_m($1::uuid, $2::uuid) AS r`, companyId, u.id);
        const twRows = await tx.$queryRawUnsafe<{ w: string | null }[]>(`SELECT theoretical_weight_kg($1::uuid, $2::uuid) AS w`, companyId, u.id);
        enriched.push({ ...u, remainingLengthM: remRows[0]?.r ?? null, theoreticalWeightKg: twRows[0]?.w ?? null });
      }
      return enriched;
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/material-units/:id/split — §9: whole-unit reservation/
  // reallocation both rely on "split it first" (§9/§14 of the physical
  // design doc).
  // -------------------------------------------------------------------------
  const splitBody = z.object({
    quantityPieces: z.number().int().positive(),
    unitLengthM: z.number().positive().optional(),
    totalLengthM: z.number().positive(),
    unitWeightKg: z.number().positive().optional(),
    totalWeightKg: z.number().positive().optional(),
    granularity: z.enum(["BUNDLE", "BATCH", "PIECE"]).default("BATCH"),
    reason: z.string().trim().min(1),
  });

  app.post<{ Params: { id: string } }>("/api/material-units/:id/split", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const b = splitBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const childId = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ split_material_unit: string }[]>(
        `SELECT split_material_unit($1::uuid, $2::uuid, $3::integer, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::material_granularity_enum, $9::text, $10::uuid)`,
        companyId, id, b.quantityPieces, b.unitLengthM ?? null, b.totalLengthM, b.unitWeightKg ?? null, b.totalWeightKg ?? null,
        b.granularity, b.reason, membershipId,
      ),
    ).then((rows) => rows[0]!.split_material_unit);

    return { sourceMaterialUnitId: id, childMaterialUnitId: childId };
  });

  // -------------------------------------------------------------------------
  // POST /api/material-units/:id/reallocate — §5: explicit, auditable
  // project reallocation. `reallocate_project` never touches
  // `current_storage_location_id` — physical location is unchanged.
  // -------------------------------------------------------------------------
  const reallocateBody = z.object({
    toProjectId: z.string().uuid().nullable(),
    reason: z.string().trim().min(1),
  });

  app.post<{ Params: { id: string } }>("/api/material-units/:id/reallocate", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const b = reallocateBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const allocationId = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ reallocate_project: string }[]>(
        `SELECT reallocate_project($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text)`,
        companyId, id, b.toProjectId, membershipId, b.reason,
      ),
    ).then((rows) => rows[0]!.reallocate_project);

    return { materialUnitId: id, allocationId, toProjectId: b.toProjectId };
  });
}
