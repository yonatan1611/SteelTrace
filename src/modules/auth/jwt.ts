import jwt from "jsonwebtoken";

/**
 * Session token payload (Task 5, §6a). `activeCompanyId`/`activeMembershipId`/
 * `roleName` are null until the user has selected (or been invited into) a
 * company — every tenant-scoped route (`requireTenantAuth`) requires them to
 * be non-null; `/api/auth/switch-company` is how they get (re)filled.
 */
export interface AuthTokenPayload {
  userId: string;
  activeCompanyId: string | null;
  activeMembershipId: string | null;
  roleName: string | null;
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
}

const TOKEN_TTL = "12h";

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, jwtSecret(), { expiresIn: TOKEN_TTL });
}

/** Throws `jwt.JsonWebTokenError`/`jwt.TokenExpiredError` on an invalid/expired token — callers map that to 401. */
export function verifyToken(token: string): AuthTokenPayload {
  const decoded = jwt.verify(token, jwtSecret());
  if (typeof decoded !== "object" || decoded === null || typeof (decoded as Record<string, unknown>).userId !== "string") {
    throw new jwt.JsonWebTokenError("malformed token payload");
  }
  const d = decoded as Record<string, unknown>;
  return {
    userId: d.userId as string,
    activeCompanyId: typeof d.activeCompanyId === "string" ? d.activeCompanyId : null,
    activeMembershipId: typeof d.activeMembershipId === "string" ? d.activeMembershipId : null,
    roleName: typeof d.roleName === "string" ? d.roleName : null,
  };
}
