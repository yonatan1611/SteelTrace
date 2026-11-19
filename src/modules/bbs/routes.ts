import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { requireTenantAuth, withAuthedTenantContext } from "../auth/middleware";
import { BadRequestError, NotFoundError } from "../../api/errors";
import { parseBbsWorkbook, type ParsedBbsRow } from "./excelImport";

const shapeCodeBody = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  activeDimensions: z.array(z.string().trim().min(1)).default([]),
});

const bbsLineInput = z.object({
  structuralElementTypeId: z.string().uuid().optional(),
  structuralElementInstanceId: z.string().uuid().optional(),
  locationNodeId: z.string().uuid().optional(),
  reinforcementPurposeId: z.string().uuid(),
  barMark: z.string().trim().min(1),
  diameterMm: z.number().positive(),
  surfaceType: z.enum(["DEFORMED", "PLAIN"]).default("DEFORMED"),
  grade: z.string().trim().min(1),
  shapeCodeId: z.string().uuid(),
  dimAMm: z.number().optional(),
  dimBMm: z.number().optional(),
  dimCMm: z.number().optional(),
  dimDMm: z.number().optional(),
  dimEMm: z.number().optional(),
  dimRMm: z.number().optional(),
  cutLengthM: z.number().positive(),
  barsPerMember: z.number().int().positive(),
  memberCount: z.number().int().positive(),
});

const createBbsBody = z.object({
  projectId: z.string().uuid(),
  referenceCode: z.string().trim().min(1),
  drawingNumber: z.string().trim().min(1).optional(),
  drawingRevision: z.string().trim().min(1).optional(),
  wastageAllowancePct: z.number().optional(),
  lines: z.array(bbsLineInput).default([]),
});

async function insertBbsLine(
  tx: Prisma.TransactionClient,
  companyId: string,
  bbsScheduleId: string,
  l: z.infer<typeof bbsLineInput>,
): Promise<unknown> {
  if (!l.structuralElementTypeId && !l.structuralElementInstanceId) {
    throw new BadRequestError(`bbs line "${l.barMark}" needs structuralElementTypeId and/or structuralElementInstanceId`);
  }
  const totalBarsRequired = l.barsPerMember * l.memberCount;
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO bbs_lines (
       company_id, bbs_schedule_id, structural_element_type_id, structural_element_instance_id, location_node_id,
       reinforcement_purpose_id, bar_mark, diameter_mm, surface_type, grade_normalized, shape_code_id,
       dim_a_mm, dim_b_mm, dim_c_mm, dim_d_mm, dim_e_mm, dim_r_mm,
       cut_length_m, bars_per_member, member_count, total_bars_required
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       $6::uuid, $7::text, $8::numeric, $9::rebar_surface_type_enum, upper(trim($10::text)), $11::uuid,
       $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16::numeric, $17::numeric,
       $18::numeric, $19::integer, $20::integer, $21::integer
     ) RETURNING *`,
    companyId, bbsScheduleId, l.structuralElementTypeId ?? null, l.structuralElementInstanceId ?? null, l.locationNodeId ?? null,
    l.reinforcementPurposeId, l.barMark, l.diameterMm, l.surfaceType, l.grade, l.shapeCodeId,
    l.dimAMm ?? null, l.dimBMm ?? null, l.dimCMm ?? null, l.dimDMm ?? null, l.dimEMm ?? null, l.dimRMm ?? null,
    l.cutLengthM, l.barsPerMember, l.memberCount, totalBarsRequired,
  );
  return (rows as unknown[])[0];
}

export function registerBbsRoutes(app: FastifyInstance): void {
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // ---------------------------------------------------------------------
  // shape_codes (§2.16) — company-scoped configurable master data.
  // ---------------------------------------------------------------------
  app.get("/api/shape-codes", { preHandler: requireTenantAuth }, async (request) => {
    const { companyId } = request.tenantContext!;
    return withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(`SELECT * FROM shape_codes WHERE company_id = $1::uuid ORDER BY code`, companyId),
    );
  });

  app.post("/api/shape-codes", { preHandler: requireTenantAuth }, async (request) => {
    const b = shapeCodeBody.parse(request.body);
    const { companyId } = request.tenantContext!;
    const rows = await withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(
        `INSERT INTO shape_codes (company_id, code, name, active_dimensions, is_active)
         VALUES ($1::uuid, $2::text, $3::text, $4::text[], true) RETURNING *`,
        companyId, b.code, b.name, b.activeDimensions,
      ),
    );
    return (rows as unknown[])[0];
  });

  // ---------------------------------------------------------------------
  // bbs_schedules / bbs_lines
  // ---------------------------------------------------------------------
  app.post("/api/bbs", { preHandler: requireTenantAuth }, async (request) => {
    const b = createBbsBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const schedule = await withAuthedTenantContext(request, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO bbs_schedules (company_id, project_id, reference_code, drawing_number, drawing_revision, wastage_allowance_pct, status, prepared_by_membership_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::numeric, 'ACTIVE', $7::uuid, now())
         RETURNING id`,
        companyId, b.projectId, b.referenceCode, b.drawingNumber ?? null, b.drawingRevision ?? null, b.wastageAllowancePct ?? null, membershipId,
      );
      const scheduleId = rows[0]!.id;
      for (const line of b.lines) {
        await insertBbsLine(tx, companyId, scheduleId, line);
      }
      return { id: scheduleId };
    });

    return { bbsScheduleId: schedule.id, lineCount: b.lines.length };
  });

  app.get("/api/bbs", { preHandler: requireTenantAuth }, async (request) => {
    const { companyId } = request.tenantContext!;
    return withAuthedTenantContext(request, (tx) =>
      tx.$queryRawUnsafe(`SELECT * FROM bbs_schedules WHERE company_id = $1::uuid ORDER BY created_at DESC`, companyId),
    );
  });

  app.get<{ Params: { id: string } }>("/api/bbs/:id", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId } = request.tenantContext!;
    const result = await withAuthedTenantContext(request, async (tx) => {
      const scheduleRows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM bbs_schedules WHERE company_id = $1::uuid AND id = $2::uuid`,
        companyId,
        id,
      );
      if (!scheduleRows[0]) return null;
      const lines = await tx.$queryRawUnsafe(`SELECT * FROM bbs_lines WHERE company_id = $1::uuid AND bbs_schedule_id = $2::uuid ORDER BY bar_mark`, companyId, id);
      return { ...scheduleRows[0], lines };
    });
    if (!result) throw new NotFoundError("BBS schedule not found");
    return result;
  });

  app.post<{ Params: { id: string } }>("/api/bbs/:id/approve", { preHandler: requireTenantAuth }, async (request) => {
    const id = z.string().uuid().parse(request.params.id);
    const { companyId, membershipId } = request.tenantContext!;
    await withAuthedTenantContext(request, (tx) =>
      tx.$executeRawUnsafe(`SELECT record_approval($1::uuid, 'bbs_schedules'::text, $2::uuid, $3::uuid)`, companyId, id, membershipId),
    );
    return { bbsScheduleId: id, approved: true };
  });

  // ---------------------------------------------------------------------
  // POST /api/bbs/import — multipart Excel import, §2.16. Accepts a
  // "file" part plus the same metadata a manual POST /api/bbs would need
  // (projectId, referenceCode), and fallback fields Format B's columns
  // never carry at all (grade/shapeCode/reinforcement purpose) — see
  // excelImport.ts's module doc for why those can't be inferred from the
  // sheet alone. Resolves each row's structural element / reinforcement
  // purpose / shape code to existing company master data; rows that name
  // something unresolvable are reported as row-level errors and skipped,
  // never silently dropped or guessed.
  // ---------------------------------------------------------------------
  const importFields = z.object({
    projectId: z.string().uuid(),
    referenceCode: z.string().trim().min(1),
    defaultGrade: z.string().trim().min(1).optional(),
    defaultShapeCodeCode: z.string().trim().min(1).optional(),
    stirrupShapeCodeCode: z.string().trim().min(1).optional(),
    defaultReinforcementPurposeId: z.string().uuid().optional(),
    stirrupReinforcementPurposeName: z.string().trim().min(1).default("Stirrups / Shear Links"),
  });

  app.post("/api/bbs/import", { preHandler: requireTenantAuth }, async (request) => {
    const parts = request.parts();
    let fileBuffer: Buffer | null = null;
    const fields: Record<string, string> = {};
    for await (const part of parts) {
      if (part.type === "file") {
        fileBuffer = await part.toBuffer();
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (!fileBuffer) {
      throw new BadRequestError("No file uploaded (expected a multipart 'file' field)");
    }

    const f = importFields.parse({
      ...fields,
      // multipart text fields always decode as strings; numeric-looking
      // optional fields here are all uuid/string, so no coercion needed.
    });

    let parsed;
    try {
      parsed = await parseBbsWorkbook(fileBuffer);
    } catch (err) {
      throw new BadRequestError(`Could not parse workbook: ${err instanceof Error ? err.message : String(err)}`);
    }

    const { companyId, membershipId } = request.tenantContext!;

    const result = await withAuthedTenantContext(request, async (tx) => {
      const scheduleRows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO bbs_schedules (company_id, project_id, reference_code, drawing_number, drawing_revision, status, prepared_by_membership_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, 'ACTIVE', $6::uuid, now())
         RETURNING id`,
        companyId,
        f.projectId,
        f.referenceCode,
        parsed.rows[0]?.drawingNumber ?? null,
        parsed.rows[0]?.drawingRevision ?? null,
        membershipId,
      );
      const scheduleId = scheduleRows[0]!.id;

      // Caches avoid re-querying the same lookup for every row of a large sheet.
      const structuralElementTypeCache = new Map<string, string>();
      const shapeCodeCache = new Map<string, string | null>();
      const reinforcementPurposeCache = new Map<string, string>();

      async function resolveStructuralElementType(name: string | null): Promise<string | null> {
        if (!name) return null;
        const key = name.trim().toLowerCase();
        if (structuralElementTypeCache.has(key)) return structuralElementTypeCache.get(key)!;
        const existing = await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM structural_element_types WHERE company_id = $1::uuid AND lower(name) = $2::text`,
          companyId,
          key,
        );
        let id: string;
        if (existing[0]) {
          id = existing[0].id;
        } else {
          const created = await tx.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO structural_element_types (company_id, name, is_active) VALUES ($1::uuid, $2::text, true) RETURNING id`,
            companyId,
            name.trim(),
          );
          id = created[0]!.id;
        }
        structuralElementTypeCache.set(key, id);
        return id;
      }

      async function resolveReinforcementPurpose(name: string): Promise<string> {
        const key = name.trim().toLowerCase();
        if (reinforcementPurposeCache.has(key)) return reinforcementPurposeCache.get(key)!;
        const existing = await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM reinforcement_purposes WHERE company_id = $1::uuid AND lower(name) = $2::text`,
          companyId,
          key,
        );
        let id: string;
        if (existing[0]) {
          id = existing[0].id;
        } else {
          const created = await tx.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO reinforcement_purposes (company_id, name, is_active) VALUES ($1::uuid, $2::text, true) RETURNING id`,
            companyId,
            name.trim(),
          );
          id = created[0]!.id;
        }
        reinforcementPurposeCache.set(key, id);
        return id;
      }

      async function resolveShapeCode(code: string | null): Promise<string | null> {
        if (!code) return null;
        const key = code.trim().toLowerCase();
        if (shapeCodeCache.has(key)) return shapeCodeCache.get(key)!;
        const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM shape_codes WHERE company_id = $1::uuid AND lower(code) = $2::text`,
          companyId,
          key,
        );
        const id = rows[0]?.id ?? null;
        shapeCodeCache.set(key, id);
        return id;
      }

      const importErrors: string[] = parsed.rowErrors.map((e) => e.message);
      let insertedCount = 0;

      async function processRow(row: ParsedBbsRow): Promise<void> {
        const purposeName = row.looksLikeStirrup ? f.stirrupReinforcementPurposeName : null;
        let reinforcementPurposeId: string;
        if (purposeName) {
          reinforcementPurposeId = await resolveReinforcementPurpose(purposeName);
        } else if (f.defaultReinforcementPurposeId) {
          reinforcementPurposeId = f.defaultReinforcementPurposeId;
        } else {
          importErrors.push(`Row ${row.rowNumber} ("${row.barMark}"): no reinforcement purpose column and no defaultReinforcementPurposeId supplied`);
          return;
        }

        const shapeCodeText = row.shapeCode ?? (row.looksLikeStirrup ? f.stirrupShapeCodeCode : f.defaultShapeCodeCode) ?? null;
        const shapeCodeId = await resolveShapeCode(shapeCodeText);
        if (!shapeCodeId) {
          importErrors.push(`Row ${row.rowNumber} ("${row.barMark}"): shape code "${shapeCodeText ?? "(none)"}" could not be resolved to an existing shape_codes row`);
          return;
        }

        const grade = row.grade ?? f.defaultGrade ?? null;
        if (!grade) {
          importErrors.push(`Row ${row.rowNumber} ("${row.barMark}"): sheet has no Grade column and no defaultGrade supplied`);
          return;
        }

        const structuralElementTypeId = await resolveStructuralElementType(row.structuralElementText);

        await insertBbsLine(tx, companyId, scheduleId, {
          structuralElementTypeId: structuralElementTypeId ?? undefined,
          reinforcementPurposeId,
          barMark: row.barMark,
          diameterMm: row.diameterMm,
          surfaceType: "DEFORMED",
          grade,
          shapeCodeId,
          dimAMm: row.dimAMm ?? undefined,
          dimBMm: row.dimBMm ?? undefined,
          dimCMm: row.dimCMm ?? undefined,
          dimDMm: row.dimDMm ?? undefined,
          cutLengthM: row.cutLengthM,
          barsPerMember: row.barsPerMember,
          memberCount: row.memberCount,
        });
        insertedCount += 1;
      }

      // Sequential — one shared `tx`, never Promise.all (Task 5's lesson).
      for (const row of parsed.rows) {
        await processRow(row);
      }

      return { scheduleId, insertedCount, importErrors };
    });

    return {
      bbsScheduleId: result.scheduleId,
      format: parsed.format,
      linesImported: result.insertedCount,
      rowErrors: result.importErrors,
      warnings: parsed.warnings,
    };
  });
}
