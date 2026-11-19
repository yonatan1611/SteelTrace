import { Prisma } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/**
 * Explicit, application-raised HTTP error — routes/services throw these
 * directly for conditions the database layer never sees (auth failures,
 * request-shape problems caught before a query is even issued, etc.).
 * `mapDatabaseError` below produces the same shape for errors that DO
 * originate from Postgres, so every route's error handling collapses onto
 * one `setErrorHandler` (registered in src/api/server.ts).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string) {
    super(400, "BAD_REQUEST", message);
  }
}
export class UnauthorizedError extends ApiError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}
export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden") {
    super(403, "FORBIDDEN", message);
  }
}
export class NotFoundError extends ApiError {
  constructor(message = "Not found") {
    super(404, "NOT_FOUND", message);
  }
}
export class ConflictError extends ApiError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
  }
}
export class UnprocessableEntityError extends ApiError {
  constructor(message: string) {
    super(422, "UNPROCESSABLE_ENTITY", message);
  }
}

/**
 * PostgreSQL SQLSTATE → HTTP mapping (Task 5, Step 1).
 *
 * Every controlled function (05) and every RLS/CHECK/FK constraint in this
 * schema surfaces to the application as a Postgres error, not a
 * hand-thrown JS one — `register_bundle` rejecting a bad input and a CHECK
 * constraint rejecting it look identical from here. Two call shapes reach
 * this mapper:
 *   - Raw queries (`tx.$queryRaw`/`$executeRaw(Unsafe)`, used for every
 *     controlled-function call): Prisma wraps the failure as
 *     `PrismaClientKnownRequestError` with `code: "P2010"` and the REAL
 *     Postgres SQLSTATE in `meta.code` (verified against live neondb —
 *     see git history of this file for the probe) — `meta.message` carries
 *     the original `ERROR: ...` text, which for `P0001` IS the exact
 *     business-rule message a controlled function raised.
 *   - Typed Prisma Client calls (used for ordinary master-data CRUD under
 *     RLS, Step 3): Prisma's OWN `P2002`/`P2003`/`P2025` codes, which mean
 *     the same things as the raw SQLSTATEs below but are never the literal
 *     5-character Postgres code.
 */
const SQLSTATE_RAISE_EXCEPTION = "P0001"; // controlled-function business-rule RAISE EXCEPTION
const SQLSTATE_CHECK_VIOLATION = "23514";
const SQLSTATE_UNIQUE_VIOLATION = "23505";
const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";
const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501"; // includes RLS WITH CHECK/USING denial

function stripPgErrorPrefix(message: string): string {
  // Postgres raw error text is prefixed "ERROR: " (and sometimes carries a
  // trailing "\nHINT: ..." / "\nDETAIL: ..." line) — strip down to the
  // single line a client should see.
  return message.replace(/^ERROR:\s*/, "").split("\n")[0]!.trim();
}

function fromSqlState(sqlState: string, rawMessage: string): ApiError | null {
  const message = stripPgErrorPrefix(rawMessage);
  switch (sqlState) {
    case SQLSTATE_RAISE_EXCEPTION:
      // The exact business-rule message a controlled function raised
      // (§12). Every controlled function uses the SAME "<thing> % not
      // found for company %" wording (register_bundle, split_material_
      // unit, dispatch_material_transfer, receive_transfer_line,
      // reallocate_project, release_hold, record_approval) for a row that
      // either genuinely doesn't exist OR exists in a different tenant —
      // RLS (06) makes those two cases indistinguishable to the function
      // itself, by design, and the HTTP layer must preserve that: a
      // cross-tenant write attempt must read as "not found," not as a
      // generic 400 that would at least confirm something unusual is
      // happening. Every OTHER P0001 (conservation mismatch, spec
      // incompatibility, self-approval, etc.) is a genuine bad request.
      return /not found for company/i.test(message) ? new NotFoundError(message) : new BadRequestError(message);
    case SQLSTATE_CHECK_VIOLATION:
      return new UnprocessableEntityError(message);
    case SQLSTATE_UNIQUE_VIOLATION:
      return new ConflictError(message);
    case SQLSTATE_FOREIGN_KEY_VIOLATION:
      // Deliberately generic — a dangling reference and a cross-tenant
      // reference RLS has made invisible look identical from here, and
      // must stay indistinguishable to the caller (never leak cross-tenant
      // existence).
      return new NotFoundError("Referenced record not found");
    case SQLSTATE_INSUFFICIENT_PRIVILEGE:
      // Covers both a direct-grant REVOKE (steeltrace_app has no
      // INSERT/UPDATE/DELETE on a controlled table, §12) and an RLS
      // USING/WITH CHECK denial (06) — Postgres reports both as 42501.
      return new ForbiddenError("Not permitted");
    default:
      return null;
  }
}

/**
 * Attempts to map a thrown error to a structured `ApiError`. Returns
 * `null` for anything that isn't a recognized database error (callers
 * fall through to a generic 500).
 */
export function mapDatabaseError(err: unknown): ApiError | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2010" && typeof err.meta?.code === "string") {
      const message = typeof err.meta.message === "string" ? err.meta.message : err.message;
      return fromSqlState(err.meta.code, message);
    }
    switch (err.code) {
      case "P2002": // typed-query unique constraint violation
        return new ConflictError("A record with these values already exists");
      case "P2003": // typed-query foreign key constraint violation
        return new NotFoundError("Referenced record not found");
      case "P2025": // typed-query record-not-found (update/delete/connect)
        return new NotFoundError("Record not found");
      default:
        return null;
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    return new BadRequestError("Malformed request");
  }

  return null;
}

/**
 * Fastify's global error handler (registered once in src/api/server.ts).
 * Every route handler can simply `throw` — an `ApiError` it raised itself,
 * or a raw Postgres/Prisma error from a controlled-function call — and let
 * this collapse it to one consistent `{ error: { code, message } }` JSON
 * shape. Never leaks a stack trace or raw Postgres text to the client
 * except the deliberately-safe `P0001` business-rule message above.
 */
export function fastifyErrorHandler(
  err: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof ApiError) {
    reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof ZodError) {
    reply.status(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request failed validation",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }

  const mapped = mapDatabaseError(err);
  if (mapped) {
    reply.status(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
    return;
  }

  request.log.error({ err }, "unhandled error");
  reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
}
