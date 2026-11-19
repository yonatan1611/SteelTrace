import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTenantAuth, withAuthedTenantContext } from "../auth/middleware";
import { ApiError, NotFoundError } from "../../api/errors";

const countLineBody = z.object({
  materialUnitId: z.string().uuid(),
  countedPieces: z.number().int().nonnegative(),
  countedLengthM: z.number().nonnegative(),
  investigationNotes: z.string().trim().min(1).optional(),
});

const createCountBody = z.object({
  storageLocationId: z.string().uuid(),
  referenceCode: z.string().trim().min(1),
  countDate: z.string().date(),
  notes: z.string().trim().min(1).optional(),
  lines: z.array(countLineBody).min(1),
});

const adjustmentInput = z.object({
  physicalStockCountLineId: z.string().uuid(),
  measurementBasis: z.enum(["LENGTH", "WEIGHT"]),
  amount: z.number().refine((v) => v !== 0, "amount must be non-zero"),
  adjustmentType: z.enum(["TOLERANCE", "CORRECTION"]),
  reason: z.string().trim().min(1),
});

const verifyBody = z.object({
  adjustments: z.array(adjustmentInput).default([]),
});

/**
 * POST /api/physical-counts & POST /api/physical-counts/:id/verify — §2.17.
 * `record_physical_stock_count` already exists in 05 (verified against
 * the live schema before writing this module, per Task 6's own
 * instruction to check first) — this route is a thin JSON-shaping wrapper
 * around it, exactly like every other controlled-function route.
 */
export function registerCountRoutes(app: FastifyInstance): void {
  app.post("/api/physical-counts", { preHandler: requireTenantAuth }, async (request) => {
    const b = createCountBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const linesJson = JSON.stringify(
      b.lines.map((l) => ({
        material_unit_id: l.materialUnitId,
        counted_pieces: l.countedPieces,
        counted_length_m: l.countedLengthM,
        investigation_notes: l.investigationNotes ?? null,
      })),
    );

    const countId = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ record_physical_stock_count: string }[]>(
        `SELECT record_physical_stock_count($1::uuid, $2::uuid, $3::text, $4::date, $5::uuid, $6::text, $7::jsonb)`,
        companyId, b.storageLocationId, b.referenceCode, b.countDate, membershipId, b.notes ?? null, linesJson,
      ),
    ).then((rows) => rows[0]!.record_physical_stock_count);

    return { physicalStockCountId: countId };
  });

  // -------------------------------------------------------------------------
  // POST /api/physical-counts/:id/verify — maker (counted_by) != checker
  // (verified_by), enforced by record_approval itself. Approved variance
  // adjustments are recorded afterward, in the SAME transaction, via
  // record_conservation_adjustment linked to each named
  // physical_stock_count_line_id (§9b: an adjustment is a documented
  // correction, never implied purely by the variance row existing).
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/physical-counts/:id/verify", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const b = verifyBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const adjustmentIds = await withAuthedTenantContext(request, async (tx) => {
      await tx.$executeRawUnsafe(`SELECT record_approval($1::uuid, 'physical_stock_counts'::text, $2::uuid, $3::uuid)`, companyId, id, membershipId);

      const ids: string[] = [];
      for (const adj of b.adjustments) {
        const lineCheck = await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM physical_stock_count_lines WHERE company_id = $1::uuid AND id = $2::uuid AND physical_stock_count_id = $3::uuid`,
          companyId,
          adj.physicalStockCountLineId,
          id,
        );
        if (!lineCheck[0]) {
          throw new ApiError(400, "BAD_REQUEST", `physicalStockCountLineId ${adj.physicalStockCountLineId} does not belong to count ${id}`);
        }
        const rows = await tx.$queryRawUnsafe<{ record_conservation_adjustment: string }[]>(
          `SELECT record_conservation_adjustment($1::uuid, NULL::uuid, NULL::uuid, $2::uuid, $3::measurement_basis_enum, $4::numeric, $5::adjustment_type_enum, $6::text, $7::uuid)`,
          companyId, adj.physicalStockCountLineId, adj.measurementBasis, adj.amount, adj.adjustmentType, adj.reason, membershipId,
        );
        ids.push(rows[0]!.record_conservation_adjustment);
      }
      return ids;
    });

    return { physicalStockCountId: id, verified: true, adjustmentIds };
  });

  app.get("/api/physical-counts", { preHandler: requireTenantAuth }, async (request) => {
    const { companyId } = request.tenantContext!;
    return withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(`SELECT * FROM physical_stock_counts WHERE company_id = $1::uuid ORDER BY count_date DESC`, companyId),
    );
  });

  app.get<{ Params: { id: string } }>("/api/physical-counts/:id", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const countRows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM physical_stock_counts WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        id,
      );
      if (!countRows[0]) return null;
      const lines = await tx.$queryRawUnsafe(
        `SELECT * FROM physical_stock_count_lines WHERE company_id = $1::uuid AND physical_stock_count_id = $2::uuid`,
        companyId,
        id,
      );
      return { ...countRows[0], lines };
    });

    if (!result) throw new NotFoundError("Physical stock count not found");
    return result;
  });
}
