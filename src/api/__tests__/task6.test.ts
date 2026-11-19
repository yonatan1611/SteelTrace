process.env.NODE_ENV = "test";

import { randomUUID, randomBytes } from "node:crypto";
import type { FastifyInstance, HTTPMethods, InjectOptions } from "fastify";
import ExcelJS from "exceljs";
import { buildServer } from "../server";
import { createExecutor, type SqlExecutor } from "../../db/bootstrapSql";
import { cleanupTestCompanies, deleteTestUsers } from "../../db/testCleanup";
import { hashPassword } from "../../modules/auth/password";

// ---------------------------------------------------------------------------
// Minimal test harness — identical style to task5.test.ts.
// ---------------------------------------------------------------------------
interface TestResult {
  name: string;
  ok: boolean;
  error?: string;
}
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, error: message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${message}`);
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Call<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(
  app: FastifyInstance,
  method: HTTPMethods,
  url: string,
  opts: { token?: string; payload?: Record<string, unknown>; query?: Record<string, string> } = {},
): Promise<Call<T>> {
  const injectOptions: InjectOptions = { method, url };
  if (opts.query) injectOptions.query = opts.query;
  if (opts.payload) injectOptions.payload = opts.payload;
  if (opts.token) injectOptions.headers = { authorization: `Bearer ${opts.token}` };
  const res = await app.inject(injectOptions);
  let body: T;
  try {
    body = res.json();
  } catch {
    body = res.body as unknown as T;
  }
  return { status: res.statusCode, body };
}

/** Builds a raw multipart/form-data body for POST /api/bbs/import (light-my-request has no form helper of its own). */
function buildMultipartBody(fields: Record<string, string>, file: { filename: string; contentType: string; buffer: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----SteelTraceTestBoundary${randomBytes(8).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, "utf8"),
  );
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function callMultipart<T = any>(
  app: FastifyInstance,
  url: string,
  token: string,
  fields: Record<string, string>,
  file: { filename: string; contentType: string; buffer: Buffer },
): Promise<Call<T>> {
  const { body, contentType } = buildMultipartBody(fields, file);
  const res = await app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}`, "content-type": contentType },
    payload: body,
  });
  let parsed: T;
  try {
    parsed = res.json();
  } catch {
    parsed = res.body as unknown as T;
  }
  return { status: res.statusCode, body: parsed };
}

// ---------------------------------------------------------------------------
// Synthetic BBS workbooks — matching the two client column layouts exactly
// (no real sample files exist in this codebase; see excelImport.ts's own
// doc comment), plus one deliberately-anomalous wastage row.
// ---------------------------------------------------------------------------
async function buildFormatAWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("BBS");
  sheet.addRow([
    "Drawing No.", "Revision", "Structural Element", "Level/Grid", "BBS Mark",
    "Bar Dia (mm)", "Grade", "Shape Code", "A", "B", "C", "D",
    "Cut Length (m)", "No. Bars Required",
  ]);
  sheet.addRow(["DWG-100", "A", "Column", "L2", "MAIN-01", 12, "B500BWR", "00", 100, 200, null, null, 3.0, 10]);
  sheet.addRow(["DWG-100", "A", "Column", "L2", "st1", 8, "B500BWR", "51", 150, 150, null, null, 1.2, 20]);
  // Deliberate anomaly: label says 5% (-> expected multiplier 1.05), but the
  // applied figure elsewhere on the same row is 1.25 (25%).
  sheet.addRow(["Note: Add 5% wastage allowance", null, null, null, null, null, null, null, null, 1.25, null, null, null, null]);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function buildFormatBWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Takeoff");
  sheet.addRow(["Drg.No", "Location", "Ref No", "Dia", "Length", "No of bar", "No of member"]);
  sheet.addRow(["MOR-01", "Beam B1", "B1-MAIN", 14, 4.5, 6, 2]);
  sheet.addRow(["MOR-01", "Beam B1", "st-a", 8, 1.0, 10, 2]);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ---------------------------------------------------------------------------
// Isolated test-tenant bootstrap — raw SQL, not through the HTTP API (see
// task5.test.ts's identical rationale: fixture setup, not the thing under
// test; never reuses seed.ts's shared global users).
// ---------------------------------------------------------------------------
interface TestCompany {
  companyId: string;
  roleId: string;
  projectId: string;
  warehouseLocId: string;
  workshopLocId: string;
  structuralElementTypeId: string;
  mainPurposeId: string;
  cuttingOpTypeId: string;
  columnInstanceId: string;
  adminEmail: string;
  adminPassword: string;
  adminUserId: string;
  checkerEmail: string;
  checkerPassword: string;
  checkerUserId: string;
}

async function bootstrapCompany(executor: SqlExecutor, label: string): Promise<TestCompany> {
  const companyId = randomUUID();
  const roleId = randomUUID();
  const projectId = randomUUID();
  const warehouseLocId = randomUUID();
  const workshopLocId = randomUUID();
  const structuralElementTypeId = randomUUID();
  const mainPurposeId = randomUUID();
  const cuttingOpTypeId = randomUUID();
  const locationNodeTypeId = randomUUID();
  const locationNodeId = randomUUID();
  const columnInstanceId = randomUUID();
  const catalogItemId = randomUUID();

  const adminUserId = randomUUID();
  const adminMembershipId = randomUUID();
  const checkerUserId = randomUUID();
  const checkerMembershipId = randomUUID();
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@test.steeltrace`;
  const checkerEmail = `checker-${randomUUID().slice(0, 8)}@test.steeltrace`;
  const adminPassword = "AdminPass123!";
  const checkerPassword = "CheckerPass123!";

  await executor.run((tx) => tx.query(`INSERT INTO companies (id, name) VALUES ($1, $2)`, [companyId, label]));

  await executor.runAs({ role: "steeltrace_app", companyId }, async (tx) => {
    await tx.query(`INSERT INTO roles (id, company_id, name) VALUES ($1,$2,'Company Admin')`, [roleId, companyId]);
    await tx.query(`INSERT INTO projects (id, company_id, name) VALUES ($1,$2,'Test Project')`, [projectId, companyId]);
    await tx.query(`INSERT INTO storage_locations (id, company_id, location_type, name) VALUES ($1,$2,'WAREHOUSE','Test Warehouse')`, [warehouseLocId, companyId]);
    await tx.query(`INSERT INTO storage_locations (id, company_id, location_type, name) VALUES ($1,$2,'PROCESSING_AREA','Test Workshop')`, [workshopLocId, companyId]);
    await tx.query(`INSERT INTO structural_element_types (id, company_id, name, is_active) VALUES ($1,$2,'Column',true)`, [structuralElementTypeId, companyId]);
    await tx.query(`INSERT INTO reinforcement_purposes (id, company_id, name, is_active) VALUES ($1,$2,'Main Longitudinal Reinforcement',true)`, [
      mainPurposeId,
      companyId,
    ]);
    await tx.query(`INSERT INTO processing_operation_types (id, company_id, name, requires_uniform_input_spec, is_active) VALUES ($1,$2,'Cutting',true,true)`, [
      cuttingOpTypeId,
      companyId,
    ]);
    await tx.query(`INSERT INTO location_node_types (id, company_id, name) VALUES ($1,$2,'Building')`, [locationNodeTypeId, companyId]);
    await tx.query(`INSERT INTO location_nodes (id, company_id, project_id, location_node_type_id, name) VALUES ($1,$2,$3,$4,'Building A')`, [
      locationNodeId,
      companyId,
      projectId,
      locationNodeTypeId,
    ]);
    await tx.query(
      `INSERT INTO structural_element_instances (id, company_id, project_id, structural_element_type_id, location_node_id, reference_code)
       VALUES ($1,$2,$3,$4,$5,'Column C-12')`,
      [columnInstanceId, companyId, projectId, structuralElementTypeId, locationNodeId],
    );
    // reorder_threshold_mt set absurdly high so this tiny test tenant's
    // stock always trips the alert — exercises GET /api/reports/kpis'
    // reorderAlerts path deterministically.
    await tx.query(
      `INSERT INTO rebar_catalog_items (id, company_id, item_code, diameter_mm, surface_type, default_grade, linear_density_kg_per_m, reorder_threshold_mt, is_active)
       VALUES ($1,$2,'RB-12-TEST',12,'DEFORMED','B500BWR',0.888,1000,true)`,
      [catalogItemId, companyId],
    );
  });

  const adminPasswordHash = await hashPassword(adminPassword);
  const checkerPasswordHash = await hashPassword(checkerPassword);
  await executor.runAs({ role: "steeltrace_identity_service", companyId }, async (tx) => {
    await tx.query(`INSERT INTO users (id, email, display_name, auth_provider, password_hash, is_active) VALUES ($1,$2,$3,'password',$4,true)`, [
      adminUserId,
      adminEmail,
      "Test Admin",
      adminPasswordHash,
    ]);
    await tx.query(`INSERT INTO company_memberships (id, company_id, user_id, role_id, is_active) VALUES ($1,$2,$3,$4,true)`, [
      adminMembershipId,
      companyId,
      adminUserId,
      roleId,
    ]);
    await tx.query(`INSERT INTO users (id, email, display_name, auth_provider, password_hash, is_active) VALUES ($1,$2,$3,'password',$4,true)`, [
      checkerUserId,
      checkerEmail,
      "Test Checker",
      checkerPasswordHash,
    ]);
    await tx.query(`INSERT INTO company_memberships (id, company_id, user_id, role_id, is_active) VALUES ($1,$2,$3,$4,true)`, [
      checkerMembershipId,
      companyId,
      checkerUserId,
      roleId,
    ]);
  });

  return {
    companyId, roleId, projectId, warehouseLocId, workshopLocId, structuralElementTypeId, mainPurposeId, cuttingOpTypeId, columnInstanceId,
    adminEmail, adminPassword, adminUserId, checkerEmail, checkerPassword, checkerUserId,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const executor = await createExecutor();
  const app = buildServer();
  await app.ready();

  const companiesToClean: string[] = [];
  const usersToClean: string[] = [];

  console.log("Bootstrapping isolated test tenant...");
  const t = await bootstrapCompany(executor, `Task6 Test Co ${randomUUID().slice(0, 8)}`);
  companiesToClean.push(t.companyId);
  usersToClean.push(t.adminUserId, t.checkerUserId);
  console.log(`Company: ${t.companyId}\n`);

  let adminToken = "";
  let checkerToken = "";
  let shapeCodeStraightId = "";
  let shapeCodeStirrupId = "";
  let bundleAUnitId = "";
  let bundleBUnitId = "";
  let bundleCUnitId = "";
  let outputXId = "";
  let outputYId = "";
  let outputZId = "";
  let op1Id = "";
  let reclassOffcutEventId = "";
  let remnantUnitId = "";
  let bundleDUnitId = "";
  let bundleEUnitId = "";
  let d1Id = "";
  let d2Id = "";
  let bundleDId = "";
  let installationId = "";
  let intendedUsageId = "";
  let countId = "";
  let countLineId = "";

  try {
    const login = async (email: string, password: string): Promise<string> => {
      const res = await call(app, "POST", "/api/auth/login", { payload: { email, password } });
      assertEqual(res.status, 200, `login status for ${email}`);
      return res.body.token;
    };
    adminToken = await login(t.adminEmail, t.adminPassword);
    checkerToken = await login(t.checkerEmail, t.checkerPassword);

    // =======================================================================
    console.log("1. Shape codes, BBS schedule, and Excel import (Format A & B)");
    // =======================================================================
    await test("create shape codes", async () => {
      const straight = await call(app, "POST", "/api/shape-codes", { token: adminToken, payload: { code: "00", name: "Straight", activeDimensions: [] } });
      assertEqual(straight.status, 200, "straight shape code create status");
      shapeCodeStraightId = straight.body.id;

      const stirrup = await call(app, "POST", "/api/shape-codes", {
        token: adminToken,
        payload: { code: "51", name: "Closed Stirrup", activeDimensions: ["a", "b"] },
      });
      assertEqual(stirrup.status, 200, "stirrup shape code create status");
      shapeCodeStirrupId = stirrup.body.id;
    });

    await test("import Format A workbook, detecting the wastage anomaly", async () => {
      const buf = await buildFormatAWorkbook();
      const res = await callMultipart(app, "/api/bbs/import", adminToken, {
        projectId: t.projectId,
        referenceCode: `BBS-A-${randomUUID().slice(0, 8)}`,
        defaultReinforcementPurposeId: t.mainPurposeId,
        stirrupShapeCodeCode: "51",
      }, { filename: "format-a.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: buf });

      assertEqual(res.status, 200, "Format A import status");
      assertEqual(res.body.format, "A", "detected format");
      assertEqual(res.body.linesImported, 2, "Format A lines imported (2 real rows, note row skipped)");
      assertEqual(res.body.rowErrors.length, 0, "Format A row errors");
      assert(res.body.warnings.length >= 1, "Format A should surface the wastage anomaly warning");
      assert(res.body.warnings[0].includes("1.05") && res.body.warnings[0].includes("1.25"), `warning should name both multipliers: ${res.body.warnings[0]}`);
    });

    await test("import Format B workbook (inline stirrup-mark mapping, no grade/shape columns)", async () => {
      const buf = await buildFormatBWorkbook();
      const res = await callMultipart(app, "/api/bbs/import", adminToken, {
        projectId: t.projectId,
        referenceCode: `BBS-B-${randomUUID().slice(0, 8)}`,
        defaultGrade: "B500BWR",
        defaultShapeCodeCode: "00",
        stirrupShapeCodeCode: "51",
        defaultReinforcementPurposeId: t.mainPurposeId,
      }, { filename: "format-b.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: buf });

      assertEqual(res.status, 200, "Format B import status");
      assertEqual(res.body.format, "B", "detected format");
      assertEqual(res.body.linesImported, 2, "Format B lines imported");
      assertEqual(res.body.rowErrors.length, 0, "Format B row errors");

      const schedule = await call(app, "GET", `/api/bbs/${res.body.bbsScheduleId}`, { token: adminToken });
      assertEqual(schedule.status, 200, "fetch imported Format B schedule");
      const stirrupLine = (schedule.body.lines as any[]).find((l) => l.bar_mark === "st-a");
      assert(stirrupLine !== undefined, "stirrup-marked line was imported");
      assertEqual(stirrupLine.total_bars_required, 20, "Format B total_bars_required = bars_per_member * member_count (10*2)");
    });

    // =======================================================================
    console.log("\n2. Intended usage, multi-bundle processing (EXACT/KNOWN_PARTIAL/POOLED), finalize, workshop check");
    // =======================================================================
    async function registerBundle(diameterMm: number, barLengthM: number, storageLocationId: string): Promise<{ bundleId: string; rootMaterialUnitId: string }> {
      const res = await call(app, "POST", "/api/bundles", {
        token: adminToken,
        payload: {
          storageLocationId,
          projectId: t.projectId,
          internalReferenceCode: `TEST-BND-${randomUUID().slice(0, 8)}`,
          diameterMm,
          grade: "B500BWR",
          // A NULL standard makes spec_compare return UNKNOWN (never
          // CONFIRMED_MATCH, §8's three-valued policy) — every bundle
          // this suite registers must share a real standard so the
          // multi-bundle processing operation below is actually
          // spec-compatible, not accidentally rejected the way Task 4's
          // own test 5(b) deliberately exercises.
          standard: "ES ISO 6935-2:2011",
          pieceCount: 1,
          barLengthM,
          surfaceType: "DEFORMED",
          originType: "GRN_PURCHASE",
          grnReference: "GRN-TEST",
          initialDisposition: "ACCEPTED",
        },
      });
      assertEqual(res.status, 200, "bundle registration status");
      return { bundleId: res.body.bundleId, rootMaterialUnitId: res.body.rootMaterialUnitId };
    }

    await test("register 3 compatible bundles directly at the workshop", async () => {
      const a = await registerBundle(12, 12, t.workshopLocId);
      const b = await registerBundle(12, 12, t.workshopLocId);
      const c = await registerBundle(12, 12, t.workshopLocId);
      bundleAUnitId = a.rootMaterialUnitId;
      bundleBUnitId = b.rootMaterialUnitId;
      bundleCUnitId = c.rootMaterialUnitId;
    });

    await test("intended usage declaration", async () => {
      const res = await call(app, "POST", "/api/intended-usage", {
        token: adminToken,
        payload: { structuralElementTypeId: t.structuralElementTypeId, reinforcementPurposeId: t.mainPurposeId },
      });
      assertEqual(res.status, 200, "intended usage create status");
      intendedUsageId = res.body.id;
    });

    await test("multi-bundle processing operation: KNOWN_PARTIAL{A,B}, EXACT{C}, POOLED{A,B,C}, summing exactly to inputs", async () => {
      const res = await call(app, "POST", "/api/processing-operations", {
        token: adminToken,
        payload: {
          projectId: t.projectId,
          referenceCode: `ST-PROC-${randomUUID().slice(0, 8)}`,
          operationTypeId: t.cuttingOpTypeId,
          storageLocationId: t.workshopLocId,
          inputs: [
            { materialUnitId: bundleAUnitId, quantityConsumedPieces: 1, lengthConsumedM: 12 },
            { materialUnitId: bundleBUnitId, quantityConsumedPieces: 1, lengthConsumedM: 12 },
            { materialUnitId: bundleCUnitId, quantityConsumedPieces: 1, lengthConsumedM: 12 },
          ],
          outputs: [
            { attributionMode: "KNOWN_PARTIAL", quantityPieces: 1, totalLengthM: 20, sources: [{ sourceInputMaterialUnitId: bundleAUnitId }, { sourceInputMaterialUnitId: bundleBUnitId }] },
            { attributionMode: "EXACT", quantityPieces: 1, totalLengthM: 10, sources: [{ sourceInputMaterialUnitId: bundleCUnitId, contributionWeight: 1 }] },
            { attributionMode: "POOLED", quantityPieces: 1, totalLengthM: 6 },
          ],
        },
      });
      assertEqual(res.status, 200, "processing operation create status");
      op1Id = res.body.operationId;
      assertEqual(res.body.outputs.length, 3, "three outputs returned");
      outputXId = res.body.outputs[0].materialUnitId;
      outputYId = res.body.outputs[1].materialUnitId;
      outputZId = res.body.outputs[2].materialUnitId;

      const detail = await call(app, "GET", `/api/processing-operations/${op1Id}`, { token: adminToken });
      assertEqual(detail.status, 200, "operation detail status");
      assertEqual(detail.body.reconciliation_status, "BALANCED", "36m in = 20+10+6=36m out, exactly balanced");
    });

    await test("finalize operation, then workshop checker sign-off (maker != checker)", async () => {
      const finalize = await call(app, "POST", `/api/processing-operations/${op1Id}/finalize`, { token: adminToken });
      assertEqual(finalize.status, 200, "finalize status");

      const selfCheck = await call(app, "POST", `/api/processing-operations/${op1Id}/check`, { token: adminToken });
      assertEqual(selfCheck.status, 400, "self-check (maker=checker) must be rejected");

      const check = await call(app, "POST", `/api/processing-operations/${op1Id}/check`, { token: checkerToken });
      assertEqual(check.status, 200, "workshop checker sign-off status");
    });

    // =======================================================================
    console.log("\n3. Reclassification, QR tagging, remnant-first matching, and reuse");
    // =======================================================================
    await test("reclassify outputs: X->PREPARED, Y->OFFCUT (tagged ST-REM), Z->SCRAP", async () => {
      const px = await call(app, "POST", `/api/material-units/${outputXId}/reclassify`, {
        token: adminToken,
        payload: { toClassification: "PREPARED", reason: "ready for use" },
      });
      assertEqual(px.status, 200, "X -> PREPARED status");

      const py = await call(app, "POST", `/api/material-units/${outputYId}/reclassify`, {
        token: adminToken,
        payload: { toClassification: "OFFCUT", reason: "reusable remnant", internalReferenceCode: "ST-REM-0001" },
      });
      assertEqual(py.status, 200, "Y -> OFFCUT status");
      assertEqual(py.body.internalReferenceCode, "ST-REM-0001", "remnant tagged with human-readable code");
      reclassOffcutEventId = py.body.reclassificationEventId;

      const pz = await call(app, "POST", `/api/material-units/${outputZId}/reclassify`, {
        token: adminToken,
        payload: { toClassification: "SCRAP", reason: "trim waste" },
      });
      assertEqual(pz.status, 200, "Z -> SCRAP status");
    });

    await test("QR code for the tagged remnant", async () => {
      const qr = await call(app, "GET", `/api/material-units/${outputYId}/qr`, { token: adminToken });
      assertEqual(qr.status, 200, "remnant QR status");
      assertEqual(qr.body.payload, `steeltrace://unit/${outputYId}`, "QR payload encodes steeltrace://unit/<id>");
      assert(qr.body.svgDataUrl.startsWith("data:image/svg+xml"), "QR svgDataUrl shape");
    });

    await test("maker=checker rejected, then distinct-checker approval of the OFFCUT reclassification", async () => {
      const self = await call(app, "POST", `/api/reclassifications/${reclassOffcutEventId}/approve`, { token: adminToken });
      assertEqual(self.status, 400, "self-approval of reclassification must be rejected");

      const approved = await call(app, "POST", `/api/reclassifications/${reclassOffcutEventId}/approve`, { token: checkerToken });
      assertEqual(approved.status, 200, "remnant reuse approval status");
    });

    await test("remnant-first suggestion finds the tagged OFFCUT, then it is reused in a downstream operation", async () => {
      const suggest = await call(app, "GET", "/api/remnants/suggest", {
        token: adminToken,
        // standard must match the unit's own (inherited from bundle C,
        // "ES ISO 6935-2:2011") — spec_compare treats a NULL query-side
        // standard as UNKNOWN, never CONFIRMED_MATCH, same policy Task
        // 4's own test 5(b) exercises from the other direction.
        query: { diameterMm: "12", surfaceType: "DEFORMED", grade: "B500BWR", standard: "ES ISO 6935-2:2011", minLengthM: "5" },
      });
      assertEqual(suggest.status, 200, "remnant suggest status");
      const found = (suggest.body as any[]).find((r) => r.materialUnitId === outputYId);
      assert(found !== undefined, "remnant-suggest returns the tagged 10m OFFCUT");
      assertEqual(found.remainingLengthM, 10, "suggested remnant's remaining length");

      const reuse = await call(app, "POST", "/api/processing-operations", {
        token: adminToken,
        payload: {
          projectId: t.projectId,
          referenceCode: `ST-PROC-REUSE-${randomUUID().slice(0, 8)}`,
          operationTypeId: t.cuttingOpTypeId,
          storageLocationId: t.workshopLocId,
          inputs: [{ materialUnitId: outputYId, quantityConsumedPieces: 1, lengthConsumedM: 10 }],
          outputs: [{ attributionMode: "EXACT", quantityPieces: 1, totalLengthM: 10, sources: [{ sourceInputMaterialUnitId: outputYId, contributionWeight: 1 }] }],
        },
      });
      assertEqual(reuse.status, 200, "remnant reuse operation status");
      remnantUnitId = reuse.body.outputs[0].materialUnitId;

      const reclassify = await call(app, "POST", `/api/material-units/${remnantUnitId}/reclassify`, {
        token: adminToken,
        payload: { toClassification: "PREPARED", reason: "reused remnant ready" },
      });
      assertEqual(reclassify.status, 200, "reused remnant -> PREPARED status");
    });

    // =======================================================================
    console.log("\n4. Physical stock count, maker-checker verification, variance adjustment");
    // =======================================================================
    let countUnitId = "";
    await test("register a bundle, count it with a variance, verify with an approved adjustment", async () => {
      const bundle = await registerBundle(10, 8, t.warehouseLocId);
      countUnitId = bundle.rootMaterialUnitId;

      const create = await call(app, "POST", "/api/physical-counts", {
        token: adminToken,
        payload: {
          storageLocationId: t.warehouseLocId,
          referenceCode: `COUNT-${randomUUID().slice(0, 8)}`,
          countDate: new Date().toISOString().slice(0, 10),
          lines: [{ materialUnitId: countUnitId, countedPieces: 1, countedLengthM: 7 }],
        },
      });
      assertEqual(create.status, 200, "physical count create status");
      countId = create.body.physicalStockCountId;

      const detail = await call(app, "GET", `/api/physical-counts/${countId}`, { token: adminToken });
      assertEqual(detail.status, 200, "physical count detail status");
      countLineId = detail.body.lines[0].id;
      assertEqual(Number(detail.body.lines[0].variance_length_m), -1, "variance = counted(7) - system(8) = -1");

      const selfVerify = await call(app, "POST", `/api/physical-counts/${countId}/verify`, { token: adminToken, payload: { adjustments: [] } });
      assertEqual(selfVerify.status, 400, "self-verification (maker=checker) must be rejected");

      const verify = await call(app, "POST", `/api/physical-counts/${countId}/verify`, {
        token: checkerToken,
        payload: {
          adjustments: [{ physicalStockCountLineId: countLineId, measurementBasis: "LENGTH", amount: -1, adjustmentType: "CORRECTION", reason: "confirmed short by 1m" }],
        },
      });
      assertEqual(verify.status, 200, "physical count verify status");
      assertEqual(verify.body.adjustmentIds.length, 1, "one adjustment recorded");
    });

    // =======================================================================
    console.log("\n5. Multi-bundle installation, intended-vs-actual deviation, supersede");
    // =======================================================================
    await test("process a dedicated bundle D, install D1+bundle E together (multi-bundle), detect an intended-vs-actual deviation", async () => {
      const d = await registerBundle(12, 12, t.workshopLocId);
      bundleDId = d.bundleId;
      const e = await registerBundle(12, 5, t.workshopLocId);
      bundleEUnitId = e.rootMaterialUnitId;

      const op = await call(app, "POST", "/api/processing-operations", {
        token: adminToken,
        payload: {
          projectId: t.projectId,
          referenceCode: `ST-PROC-D-${randomUUID().slice(0, 8)}`,
          operationTypeId: t.cuttingOpTypeId,
          storageLocationId: t.workshopLocId,
          inputs: [{ materialUnitId: d.rootMaterialUnitId, quantityConsumedPieces: 1, lengthConsumedM: 12 }],
          outputs: [
            { attributionMode: "EXACT", quantityPieces: 1, totalLengthM: 9, sources: [{ sourceInputMaterialUnitId: d.rootMaterialUnitId, contributionWeight: 1 }] },
            { attributionMode: "EXACT", quantityPieces: 1, totalLengthM: 3, sources: [{ sourceInputMaterialUnitId: d.rootMaterialUnitId, contributionWeight: 1 }] },
          ],
        },
      });
      assertEqual(op.status, 200, "bundle D processing status");
      d1Id = op.body.outputs[0].materialUnitId;
      d2Id = op.body.outputs[1].materialUnitId;
      bundleDUnitId = d.rootMaterialUnitId;

      await call(app, "POST", `/api/material-units/${d1Id}/reclassify`, { token: adminToken, payload: { toClassification: "PREPARED", reason: "main bar ready" } });
      await call(app, "POST", `/api/material-units/${d2Id}/reclassify`, { token: adminToken, payload: { toClassification: "SCRAP", reason: "trim waste" } });

      // Intended usage declared a DIFFERENT purpose than what gets
      // installed — using the SAME purpose id here deliberately won't
      // deviate, so declare against a throwaway second purpose instead.
      // ("Stirrups / Shear Links" is avoided here — the Format A import
      // earlier in this suite already auto-created it for the "st1" row,
      // and creating it again would just hit the (company_id, name)
      // unique constraint.)
      const altPurpose = await call(app, "POST", "/api/reinforcement-purposes", { token: adminToken, payload: { name: "Distribution Reinforcement" } });
      assertEqual(altPurpose.status, 200, "alternate purpose create status");

      const declaration = await call(app, "POST", "/api/intended-usage", {
        token: adminToken,
        payload: { structuralElementInstanceId: t.columnInstanceId, reinforcementPurposeId: altPurpose.body.id },
      });
      assertEqual(declaration.status, 200, "deviation-test declaration status");

      const install = await call(app, "POST", "/api/installations", {
        token: adminToken,
        payload: {
          projectId: t.projectId,
          structuralElementInstanceId: t.columnInstanceId,
          reinforcementPurposeId: t.mainPurposeId, // actual purpose differs from the declaration's altPurpose
          intendedUsageDeclarationId: declaration.body.id,
          materialUnitIds: [d1Id, bundleEUnitId],
        },
      });
      assertEqual(install.status, 200, "multi-bundle installation status");
      assertEqual(install.body.intendedVsActualMatch, false, "actual purpose differs from the declared intent");
      installationId = install.body.installationId;

      const consumption = await call(app, "GET", "/api/reports/consumption", { token: adminToken });
      assertEqual(consumption.status, 200, "consumption report status");
      const deviation = (consumption.body.intendedVsActualDeviations as any[]).find((dv) => dv.installation_id === installationId);
      assert(deviation !== undefined, "the mismatched installation appears in intendedVsActualDeviations");
    });

    await test("supersede the installation with a corrected purpose, then verify it", async () => {
      const supersede = await call(app, "POST", `/api/installations/${installationId}/supersede`, {
        token: adminToken,
        payload: { structuralElementInstanceId: t.columnInstanceId, reinforcementPurposeId: t.mainPurposeId, materialUnitIds: [d1Id, bundleEUnitId] },
      });
      assertEqual(supersede.status, 200, "supersede status");
      const newInstallationId = supersede.body.newInstallationId;

      const old = await call(app, "GET", `/api/installations/${installationId}`, { token: adminToken });
      assertEqual(old.body.status, "SUPERSEDED", "old installation flipped to SUPERSEDED");

      const selfVerify = await call(app, "POST", `/api/installations/${newInstallationId}/verify`, { token: adminToken });
      assertEqual(selfVerify.status, 400, "self-verification (maker=checker) must be rejected");

      const verify = await call(app, "POST", `/api/installations/${newInstallationId}/verify`, { token: checkerToken });
      assertEqual(verify.status, 200, "site QC verification status");
    });

    // =======================================================================
    console.log("\n6. Executive KPIs, backward genealogy (POOLED), forward genealogy (100% conservation)");
    // =======================================================================
    await test("executive KPIs are present, non-negative, and the seeded reorder alert fires", async () => {
      const kpis = await call(app, "GET", "/api/reports/kpis", { token: adminToken });
      assertEqual(kpis.status, 200, "kpis status");
      for (const field of ["totalInventoryMt", "availableStockMt", "reservedStockMt", "onHoldMt", "inTransitMt", "installedMt", "reusableOffcutMt", "scrapMt", "unallocatedCompanyStockMt"]) {
        assert(typeof kpis.body[field] === "number" && kpis.body[field] >= 0, `kpis.${field} should be a non-negative number, got ${kpis.body[field]}`);
      }
      assert(kpis.body.reorderAlerts.length >= 1, "the deliberately-low reorder threshold should trigger at least one alert");
      assert(kpis.body.unreconciledOperationsCount >= 0, "unreconciledOperationsCount present");
      assert(kpis.body.unreconciledTransfersCount >= 0, "unreconciledTransfersCount present");
    });

    await test("backward genealogy on the POOLED output returns contributionWeight: null for every source", async () => {
      const genealogy = await call(app, "GET", `/api/reports/genealogy/unit/${outputZId}`, { token: adminToken });
      assertEqual(genealogy.status, 200, "backward genealogy status");
      assertEqual(genealogy.body.origins.length, 3, "POOLED output traces to all 3 source bundles");
      for (const origin of genealogy.body.origins) {
        assertEqual(origin.confidence, "POOLED", "every origin's confidence is POOLED");
        assertEqual(origin.contribution_weight, null, "POOLED confidence must never carry a fabricated contribution_weight");
      }
    });

    await test("forward genealogy on bundle D shows exact 100% length conservation (9 installed + 3 scrap = 12)", async () => {
      const genealogy = await call(app, "GET", `/api/reports/genealogy/bundle/${bundleDId}`, { token: adminToken });
      assertEqual(genealogy.status, 200, "forward genealogy status");
      assertEqual(genealogy.body.originalLengthM, 12, "bundle D original length");
      assertClose(genealogy.body.installedM, 9, 0.001, "installed length");
      assertClose(genealogy.body.scrapM, 3, 0.001, "scrap length");
      assertClose(genealogy.body.accountedForM, 12, 0.001, "accounted-for length");
      assertEqual(genealogy.body.fullyConserved, true, "bundle D's lifecycle fully reconciles to its original length");
    });
  } finally {
    console.log(`\nCleaning up ${companiesToClean.length} test company tenant(s)...`);
    await cleanupTestCompanies(executor, companiesToClean);
    await deleteTestUsers(executor, usersToClean);
    await app.close();
  }

  console.log("\n" + "=".repeat(70));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} tests passed.`);
  if (failed.length > 0) {
    console.log(`\nFAILED:`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
  }

  await executor.close();
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error("SUITE CRASHED:", e);
  process.exit(1);
});
