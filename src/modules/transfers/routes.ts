import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTenantAuth, withAuthedTenantContext } from "../auth/middleware";
import { NotFoundError } from "../../api/errors";

const dispatchLineSchema = z.object({
  sourceMaterialUnitId: z.string().uuid(),
  quantityPieces: z.number().int().positive(),
  unitLengthM: z.number().positive().nullable().optional(),
  totalLengthM: z.number().positive(),
  unitWeightKg: z.number().positive().nullable().optional(),
  totalWeightKg: z.number().positive().nullable().optional(),
});

const dispatchBody = z.object({
  projectId: z.string().uuid(),
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  vehicleInfo: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  lines: z.array(dispatchLineSchema).min(1),
});

const portionSchema = z.object({
  quantityPieces: z.number().int().positive(),
  unitLengthM: z.number().positive().nullable().optional(),
  totalLengthM: z.number().positive(),
  unitWeightKg: z.number().positive().nullable().optional(),
  totalWeightKg: z.number().positive().nullable().optional(),
  disposition: z.enum(["ACCEPTED", "ON_HOLD", "DAMAGED_DISCREPANT"]),
});

const adjustmentSchema = z.object({
  measurementBasis: z.enum(["LENGTH", "WEIGHT"]),
  amount: z.number().refine((v) => v !== 0, "amount must be non-zero"),
  adjustmentType: z.enum(["TOLERANCE", "CORRECTION"]),
  reason: z.string().trim().min(1),
});

const receiveBody = z.object({
  materialTransferLineId: z.string().uuid(),
  notes: z.string().trim().min(1).optional(),
  portions: z.array(portionSchema).min(1),
  adjustments: z.array(adjustmentSchema).optional(),
});

export function registerTransferRoutes(app: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // POST /api/transfers — §2.10/§9: dispatch always splits off a dedicated
  // in-transit placeholder per line (`dispatch_material_transfer`, 05) —
  // never relocates the source row in place.
  // -------------------------------------------------------------------------
  app.post("/api/transfers", { preHandler: requireTenantAuth }, async (request) => {
    const b = dispatchBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const linesJson = JSON.stringify(
      b.lines.map((l) => ({
        source_material_unit_id: l.sourceMaterialUnitId,
        quantity_pieces: l.quantityPieces,
        unit_length_m: l.unitLengthM ?? null,
        total_length_m: l.totalLengthM,
        unit_weight_kg: l.unitWeightKg ?? null,
        total_weight_kg: l.totalWeightKg ?? null,
      })),
    );

    const transferId = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ dispatch_material_transfer: string }[]>(
        `SELECT dispatch_material_transfer($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::text, $8::jsonb)`,
        companyId, b.projectId, b.fromLocationId, b.toLocationId, membershipId,
        b.vehicleInfo ?? null, b.idempotencyKey ?? randomUUID(), linesJson,
      ),
    ).then((rows) => rows[0]!.dispatch_material_transfer);

    const lines = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ id: string; material_unit_id: string; split_from_material_unit_id: string }[]>(
        `SELECT id, material_unit_id, split_from_material_unit_id FROM material_transfer_lines
          WHERE company_id = $1::uuid AND material_transfer_id = $2::uuid ORDER BY created_at`,
        companyId,
        transferId,
      ),
    );

    return {
      transferId,
      lines: lines.map((l) => ({ lineId: l.id, placeholderMaterialUnitId: l.material_unit_id, sourceMaterialUnitId: l.split_from_material_unit_id })),
    };
  });

  // -------------------------------------------------------------------------
  // POST /api/transfers/:id/receive — §11: one call covers one
  // `material_transfer_line_id`, with potentially several differently-
  // dispositioned portions (ACCEPTED/ON_HOLD/DAMAGED_DISCREPANT) in a
  // single receipt event — a transfer with multiple lines (multiple source
  // units) is received by one call per line. Optional `adjustments` record
  // a documented over/under-receipt correction against the SAME line, in
  // the SAME transaction (`record_conservation_adjustment`, added this
  // task — see 05's own comment on the gap it closes).
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/transfers/:id/receive", { preHandler: requireTenantAuth }, async (request) => {
    const transferId = z.string().uuid().parse(request.params.id);
    const b = receiveBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const portionsJson = JSON.stringify(
      b.portions.map((p) => ({
        quantity_pieces: p.quantityPieces,
        unit_length_m: p.unitLengthM ?? null,
        total_length_m: p.totalLengthM,
        unit_weight_kg: p.unitWeightKg ?? null,
        total_weight_kg: p.totalWeightKg ?? null,
        disposition: p.disposition,
      })),
    );

    const result = await withAuthedTenantContext(request, async (tx) => {
      const lineCheck = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM material_transfer_lines WHERE company_id = $1::uuid AND id = $2::uuid AND material_transfer_id = $3::uuid`,
        companyId,
        b.materialTransferLineId,
        transferId,
      );
      if (!lineCheck[0]) {
        return { kind: "line_not_found" as const };
      }

      const receiptId = await tx
        .$queryRawUnsafe<{ receive_transfer_line: string }[]>(
          `SELECT receive_transfer_line($1::uuid, $2::uuid, $3::uuid, $4::text, $5::jsonb)`,
          companyId,
          b.materialTransferLineId,
          membershipId,
          b.notes ?? null,
          portionsJson,
        )
        .then((rows) => rows[0]!.receive_transfer_line);

      const adjustmentIds: string[] = [];
      for (const adj of b.adjustments ?? []) {
        const adjRows = await tx.$queryRawUnsafe<{ record_conservation_adjustment: string }[]>(
          `SELECT record_conservation_adjustment($1::uuid, NULL::uuid, $2::uuid, NULL::uuid, $3::measurement_basis_enum, $4::numeric, $5::adjustment_type_enum, $6::text, $7::uuid)`,
          companyId, b.materialTransferLineId, adj.measurementBasis, adj.amount, adj.adjustmentType, adj.reason, membershipId,
        );
        adjustmentIds.push(adjRows[0]!.record_conservation_adjustment);
      }

      const transferRow = await tx.$queryRawUnsafe<{ status: string; reconciliation_status: string }[]>(
        `SELECT status, reconciliation_status FROM material_transfers WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        transferId,
      );

      return { kind: "ok" as const, receiptId, adjustmentIds, transfer: transferRow[0]! };
    });

    if (result.kind === "line_not_found") {
      throw new NotFoundError("Transfer line not found for this transfer");
    }
    return {
      transferId,
      materialTransferLineId: b.materialTransferLineId,
      receiptId: result.receiptId,
      adjustmentIds: result.adjustmentIds,
      transferStatus: result.transfer.status,
      reconciliationStatus: result.transfer.reconciliation_status,
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/transfers & GET /api/transfers/:id
  // -------------------------------------------------------------------------
  app.get("/api/transfers", { preHandler: requireTenantAuth }, async (request) => {
    const { companyId } = request.tenantContext!;
    return withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(`SELECT * FROM material_transfers WHERE company_id = $1::uuid ORDER BY dispatched_at DESC`, companyId),
    );
  });

  app.get<{ Params: { id: string } }>("/api/transfers/:id", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const transfer = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM material_transfers WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        id,
      );
      if (!transfer[0]) return null;

      const lines = await tx.$queryRawUnsafe(
        `SELECT * FROM material_transfer_lines WHERE company_id = $1::uuid AND material_transfer_id = $2::uuid ORDER BY created_at`,
        companyId,
        id,
      );
      const receipts = await tx.$queryRawUnsafe(
        `SELECT r.*, json_agg(rl.* ORDER BY rl.created_at) AS lines
           FROM material_transfer_receipts r
           LEFT JOIN material_transfer_receipt_lines rl
             ON rl.company_id = r.company_id AND rl.material_transfer_receipt_id = r.id
          WHERE r.company_id = $1::uuid AND r.material_transfer_id = $2::uuid
          GROUP BY r.id, r.company_id, r.material_transfer_id, r.received_by_membership_id, r.received_at, r.notes
          ORDER BY r.received_at`,
        companyId,
        id,
      );

      return { ...transfer[0], lines, receipts };
    });

    if (!result) throw new NotFoundError("Transfer not found");
    return result;
  });
}
