import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { fastifyErrorHandler } from "./errors";

// Defense in depth (Task 6): Postgres `count(*)`/`count(col)` returns
// `bigint`, which Prisma's raw-query layer maps to JS `BigInt` — and
// `BigInt` has no default `JSON.stringify` behavior at all (it throws,
// crashing the response with a 500 "Do not know how to serialize a
// BigInt", found running GET /api/reports/consumption for the first
// time). Every call site that returns a `count(...)` is also fixed to
// cast `::int` in its own SQL — this global `toJSON` is the safety net
// for every one of them we haven't (or won't) think to cast, since a row
// count in this application's reports never approaches
// `Number.MAX_SAFE_INTEGER`.
(BigInt.prototype as unknown as { toJSON(): number }).toJSON = function (this: bigint) {
  return Number(this);
};


import { registerAuthRoutes } from "../modules/auth/routes";
import { registerMasterDataRoutes } from "../modules/master-data/routes";
import { registerBundleRoutes } from "../modules/bundles/routes";
import { registerInventoryRoutes } from "../modules/inventory/routes";
import { registerTransferRoutes } from "../modules/transfers/routes";
import { registerBbsRoutes } from "../modules/bbs/routes";
import { registerProcessingRoutes } from "../modules/processing/routes";
import { registerRemnantRoutes } from "../modules/remnants/routes";
import { registerCountRoutes } from "../modules/counts/routes";
import { registerInstallationRoutes } from "../modules/installations/routes";
import { registerReportRoutes } from "../modules/reports/routes";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.setErrorHandler(fastifyErrorHandler);

  // Vite's dev server proxies /api same-origin (vite.config.ts), so this is
  // only exercised when the web/ build is served from a different origin
  // than the API in production.
  app.register(cors, { origin: true });

  app.get("/health", async () => ({ status: "ok" }));

  registerAuthRoutes(app);
  registerMasterDataRoutes(app);
  registerBundleRoutes(app);
  registerInventoryRoutes(app);
  registerTransferRoutes(app);
  registerBbsRoutes(app);
  registerProcessingRoutes(app);
  registerRemnantRoutes(app);
  registerCountRoutes(app);
  registerInstallationRoutes(app);
  registerReportRoutes(app);

  return app;
}

async function main(): Promise<void> {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
