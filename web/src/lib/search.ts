import { api, ApiRequestError } from "./api";

export interface SearchResult {
  kind: "bundle" | "processingOperation" | "materialUnit";
  id: string;
  path: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BundleRow {
  id: string;
  internal_reference_code: string;
}
interface ProcessingOperationRow {
  id: string;
  reference_code: string;
}
interface MaterialUnitRow {
  id: string;
  internal_reference_code: string | null;
}

/**
 * The backend has no server-side "find by human-readable code" endpoint
 * (CLAUDE.md §2.18 names the codes, but no search route was ever built for
 * them) — this does the lookup client-side against the existing list
 * endpoints, prefix-routing by the code's own convention (ST-BND-/ST-PROC-/
 * ST-REM-) and falling back to a raw-UUID probe across all three kinds.
 */
export async function resolveReferenceCode(raw: string): Promise<SearchResult | null> {
  const query = raw.trim();
  if (!query) return null;
  const upper = query.toUpperCase();

  if (upper.startsWith("ST-BND-")) {
    const bundles = await api.get<BundleRow[]>("/bundles");
    const match = bundles.find((b) => b.internal_reference_code.toUpperCase() === upper);
    return match ? { kind: "bundle", id: match.id, path: `/bundles?highlight=${match.id}` } : null;
  }

  if (upper.startsWith("ST-PROC-")) {
    const ops = await api.get<ProcessingOperationRow[]>("/processing-operations");
    const match = ops.find((o) => o.reference_code.toUpperCase() === upper);
    return match ? { kind: "processingOperation", id: match.id, path: `/processing?highlight=${match.id}` } : null;
  }

  if (upper.startsWith("ST-REM-")) {
    const units = await api.get<MaterialUnitRow[]>("/inventory?limit=1000");
    const match = units.find((u) => u.internal_reference_code?.toUpperCase() === upper);
    return match ? { kind: "materialUnit", id: match.id, path: `/inventory?highlight=${match.id}` } : null;
  }

  if (UUID_RE.test(query)) {
    try {
      await api.get(`/bundles/${query}`);
      return { kind: "bundle", id: query, path: `/bundles?highlight=${query}` };
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.status !== 404) throw err;
    }
    try {
      await api.get(`/processing-operations/${query}`);
      return { kind: "processingOperation", id: query, path: `/processing?highlight=${query}` };
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.status !== 404) throw err;
    }
    try {
      await api.get(`/material-units/${query}/qr`);
      return { kind: "materialUnit", id: query, path: `/inventory?highlight=${query}` };
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.status !== 404) throw err;
    }
  }

  return null;
}
