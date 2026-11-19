import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { requireTenantAuth, withAuthedTenantContext } from "../auth/middleware";
import { NotFoundError } from "../../api/errors";

const reclassifyBody = z.object({
  toClassification: z.enum(["PREPARED", "OFFCUT", "SCRAP"]),
  reason: z.string().trim().min(1),
  internalReferenceCode: z.string().trim().min(1).optional(),
});

const remnantSuggestQuery = z.object({
  diameterMm: z.coerce.number().positive(),
  surfaceType: z.enum(["DEFORMED", "PLAIN"]),
  grade: z.string().trim().min(1),
  standard: z.string().trim().min(1).optional(),
  minLengthM: z.coerce.number().positive(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export function registerRemnantRoutes(app: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // POST /api/material-units/:id/reclassify — §7 of data-model.md.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/material-units/:id/reclassify", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const b = reclassifyBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const eventId = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ reclassify_material_unit: string }[]>(
        `SELECT reclassify_material_unit($1::uuid, $2::uuid, $3::material_classification_enum, $4::text, $5::uuid, $6::text)`,
        companyId, id, b.toClassification, b.reason, membershipId, b.internalReferenceCode ?? null,
      ),
    ).then((rows) => rows[0]!.reclassify_material_unit);

    const unit = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ classification: string; internal_reference_code: string | null }[]>(
        `SELECT classification, internal_reference_code FROM material_units WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        id,
      ),
    ).then((rows) => rows[0]!);

    return {
      reclassificationEventId: eventId,
      materialUnitId: id,
      classification: unit.classification,
      internalReferenceCode: unit.internal_reference_code,
    };
  });

  // -------------------------------------------------------------------------
  // POST /api/reclassifications/:id/approve — maker-checker remnant reuse
  // sign-off (§2.19); record_approval enforces maker != checker itself.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/reclassifications/:id/approve", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId, membershipId } = request.tenantContext!;
    await withAuthedTenantContext(request, (tx) =>
      tx.$executeRawUnsafe(`SELECT record_approval($1::uuid, 'reclassification_events'::text, $2::uuid, $3::uuid)`, companyId, id, membershipId),
    );
    return { reclassificationEventId: id, approved: true };
  });

  // -------------------------------------------------------------------------
  // GET /api/material-units/:id/qr — any tagged batch/remnant, encoding
  // steeltrace://unit/<unitId> (no third-party/IDIS dependency, CLAUDE.md §1).
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/material-units/:id/qr", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId } = request.tenantContext!;
    const unit = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ id: string; internal_reference_code: string | null }[]>(
        `SELECT id, internal_reference_code FROM material_units WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        id,
      ),
    ).then((rows) => rows[0] ?? null);
    if (!unit) throw new NotFoundError("Material unit not found");

    const payload = `steeltrace://unit/${unit.id}`;
    const svg = await QRCode.toString(payload, { type: "svg" });
    return {
      materialUnitId: unit.id,
      internalReferenceCode: unit.internal_reference_code,
      payload,
      svgDataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/remnants/suggest — §2.9's "remnant-first" workflow: surfaces
  // reusable OFFCUT stock whose spec is a CONFIRMED_MATCH and whose
  // remaining length covers the request, shortest-fit-first so the
  // smallest adequate offcut is consumed before a larger one or a fresh
  // bar — the standard "first-fit" remnant strategy.
  // -------------------------------------------------------------------------
  app.get("/api/remnants/suggest", { preHandler: requireTenantAuth }, async (request) => {
    const q = remnantSuggestQuery.parse(request.query);
    const { companyId } = request.tenantContext!;

    // One statement, not one round trip per candidate — material_unit_
    // remaining_length_m is called once per matching row INSIDE this
    // single query (same pattern as reports/routes.ts and the bundles/
    // inventory list routes), filtered by the HAVING-equivalent WHERE on
    // the computed column, rather than fetched row-by-row from Node and
    // filtered there.
    const withRemaining = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ material_unit_id: string; remaining_length_m: string }[]>(
        `SELECT id AS material_unit_id, remaining_length_m FROM (
           SELECT id, material_unit_remaining_length_m(company_id, id) AS remaining_length_m
             FROM material_units
            WHERE company_id = $1::uuid AND classification = 'OFFCUT' AND status = 'AVAILABLE'
              AND spec_compare($2::numeric, $3::rebar_surface_type_enum, upper(trim($4::text)), upper(trim($5::text)),
                                diameter_mm, surface_type, grade_normalized, standard_normalized) = 'CONFIRMED_MATCH'
         ) sized
         WHERE remaining_length_m >= $6::numeric
         ORDER BY remaining_length_m ASC
         LIMIT $7::int`,
        companyId, q.diameterMm, q.surfaceType, q.grade, q.standard ?? null, q.minLengthM, q.limit,
      ),
    );

    return withRemaining.map((r) => ({ materialUnitId: r.material_unit_id, remainingLengthM: Number(r.remaining_length_m) }));
  });
}
