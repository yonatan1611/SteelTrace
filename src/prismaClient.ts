import { PrismaClient } from "@prisma/client";

// Scaffolding only (Task 2) — the ordinary application role this client
// connects as (DATABASE_URL, the Neon pooled connection) operates under Row-
// Level Security. Task 3 will add the `withTenantContext` helper that wraps
// every request in an interactive `$transaction` and issues
// `SET LOCAL app.current_company_id` / `SET LOCAL app.current_user_id` as
// its first statement (docs/physical-database-design.md §13) — no query
// against a tenant-scoped table should be issued through this client
// without that context set first.
export const prisma = new PrismaClient();
