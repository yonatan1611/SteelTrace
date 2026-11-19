process.env.NODE_ENV = "test";

import { randomUUID } from "node:crypto";
import type { FastifyInstance, HTTPMethods, InjectOptions } from "fastify";
import { buildServer } from "../server";
import { createExecutor, type SqlExecutor } from "../../db/bootstrapSql";
import { cleanupTestCompanies, deleteTestUsers } from "../../db/testCleanup";
import { hashPassword } from "../../modules/auth/password";

// ---------------------------------------------------------------------------
// Minimal test harness (same style as src/db/integrity.test.ts) — HTTP calls
// go through Fastify's `inject()`, so no real port/listener is needed.
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

// ---------------------------------------------------------------------------
// Isolated test-tenant bootstrap — raw SQL, NOT through the HTTP API (this
// is fixture setup, not the thing under test), and deliberately NOT via
// src/db/seed.ts: seed() reuses the SAME global `users` rows (fixed
// `ROLE_EMAILS`) across every company it seeds, including the real
// "First Construction Client" — those rows have no `password_hash` set
// (seed.ts never needed one) and must never be mutated by a test. Every
// user/email created here is test-specific and unique per run, so it can
// also be deleted outright in cleanup (unlike seed.ts's shared users).
// ---------------------------------------------------------------------------
interface TestCompany {
  companyId: string;
  roleId: string;
  projectId: string;
  project2Id: string;
  warehouseLocId: string;
  workshopLocId: string;
  adminEmail: string;
  adminPassword: string;
  adminUserId: string;
  adminMembershipId: string;
}

async function bootstrapCompany(executor: SqlExecutor, label: string): Promise<TestCompany> {
  const companyId = randomUUID();
  const roleId = randomUUID();
  const projectId = randomUUID();
  const project2Id = randomUUID();
  const warehouseLocId = randomUUID();
  const workshopLocId = randomUUID();
  const adminUserId = randomUUID();
  const adminMembershipId = randomUUID();
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@test.steeltrace`;
  const adminPassword = "AdminPass123!";

  await executor.run((tx) => tx.query(`INSERT INTO companies (id, name) VALUES ($1, $2)`, [companyId, label]));

  await executor.runAs({ role: "steeltrace_app", companyId }, async (tx) => {
    await tx.query(`INSERT INTO roles (id, company_id, name) VALUES ($1,$2,'Company Admin')`, [roleId, companyId]);
    await tx.query(`INSERT INTO projects (id, company_id, name) VALUES ($1,$2,'Test Project A')`, [projectId, companyId]);
    await tx.query(`INSERT INTO projects (id, company_id, name) VALUES ($1,$2,'Test Project B')`, [project2Id, companyId]);
    await tx.query(`INSERT INTO storage_locations (id, company_id, location_type, name) VALUES ($1,$2,'WAREHOUSE','Test Warehouse')`, [
      warehouseLocId,
      companyId,
    ]);
    await tx.query(`INSERT INTO storage_locations (id, company_id, location_type, name) VALUES ($1,$2,'PROCESSING_AREA','Test Workshop')`, [
      workshopLocId,
      companyId,
    ]);
  });

  const passwordHash = await hashPassword(adminPassword);
  await executor.runAs({ role: "steeltrace_identity_service", companyId }, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, email, display_name, auth_provider, password_hash, is_active) VALUES ($1,$2,$3,'password',$4,true)`,
      [adminUserId, adminEmail, "Test Admin", passwordHash],
    );
    await tx.query(`INSERT INTO company_memberships (id, company_id, user_id, role_id, is_active) VALUES ($1,$2,$3,$4,true)`, [
      adminMembershipId,
      companyId,
      adminUserId,
      roleId,
    ]);
  });

  return { companyId, roleId, projectId, project2Id, warehouseLocId, workshopLocId, adminEmail, adminPassword, adminUserId, adminMembershipId };
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

  console.log("Bootstrapping isolated test tenants...");
  const companyA = await bootstrapCompany(executor, `Task5 Test Co A ${randomUUID().slice(0, 8)}`);
  const companyB = await bootstrapCompany(executor, `Task5 Test Co B ${randomUUID().slice(0, 8)}`);
  companiesToClean.push(companyA.companyId, companyB.companyId);
  usersToClean.push(companyA.adminUserId, companyB.adminUserId);
  console.log(`Company A: ${companyA.companyId}\nCompany B: ${companyB.companyId}\n`);

  let adminToken = "";
  let inviteeEmail = "";
  let inviteeUserId = "";
  let inviteeMembershipId = "";
  let inviteeToken = "";
  let bundleAcceptedId = "";
  let bundleOnHoldId = "";
  let bundleOnHoldRootUnitId = "";
  let splitSourceUnitId = "";
  let splitChildUnitId = "";
  let transferRootUnitId = "";
  let transferId = "";
  let transferLineId = "";

  try {
    // =======================================================================
    console.log("1. Registration -> login -> company-switcher -> invitation -> acceptance -> deactivation");
    // =======================================================================
    await test("standalone registration + login has activeCompanyId null", async () => {
      const standaloneEmail = `standalone-${randomUUID().slice(0, 8)}@test.steeltrace`;
      const reg = await call(app, "POST", "/api/auth/register", {
        payload: { email: standaloneEmail, password: "Standalone123!", displayName: "Standalone User" },
      });
      assertEqual(reg.status, 200, "register status");
      usersToClean.push(reg.body.userId);

      const login = await call(app, "POST", "/api/auth/login", { payload: { email: standaloneEmail, password: "Standalone123!" } });
      assertEqual(login.status, 200, "login status");
      assertEqual(login.body.activeCompanyId, null, "activeCompanyId should be null with no memberships");
    });

    await test("admin login succeeds with active company", async () => {
      const login = await call(app, "POST", "/api/auth/login", { payload: { email: companyA.adminEmail, password: companyA.adminPassword } });
      assertEqual(login.status, 200, "login status");
      assertEqual(login.body.activeCompanyId, companyA.companyId, "admin's active company");
      adminToken = login.body.token;
    });

    await test("wrong password is rejected", async () => {
      const login = await call(app, "POST", "/api/auth/login", { payload: { email: companyA.adminEmail, password: "wrong-password" } });
      assertEqual(login.status, 401, "wrong password status");
    });

    await test("register invitee, admin invites, invitee accepts", async () => {
      inviteeEmail = `invitee-${randomUUID().slice(0, 8)}@test.steeltrace`;
      const reg = await call(app, "POST", "/api/auth/register", {
        payload: { email: inviteeEmail, password: "Invitee123!", displayName: "Invitee User" },
      });
      assertEqual(reg.status, 200, "invitee register status");
      inviteeUserId = reg.body.userId;
      usersToClean.push(inviteeUserId);

      const invite = await call(app, "POST", "/api/invitations", {
        token: adminToken,
        payload: { invitedEmail: inviteeEmail, roleId: companyA.roleId },
      });
      assertEqual(invite.status, 200, "invitation create status");
      assert(typeof invite.body.token === "string" && invite.body.token.length > 0, "invitation returns a raw token");

      const accept = await call(app, "POST", "/api/invitations/accept", { payload: { token: invite.body.token } });
      assertEqual(accept.status, 200, "invitation accept status");
      assertEqual(accept.body.companyId, companyA.companyId, "accepted into company A");
      inviteeMembershipId = accept.body.membershipId;
      inviteeToken = accept.body.token;
    });

    await test("invitee GET /api/users/me reflects their own profile", async () => {
      const me = await call(app, "GET", "/api/users/me", { token: inviteeToken });
      assertEqual(me.status, 200, "users/me status");
      assertEqual(me.body.email, inviteeEmail, "users/me email");
    });

    await test("invitee can switch-company into the company they were just invited to", async () => {
      const res = await call(app, "POST", "/api/auth/switch-company", { token: inviteeToken, payload: { companyId: companyA.companyId } });
      assertEqual(res.status, 200, "switch-company status");
      assertEqual(res.body.activeCompanyId, companyA.companyId, "switch-company activeCompanyId");
    });

    await test("admin deactivates the invitee's membership; further switch-company is then forbidden", async () => {
      const deactivate = await call(app, "PATCH", `/api/memberships/${inviteeMembershipId}/deactivate`, { token: adminToken });
      assertEqual(deactivate.status, 200, "deactivate status");

      const res = await call(app, "POST", "/api/auth/switch-company", { token: inviteeToken, payload: { companyId: companyA.companyId } });
      assertEqual(res.status, 403, "switch-company after deactivation should be forbidden");
    });

    // =======================================================================
    console.log("\n2. Location node cycle rejection");
    // =======================================================================
    await test("creating a cycle in location_nodes is rejected", async () => {
      const typeRes = await call(app, "POST", "/api/location-node-types", { token: adminToken, payload: { name: "Building" } });
      assertEqual(typeRes.status, 200, "location-node-type create status");
      const typeId = typeRes.body.id;

      const node1 = await call(app, "POST", "/api/location-nodes", {
        token: adminToken,
        payload: { projectId: companyA.projectId, locationNodeTypeId: typeId, name: "Node 1" },
      });
      assertEqual(node1.status, 200, "node1 create status");

      const node2 = await call(app, "POST", "/api/location-nodes", {
        token: adminToken,
        payload: { projectId: companyA.projectId, locationNodeTypeId: typeId, name: "Node 2", parentId: node1.body.id },
      });
      assertEqual(node2.status, 200, "node2 create status");

      const cycleAttempt = await call(app, "PATCH", `/api/location-nodes/${node1.body.id}`, {
        token: adminToken,
        payload: { parentId: node2.body.id },
      });
      assert(cycleAttempt.status === 400 || cycleAttempt.status === 422, `cycle rejection status, got ${cycleAttempt.status}`);
    });

    // =======================================================================
    console.log("\n3. Bundle registration, QR, maker-checker rejection, release-hold");
    // =======================================================================
    await test("register an ACCEPTED bundle and an ON_HOLD (quarantined) bundle", async () => {
      const accepted = await call(app, "POST", "/api/bundles", {
        token: adminToken,
        payload: {
          storageLocationId: companyA.warehouseLocId,
          projectId: companyA.projectId,
          internalReferenceCode: `TEST-BND-ACC-${randomUUID().slice(0, 8)}`,
          diameterMm: 12,
          grade: "B500BWR",
          pieceCount: 1,
          barLengthM: 10,
          surfaceType: "DEFORMED",
          originType: "GRN_PURCHASE",
          grnReference: "GRN-TEST-1",
          initialDisposition: "ACCEPTED",
        },
      });
      assertEqual(accepted.status, 200, "accepted bundle create status");
      bundleAcceptedId = accepted.body.bundleId;

      const onHold = await call(app, "POST", "/api/bundles", {
        token: adminToken,
        payload: {
          storageLocationId: companyA.warehouseLocId,
          internalReferenceCode: `TEST-BND-HOLD-${randomUUID().slice(0, 8)}`,
          diameterMm: 16,
          grade: "B500BWR",
          pieceCount: 1,
          barLengthM: 5,
          surfaceType: "DEFORMED",
          originType: "GRN_PURCHASE",
          grnReference: "GRN-TEST-2",
          initialDisposition: "ON_HOLD",
        },
      });
      assertEqual(onHold.status, 200, "on-hold bundle create status");
      bundleOnHoldId = onHold.body.bundleId;
      bundleOnHoldRootUnitId = onHold.body.rootMaterialUnitId;

      const detail = await call(app, "GET", `/api/bundles/${bundleOnHoldId}`, { token: adminToken });
      assertEqual(detail.status, 200, "on-hold bundle detail status");
      assertEqual(detail.body.initial_disposition, "ON_HOLD", "on-hold bundle disposition");
    });

    await test("QR code generation returns an SVG data URL", async () => {
      const qr = await call(app, "GET", `/api/bundles/${bundleAcceptedId}/qr`, { token: adminToken });
      assertEqual(qr.status, 200, "qr status");
      assert(typeof qr.body.svgDataUrl === "string" && qr.body.svgDataUrl.startsWith("data:image/svg+xml"), "qr svgDataUrl shape");
    });

    await test("approving a bundle with maker === checker is rejected", async () => {
      // adminToken both registered (maker) and is attempting to approve (checker) bundleAcceptedId.
      const approve = await call(app, "POST", `/api/bundles/${bundleAcceptedId}/approve`, { token: adminToken });
      assertEqual(approve.status, 409, "self-approval rejection status");
    });

    await test("release_hold transitions the ON_HOLD unit to AVAILABLE", async () => {
      const release = await call(app, "POST", `/api/material-units/${bundleOnHoldRootUnitId}/release-hold`, {
        token: adminToken,
        payload: { reason: "inspected, found acceptable" },
      });
      assertEqual(release.status, 200, "release-hold status");
      assertEqual(release.body.status, "AVAILABLE", "released unit status");
    });

    // =======================================================================
    console.log("\n4. Inventory, split, reallocate, multi-disposition transfer receipt");
    // =======================================================================
    await test("register a bundle, confirm it via inventory query, then split it", async () => {
      const bundle = await call(app, "POST", "/api/bundles", {
        token: adminToken,
        payload: {
          storageLocationId: companyA.warehouseLocId,
          projectId: companyA.projectId,
          internalReferenceCode: `TEST-BND-SPLIT-${randomUUID().slice(0, 8)}`,
          diameterMm: 20,
          grade: "B500BWR",
          pieceCount: 2,
          barLengthM: 10,
          surfaceType: "DEFORMED",
          originType: "GRN_PURCHASE",
          grnReference: "GRN-TEST-3",
          initialDisposition: "ACCEPTED",
        },
      });
      assertEqual(bundle.status, 200, "split-source bundle create status");
      splitSourceUnitId = bundle.body.rootMaterialUnitId;

      const inv = await call(app, "GET", "/api/inventory", { token: adminToken, query: { projectId: companyA.projectId } });
      assertEqual(inv.status, 200, "inventory query status");
      const found = (inv.body as any[]).find((u) => u.id === splitSourceUnitId);
      assert(found !== undefined, "newly registered unit appears in inventory query");
      assertEqual(Number(found.remainingLengthM), 20, "inventory remainingLengthM for 2x10m bundle");

      const split = await call(app, "POST", `/api/material-units/${splitSourceUnitId}/split`, {
        token: adminToken,
        payload: { quantityPieces: 1, totalLengthM: 10, granularity: "BATCH", reason: "test split" },
      });
      assertEqual(split.status, 200, "split status");
      splitChildUnitId = split.body.childMaterialUnitId;
      assert(typeof splitChildUnitId === "string" && splitChildUnitId.length > 0, "split returns a child unit id");
    });

    await test("reallocate_project changes project_id but leaves physical location unchanged", async () => {
      const reallocate = await call(app, "POST", `/api/material-units/${splitSourceUnitId}/reallocate`, {
        token: adminToken,
        payload: { toProjectId: companyA.project2Id, reason: "test reallocate" },
      });
      assertEqual(reallocate.status, 200, "reallocate status");

      const inv = await call(app, "GET", "/api/inventory", { token: adminToken, query: { projectId: companyA.project2Id } });
      const found = (inv.body as any[]).find((u) => u.id === splitSourceUnitId);
      assert(found !== undefined, "reallocated unit now appears under project B");
      assertEqual(found.project_id, companyA.project2Id, "unit's project_id updated");
      assertEqual(found.current_storage_location_id, companyA.warehouseLocId, "physical storage location unchanged by reallocation");
    });

    await test("dispatch + multi-disposition receive reaches RECEIVED", async () => {
      const bundle = await call(app, "POST", "/api/bundles", {
        token: adminToken,
        payload: {
          storageLocationId: companyA.warehouseLocId,
          projectId: companyA.projectId,
          internalReferenceCode: `TEST-BND-XFER-${randomUUID().slice(0, 8)}`,
          diameterMm: 10,
          grade: "B500BWR",
          pieceCount: 1,
          barLengthM: 10,
          surfaceType: "DEFORMED",
          originType: "GRN_PURCHASE",
          grnReference: "GRN-TEST-4",
          initialDisposition: "ACCEPTED",
        },
      });
      assertEqual(bundle.status, 200, "transfer-source bundle create status");
      transferRootUnitId = bundle.body.rootMaterialUnitId;

      const dispatch = await call(app, "POST", "/api/transfers", {
        token: adminToken,
        payload: {
          projectId: companyA.projectId,
          fromLocationId: companyA.warehouseLocId,
          toLocationId: companyA.workshopLocId,
          lines: [{ sourceMaterialUnitId: transferRootUnitId, quantityPieces: 1, totalLengthM: 10 }],
        },
      });
      assertEqual(dispatch.status, 200, "dispatch status");
      transferId = dispatch.body.transferId;
      transferLineId = dispatch.body.lines[0].lineId;

      const receive = await call(app, "POST", `/api/transfers/${transferId}/receive`, {
        token: adminToken,
        payload: {
          materialTransferLineId: transferLineId,
          portions: [
            { quantityPieces: 1, totalLengthM: 8, disposition: "ACCEPTED" },
            { quantityPieces: 1, totalLengthM: 1, disposition: "DAMAGED_DISCREPANT" },
            { quantityPieces: 1, totalLengthM: 1, disposition: "ON_HOLD" },
          ],
        },
      });
      assertEqual(receive.status, 200, "receive status");
      assertEqual(receive.body.transferStatus, "RECEIVED", "transfer reaches RECEIVED after full multi-disposition receipt");
    });

    // =======================================================================
    console.log("\n5. Cross-tenant isolation (Company B vs Company A)");
    // =======================================================================
    await test("Company B cannot read Company A's bundle", async () => {
      const login = await call(app, "POST", "/api/auth/login", { payload: { email: companyB.adminEmail, password: companyB.adminPassword } });
      assertEqual(login.status, 200, "company B login status");
      const companyBToken: string = login.body.token;

      const getBundle = await call(app, "GET", `/api/bundles/${bundleAcceptedId}`, { token: companyBToken });
      assertEqual(getBundle.status, 404, "cross-tenant bundle read status");

      const releaseHold = await call(app, "POST", `/api/material-units/${bundleOnHoldRootUnitId}/release-hold`, {
        token: companyBToken,
        payload: { reason: "attempted cross-tenant release" },
      });
      assert(releaseHold.status === 403 || releaseHold.status === 404, `cross-tenant release-hold status, got ${releaseHold.status}`);

      const approve = await call(app, "POST", `/api/bundles/${bundleAcceptedId}/approve`, { token: companyBToken });
      assert(approve.status === 403 || approve.status === 404, `cross-tenant approve status, got ${approve.status}`);

      const getTransfer = await call(app, "GET", `/api/transfers/${transferId}`, { token: companyBToken });
      assertEqual(getTransfer.status, 404, "cross-tenant transfer read status");
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
