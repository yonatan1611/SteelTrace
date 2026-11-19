import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireTenantAuth, withAuthedTenantContext } from "../auth/middleware";
import { NotFoundError } from "../../api/errors";

const installBody = z.object({
  projectId: z.string().uuid(),
  structuralElementInstanceId: z.string().uuid(),
  reinforcementPurposeId: z.string().uuid(),
  intendedUsageDeclarationId: z.string().uuid().optional(),
  bbsLineId: z.string().uuid().optional(),
  notes: z.string().trim().min(1).optional(),
  materialUnitIds: z.array(z.string().uuid()).min(1),
});

const supersedeBody = installBody.omit({ projectId: true });

/**
 * intendedVsActualMatch: compares this installation's own
 * (structuralElementInstanceId, reinforcementPurposeId) against whichever
 * of intendedUsageDeclarationId/bbsLineId was supplied — never fabricated
 * when neither was given (no intent was ever declared to compare against).
 */
async function computeIntendedVsActualMatch(
  tx: Prisma.TransactionClient,
  companyId: string,
  structuralElementInstanceId: string,
  reinforcementPurposeId: string,
  intendedUsageDeclarationId?: string,
  bbsLineId?: string,
): Promise<boolean | null> {
  if (intendedUsageDeclarationId) {
    const rows = await tx.$queryRawUnsafe<{ structural_element_instance_id: string | null; reinforcement_purpose_id: string }[]>(
      `SELECT structural_element_instance_id, reinforcement_purpose_id FROM intended_usage_declarations WHERE company_id = $1::uuid AND id = $2::uuid`,
      companyId,
      intendedUsageDeclarationId,
    );
    if (!rows[0]) return null;
    return rows[0].structural_element_instance_id === structuralElementInstanceId && rows[0].reinforcement_purpose_id === reinforcementPurposeId;
  }
  if (bbsLineId) {
    const rows = await tx.$queryRawUnsafe<{ structural_element_instance_id: string | null; reinforcement_purpose_id: string }[]>(
      `SELECT structural_element_instance_id, reinforcement_purpose_id FROM bbs_lines WHERE company_id = $1::uuid AND id = $2::uuid`,
      companyId,
      bbsLineId,
    );
    if (!rows[0]) return null;
    return (rows[0].structural_element_instance_id === null || rows[0].structural_element_instance_id === structuralElementInstanceId) &&
      rows[0].reinforcement_purpose_id === reinforcementPurposeId;
  }
  return null;
}

export function registerInstallationRoutes(app: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // POST /api/installations — install_material (§11a/§12). One or more
  // material_unit_ids feed ONE element + ONE purpose — a multi-spec
  // precast cage (PB1/PB2, §2.16) is modeled as several InstallationLine-
  // bearing single-spec installations against the SAME
  // structuralElementInstanceId, never one mixed-spec call.
  // -------------------------------------------------------------------------
  app.post("/api/installations", { preHandler: requireTenantAuth }, async (request) => {
    const b = installBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const installationId = await tx
        .$queryRawUnsafe<{ install_material: string }[]>(
          `SELECT install_material($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::text, $9::uuid[])`,
          companyId, b.projectId, b.structuralElementInstanceId, b.reinforcementPurposeId,
          b.intendedUsageDeclarationId ?? null, b.bbsLineId ?? null, membershipId, b.notes ?? null, b.materialUnitIds,
        )
        .then((rows) => rows[0]!.install_material);

      const intendedVsActualMatch = await computeIntendedVsActualMatch(
        tx, companyId, b.structuralElementInstanceId, b.reinforcementPurposeId, b.intendedUsageDeclarationId, b.bbsLineId,
      );

      return { installationId, intendedVsActualMatch };
    });

    return { installationId: result.installationId, materialUnitIds: b.materialUnitIds, intendedVsActualMatch: result.intendedVsActualMatch };
  });

  // -------------------------------------------------------------------------
  // POST /api/installations/:id/supersede — audited corrections (§11a).
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/installations/:id/supersede", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const b = supersedeBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const newInstallationId = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe<{ supersede_installation: string }[]>(
        `SELECT supersede_installation($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::text, $9::uuid[])`,
        companyId, id, b.structuralElementInstanceId, b.reinforcementPurposeId,
        b.intendedUsageDeclarationId ?? null, b.bbsLineId ?? null, membershipId, b.notes ?? null, b.materialUnitIds,
      ),
    ).then((rows) => rows[0]!.supersede_installation);

    return { supersededInstallationId: id, newInstallationId };
  });

  // -------------------------------------------------------------------------
  // POST /api/installations/:id/verify — site QC sign-off (§11a).
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/installations/:id/verify", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId, membershipId } = request.tenantContext!;
    await withAuthedTenantContext(request, (tx) =>
      tx.$executeRawUnsafe(`SELECT record_approval($1::uuid, 'installations'::text, $2::uuid, $3::uuid)`, companyId, id, membershipId),
    );
    return { installationId: id, verified: true };
  });

  // -------------------------------------------------------------------------
  // GET /api/installations & GET /api/installations/:id — with linked
  // structural element, location hierarchy path, purpose, and source
  // unit origins.
  // -------------------------------------------------------------------------
  async function locationPath(tx: Prisma.TransactionClient, companyId: string, locationNodeId: string | null): Promise<string[]> {
    const path: string[] = [];
    let current = locationNodeId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const rows = await tx.$queryRawUnsafe<{ name: string; parent_id: string | null }[]>(
        `SELECT name, parent_id FROM location_nodes WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        current,
      );
      if (!rows[0]) break;
      path.unshift(rows[0].name);
      current = rows[0].parent_id;
    }
    return path;
  }

  app.get("/api/installations", { preHandler: requireTenantAuth }, async (request) => {
    const { companyId } = request.tenantContext!;
    return withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(`SELECT * FROM installations WHERE company_id = $1::uuid ORDER BY installed_at DESC`, companyId),
    );
  });

  app.get<{ Params: { id: string } }>("/api/installations/:id", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        { id: string; structural_element_instance_id: string; reinforcement_purpose_id: string; [k: string]: unknown }[]
      >(`SELECT * FROM installations WHERE company_id = $1::uuid AND id = $2::uuid`, companyId, id);
      if (!rows[0]) return null;
      const installation = rows[0];

      const elementRows = await tx.$queryRawUnsafe<{ reference_code: string; location_node_id: string; structural_element_type_id: string }[]>(
        `SELECT reference_code, location_node_id, structural_element_type_id FROM structural_element_instances WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        installation.structural_element_instance_id,
      );
      const purposeRows = await tx.$queryRawUnsafe<{ name: string }[]>(
        `SELECT name FROM reinforcement_purposes WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        installation.reinforcement_purpose_id,
      );
      const lines = await tx.$queryRawUnsafe<{ material_unit_id: string }[]>(
        `SELECT material_unit_id FROM installation_lines WHERE company_id = $1::uuid AND installation_id = $2::uuid`,
        companyId,
        id,
      );

      const path = elementRows[0] ? await locationPath(tx, companyId, elementRows[0].location_node_id) : [];

      // Sequential — shared tx, never Promise.all.
      const sourceUnits: Record<string, unknown>[] = [];
      for (const line of lines) {
        const origins = await tx.$queryRawUnsafe(
          `SELECT bundle_id, confidence, contribution_weight FROM material_unit_origins WHERE company_id = $1::uuid AND material_unit_id = $2::uuid`,
          companyId,
          line.material_unit_id,
        );
        sourceUnits.push({ materialUnitId: line.material_unit_id, origins });
      }

      return {
        ...installation,
        structuralElementReferenceCode: elementRows[0]?.reference_code ?? null,
        reinforcementPurposeName: purposeRows[0]?.name ?? null,
        locationPath: path,
        sourceUnits,
      };
    });

    if (!result) throw new NotFoundError("Installation not found");
    return result;
  });
}
