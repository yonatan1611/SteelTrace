import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import type { Prisma } from "@prisma/client";
import { ApiError, UnauthorizedError } from "../../api/errors";
import { withTenantContext, type TenantContext } from "../../db/tenantContext";
import { type AuthTokenPayload, verifyToken } from "./jwt";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthTokenPayload;
    tenantContext?: TenantContext;
  }
}

function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or malformed Authorization header");
  }
  return header.slice("Bearer ".length).trim();
}

function decodeAuth(request: FastifyRequest): AuthTokenPayload {
  const token = extractBearerToken(request);
  try {
    return verifyToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError("Session token expired");
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new UnauthorizedError("Invalid session token");
    }
    throw err;
  }
}

/**
 * Attaches `request.auth` for routes that only need to know WHO is calling,
 * not which company's data they're touching — `/api/users/me`,
 * `/api/auth/switch-company`, accepting an invitation, etc.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  request.auth = decodeAuth(request);
}

/**
 * Attaches both `request.auth` and `request.tenantContext` — every
 * tenant-scoped route (master data, bundles, inventory, transfers, §12/§13)
 * uses this as its `preHandler`, then calls `withAuthedTenantContext` to run
 * its actual DB work. Rejects (400) a token with no active company — the
 * caller must `/api/auth/switch-company` first (§6a).
 */
export async function requireTenantAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const auth = decodeAuth(request);
  if (!auth.activeCompanyId || !auth.activeMembershipId) {
    throw new ApiError(400, "NO_ACTIVE_COMPANY", "No active company selected — call /api/auth/switch-company first");
  }
  request.auth = auth;
  request.tenantContext = {
    companyId: auth.activeCompanyId,
    userId: auth.userId,
    membershipId: auth.activeMembershipId,
  };
}

/** Convenience wrapper: runs `fn` under the tenant context `requireTenantAuth` already attached to `request`. */
export function withAuthedTenantContext<T>(
  request: FastifyRequest,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!request.tenantContext) {
    throw new ApiError(500, "MISSING_TENANT_CONTEXT", "requireTenantAuth preHandler was not applied to this route");
  }
  return withTenantContext(request.tenantContext, fn);
}
