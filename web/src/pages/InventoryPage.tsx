import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Scissors, ArrowRightLeft } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Badge, Button, Card, ErrorBanner, Field, Modal, PageHeader, Spinner, inputClass } from "../components/ui";

interface MaterialUnitRow {
  id: string;
  project_id: string | null;
  current_storage_location_id: string | null;
  status: string;
  classification: string;
  granularity: string;
  surface_type: string;
  diameter_mm: string;
  grade_normalized: string;
  internal_reference_code: string | null;
  total_length_m: string;
  remainingLengthM: string | null;
  theoreticalWeightKg: string | null;
}
interface LookupRow {
  id: string;
  name: string;
}

const STATUSES = ["AVAILABLE", "RESERVED", "CONSUMED", "DISPATCHED", "INSTALLED", "ON_HOLD"];
const CLASSIFICATIONS = ["ORIGINAL", "PENDING_RECONCILIATION", "PREPARED", "OFFCUT", "SCRAP"];

export function InventoryPage() {
  const [params] = useSearchParams();
  const highlight = params.get("highlight");

  const [units, setUnits] = useState<MaterialUnitRow[]>([]);
  const [projects, setProjects] = useState<LookupRow[]>([]);
  const [locations, setLocations] = useState<LookupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState({
    projectId: "",
    storageLocationId: "",
    status: "",
    classification: "",
    diameterMm: "",
    unallocatedOnly: false,
  });

  const [splitFor, setSplitFor] = useState<MaterialUnitRow | null>(null);
  const [splitForm, setSplitForm] = useState({ quantityPieces: "", totalLengthM: "", granularity: "BATCH", reason: "" });

  const [reallocateFor, setReallocateFor] = useState<MaterialUnitRow | null>(null);
  const [reallocateTo, setReallocateTo] = useState("");
  const [reallocateReason, setReallocateReason] = useState("");

  const [actionError, setActionError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", "500");
      if (filters.projectId) qs.set("projectId", filters.projectId);
      if (filters.storageLocationId) qs.set("storageLocationId", filters.storageLocationId);
      if (filters.status) qs.set("status", filters.status);
      if (filters.classification) qs.set("classification", filters.classification);
      if (filters.diameterMm) qs.set("diameterMm", filters.diameterMm);
      if (filters.unallocatedOnly) qs.set("unallocatedOnly", "true");
      setUnits(await api.get<MaterialUnitRow[]>(`/inventory?${qs.toString()}`));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Failed to load inventory");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => {
    api.get<LookupRow[]>("/projects").then(setProjects).catch(() => {});
    api.get<LookupRow[]>("/storage-locations").then(setLocations).catch(() => {});
  }, []);

  const sorted = useMemo(() => {
    if (!highlight) return units;
    const idx = units.findIndex((u) => u.id === highlight);
    if (idx <= 0) return units;
    const copy = [...units];
    const [item] = copy.splice(idx, 1);
    copy.unshift(item);
    return copy;
  }, [units, highlight]);

  async function submitSplit(e: FormEvent) {
    e.preventDefault();
    if (!splitFor) return;
    setActionError(null);
    try {
      await api.post(`/material-units/${splitFor.id}/split`, {
        quantityPieces: Number(splitForm.quantityPieces),
        totalLengthM: Number(splitForm.totalLengthM),
        granularity: splitForm.granularity,
        reason: splitForm.reason,
      });
      setSplitFor(null);
      setSplitForm({ quantityPieces: "", totalLengthM: "", granularity: "BATCH", reason: "" });
      await reload();
    } catch (e) {
      setActionError(e instanceof ApiRequestError ? e.message : "Could not split unit");
    }
  }

  async function submitReallocate(e: FormEvent) {
    e.preventDefault();
    if (!reallocateFor) return;
    setActionError(null);
    try {
      await api.post(`/material-units/${reallocateFor.id}/reallocate`, {
        toProjectId: reallocateTo || null,
        reason: reallocateReason,
      });
      setReallocateFor(null);
      setReallocateTo("");
      setReallocateReason("");
      await reload();
    } catch (e) {
      setActionError(e instanceof ApiRequestError ? e.message : "Could not reallocate unit");
    }
  }

  function projectName(id: string | null): string {
    if (!id) return "Unallocated";
    return projects.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  }

  return (
    <div>
      <PageHeader title="Yard & Inventory Control" />
      <ErrorBanner message={error} />
      <ErrorBanner message={actionError} />

      <Card className="mb-4 flex flex-wrap gap-3">
        <select value={filters.projectId} onChange={(e) => setFilters({ ...filters, projectId: e.target.value })} className={inputClass}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={filters.storageLocationId} onChange={(e) => setFilters({ ...filters, storageLocationId: e.target.value })} className={inputClass}>
          <option value="">All locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} className={inputClass}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={filters.classification} onChange={(e) => setFilters({ ...filters, classification: e.target.value })} className={inputClass}>
          <option value="">All classifications</option>
          {CLASSIFICATIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          type="number"
          placeholder="Diameter mm"
          value={filters.diameterMm}
          onChange={(e) => setFilters({ ...filters, diameterMm: e.target.value })}
          className={`${inputClass} w-32`}
        />
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={filters.unallocatedOnly} onChange={(e) => setFilters({ ...filters, unallocatedOnly: e.target.checked })} />
          Unallocated stock only
        </label>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="py-2 pl-4">Code / ID</th>
                <th>Project</th>
                <th>Diameter</th>
                <th>Surface</th>
                <th>Grade</th>
                <th>Granularity</th>
                <th>Classification</th>
                <th>Status</th>
                <th className="text-right">Remaining (m)</th>
                <th className="pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((u) => (
                <tr key={u.id} className={`border-b border-slate-100 ${u.id === highlight ? "bg-amber-50" : ""}`}>
                  <td className="py-2 pl-4 font-mono text-xs">{u.internal_reference_code ?? u.id.slice(0, 8)}</td>
                  <td>{projectName(u.project_id)}</td>
                  <td>{u.diameter_mm} mm</td>
                  <td>{u.surface_type}</td>
                  <td>{u.grade_normalized}</td>
                  <td>{u.granularity}</td>
                  <td>
                    <Badge value={u.classification} />
                  </td>
                  <td>
                    <Badge value={u.status} />
                  </td>
                  <td className="text-right">{u.remainingLengthM ? Number(u.remainingLengthM).toFixed(2) : "—"}</td>
                  <td className="pr-4 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        title="Split unit"
                        onClick={() => setSplitFor(u)}
                        className="rounded p-1.5 text-slate-500 hover:bg-slate-100"
                      >
                        <Scissors size={15} />
                      </button>
                      <button
                        title="Reallocate project"
                        onClick={() => {
                          setReallocateFor(u);
                          setReallocateTo(u.project_id ?? "");
                        }}
                        className="rounded p-1.5 text-slate-500 hover:bg-slate-100"
                      >
                        <ArrowRightLeft size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-6 text-center text-slate-400">
                    No material units match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {splitFor && (
        <Modal title="Split Unit" onClose={() => setSplitFor(null)}>
          <p className="mb-3 text-sm text-slate-500">
            Splits off a new material unit from {splitFor.internal_reference_code ?? splitFor.id.slice(0, 8)} (remaining:{" "}
            {splitFor.remainingLengthM ? Number(splitFor.remainingLengthM).toFixed(2) : "—"} m). Used before a partial reservation or reallocation.
          </p>
          <form onSubmit={submitSplit} className="flex flex-col gap-3">
            <Field label="Pieces to split off">
              <input required type="number" min={1} value={splitForm.quantityPieces} onChange={(e) => setSplitForm({ ...splitForm, quantityPieces: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Total length to split off (m)">
              <input required type="number" step="0.01" value={splitForm.totalLengthM} onChange={(e) => setSplitForm({ ...splitForm, totalLengthM: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Granularity">
              <select value={splitForm.granularity} onChange={(e) => setSplitForm({ ...splitForm, granularity: e.target.value })} className={inputClass}>
                <option value="BATCH">Batch</option>
                <option value="BUNDLE">Bundle</option>
                <option value="PIECE">Piece</option>
              </select>
            </Field>
            <Field label="Reason">
              <input required value={splitForm.reason} onChange={(e) => setSplitForm({ ...splitForm, reason: e.target.value })} className={inputClass} />
            </Field>
            <Button type="submit" className="justify-center">
              Split
            </Button>
          </form>
        </Modal>
      )}

      {reallocateFor && (
        <Modal title="Reallocate Project" onClose={() => setReallocateFor(null)}>
          <p className="mb-3 text-sm text-slate-500">
            Reallocation changes project ownership only — the material's physical storage location is unchanged.
          </p>
          <form onSubmit={submitReallocate} className="flex flex-col gap-3">
            <Field label="New project">
              <select value={reallocateTo} onChange={(e) => setReallocateTo(e.target.value)} className={inputClass}>
                <option value="">Unallocated (no project)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason">
              <input required value={reallocateReason} onChange={(e) => setReallocateReason(e.target.value)} className={inputClass} />
            </Field>
            <Button type="submit" className="justify-center">
              Reallocate
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
