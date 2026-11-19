import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withIdentityServiceContext } from "../../db/tenantContext";
import { ApiError, ForbiddenError, NotFoundError, UnauthorizedError } from "../../api/errors";
import { requireAuth, requireTenantAuth, withAuthedTenantContext } from "./middleware";
import { signToken } from "./jwt";
import { hashPassword, verifyPassword } from "./password";

const COMPANY_ADMIN_ROLE_NAME = "Company Admin";
const INVITATION_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const registerBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "password must be at least 8 characters"),
  displayName: z.string().trim().min(1),
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const switchCompanyBody = z.object({
  companyId: z.string().uuid(),
});

const createInvitationBody = z.object({
  invitedEmail: z.string().trim().toLowerCase().email(),
  roleId: z.string().uuid(),
  expiresInDays: z.number().int().positive().optional(),
});

const acceptInvitationBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8).optional(),
  displayName: z.string().trim().min(1).optional(),
});

const updateMeBody = z.object({
  displayName: z.string().trim().min(1).optional(),
});

interface MembershipRow {
  id: string;
  company_id: string;
  role_id: string;
  is_active: boolean;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  is_active: boolean;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // POST /api/auth/register — §6: creates the global `users` row via the
  // identity-service role (never `steeltrace_app`, which has no INSERT
  // grant on `users` at all). A freshly registered user has no company
  // membership yet — the response carries no token; the person either
  // accepts an invitation (`/api/invitations/accept`) or, once they hold a
  // membership, calls `/api/auth/login`.
  // -------------------------------------------------------------------------
  app.post("/api/auth/register", async (request) => {
    const body = registerBody.parse(request.body);

    const passwordHash = await hashPassword(body.password);
    const user = await withIdentityServiceContext(async (tx) => {
      const rows = await tx.$queryRawUnsafe<UserRow[]>(
        `INSERT INTO users (email, display_name, auth_provider, password_hash, is_active)
         VALUES ($1, $2, 'password', $3, true)
         RETURNING id, email, display_name, password_hash, is_active`,
        body.email,
        body.displayName,
        passwordHash,
      );
      return rows[0]!;
    });

    return {
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
    };
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/login — §6a: authenticates, then resolves every ACTIVE
  // company_memberships row this user holds (across every company — the
  // narrow `company_memberships_identity_service_self` RLS policy, 06, is
  // what makes that possible without a company context yet) and enriches
  // each with its role/company name via a normal per-company-scoped query.
  // The first membership (by joinedAt) becomes the token's initial active
  // company; a user with zero memberships gets `activeCompanyId: null`.
  // -------------------------------------------------------------------------
  app.post("/api/auth/login", async (request) => {
    const body = loginBody.parse(request.body);

    const user = await withIdentityServiceContext(async (tx) => {
      const rows = await tx.$queryRawUnsafe<UserRow[]>(
        `SELECT id, email, display_name, password_hash, is_active FROM users WHERE email = $1`,
        body.email,
      );
      return rows[0] ?? null;
    });

    if (!user || !user.is_active || !user.password_hash || !(await verifyPassword(body.password, user.password_hash))) {
      throw new UnauthorizedError("Invalid email or password");
    }

    const memberships = await withIdentityServiceContext(
      async (tx) =>
        tx.$queryRawUnsafe<MembershipRow[]>(
          `SELECT id, company_id, role_id, is_active FROM company_memberships
            WHERE user_id = $1::uuid AND is_active = true
            ORDER BY joined_at ASC`,
          user.id,
        ),
      undefined,
      { userId: user.id },
    );

    const enriched = await Promise.all(
      memberships.map((m) =>
        withIdentityServiceContext(
          async (tx) => {
            const rows = await tx.$queryRawUnsafe<{ role_name: string; company_name: string }[]>(
              `SELECT r.name AS role_name, c.name AS company_name
                 FROM company_memberships cm
                 JOIN roles r ON r.company_id = cm.company_id AND r.id = cm.role_id
                 JOIN companies c ON c.id = cm.company_id
                WHERE cm.company_id = $1::uuid AND cm.id = $2::uuid`,
              m.company_id,
              m.id,
            );
            return { ...m, ...rows[0]! };
          },
          undefined,
          { companyId: m.company_id },
        ),
      ),
    );

    const active = enriched[0] ?? null;
    const token = signToken({
      userId: user.id,
      activeCompanyId: active?.company_id ?? null,
      activeMembershipId: active?.id ?? null,
      roleName: active?.role_name ?? null,
    });

    return {
      token,
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      memberships: enriched.map((m) => ({
        membershipId: m.id,
        companyId: m.company_id,
        companyName: m.company_name,
        roleId: m.role_id,
        roleName: m.role_name,
      })),
      activeCompanyId: active?.company_id ?? null,
    };
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/switch-company — §6a: re-issues the token with a
  // different active company, after confirming the caller actually holds
  // an ACTIVE membership there (never trusts the client-supplied companyId
  // without this check).
  // -------------------------------------------------------------------------
  app.post("/api/auth/switch-company", { preHandler: requireAuth }, async (request) => {
    const body = switchCompanyBody.parse(request.body);
    const userId = request.auth!.userId;

    const membership = await withIdentityServiceContext(
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ id: string; role_name: string }[]>(
          `SELECT cm.id, r.name AS role_name
             FROM company_memberships cm
             JOIN roles r ON r.company_id = cm.company_id AND r.id = cm.role_id
            WHERE cm.company_id = $1::uuid AND cm.user_id = $2::uuid AND cm.is_active = true`,
          body.companyId,
          userId,
        );
        return rows[0] ?? null;
      },
      undefined,
      { companyId: body.companyId },
    );

    if (!membership) {
      throw new ForbiddenError("Not an active member of this company");
    }

    const token = signToken({
      userId,
      activeCompanyId: body.companyId,
      activeMembershipId: membership.id,
      roleName: membership.role_name,
    });

    return { token, activeCompanyId: body.companyId, activeMembershipId: membership.id, roleName: membership.role_name };
  });

  // -------------------------------------------------------------------------
  // POST /api/invitations — Company Admin only (§6, §2.19's maker/checker
  // vocabulary doesn't cover membership roles, but inviting new members is
  // clearly an admin action; `roleName` comes straight from the caller's
  // own token, refreshed at every login/switch-company). Never queries
  // `users` — an invitation is addressed to an email, resolved to an
  // account only at acceptance (§6).
  // -------------------------------------------------------------------------
  app.post("/api/invitations", { preHandler: requireTenantAuth }, async (request) => {
    if (request.auth!.roleName !== COMPANY_ADMIN_ROLE_NAME) {
      throw new ForbiddenError("Only a Company Admin may create invitations");
    }
    const body = createInvitationBody.parse(request.body);
    const { companyId, membershipId } = request.tenantContext!;

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(
      Date.now() + (body.expiresInDays !== undefined ? body.expiresInDays * 24 * 60 * 60 * 1000 : INVITATION_DEFAULT_TTL_MS),
    );

    const invitation = await withAuthedTenantContext(request, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO company_invitations (company_id, invited_email, role_id, invited_by_membership_id, expires_at, status, token_hash, invited_at)
         VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, $5::timestamptz, 'PENDING', $6::text, now())
         RETURNING id`,
        companyId,
        body.invitedEmail,
        body.roleId,
        membershipId,
        expiresAt,
        tokenHash,
      );
      return rows[0]!;
    });

    // Raw token returned ONLY here, for dev/testing — real email delivery
    // is not wired up yet (CLAUDE.md §8 Q4/Q6 territory); production must
    // deliver this via an actual email send and never echo it in the API
    // response.
    return { invitationId: invitation.id, invitedEmail: body.invitedEmail, token: rawToken, expiresAt };
  });

  // -------------------------------------------------------------------------
  // POST /api/invitations/accept — §6: no auth required (the invitee may
  // not have an account yet). Verifies token_hash + status + expiry, then
  // finds-or-creates the `users` row by the invitation's own invited_email
  // (never by a client-supplied email, so acceptance can only ever grant
  // the membership the invitation itself named) and inserts the
  // membership, all as `steeltrace_identity_service` in one transaction.
  // -------------------------------------------------------------------------
  app.post("/api/invitations/accept", async (request) => {
    const body = acceptInvitationBody.parse(request.body);
    const tokenHash = createHash("sha256").update(body.token).digest("hex");

    const invitation = await withIdentityServiceContext((tx) =>
      tx.$queryRawUnsafe<
        { id: string; company_id: string; invited_email: string; role_id: string; status: string; expires_at: Date | null }[]
      >(`SELECT id, company_id, invited_email, role_id, status, expires_at FROM company_invitations WHERE token_hash = $1`, tokenHash),
    ).then((rows) => rows[0] ?? null);

    if (!invitation) {
      throw new NotFoundError("Invitation not found or already used");
    }
    if (invitation.status !== "PENDING") {
      throw new ApiError(409, "INVITATION_NOT_PENDING", `Invitation has already been ${invitation.status.toLowerCase()}`);
    }
    if (invitation.expires_at && invitation.expires_at.getTime() < Date.now()) {
      throw new ApiError(410, "INVITATION_EXPIRED", "Invitation has expired");
    }

    const result = await withIdentityServiceContext(
      async (tx) => {
        let user = (
          await tx.$queryRawUnsafe<UserRow[]>(`SELECT id, email, display_name, password_hash, is_active FROM users WHERE email = $1`, invitation.invited_email)
        )[0];

        if (!user) {
          if (!body.password) {
            throw new ApiError(400, "PASSWORD_REQUIRED", "password is required to create a new account");
          }
          const passwordHash = await hashPassword(body.password);
          user = (
            await tx.$queryRawUnsafe<UserRow[]>(
              `INSERT INTO users (email, display_name, auth_provider, password_hash, is_active)
               VALUES ($1, $2, 'password', $3, true)
               RETURNING id, email, display_name, password_hash, is_active`,
              invitation.invited_email,
              body.displayName ?? invitation.invited_email,
              passwordHash,
            )
          )[0]!;
        }

        const existing = await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM company_memberships WHERE company_id = $1::uuid AND user_id = $2::uuid`,
          invitation.company_id,
          user.id,
        );
        let membershipId: string;
        if (existing[0]) {
          membershipId = existing[0].id;
          await tx.$executeRawUnsafe(
            `UPDATE company_memberships SET is_active = true, role_id = $3::uuid WHERE company_id = $1::uuid AND id = $2::uuid`,
            invitation.company_id,
            membershipId,
            invitation.role_id,
          );
        } else {
          const inserted = await tx.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO company_memberships (company_id, user_id, role_id, is_active, joined_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, true, now())
             RETURNING id`,
            invitation.company_id,
            user.id,
            invitation.role_id,
          );
          membershipId = inserted[0]!.id;
        }

        await tx.$executeRawUnsafe(
          `UPDATE company_invitations SET status = 'ACCEPTED', accepted_user_id = $2::uuid, accepted_at = now() WHERE company_id = $1::uuid AND id = $3::uuid`,
          invitation.company_id,
          user.id,
          invitation.id,
        );

        const roleRow = (
          await tx.$queryRawUnsafe<{ name: string }[]>(
            `SELECT name FROM roles WHERE company_id = $1::uuid AND id = $2::uuid`,
            invitation.company_id,
            invitation.role_id,
          )
        )[0]!;

        return { user, membershipId, roleName: roleRow.name };
      },
      undefined,
      { companyId: invitation.company_id },
    );

    const token = signToken({
      userId: result.user.id,
      activeCompanyId: invitation.company_id,
      activeMembershipId: result.membershipId,
      roleName: result.roleName,
    });

    return {
      token,
      userId: result.user.id,
      companyId: invitation.company_id,
      membershipId: result.membershipId,
      roleName: result.roleName,
    };
  });

  // -------------------------------------------------------------------------
  // PATCH /api/memberships/:membershipId/deactivate — Company Admin only.
  // Never deletes (§15) — flips is_active and records who/when, via an
  // ordinary app-role UPDATE (granted, 01) under RLS, so the target
  // membership must belong to the caller's own active company.
  // -------------------------------------------------------------------------
  app.patch<{ Params: { membershipId: string } }>(
    "/api/memberships/:membershipId/deactivate",
    { preHandler: requireTenantAuth },
    async (request) => {
      if (request.auth!.roleName !== COMPANY_ADMIN_ROLE_NAME) {
        throw new ForbiddenError("Only a Company Admin may deactivate memberships");
      }
      const membershipId = z.string().uuid().parse(request.params.membershipId);
      const { companyId, membershipId: callerMembershipId } = request.tenantContext!;

      const updated = await withAuthedTenantContext(request, async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
          `UPDATE company_memberships
              SET is_active = false, deactivated_at = now(), deactivated_by_membership_id = $3::uuid
            WHERE company_id = $1::uuid AND id = $2::uuid AND is_active = true
            RETURNING id`,
          companyId,
          membershipId,
          callerMembershipId,
        );
        return rows[0] ?? null;
      });

      if (!updated) {
        throw new NotFoundError("Active membership not found");
      }
      return { membershipId: updated.id, deactivated: true };
    },
  );

  // -------------------------------------------------------------------------
  // GET/PATCH /api/users/me — self-service profile (§6b). Routed through
  // `steeltrace_identity_service` (unrestricted `users_identity_service_*`
  // policies, 06) rather than `steeltrace_app`, so this works even for a
  // user with no active company yet; "self" is enforced at the application
  // level (`WHERE id = $userId`), not by the identity-service role's own
  // (deliberately wide) grants.
  // -------------------------------------------------------------------------
  app.get("/api/users/me", { preHandler: requireAuth }, async (request) => {
    const user = await withIdentityServiceContext((tx) =>
      tx.$queryRawUnsafe<UserRow[]>(`SELECT id, email, display_name, password_hash, is_active FROM users WHERE id = $1::uuid`, request.auth!.userId),
    ).then((rows) => rows[0] ?? null);

    if (!user) {
      throw new NotFoundError("User not found");
    }
    return { userId: user.id, email: user.email, displayName: user.display_name, isActive: user.is_active };
  });

  app.patch("/api/users/me", { preHandler: requireAuth }, async (request) => {
    const body = updateMeBody.parse(request.body);
    if (body.displayName === undefined) {
      return { updated: false };
    }

    const user = await withIdentityServiceContext((tx) =>
      tx.$queryRawUnsafe<UserRow[]>(
        `UPDATE users SET display_name = $2::text WHERE id = $1::uuid RETURNING id, email, display_name, password_hash, is_active`,
        request.auth!.userId,
        body.displayName,
      ),
    ).then((rows) => rows[0] ?? null);

    if (!user) {
      throw new NotFoundError("User not found");
    }
    return { userId: user.id, email: user.email, displayName: user.display_name };
  });
}

// Re-exported for other modules (e.g. a future invitations-list route)
// that also need the shared "Company Admin only" constant.
export { COMPANY_ADMIN_ROLE_NAME };
