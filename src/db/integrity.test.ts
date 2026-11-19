import { randomUUID } from "node:crypto";
import { createExecutor, type SqlExecutor, type TxHandle } from "./bootstrapSql";
import { seed, type SeedResult } from "./seed";
import { cleanupTestCompanies } from "./testCleanup";

// ---------------------------------------------------------------------------
// Minimal, dependency-free test harness (no framework needed for a single
// sequential suite run via `tsx`/`npm test`).
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
  const a = typeof actual === "number" ? actual : Number(actual);
  const e = typeof expected === "number" ? expected : Number(expected);
  if (Math.abs(a - e) > 1e-6) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

async function assertRejects(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`expected rejection but succeeded: ${message}`);
}

// ---------------------------------------------------------------------------
// Thin wrappers around the controlled SQL functions (05), so the scenarios
// below read as business steps, not raw SQL.
// ---------------------------------------------------------------------------
async function remaining(tx: TxHandle, companyId: string, unitId: string): Promise<number> {
  const { rows } = await tx.query<{ r: string }>(
    `SELECT material_unit_remaining_length_m($1, $2) AS r`,
    [companyId, unitId],
  );
  return Number(rows[0]!.r);
}

async function rootUnitOf(tx: TxHandle, companyId: string, bundleId: string): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM material_units WHERE company_id = $1 AND source_bundle_id = $2`,
    [companyId, bundleId],
  );
  return rows[0]!.id;
}

async function registerBundle(
  tx: TxHandle,
  companyId: string,
  opts: {
    storageLocationId: string;
    referenceCode: string;
    diameterMm: number;
    grade: string;
    standard: string | null;
    pieceCount: number;
    barLengthM: number;
    surfaceType: "DEFORMED" | "PLAIN";
    registeredByMembershipId: string;
  },
): Promise<{ bundleId: string; rootMaterialUnitId: string }> {
  // GRN_PURCHASE (with a synthetic GRN reference), never OPENING_STOCK —
  // bundles registered ad hoc by this test suite must never be counted
  // among the client's real 102-bundle opening-stock baseline (seed.ts
  // owns that origin_type exclusively).
  const { rows } = await tx.query<{ bundle_id: string; root_material_unit_id: string }>(
    `SELECT * FROM register_bundle($1,NULL,$2,$3,NULL,NULL,NULL,$4,$5,$6,NULL,$7,$8,$9,'GRN_PURCHASE',$10,NULL,NULL,NULL,NULL,NULL,NULL,'ACCEPTED',$11)`,
    [
      companyId,
      opts.storageLocationId,
      opts.referenceCode,
      opts.diameterMm,
      opts.grade,
      opts.standard,
      opts.pieceCount,
      opts.barLengthM,
      opts.surfaceType,
      `GRN-TEST-${opts.referenceCode}`,
      opts.registeredByMembershipId,
    ],
  );
  return { bundleId: rows[0]!.bundle_id, rootMaterialUnitId: rows[0]!.root_material_unit_id };
}

async function dispatch(
  tx: TxHandle,
  companyId: string,
  opts: {
    projectId: string | null;
    fromLocationId: string;
    toLocationId: string;
    dispatchedByMembershipId: string;
    lines: { sourceMaterialUnitId: string; quantityPieces: number; unitLengthM: number | null; totalLengthM: number }[];
  },
): Promise<{ transferId: string; lineIds: string[]; placeholderIds: string[] }> {
  const { rows } = await tx.query<{ dispatch_material_transfer: string }>(
    `SELECT dispatch_material_transfer($1,$2,$3,$4,$5,NULL,$6,$7::jsonb)`,
    [
      companyId,
      opts.projectId,
      opts.fromLocationId,
      opts.toLocationId,
      opts.dispatchedByMembershipId,
      randomUUID(),
      JSON.stringify(
        opts.lines.map((l) => ({
          source_material_unit_id: l.sourceMaterialUnitId,
          quantity_pieces: l.quantityPieces,
          unit_length_m: l.unitLengthM,
          total_length_m: l.totalLengthM,
          unit_weight_kg: null,
          total_weight_kg: null,
        })),
      ),
    ],
  );
  const transferId = rows[0]!.dispatch_material_transfer;
  const { rows: lineRows } = await tx.query<{ id: string; material_unit_id: string }>(
    `SELECT id, material_unit_id FROM material_transfer_lines WHERE company_id = $1 AND material_transfer_id = $2 ORDER BY created_at`,
    [companyId, transferId],
  );
  return {
    transferId,
    lineIds: lineRows.map((r) => r.id),
    placeholderIds: lineRows.map((r) => r.material_unit_id),
  };
}

async function receive(
  tx: TxHandle,
  companyId: string,
  opts: {
    transferLineId: string;
    receivedByMembershipId: string;
    portions: { quantityPieces: number; unitLengthM: number | null; totalLengthM: number; disposition: "ACCEPTED" | "ON_HOLD" | "DAMAGED_DISCREPANT" }[];
  },
): Promise<string[]> {
  await tx.query(`SELECT receive_transfer_line($1,$2,$3,NULL,$4::jsonb)`, [
    companyId,
    opts.transferLineId,
    opts.receivedByMembershipId,
    JSON.stringify(
      opts.portions.map((p) => ({
        quantity_pieces: p.quantityPieces,
        unit_length_m: p.unitLengthM,
        total_length_m: p.totalLengthM,
        unit_weight_kg: null,
        total_weight_kg: null,
        disposition: p.disposition,
      })),
    ),
  ]);
  const { rows } = await tx.query<{ resulting_material_unit_id: string }>(
    `SELECT resulting_material_unit_id FROM material_transfer_receipt_lines
      WHERE company_id = $1 AND material_transfer_line_id = $2 ORDER BY created_at`,
    [companyId, opts.transferLineId],
  );
  return rows.map((r) => r.resulting_material_unit_id);
}

/** Dispatch + receive (single ACCEPTED portion) in one step — the common case. */
async function dispatchAndReceiveOne(
  tx: TxHandle,
  companyId: string,
  opts: {
    projectId: string | null;
    fromLocationId: string;
    toLocationId: string;
    membershipId: string;
    sourceMaterialUnitId: string;
    quantityPieces: number;
    unitLengthM: number | null;
    totalLengthM: number;
  },
): Promise<string> {
  const d = await dispatch(tx, companyId, {
    projectId: opts.projectId,
    fromLocationId: opts.fromLocationId,
    toLocationId: opts.toLocationId,
    dispatchedByMembershipId: opts.membershipId,
    lines: [{ sourceMaterialUnitId: opts.sourceMaterialUnitId, quantityPieces: opts.quantityPieces, unitLengthM: opts.unitLengthM, totalLengthM: opts.totalLengthM }],
  });
  const [unitId] = await receive(tx, companyId, {
    transferLineId: d.lineIds[0]!,
    receivedByMembershipId: opts.membershipId,
    portions: [{ quantityPieces: opts.quantityPieces, unitLengthM: opts.unitLengthM, totalLengthM: opts.totalLengthM, disposition: "ACCEPTED" }],
  });
  return unitId!;
}

interface ProcessingOutputSpec {
  attributionMode: "EXACT" | "KNOWN_PARTIAL" | "POOLED";
  quantityPieces: number;
  unitLengthM: number | null;
  totalLengthM: number;
  sources?: { sourceInputMaterialUnitId: string; contributionWeight: number | null }[];
}

async function recordProcessingOperation(
  tx: TxHandle,
  companyId: string,
  opts: {
    projectId: string;
    referenceCode: string;
    operationTypeId: string;
    storageLocationId: string;
    performedByMembershipId: string;
    inputs: { materialUnitId: string; quantityConsumedPieces: number; lengthConsumedM: number }[];
    outputs: ProcessingOutputSpec[];
  },
): Promise<{ operationId: string; outputUnitIds: string[] }> {
  const { rows } = await tx.query<{ operation_id: string; output_index: number | null; output_material_unit_id: string | null }>(
    `SELECT * FROM record_processing_operation($1,NULL,$2,NULL,$3,$4,$5,$6,NULL,$7::jsonb,$8::jsonb,NULL)`,
    [
      companyId,
      opts.projectId,
      opts.referenceCode,
      opts.operationTypeId,
      opts.storageLocationId,
      opts.performedByMembershipId,
      JSON.stringify(
        opts.inputs.map((i) => ({
          material_unit_id: i.materialUnitId,
          quantity_consumed_pieces: i.quantityConsumedPieces,
          length_consumed_m: i.lengthConsumedM,
          weight_consumed_kg: null,
        })),
      ),
      JSON.stringify(
        opts.outputs.map((o) => ({
          attribution_mode: o.attributionMode,
          quantity_pieces: o.quantityPieces,
          unit_length_m: o.unitLengthM,
          total_length_m: o.totalLengthM,
          sources: (o.sources ?? []).map((s) => ({
            source_input_material_unit_id: s.sourceInputMaterialUnitId,
            contribution_weight: s.contributionWeight,
          })),
        })),
      ),
    ],
  );
  const operationId = rows[0]!.operation_id;
  const outputUnitIds = rows.filter((r) => r.output_material_unit_id).map((r) => r.output_material_unit_id!);
  return { operationId, outputUnitIds };
}

async function reclassify(tx: TxHandle, companyId: string, unitId: string, to: string, reason: string, membershipId: string): Promise<void> {
  await tx.query(`SELECT reclassify_material_unit($1,$2,$3,$4,$5)`, [companyId, unitId, to, reason, membershipId]);
}

async function install(
  tx: TxHandle,
  companyId: string,
  opts: { projectId: string; structuralElementInstanceId: string; reinforcementPurposeId: string; installedByMembershipId: string; materialUnitIds: string[] },
): Promise<string> {
  const { rows } = await tx.query<{ install_material: string }>(
    `SELECT install_material($1,$2,$3,$4,NULL,NULL,$5,NULL,$6::uuid[])`,
    [companyId, opts.projectId, opts.structuralElementInstanceId, opts.reinforcementPurposeId, opts.installedByMembershipId, opts.materialUnitIds],
  );
  return rows[0]!.install_material;
}

async function releaseHold(tx: TxHandle, companyId: string, unitId: string, membershipId: string, reason: string): Promise<void> {
  await tx.query(`SELECT release_hold($1,$2,$3,$4)`, [companyId, unitId, membershipId, reason]);
}

async function recordApproval(tx: TxHandle, companyId: string, targetTable: string, targetId: string, approvingMembershipId: string): Promise<void> {
  await tx.query(`SELECT record_approval($1,$2,$3,$4)`, [companyId, targetTable, targetId, approvingMembershipId]);
}

async function originOf(tx: TxHandle, companyId: string, unitId: string): Promise<{ bundleId: string; confidence: string; contributionWeight: string | null }[]> {
  const { rows } = await tx.query<{ bundle_id: string; confidence: string; contribution_weight: string | null }>(
    `SELECT bundle_id, confidence, contribution_weight FROM material_unit_origins WHERE company_id = $1 AND material_unit_id = $2`,
    [companyId, unitId],
  );
  return rows.map((r) => ({ bundleId: r.bundle_id, confidence: r.confidence, contributionWeight: r.contribution_weight }));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const executor = await createExecutor();

  // `s` — the REAL seeded client company ("First Construction Client").
  // Scenario 1 only: read-only assertions against the actual operational
  // baseline. Nothing below ever mutates through `s` — every scenario that
  // writes (2-5) runs against `t`, a disposable, isolated test tenant
  // (seed() against a fresh random company name reuses every bit of
  // seed.ts's setup — roles, catalogs, projects, locations, 102-bundle
  // opening stock — under a brand-new company_id), so the seeded client
  // company is never touched by anything this suite writes. `t` and its
  // single-row "Company B" sibling (scenario 5e) are torn down in the
  // `finally` block below regardless of pass/fail, so repeated runs never
  // accumulate orphaned test companies in the live database.
  console.log("Seeding baseline...");
  const s = await seed(executor);
  console.log(`Seed OK — company ${s.companyId}, ${s.openingStockBundleIds.length} opening-stock bundles.\n`);

  const testCompanyName = `Integrity Test Co ${randomUUID().slice(0, 8)}`;
  console.log(`Seeding isolated test tenant "${testCompanyName}"...`);
  const t = await seed(executor, testCompanyName);
  console.log(`Isolated test tenant OK — company ${t.companyId}.\n`);

  const companiesToClean: string[] = [t.companyId];

  const workshopMembershipId = t.membershipIds["Workshop / Fabrication Operator"];
  const warehouseMembershipId = t.membershipIds["Warehouse / Receiving Officer"];
  const qualityMembershipId = t.membershipIds["Quality / Approving Officer"];
  const siteMembershipId = t.membershipIds["Site Engineer / Supervisor"];
  const cuttingOpTypeId = t.processingOperationTypeIds["Cutting"]!;
  const mainLongitudinalPurposeId = t.reinforcementPurposeIds["Main Longitudinal Reinforcement"]!;

  try {

  // =========================================================================
  console.log("1. Opening Stock & Rolling Margin Verification");
  // =========================================================================
  await test("102 bundles, 21598 pieces, 259176 m, 204000 kg", async () => {
    await executor.runAs({ role: "steeltrace_app", companyId: s.companyId }, async (tx) => {
      // Matched by the exact ids `seed()` created/found, not merely by
      // `origin_type = 'OPENING_STOCK'` — robust against any other
      // OPENING_STOCK-tagged row a prior (buggy, since fixed) test run
      // may have left behind; the seeded baseline is defined by exactly
      // these 102 ids, nothing more.
      const { rows } = await tx.query<{ bundles: string; pieces: string; length: string; weight: string }>(
        `SELECT count(*) bundles, sum(piece_count) pieces, sum(piece_count * bar_length_m) length, sum(actual_weight_kg) weight
           FROM bundles WHERE company_id = $1 AND id = ANY($2::uuid[])`,
        [s.companyId, s.openingStockBundleIds],
      );
      assertEqual(rows[0]!.bundles, 102, "bundle count");
      assertEqual(rows[0]!.pieces, 21598, "piece count");
      assertEqual(rows[0]!.length, 259176, "total length");
      assertEqual(rows[0]!.weight, 204000, "total weight");
    });
  });

  await test("rolling_margin_kg is non-null for a seeded opening-stock bundle", async () => {
    await executor.runAs({ role: "steeltrace_app", companyId: s.companyId }, async (tx) => {
      const bundleId = s.openingStockBundleIds[0]!;
      const { rows } = await tx.query<{ margin: string | null }>(`SELECT rolling_margin_kg($1, $2) AS margin`, [s.companyId, bundleId]);
      assert(rows[0]!.margin !== null, "rolling_margin_kg should not be null");
    });
  });

  // =========================================================================
  console.log("\n2. Full §20 Lifecycle Worked Example & Exact Conservation (5,088 m)");
  // =========================================================================
  let u0Id = "", u5Id = "", u2Id = "", u4Id = "", u6Id = "";
  await test("register U0 (424 bars x 12m = 5088m), allocate, dispatch, receive -> U1 (12m)", async () => {
    await executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
      const { rootMaterialUnitId } = await registerBundle(tx, t.companyId, {
        storageLocationId: t.storageLocationIds.mainYard,
        referenceCode: `ST-BND-LIFECYCLE-${randomUUID().slice(0, 8)}`,
        diameterMm: 8,
        grade: "B500BWR",
        standard: "ES ISO 6935-2:2011",
        pieceCount: 424,
        barLengthM: 12,
        surfaceType: "DEFORMED",
        registeredByMembershipId: warehouseMembershipId,
      });
      u0Id = rootMaterialUnitId;
      assertEqual(await remaining(tx, t.companyId, u0Id), 5088, "U0 initial remaining");

      await tx.query(`SELECT reallocate_project($1,$2,$3,$4,$5)`, [t.companyId, u0Id, t.projectIds.hotel, warehouseMembershipId, "allocate to Hotel"]);

      const d = await dispatch(tx, t.companyId, {
        projectId: t.projectIds.hotel,
        fromLocationId: t.storageLocationIds.mainYard,
        toLocationId: t.storageLocationIds.centralWorkshop,
        dispatchedByMembershipId: warehouseMembershipId,
        lines: [{ sourceMaterialUnitId: u0Id, quantityPieces: 1, unitLengthM: 12, totalLengthM: 12 }],
      });
      assertEqual(await remaining(tx, t.companyId, u0Id), 5076, "remaining(U0) after dispatch");
      assertEqual(await remaining(tx, t.companyId, d.placeholderIds[0]!), 12, "remaining(U0a) before receipt");

      const [u1Id] = await receive(tx, t.companyId, {
        transferLineId: d.lineIds[0]!,
        receivedByMembershipId: workshopMembershipId,
        portions: [{ quantityPieces: 1, unitLengthM: 12, totalLengthM: 12, disposition: "ACCEPTED" }],
      });
      assertEqual(await remaining(tx, t.companyId, d.placeholderIds[0]!), 0, "remaining(U0a) after receipt");
      assertEqual(await remaining(tx, t.companyId, u0Id), 5076, "remaining(U0) unchanged after receipt");

      const { rows: statusRows } = await tx.query<{ status: string }>(`SELECT status FROM material_transfers WHERE company_id=$1 AND id=$2`, [t.companyId, d.transferId]);
      assert(statusRows[0]!.status === "RECEIVED", "transfer should reach RECEIVED");

      // Process U1 (12m) -> U2 (9.0 PREPARED), U3 (2.5 OFFCUT), U4 (0.5 SCRAP), all EXACT.
      const op1 = await recordProcessingOperation(tx, t.companyId, {
        projectId: t.projectIds.hotel,
        referenceCode: `ST-PROC-${randomUUID().slice(0, 8)}`,
        operationTypeId: cuttingOpTypeId,
        storageLocationId: t.storageLocationIds.centralWorkshop,
        performedByMembershipId: workshopMembershipId,
        inputs: [{ materialUnitId: u1Id!, quantityConsumedPieces: 1, lengthConsumedM: 12 }],
        outputs: [
          { attributionMode: "EXACT", quantityPieces: 1, unitLengthM: 9.0, totalLengthM: 9.0, sources: [{ sourceInputMaterialUnitId: u1Id!, contributionWeight: 1 }] },
          { attributionMode: "EXACT", quantityPieces: 1, unitLengthM: 2.5, totalLengthM: 2.5, sources: [{ sourceInputMaterialUnitId: u1Id!, contributionWeight: 1 }] },
          { attributionMode: "EXACT", quantityPieces: 1, unitLengthM: 0.5, totalLengthM: 0.5, sources: [{ sourceInputMaterialUnitId: u1Id!, contributionWeight: 1 }] },
        ],
      });
      [u2Id, , u4Id] = op1.outputUnitIds as [string, string, string];
      const u3Id = op1.outputUnitIds[1]!;

      await reclassify(tx, t.companyId, u2Id, "PREPARED", "main reinforcement", qualityMembershipId);
      await reclassify(tx, t.companyId, u3Id, "OFFCUT", "reusable beam offcut", qualityMembershipId);
      await reclassify(tx, t.companyId, u4Id, "SCRAP", "trim waste", qualityMembershipId);

      // Reuse U3 (2.5m OFFCUT) -> U5 (2.2m PREPARED), U6 (0.3m SCRAP).
      const op2 = await recordProcessingOperation(tx, t.companyId, {
        projectId: t.projectIds.hotel,
        referenceCode: `ST-PROC-${randomUUID().slice(0, 8)}`,
        operationTypeId: cuttingOpTypeId,
        storageLocationId: t.storageLocationIds.centralWorkshop,
        performedByMembershipId: workshopMembershipId,
        inputs: [{ materialUnitId: u3Id, quantityConsumedPieces: 1, lengthConsumedM: 2.5 }],
        outputs: [
          { attributionMode: "EXACT", quantityPieces: 1, unitLengthM: 2.2, totalLengthM: 2.2, sources: [{ sourceInputMaterialUnitId: u3Id, contributionWeight: 1 }] },
          { attributionMode: "EXACT", quantityPieces: 1, unitLengthM: 0.3, totalLengthM: 0.3, sources: [{ sourceInputMaterialUnitId: u3Id, contributionWeight: 1 }] },
        ],
      });
      u5Id = op2.outputUnitIds[0]!;
      u6Id = op2.outputUnitIds[1]!;
      await reclassify(tx, t.companyId, u5Id, "PREPARED", "beam reuse", qualityMembershipId);
      await reclassify(tx, t.companyId, u6Id, "SCRAP", "trim waste", qualityMembershipId);

      // Install U2 (9.0m) into Column C-12.
      await install(tx, t.companyId, {
        projectId: t.projectIds.hotel,
        structuralElementInstanceId: t.structuralElementInstanceIds.columnC12,
        reinforcementPurposeId: mainLongitudinalPurposeId,
        installedByMembershipId: siteMembershipId,
        materialUnitIds: [u2Id],
      });
    });
  });

  await test("end-state conservation: 5076 + 2.2 + 9.0 + 0.8 = 5088.000 m exactly", async () => {
    await executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
      const remU0 = await remaining(tx, t.companyId, u0Id);
      const remU5 = await remaining(tx, t.companyId, u5Id);
      const { rows: u2Rows } = await tx.query<{ total_length_m: string }>(`SELECT total_length_m FROM material_units WHERE company_id=$1 AND id=$2`, [t.companyId, u2Id]);
      const { rows: u4Rows } = await tx.query<{ total_length_m: string }>(`SELECT total_length_m FROM material_units WHERE company_id=$1 AND id=$2`, [t.companyId, u4Id]);
      const { rows: u6Rows } = await tx.query<{ total_length_m: string }>(`SELECT total_length_m FROM material_units WHERE company_id=$1 AND id=$2`, [t.companyId, u6Id]);
      const installedLen = Number(u2Rows[0]!.total_length_m);
      const scrapLen = Number(u4Rows[0]!.total_length_m) + Number(u6Rows[0]!.total_length_m);

      assertEqual(remU0, 5076, "remaining(U0)");
      assertEqual(remU5, 2.2, "remaining(U5)");
      assertEqual(installedLen, 9.0, "installed(U2)");
      assertEqual(scrapLen, 0.8, "scrap(U4+U6)");
      assertEqual(remU0 + remU5 + installedLen + scrapLen, 5088, "grand total");
    });
  });

  await test("material_unit_origins for U5: confidence=EXACT, contribution_weight=1", async () => {
    await executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
      const origins = await originOf(tx, t.companyId, u5Id);
      assertEqual(origins.length, 1, "U5 should trace to exactly one bundle");
      assert(origins[0]!.confidence === "EXACT", `expected EXACT, got ${origins[0]!.confidence}`);
      assertEqual(origins[0]!.contributionWeight, 1, "U5 contribution_weight");
    });
  });

  // =========================================================================
  console.log("\n3. Multi-Bundle Mixed Attribution & Sticky Confidence (§6 & §10)");
  // =========================================================================
  let outputZId = "";
  await test("OutputX=KNOWN_PARTIAL{A,B} (C excluded), OutputY=EXACT{C}, OutputZ=POOLED{A,B,C}", async () => {
    await executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
      const { rows: tenMmBundles } = await tx.query<{ id: string }>(
        `SELECT id FROM bundles WHERE company_id = $1 AND diameter_mm = 10 AND origin_type = 'OPENING_STOCK' ORDER BY internal_reference_code LIMIT 3`,
        [t.companyId],
      );
      assertEqual(tenMmBundles.length, 3, "need 3 distinct 10mm bundles");
      const [bundleA, bundleB, bundleC] = tenMmBundles.map((r) => r.id);

      const rootA = await rootUnitOf(tx, t.companyId, bundleA!);
      const rootB = await rootUnitOf(tx, t.companyId, bundleB!);
      const rootC = await rootUnitOf(tx, t.companyId, bundleC!);

      const unitA = await dispatchAndReceiveOne(tx, t.companyId, {
        projectId: t.projectIds.hotel, fromLocationId: t.storageLocationIds.mainYard, toLocationId: t.storageLocationIds.centralWorkshop,
        membershipId: warehouseMembershipId, sourceMaterialUnitId: rootA, quantityPieces: 4, unitLengthM: 12, totalLengthM: 48,
      });
      const unitB = await dispatchAndReceiveOne(tx, t.companyId, {
        projectId: t.projectIds.hotel, fromLocationId: t.storageLocationIds.mainYard, toLocationId: t.storageLocationIds.centralWorkshop,
        membershipId: warehouseMembershipId, sourceMaterialUnitId: rootB, quantityPieces: 6, unitLengthM: 12, totalLengthM: 72,
      });
      const unitC = await dispatchAndReceiveOne(tx, t.companyId, {
        projectId: t.projectIds.hotel, fromLocationId: t.storageLocationIds.mainYard, toLocationId: t.storageLocationIds.centralWorkshop,
        membershipId: warehouseMembershipId, sourceMaterialUnitId: rootC, quantityPieces: 3, unitLengthM: 12, totalLengthM: 36,
      });

      const op = await recordProcessingOperation(tx, t.companyId, {
        projectId: t.projectIds.hotel,
        referenceCode: `ST-PROC-${randomUUID().slice(0, 8)}`,
        operationTypeId: cuttingOpTypeId,
        storageLocationId: t.storageLocationIds.centralWorkshop,
        performedByMembershipId: workshopMembershipId,
        inputs: [
          { materialUnitId: unitA, quantityConsumedPieces: 4, lengthConsumedM: 48 },
          { materialUnitId: unitB, quantityConsumedPieces: 6, lengthConsumedM: 72 },
          { materialUnitId: unitC, quantityConsumedPieces: 3, lengthConsumedM: 36 },
        ],
        outputs: [
          { attributionMode: "KNOWN_PARTIAL", quantityPieces: 1, unitLengthM: 20, totalLengthM: 20, sources: [{ sourceInputMaterialUnitId: unitA, contributionWeight: null }, { sourceInputMaterialUnitId: unitB, contributionWeight: null }] },
          { attributionMode: "EXACT", quantityPieces: 1, unitLengthM: 10, totalLengthM: 10, sources: [{ sourceInputMaterialUnitId: unitC, contributionWeight: 1 }] },
          { attributionMode: "POOLED", quantityPieces: 1, unitLengthM: 5, totalLengthM: 5 },
        ],
      });

      const [outputXId, outputYId, zId] = op.outputUnitIds;
      outputZId = zId!;

      const originsX = await originOf(tx, t.companyId, outputXId!);
      const xBundles = new Set(originsX.map((o) => o.bundleId));
      assert(xBundles.has(bundleA!) && xBundles.has(bundleB!), "OutputX must trace to A and B");
      assert(!xBundles.has(bundleC!), "OutputX must NOT trace to C");
      assert(originsX.every((o) => o.confidence === "KNOWN_PARTIAL"), "OutputX confidence should be KNOWN_PARTIAL");

      const originsY = await originOf(tx, t.companyId, outputYId!);
      assertEqual(originsY.length, 1, "OutputY traces to exactly one bundle");
      assert(originsY[0]!.bundleId === bundleC, "OutputY must trace to C");
      assert(originsY[0]!.confidence === "EXACT", "OutputY confidence should be EXACT");

      const originsZ = await originOf(tx, t.companyId, outputZId);
      const zBundles = new Set(originsZ.map((o) => o.bundleId));
      assert(zBundles.has(bundleA!) && zBundles.has(bundleB!) && zBundles.has(bundleC!), "OutputZ must trace to A, B, and C");
      assert(originsZ.every((o) => o.confidence === "POOLED"), "OutputZ confidence should be POOLED");
    });
  });

  await test("sticky weakest link: downstream single-input op on POOLED OutputZ stays POOLED", async () => {
    await executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
      // OutputZ was just created as PENDING_RECONCILIATION (§7 of
      // data-model.md) — it must be reclassified before any downstream
      // operation may consume it, same as every other fresh output.
      await reclassify(tx, t.companyId, outputZId, "PREPARED", "ready for reuse", qualityMembershipId);

      const op = await recordProcessingOperation(tx, t.companyId, {
        projectId: t.projectIds.hotel,
        referenceCode: `ST-PROC-${randomUUID().slice(0, 8)}`,
        operationTypeId: cuttingOpTypeId,
        storageLocationId: t.storageLocationIds.centralWorkshop,
        performedByMembershipId: workshopMembershipId,
        inputs: [{ materialUnitId: outputZId, quantityConsumedPieces: 1, lengthConsumedM: 5 }],
        outputs: [{ attributionMode: "EXACT", quantityPieces: 1, unitLengthM: 5, totalLengthM: 5, sources: [{ sourceInputMaterialUnitId: outputZId, contributionWeight: 1 }] }],
      });
      const downstreamUnitId = op.outputUnitIds[0]!;
      const origins = await originOf(tx, t.companyId, downstreamUnitId);
      assert(origins.every((o) => o.confidence === "POOLED"), "downstream of a POOLED unit must stay POOLED even though this step itself is EXACT");
    });
  });

  // =========================================================================
  console.log("\n4. Multi-Disposition Single Receipt & Quarantine Gate (§11)");
  // =========================================================================
  let onHoldUnitId = "";
  await test("8m ACCEPTED + 1m DAMAGED_DISCREPANT + 1m ON_HOLD in one receipt; transfer -> RECEIVED", async () => {
    await executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM bundles WHERE company_id = $1 AND diameter_mm = 12 AND origin_type = 'OPENING_STOCK' ORDER BY internal_reference_code LIMIT 1`,
        [t.companyId],
      );
      const rootUnit = await rootUnitOf(tx, t.companyId, rows[0]!.id);

      const d = await dispatch(tx, t.companyId, {
        projectId: t.projectIds.hotel,
        fromLocationId: t.storageLocationIds.mainYard,
        toLocationId: t.storageLocationIds.centralWorkshop,
        dispatchedByMembershipId: warehouseMembershipId,
        lines: [{ sourceMaterialUnitId: rootUnit, quantityPieces: 1, unitLengthM: null, totalLengthM: 10 }],
      });

      const receivedUnits = await receive(tx, t.companyId, {
        transferLineId: d.lineIds[0]!,
        receivedByMembershipId: workshopMembershipId,
        portions: [
          { quantityPieces: 1, unitLengthM: null, totalLengthM: 8, disposition: "ACCEPTED" },
          { quantityPieces: 1, unitLengthM: null, totalLengthM: 1, disposition: "DAMAGED_DISCREPANT" },
          { quantityPieces: 1, unitLengthM: null, totalLengthM: 1, disposition: "ON_HOLD" },
        ],
      });
      assertEqual(receivedUnits.length, 3, "three resulting units from one receipt event");

      assertEqual(await remaining(tx, t.companyId, d.placeholderIds[0]!), 0, "placeholder fully drawn down");

      const { rows: statusRows } = await tx.query<{ status: string }>(`SELECT status FROM material_transfers WHERE company_id=$1 AND id=$2`, [t.companyId, d.transferId]);
      assert(statusRows[0]!.status === "RECEIVED", "transfer should reach RECEIVED");

      const { rows: unitStatuses } = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM material_units WHERE company_id = $1 AND id = ANY($2::uuid[])`,
        [t.companyId, receivedUnits],
      );
      const statusById = new Map(unitStatuses.map((r) => [r.id, r.status]));
      assert(statusById.get(receivedUnits[0]!) === "AVAILABLE", "ACCEPTED portion should be AVAILABLE");
      assert(statusById.get(receivedUnits[1]!) === "ON_HOLD", "DAMAGED_DISCREPANT portion should be ON_HOLD");
      assert(statusById.get(receivedUnits[2]!) === "ON_HOLD", "ON_HOLD portion should be ON_HOLD");

      onHoldUnitId = receivedUnits[2]!;
    });
  });

  await test("ON_HOLD unit is rejected as a processing_input by trigger", async () => {
    await executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
      await assertRejects(
        () =>
          recordProcessingOperation(tx, t.companyId, {
            projectId: t.projectIds.hotel,
            referenceCode: `ST-PROC-${randomUUID().slice(0, 8)}`,
            operationTypeId: cuttingOpTypeId,
            storageLocationId: t.storageLocationIds.centralWorkshop,
            performedByMembershipId: workshopMembershipId,
            inputs: [{ materialUnitId: onHoldUnitId, quantityConsumedPieces: 1, lengthConsumedM: 1 }],
            outputs: [],
          }),
        "ON_HOLD unit must not be consumable",
      );
    });
  });

  await test("release_hold transitions the held unit to AVAILABLE", async () => {
    await executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
      await releaseHold(tx, t.companyId, onHoldUnitId, qualityMembershipId, "inspected, found acceptable");
      const { rows } = await tx.query<{ status: string }>(`SELECT status FROM material_units WHERE company_id=$1 AND id=$2`, [t.companyId, onHoldUnitId]);
      assert(rows[0]!.status === "AVAILABLE", "unit should now be AVAILABLE");
    });
  });

  // =========================================================================
  console.log("\n5. Safety & Security Rejection Gates");
  // =========================================================================
  await test("(a) output length > input length without an adjustment is rejected", async () => {
    await assertRejects(
      () =>
        executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `SELECT id FROM bundles WHERE company_id = $1 AND diameter_mm = 16 AND origin_type = 'OPENING_STOCK' LIMIT 1`,
            [t.companyId],
          );
          const rootUnit = await rootUnitOf(tx, t.companyId, rows[0]!.id);
          const unit = await dispatchAndReceiveOne(tx, t.companyId, {
            projectId: t.projectIds.hotel, fromLocationId: t.storageLocationIds.mainYard, toLocationId: t.storageLocationIds.centralWorkshop,
            membershipId: warehouseMembershipId, sourceMaterialUnitId: rootUnit, quantityPieces: 1, unitLengthM: 1, totalLengthM: 1,
          });
          await recordProcessingOperation(tx, t.companyId, {
            projectId: t.projectIds.hotel,
            referenceCode: `ST-PROC-${randomUUID().slice(0, 8)}`,
            operationTypeId: cuttingOpTypeId,
            storageLocationId: t.storageLocationIds.centralWorkshop,
            performedByMembershipId: workshopMembershipId,
            inputs: [{ materialUnitId: unit, quantityConsumedPieces: 1, lengthConsumedM: 1 }],
            outputs: [{ attributionMode: "EXACT", quantityPieces: 1, unitLengthM: 2, totalLengthM: 2, sources: [{ sourceInputMaterialUnitId: unit, contributionWeight: 1 }] }],
          });
        }),
      "1m input -> 2m output with no adjustment must be blocked by the conservation trigger",
    );
  });

  await test("(b) combining a NULL-standard input with requires_uniform_input_spec=true is rejected", async () => {
    await assertRejects(
      () =>
        executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
          const { bundleId: unknownStdBundle } = await registerBundle(tx, t.companyId, {
            storageLocationId: t.storageLocationIds.mainYard,
            referenceCode: `ST-BND-UNKSTD-${randomUUID().slice(0, 8)}`,
            diameterMm: 20,
            grade: "B500BWR",
            standard: null, // -> spec_compare(...) = 'UNKNOWN', never CONFIRMED_MATCH
            pieceCount: 5,
            barLengthM: 12,
            surfaceType: "DEFORMED",
            registeredByMembershipId: warehouseMembershipId,
          });
          const rootUnknown = await rootUnitOf(tx, t.companyId, unknownStdBundle);

          const { rows } = await tx.query<{ id: string }>(
            `SELECT id FROM bundles WHERE company_id = $1 AND diameter_mm = 20 AND origin_type = 'OPENING_STOCK' LIMIT 1`,
            [t.companyId],
          );
          const rootKnown = await rootUnitOf(tx, t.companyId, rows[0]!.id);

          const unitUnknown = await dispatchAndReceiveOne(tx, t.companyId, {
            projectId: t.projectIds.hotel, fromLocationId: t.storageLocationIds.mainYard, toLocationId: t.storageLocationIds.centralWorkshop,
            membershipId: warehouseMembershipId, sourceMaterialUnitId: rootUnknown, quantityPieces: 1, unitLengthM: 12, totalLengthM: 12,
          });
          const unitKnown = await dispatchAndReceiveOne(tx, t.companyId, {
            projectId: t.projectIds.hotel, fromLocationId: t.storageLocationIds.mainYard, toLocationId: t.storageLocationIds.centralWorkshop,
            membershipId: warehouseMembershipId, sourceMaterialUnitId: rootKnown, quantityPieces: 1, unitLengthM: 12, totalLengthM: 12,
          });

          await recordProcessingOperation(tx, t.companyId, {
            projectId: t.projectIds.hotel,
            referenceCode: `ST-PROC-${randomUUID().slice(0, 8)}`,
            operationTypeId: cuttingOpTypeId, // requires_uniform_input_spec = true
            storageLocationId: t.storageLocationIds.centralWorkshop,
            performedByMembershipId: workshopMembershipId,
            inputs: [
              { materialUnitId: unitKnown, quantityConsumedPieces: 1, lengthConsumedM: 12 },
              { materialUnitId: unitUnknown, quantityConsumedPieces: 1, lengthConsumedM: 12 },
            ],
            outputs: [],
          });
        }),
      "a NULL standard must be treated as UNKNOWN, never as a match, under requires_uniform_input_spec=true",
    );
  });

  await test("(c) maker=checker self-approval is rejected", async () => {
    await assertRejects(
      () =>
        executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `SELECT id FROM bundles WHERE company_id = $1 AND diameter_mm = 24 AND origin_type = 'OPENING_STOCK' LIMIT 1`,
            [t.companyId],
          );
          const rootUnit = await rootUnitOf(tx, t.companyId, rows[0]!.id);
          const unit = await dispatchAndReceiveOne(tx, t.companyId, {
            projectId: t.projectIds.hotel, fromLocationId: t.storageLocationIds.mainYard, toLocationId: t.storageLocationIds.centralWorkshop,
            membershipId: warehouseMembershipId, sourceMaterialUnitId: rootUnit, quantityPieces: 1, unitLengthM: 1, totalLengthM: 1,
          });
          const op = await recordProcessingOperation(tx, t.companyId, {
            projectId: t.projectIds.hotel,
            referenceCode: `ST-PROC-${randomUUID().slice(0, 8)}`,
            operationTypeId: cuttingOpTypeId,
            storageLocationId: t.storageLocationIds.centralWorkshop,
            performedByMembershipId: workshopMembershipId, // <- maker
            inputs: [{ materialUnitId: unit, quantityConsumedPieces: 1, lengthConsumedM: 1 }],
            outputs: [{ attributionMode: "EXACT", quantityPieces: 1, unitLengthM: 1, totalLengthM: 1, sources: [{ sourceInputMaterialUnitId: unit, contributionWeight: 1 }] }],
          });
          // same membership attempts to also be the checker:
          await recordApproval(tx, t.companyId, "processing_operations", op.operationId, workshopMembershipId);
        }),
      "the maker and checker must not be the same membership",
    );
  });

  await test("(d) direct INSERT by steeltrace_app on a controlled table is rejected", async () => {
    await assertRejects(
      () =>
        executor.runAs({ role: "steeltrace_app", companyId: t.companyId }, async (tx) => {
          await tx.query(
            `INSERT INTO material_units (company_id, project_id, source_bundle_id, granularity, classification, status,
               diameter_mm, grade, grade_normalized, standard, surface_type, quantity_pieces, total_length_m, created_at, updated_at)
             VALUES ($1, NULL, NULL, 'BATCH', 'PENDING_RECONCILIATION', 'AVAILABLE', 12, 'X', 'X', 'DEFORMED', 1, 1, now(), now())`,
            [t.companyId],
          );
        }),
      "steeltrace_app must have no direct INSERT grant on material_units",
    );
  });

  await test("(e) cross-tenant access under RLS is blocked (Company B cannot see/write Company A's rows)", async () => {
    const companyBId = randomUUID();
    companiesToClean.push(companyBId);
    await executor.runAs({ role: "steeltrace_app", companyId: companyBId }, async (tx) => {
      await tx.query(`INSERT INTO companies (id, name) VALUES ($1, $2)`, [companyBId, "Second Construction Client (test)"]);
    });

    // Company A's bundle is invisible from a Company B session.
    await executor.runAs({ role: "steeltrace_app", companyId: companyBId }, async (tx) => {
      const { rows } = await tx.query(`SELECT id FROM bundles WHERE id = $1`, [t.openingStockBundleIds[0]]);
      assertEqual(rows.length, 0, "Company A's bundle must not be visible under Company B's context");
    });

    // A cross-tenant WRITE attempt is rejected by the WITH CHECK clause.
    await assertRejects(
      () =>
        executor.runAs({ role: "steeltrace_app", companyId: companyBId }, async (tx) => {
          await tx.query(`INSERT INTO storage_locations (company_id, name, location_type) VALUES ($1, 'Hacked', 'WAREHOUSE')`, [t.companyId]);
        }),
      "inserting a row whose company_id does not match app.current_company_id must violate the RLS WITH CHECK policy",
    );
  });
  } finally {
    // Isolated test tenant + Company B cleanup — runs whether the suite
    // above passed, failed, or threw, so the live database never
    // accumulates orphaned test companies across runs (this is what was
    // missing before: every prior run left its own "Second Construction
    // Client (test)" company behind, and scenarios 2-5 wrote directly into
    // the real seeded client company instead of an isolated tenant).
    console.log(`\nCleaning up ${companiesToClean.length} test company tenant(s)...`);
    await cleanupTestCompanies(executor, companiesToClean);
  }

  // =========================================================================
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
