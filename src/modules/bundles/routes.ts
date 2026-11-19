import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import QRCode from "qrcode";
import { z } from "zod";
import { requireTenantAuth, withAuthedTenantContext } from "../auth/middleware";
import { ConflictError, NotFoundError } from "../../api/errors";

const attributeValueSchema = z.object({
  definitionId: z.string().uuid(),
  valueText: z.string().optional(),
  valueNumber: z.number().optional(),
  valueDate: z.string().optional(), // ISO date
});

const registerBundleBody = z.object({
  projectId: z.string().uuid().optional(),
  storageLocationId: z.string().uuid(),
  internalReferenceCode: z.string().trim().min(1),
  supplierId: z.string().uuid().optional(),
  manufacturerId: z.string().uuid().optional(),
  countryOfOrigin: z.string().trim().min(1).optional(),
  diameterMm: z.number().positive(),
  grade: z.string().trim().min(1),
  standard: z.string().trim().min(1).optional(),
  heatNumber: z.string().trim().min(1).optional(),
  pieceCount: z.number().int().positive(),
  barLengthM: z.number().positive(),
  surfaceType: z.enum(["DEFORMED", "PLAIN"]),
  originType: z.enum(["OPENING_STOCK", "GRN_PURCHASE"]),
  grnReference: z.string().trim().min(1).optional(),
  poReference: z.string().trim().min(1).optional(),
  deliveryNoteNumber: z.string().trim().min(1).optional(),
  vehicleInfo: z.string().trim().min(1).optional(),
  weighbridgeTicketNumber: z.string().trim().min(1).optional(),
  mtcReference: z.string().trim().min(1).optional(),
  actualWeightKg: z.number().positive().optional(),
  initialDisposition: z.enum(["ACCEPTED", "ON_HOLD", "DAMAGED_DISCREPANT"]).default("ACCEPTED"),
  attributes: z.array(attributeValueSchema).optional(),
});

interface BundleRow {
  id: string;
  company_id: string;
  internal_reference_code: string;
  diameter_mm: string;
  grade: string;
  standard: string | null;
  surface_type: string;
  origin_type: string;
  piece_count: number;
  bar_length_m: string;
  actual_weight_kg: string | null;
  initial_disposition: string;
  registered_by_membership_id: string;
  approved_by_membership_id: string | null;
  approved_at: Date | null;
  [key: string]: unknown;
}

async function bundleRootUnitId(tx: Prisma.TransactionClient, companyId: string, bundleId: string): Promise<string | null> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM material_units WHERE company_id = $1::uuid AND source_bundle_id = $2::uuid AND granularity = 'BUNDLE'`,
    companyId,
    bundleId,
  );
  return rows[0]?.id ?? null;
}

async function enrichBundle(
  tx: Prisma.TransactionClient,
  companyId: string,
  bundle: BundleRow,
): Promise<Record<string, unknown>> {
  const rootUnitId = await bundleRootUnitId(tx, companyId, bundle.id);
  let remainingLengthM: string | null = null;
  let theoreticalWeightKg: string | null = null;
  if (rootUnitId) {
    // Sequential, not Promise.all: a Prisma interactive-transaction client
    // holds one physical connection for the whole transaction (required —
    // the SET LOCAL ROLE/GUCs withTenantContext issued must stay in
    // effect), and concurrent queries racing over that single connection
    // is not a safe pattern (observed firsthand: intermittent "Transaction
    // not found" P2028 errors under concurrent $queryRawUnsafe calls on
    // the same `tx`).
    const remRows = await tx.$queryRawUnsafe<{ r: string }[]>(`SELECT material_unit_remaining_length_m($1::uuid, $2::uuid) AS r`, companyId, rootUnitId);
    const twRows = await tx.$queryRawUnsafe<{ w: string | null }[]>(`SELECT theoretical_weight_kg($1::uuid, $2::uuid) AS w`, companyId, rootUnitId);
    remainingLengthM = remRows[0]?.r ?? null;
    theoreticalWeightKg = twRows[0]?.w ?? null;
  }
  const marginRows = await tx.$queryRawUnsafe<{ margin: string | null }[]>(`SELECT rolling_margin_kg($1::uuid, $2::uuid) AS margin`, companyId, bundle.id);

  return {
    ...bundle,
    rootMaterialUnitId: rootUnitId,
    remainingLengthM,
    theoreticalWeightKg,
    rollingMarginKg: marginRows[0]?.margin ?? null,
  };
}

export function registerBundleRoutes(app: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // POST /api/bundles — §2.2/§2.13: the ONLY write path for a new bundle
  // is `register_bundle` (§12) — never a direct INSERT. Optional
  // `attributes` (§2.2's "field set must be extensible") are ordinary
  // app-role inserts into `bundle_attribute_values` after the controlled
  // call, since that table isn't part of the conservation-critical graph.
  // -------------------------------------------------------------------------
  app.post("/api/bundles", { preHandler: requireTenantAuth }, async (request) => {
    const b = registerBundleBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ bundle_id: string; root_material_unit_id: string }[]>(
        `SELECT * FROM register_bundle(
           $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid, $6::uuid, $7::text,
           $8::numeric, $9::text, $10::text, $11::text, $12::integer, $13::numeric,
           $14::rebar_surface_type_enum, $15::bundle_origin_type_enum, $16::text, $17::text,
           $18::text, $19::text, $20::text, $21::text, $22::numeric, $23::receipt_disposition_enum, $24::uuid
         )`,
        companyId, b.projectId ?? null, b.storageLocationId, b.internalReferenceCode, b.supplierId ?? null,
        b.manufacturerId ?? null, b.countryOfOrigin ?? null, b.diameterMm, b.grade, b.standard ?? null,
        b.heatNumber ?? null, b.pieceCount, b.barLengthM, b.surfaceType, b.originType, b.grnReference ?? null,
        b.poReference ?? null, b.deliveryNoteNumber ?? null, b.vehicleInfo ?? null, b.weighbridgeTicketNumber ?? null,
        b.mtcReference ?? null, b.actualWeightKg ?? null, b.initialDisposition, membershipId,
      );
      const created = rows[0]!;

      for (const attr of b.attributes ?? []) {
        await tx.$executeRawUnsafe(
          `INSERT INTO bundle_attribute_values (company_id, bundle_id, bundle_attribute_definition_id, value_text, value_number, value_date)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::numeric, $6::date)`,
          companyId, created.bundle_id, attr.definitionId, attr.valueText ?? null, attr.valueNumber ?? null, attr.valueDate ?? null,
        );
      }

      return created;
    });

    return { bundleId: result.bundle_id, rootMaterialUnitId: result.root_material_unit_id };
  });

  // -------------------------------------------------------------------------
  // GET /api/bundles & GET /api/bundles/:id
  // -------------------------------------------------------------------------
  app.get("/api/bundles", { preHandler: requireTenantAuth }, async (request) => {
    const { companyId } = request.tenantContext!;
    const bundles = await withAuthedTenantContext(request, async (tx) => {
      const rows = await tx.$queryRawUnsafe<BundleRow[]>(`SELECT * FROM bundles WHERE company_id = $1::uuid ORDER BY registered_at DESC`, companyId);
      // Sequential — see the note in enrichBundle: concurrent queries over
      // one shared Prisma transaction client are not safe.
      const enriched: Record<string, unknown>[] = [];
      for (const b of rows) {
        enriched.push(await enrichBundle(tx, companyId, b));
      }
      return enriched;
    });
    return bundles;
  });

  app.get<{ Params: { id: string } }>("/api/bundles/:id", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId } = request.tenantContext!;
    const bundle = await withAuthedTenantContext(request, async (tx) => {
      const rows = await tx.$queryRawUnsafe<BundleRow[]>(`SELECT * FROM bundles WHERE company_id = $1::uuid AND id = $2::uuid`, companyId, id);
      if (!rows[0]) return null;
      return enrichBundle(tx, companyId, rows[0]);
    });
    if (!bundle) throw new NotFoundError("Bundle not found");
    return bundle;
  });

  // -------------------------------------------------------------------------
  // GET /api/bundles/:id/qr — §2.2/§2.3: server-generated QR referencing
  // only SteelTrace's own internal bundle id (no IDIS/third-party scheme,
  // CLAUDE.md §1). Returned as an SVG data URL — printable/displayable
  // without any client-side QR library.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/bundles/:id/qr", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId } = request.tenantContext!;
    const bundle = await withAuthedTenantContext(request, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string; internal_reference_code: string }[]>(
        `SELECT id, internal_reference_code FROM bundles WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        id,
      );
      return rows[0] ?? null;
    });
    if (!bundle) throw new NotFoundError("Bundle not found");

    const payload = JSON.stringify({ type: "BUNDLE", id: bundle.id, code: bundle.internal_reference_code });
    const svg = await QRCode.toString(payload, { type: "svg" });
    return { bundleId: bundle.id, payload, svgDataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` };
  });

  // -------------------------------------------------------------------------
  // POST /api/bundles/:id/approve — GRN maker-checker (§2.19). NOTE: unlike
  // processing_operations/reclassification_events/conservation_adjustments/
  // bbs_schedules/physical_stock_counts/installations, `bundles` approval
  // is NOT routed through `record_approval` — 05's own header comment on
  // that function documents this as a deliberate choice: bundle approval
  // is an ordinary mutable-master-data correction (§15), using `bundles`'
  // direct `UPDATE` grant. The maker != checker rule is still enforced —
  // now at BOTH layers: the `bundles_approval_self_check` CHECK constraint
  // added this task (02), and this explicit pre-check for a clearer error
  // message than a raw 422 constraint-violation would give.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/bundles/:id/approve", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId, membershipId } = request.tenantContext!;

    const updated = await withAuthedTenantContext(request, async (tx) => {
      const existing = await tx.$queryRawUnsafe<{ registered_by_membership_id: string; approved_by_membership_id: string | null }[]>(
        `SELECT registered_by_membership_id, approved_by_membership_id FROM bundles WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        id,
      );
      if (!existing[0]) return { kind: "not_found" as const };
      if (existing[0].approved_by_membership_id) return { kind: "already_approved" as const };
      if (existing[0].registered_by_membership_id === membershipId) return { kind: "self_approval" as const };

      const rows = await tx.$queryRawUnsafe<BundleRow[]>(
        `UPDATE bundles SET approved_by_membership_id = $3::uuid, approved_at = now()
          WHERE company_id = $1::uuid AND id = $2::uuid AND approved_by_membership_id IS NULL
          RETURNING *`,
        companyId,
        id,
        membershipId,
      );
      return { kind: "ok" as const, row: rows[0]! };
    });

    if (updated.kind === "not_found") throw new NotFoundError("Bundle not found");
    if (updated.kind === "already_approved") throw new ConflictError("Bundle has already been approved");
    if (updated.kind === "self_approval") throw new ConflictError("The approving membership cannot be the same as the registering membership");
    return { bundleId: updated.row.id, approvedByMembershipId: updated.row.approved_by_membership_id, approvedAt: updated.row.approved_at };
  });

  // -------------------------------------------------------------------------
  // POST /api/material-units/:id/release-hold — §2.13 quarantine release.
  // -------------------------------------------------------------------------
  const releaseHoldBody = z.object({ reason: z.string().trim().min(1) });

  app.post<{ Params: { id: string } }>("/api/material-units/:id/release-hold", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const body = releaseHoldBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const releaseId = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ release_hold: string }[]>(
        `SELECT release_hold($1::uuid, $2::uuid, $3::uuid, $4::text)`,
        companyId,
        id,
        membershipId,
        body.reason,
      ),
    ).then((rows) => rows[0]!.release_hold);

    return { materialUnitId: id, releaseId, status: "AVAILABLE" };
  });

  // -------------------------------------------------------------------------
  // POST /api/attachments & GET /api/attachments — §2.19: supporting
  // documents (MTC, weighbridge ticket, delivery note, signed count sheet)
  // linked to the record they evidence. Real file storage isn't wired up
  // (out of scope here) — `storageKey` is an opaque, caller-supplied
  // reference, exactly like the design doc's own placeholder shape (§15).
  // `target_table` is validated against a fixed allow-list by a DB trigger
  // (04) — a bad value surfaces as the trigger's own P0001 message via the
  // shared error mapper, not duplicated here.
  // -------------------------------------------------------------------------
  const attachmentBody = z.object({
    targetTable: z.string().trim().min(1),
    targetRecordId: z.string().uuid(),
    fileName: z.string().trim().min(1),
    mimeType: z.string().trim().min(1),
    fileSizeBytes: z.number().int().positive(),
    storageKey: z.string().trim().min(1),
  });

  app.post("/api/attachments", { preHandler: requireTenantAuth }, async (request) => {
    const b = attachmentBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `INSERT INTO attachments (company_id, target_table, target_record_id, file_name, mime_type, file_size_bytes, storage_key, uploaded_by_membership_id)
         VALUES ($1::uuid, $2::text, $3::uuid, $4::text, $5::text, $6::bigint, $7::text, $8::uuid) RETURNING *`,
        companyId, b.targetTable, b.targetRecordId, b.fileName, b.mimeType, b.fileSizeBytes, b.storageKey, membershipId,
      ),
    );
    return (rows as unknown[])[0];
  });

  const attachmentsQuery = z.object({ targetTable: z.string().trim().min(1), targetRecordId: z.string().uuid() });

  app.get("/api/attachments", { preHandler: requireTenantAuth }, async (request) => {
    const q = attachmentsQuery.parse(request.query);
    const { companyId } = request.tenantContext!;
    return withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT * FROM attachments WHERE company_id = $1::uuid AND target_table = $2::text AND target_record_id = $3::uuid ORDER BY uploaded_at DESC`,
        companyId,
        q.targetTable,
        q.targetRecordId,
      ),
    );
  });
}
