import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTenantAuth, withAuthedTenantContext } from "../auth/middleware";
import { NotFoundError } from "../../api/errors";

// ---------------------------------------------------------------------------
// work_orders — ordinary master data (01 grants), optionally linked to a BBS line.
// ---------------------------------------------------------------------------
const workOrderBody = z.object({
  projectId: z.string().uuid(),
  referenceCode: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  bbsLineId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// intended_usage_declarations — ordinary master data (01, gap closed this
// task); exactly one of processingOperationId/processingOutputId per the
// CHECK, and at least one of structuralElementTypeId/
// structuralElementInstanceId (schema.prisma's documented constraint).
// ---------------------------------------------------------------------------
const intendedUsageBody = z.object({
  processingOperationId: z.string().uuid().optional(),
  processingOutputId: z.string().uuid().optional(),
  structuralElementTypeId: z.string().uuid().optional(),
  structuralElementInstanceId: z.string().uuid().optional(),
  locationNodeId: z.string().uuid().optional(),
  reinforcementPurposeId: z.string().uuid(),
  bbsLineId: z.string().uuid().optional(),
});

const processingInputSchema = z.object({
  materialUnitId: z.string().uuid(),
  quantityConsumedPieces: z.number().int().positive(),
  lengthConsumedM: z.number().positive(),
  weightConsumedKg: z.number().positive().optional(),
});

const processingOutputSourceSchema = z.object({
  sourceInputMaterialUnitId: z.string().uuid(),
  contributionWeight: z.number().positive().max(1).optional(),
});

const processingOutputSchema = z.object({
  attributionMode: z.enum(["EXACT", "KNOWN_PARTIAL", "POOLED"]),
  granularity: z.enum(["BUNDLE", "BATCH", "PIECE"]).default("BATCH"),
  quantityPieces: z.number().int().positive(),
  unitLengthM: z.number().positive().optional(),
  totalLengthM: z.number().positive(),
  unitWeightKg: z.number().positive().optional(),
  totalWeightKg: z.number().positive().optional(),
  sources: z.array(processingOutputSourceSchema).default([]),
});

const adjustmentSchema = z.object({
  measurementBasis: z.enum(["LENGTH", "WEIGHT"]),
  amount: z.number().refine((v) => v !== 0, "amount must be non-zero"),
  adjustmentType: z.enum(["TOLERANCE", "CORRECTION"]),
  reason: z.string().trim().min(1),
});

const recordProcessingOperationBody = z.object({
  existingOperationId: z.string().uuid().optional(),
  projectId: z.string().uuid(),
  workOrderId: z.string().uuid().optional(),
  referenceCode: z.string().trim().min(1),
  operationTypeId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(1).optional(),
  inputs: z.array(processingInputSchema).default([]),
  outputs: z.array(processingOutputSchema).default([]),
  adjustments: z.array(adjustmentSchema).default([]),
});

interface ProcessingOperationResultRow {
  operation_id: string;
  output_index: number | null;
  output_material_unit_id: string | null;
}

const reservationBody = z.object({
  materialUnitId: z.string().uuid(),
  intendedUsageDeclarationId: z.string().uuid().optional(),
  bbsLineId: z.string().uuid().optional(),
  expiresAt: z.string().datetime().optional(),
});

const releaseReservationBody = z.object({
  releaseType: z.enum(["FULFILLED", "CANCELLED", "EXPIRED"]),
  releaseReason: z.string().trim().min(1).optional(),
});

export function registerProcessingRoutes(app: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // work_orders
  // -------------------------------------------------------------------------
  app.get("/api/work-orders", { preHandler: requireTenantAuth }, async (request) => {
    const { companyId } = request.tenantContext!;
    return withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(`SELECT * FROM work_orders WHERE company_id = $1::uuid ORDER BY created_at DESC`, companyId),
    );
  });

  app.post("/api/work-orders", { preHandler: requireTenantAuth }, async (request) => {
    const b = workOrderBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `INSERT INTO work_orders (company_id, project_id, reference_code, description, bbs_line_id, created_by_membership_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::uuid, now()) RETURNING *`,
        companyId, b.projectId, b.referenceCode, b.description ?? null, b.bbsLineId ?? null, membershipId,
      ),
    );
    return (rows as unknown[])[0];
  });

  // -------------------------------------------------------------------------
  // intended_usage_declarations (§2.7: declared intent, corrected by a
  // supersede-chain, never silently overwritten).
  // -------------------------------------------------------------------------
  app.post("/api/intended-usage", { preHandler: requireTenantAuth }, async (request) => {
    const b = intendedUsageBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `INSERT INTO intended_usage_declarations (
           company_id, processing_operation_id, processing_output_id, structural_element_type_id,
           structural_element_instance_id, location_node_id, reinforcement_purpose_id, bbs_line_id,
           declared_by_membership_id, declared_at, status
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, now(), 'ACTIVE')
         RETURNING *`,
        companyId, b.processingOperationId ?? null, b.processingOutputId ?? null, b.structuralElementTypeId ?? null,
        b.structuralElementInstanceId ?? null, b.locationNodeId ?? null, b.reinforcementPurposeId, b.bbsLineId ?? null,
        membershipId,
      ),
    );
    return (rows as unknown[])[0];
  });

  app.post<{ Params: { id: string } }>("/api/intended-usage/:id/supersede", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const b = intendedUsageBody.partial().parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const old = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM intended_usage_declarations WHERE company_id = $1::uuid AND id = $2::uuid AND status = 'ACTIVE'`,
        companyId,
        id,
      );
      if (!old[0]) return null;
      const prev = old[0] as Record<string, string | null>;

      const newRows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `INSERT INTO intended_usage_declarations (
           company_id, processing_operation_id, processing_output_id, structural_element_type_id,
           structural_element_instance_id, location_node_id, reinforcement_purpose_id, bbs_line_id,
           declared_by_membership_id, declared_at, status, supersedes_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, now(), 'ACTIVE', $10::uuid)
         RETURNING *`,
        companyId,
        b.processingOperationId ?? prev.processing_operation_id,
        b.processingOutputId ?? prev.processing_output_id,
        b.structuralElementTypeId ?? prev.structural_element_type_id,
        b.structuralElementInstanceId ?? prev.structural_element_instance_id,
        b.locationNodeId ?? prev.location_node_id,
        b.reinforcementPurposeId ?? prev.reinforcement_purpose_id,
        b.bbsLineId ?? prev.bbs_line_id,
        membershipId,
        id,
      );

      await tx.$executeRawUnsafe(`UPDATE intended_usage_declarations SET status = 'SUPERSEDED' WHERE company_id = $1::uuid AND id = $2::uuid`, companyId, id);

      return newRows[0]!;
    });

    if (!result) throw new NotFoundError("Active intended usage declaration not found");
    return result;
  });

  // -------------------------------------------------------------------------
  // processing-operations — the only write path is record_processing_operation
  // (§12); this route is a thin JSON-shaping wrapper, never a direct INSERT.
  // -------------------------------------------------------------------------
  app.post("/api/processing-operations", { preHandler: requireTenantAuth }, async (request) => {
    const b = recordProcessingOperationBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const inputsJson = JSON.stringify(
      b.inputs.map((i) => ({
        material_unit_id: i.materialUnitId,
        quantity_consumed_pieces: i.quantityConsumedPieces,
        length_consumed_m: i.lengthConsumedM,
        weight_consumed_kg: i.weightConsumedKg ?? null,
      })),
    );
    const outputsJson = JSON.stringify(
      b.outputs.map((o) => ({
        attribution_mode: o.attributionMode,
        granularity: o.granularity,
        quantity_pieces: o.quantityPieces,
        unit_length_m: o.unitLengthM ?? null,
        total_length_m: o.totalLengthM,
        unit_weight_kg: o.unitWeightKg ?? null,
        total_weight_kg: o.totalWeightKg ?? null,
        sources: o.sources.map((s) => ({
          source_input_material_unit_id: s.sourceInputMaterialUnitId,
          contribution_weight: s.contributionWeight ?? null,
        })),
      })),
    );
    const adjustmentsJson = JSON.stringify(
      b.adjustments.map((a) => ({
        measurement_basis: a.measurementBasis,
        amount: a.amount,
        adjustment_type: a.adjustmentType,
        reason: a.reason,
      })),
    );

    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<ProcessingOperationResultRow[]>(
        `SELECT * FROM record_processing_operation(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::uuid, $7::uuid, $8::uuid, $9::text, $10::jsonb, $11::jsonb, $12::jsonb
         )`,
        companyId, b.existingOperationId ?? null, b.projectId, b.workOrderId ?? null, b.referenceCode, b.operationTypeId,
        b.storageLocationId, membershipId, b.idempotencyKey ?? null, inputsJson, outputsJson, adjustmentsJson,
      ),
    );

    const operationId = rows[0]!.operation_id;
    const outputs = rows.filter((r) => r.output_material_unit_id !== null).map((r) => ({ outputIndex: r.output_index, materialUnitId: r.output_material_unit_id }));
    return { operationId, outputs };
  });

  app.post<{ Params: { id: string } }>("/api/processing-operations/:id/finalize", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId } = request.tenantContext!;
    await withAuthedTenantContext(request, (tx) => tx.$executeRawUnsafe(`SELECT finalize_processing_operation($1::uuid, $2::uuid)`, companyId, id));
    return { operationId: id, finalized: true };
  });

  app.post<{ Params: { id: string } }>("/api/processing-operations/:id/check", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId, membershipId } = request.tenantContext!;
    await withAuthedTenantContext(request, (tx) =>
      tx.$executeRawUnsafe(`SELECT record_approval($1::uuid, 'processing_operations'::text, $2::uuid, $3::uuid)`, companyId, id, membershipId),
    );
    return { operationId: id, checked: true };
  });

  app.get("/api/processing-operations", { preHandler: requireTenantAuth }, async (request) => {
    const { companyId } = request.tenantContext!;
    return withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(`SELECT * FROM processing_operations WHERE company_id = $1::uuid ORDER BY performed_at DESC`, companyId),
    );
  });

  app.get<{ Params: { id: string } }>("/api/processing-operations/:id", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const opRows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM processing_operations WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        id,
      );
      if (!opRows[0]) return null;

      const inputs = await tx.$queryRawUnsafe(`SELECT * FROM processing_inputs WHERE company_id = $1::uuid AND processing_operation_id = $2::uuid`, companyId, id);
      const outputs = await tx.$queryRawUnsafe<{ id: string; material_unit_id: string; attribution_mode: string }[]>(
        `SELECT * FROM processing_outputs WHERE company_id = $1::uuid AND processing_operation_id = $2::uuid`,
        companyId,
        id,
      );

      // Sequential, not Promise.all — one shared `tx`.
      const outputsWithOrigins: Record<string, unknown>[] = [];
      for (const o of outputs) {
        const origins = await tx.$queryRawUnsafe(
          `SELECT bundle_id, confidence, contribution_weight FROM material_unit_origins WHERE company_id = $1::uuid AND material_unit_id = $2::uuid`,
          companyId,
          o.material_unit_id,
        );
        outputsWithOrigins.push({ ...o, origins });
      }

      return { ...opRows[0], inputs, outputs: outputsWithOrigins };
    });

    if (!result) throw new NotFoundError("Processing operation not found");
    return result;
  });

  // -------------------------------------------------------------------------
  // material_reservations — whole-unit only (§14); reserve_material_unit/
  // release_reservation (added this task, closing the §14 gap where
  // material_units has no direct write grant for steeltrace_app at all).
  // -------------------------------------------------------------------------
  app.post("/api/reservations", { preHandler: requireTenantAuth }, async (request) => {
    const b = reservationBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ reserve_material_unit: string }[]>(
        `SELECT reserve_material_unit($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::timestamptz)`,
        companyId, b.materialUnitId, b.intendedUsageDeclarationId ?? null, b.bbsLineId ?? null, membershipId, b.expiresAt ?? null,
      ),
    );
    return { reservationId: rows[0]!.reserve_material_unit, materialUnitId: b.materialUnitId, status: "RESERVED" };
  });

  app.post<{ Params: { id: string } }>("/api/reservations/:id/release", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const b = releaseReservationBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;
    await withAuthedTenantContext(request, (tx) =>
      tx.$executeRawUnsafe(
        `SELECT release_reservation($1::uuid, $2::uuid, $3::release_type_enum, $4::text, $5::uuid)`,
        companyId, id, b.releaseType, b.releaseReason ?? null, membershipId,
      ),
    );
    return { reservationId: id, releaseType: b.releaseType };
  });
}
