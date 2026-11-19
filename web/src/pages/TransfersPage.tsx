import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Truck, Inbox } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Badge, Button, Card, ErrorBanner, Field, Modal, PageHeader, Spinner, inputClass } from "../components/ui";

interface TransferRow {
  id: string;
  project_id: string;
  from_location_id: string;
  to_location_id: string;
  status: string;
  reconciliation_status: string;
  vehicle_info: string | null;
  dispatched_at: string;
}
interface TransferLineRow {
  id: string;
  material_unit_id: string;
  split_from_material_unit_id: string;
}
interface TransferDetail extends TransferRow {
  lines: TransferLineRow[];
  receipts: unknown[];
}
interface LookupRow {
  id: string;
  name: string;
}
interface MaterialUnitRow {
  id: string;
  internal_reference_code: string | null;
  diameter_mm: string;
  remainingLengthM: string | null;
  total_length_m: string;
}

interface DispatchLineForm {
  sourceMaterialUnitId: string;
  quantityPieces: string;
  totalLengthM: string;
}

export function TransfersPage() {
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [projects, setProjects] = useState<LookupRow[]>([]);
  const [locations, setLocations] = useState<LookupRow[]>([]);
  const [units, setUnits] = useState<MaterialUnitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showDispatch, setShowDispatch] = useState(false);
  const [dispatchForm, setDispatchForm] = useState({ projectId: "", fromLocationId: "", toLocationId: "", vehicleInfo: "" });
  const [dispatchLines, setDispatchLines] = useState<DispatchLineForm[]>([{ sourceMaterialUnitId: "", quantityPieces: "", totalLengthM: "" }]);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const [detailFor, setDetailFor] = useState<TransferDetail | null>(null);
  const [receiveLine, setReceiveLine] = useState<TransferLineRow | null>(null);
  const [portions, setPortions] = useState([{ quantityPieces: "", totalLengthM: "", disposition: "ACCEPTED" as "ACCEPTED" | "ON_HOLD" | "DAMAGED_DISCREPANT" }]);
  const [receiveError, setReceiveError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setTransfers(await api.get<TransferRow[]>("/transfers"));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Failed to load transfers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    api.get<LookupRow[]>("/projects").then(setProjects).catch(() => {});
    api.get<LookupRow[]>("/storage-locations").then(setLocations).catch(() => {});
    api.get<MaterialUnitRow[]>("/inventory?status=AVAILABLE&limit=500").then(setUnits).catch(() => {});
  }, []);

  function locationName(id: string): string {
    return locations.find((l) => l.id === id)?.name ?? id.slice(0, 8);
  }
  function unitLabel(id: string): string {
    const u = units.find((x) => x.id === id);
    return u ? `${u.internal_reference_code ?? id.slice(0, 8)} — Ø${u.diameter_mm}mm, ${u.remainingLengthM ?? u.total_length_m}m left` : id.slice(0, 8);
  }

  async function submitDispatch(e: FormEvent) {
    e.preventDefault();
    setDispatchError(null);
    try {
      await api.post("/transfers", {
        projectId: dispatchForm.projectId,
        fromLocationId: dispatchForm.fromLocationId,
        toLocationId: dispatchForm.toLocationId,
        vehicleInfo: dispatchForm.vehicleInfo || undefined,
        lines: dispatchLines.map((l) => ({
          sourceMaterialUnitId: l.sourceMaterialUnitId,
          quantityPieces: Number(l.quantityPieces),
          totalLengthM: Number(l.totalLengthM),
        })),
      });
      setShowDispatch(false);
      setDispatchForm({ projectId: "", fromLocationId: "", toLocationId: "", vehicleInfo: "" });
      setDispatchLines([{ sourceMaterialUnitId: "", quantityPieces: "", totalLengthM: "" }]);
      await reload();
    } catch (e) {
      setDispatchError(e instanceof ApiRequestError ? e.message : "Could not dispatch transfer");
    }
  }

  async function openDetail(t: TransferRow) {
    setDetailFor(await api.get<TransferDetail>(`/transfers/${t.id}`));
  }

  const portionTotal = portions.reduce((sum, p) => sum + (Number(p.totalLengthM) || 0), 0);
  const dispatchedTotal = receiveLine ? Number(units.find((u) => u.id === receiveLine.material_unit_id)?.total_length_m ?? 0) : 0;

  async function submitReceive(e: FormEvent) {
    e.preventDefault();
    if (!detailFor || !receiveLine) return;
    setReceiveError(null);
    try {
      await api.post(`/transfers/${detailFor.id}/receive`, {
        materialTransferLineId: receiveLine.id,
        portions: portions.map((p) => ({ quantityPieces: Number(p.quantityPieces), totalLengthM: Number(p.totalLengthM), disposition: p.disposition })),
      });
      setReceiveLine(null);
      setPortions([{ quantityPieces: "", totalLengthM: "", disposition: "ACCEPTED" }]);
      setDetailFor(await api.get<TransferDetail>(`/transfers/${detailFor.id}`));
      await reload();
    } catch (e) {
      setReceiveError(e instanceof ApiRequestError ? e.message : "Could not record receipt");
    }
  }

  return (
    <div>
      <PageHeader title="Material Transfers" actions={<Button onClick={() => setShowDispatch(true)}>Dispatch</Button>} />
      <ErrorBanner message={error} />

      {loading ? (
        <Spinner />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="py-2 pl-4">Dispatched</th>
                <th>From</th>
                <th>To</th>
                <th>Vehicle</th>
                <th>Status</th>
                <th>Reconciliation</th>
                <th className="pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id} className="border-b border-slate-100">
                  <td className="py-2 pl-4">{new Date(t.dispatched_at).toLocaleString()}</td>
                  <td>{locationName(t.from_location_id)}</td>
                  <td>{locationName(t.to_location_id)}</td>
                  <td>{t.vehicle_info ?? "—"}</td>
                  <td>
                    <Badge value={t.status} />
                  </td>
                  <td>
                    <Badge value={t.reconciliation_status} />
                  </td>
                  <td className="pr-4 text-right">
                    <button onClick={() => openDetail(t)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100" title="View / receive">
                      <Inbox size={15} />
                    </button>
                  </td>
                </tr>
              ))}
              {transfers.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-slate-400">
                    No transfers dispatched yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {showDispatch && (
        <Modal title="Dispatch Transfer" onClose={() => setShowDispatch(false)}>
          <form onSubmit={submitDispatch} className="flex flex-col gap-3">
            <ErrorBanner message={dispatchError} />
            <Field label="Project">
              <select required value={dispatchForm.projectId} onChange={(e) => setDispatchForm({ ...dispatchForm, projectId: e.target.value })} className={inputClass}>
                <option value="">Select…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From location">
                <select required value={dispatchForm.fromLocationId} onChange={(e) => setDispatchForm({ ...dispatchForm, fromLocationId: e.target.value })} className={inputClass}>
                  <option value="">Select…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="To location">
                <select required value={dispatchForm.toLocationId} onChange={(e) => setDispatchForm({ ...dispatchForm, toLocationId: e.target.value })} className={inputClass}>
                  <option value="">Select…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Vehicle info (optional)">
              <input value={dispatchForm.vehicleInfo} onChange={(e) => setDispatchForm({ ...dispatchForm, vehicleInfo: e.target.value })} className={inputClass} />
            </Field>

            <div className="border-t border-slate-100 pt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">Lines</span>
                <button
                  type="button"
                  className="text-xs font-medium text-slate-500 underline"
                  onClick={() => setDispatchLines([...dispatchLines, { sourceMaterialUnitId: "", quantityPieces: "", totalLengthM: "" }])}
                >
                  + Add line
                </button>
              </div>
              {dispatchLines.map((line, i) => (
                <div key={i} className="mb-2 grid grid-cols-[2fr_1fr_1fr] gap-2">
                  <select
                    required
                    value={line.sourceMaterialUnitId}
                    onChange={(e) => {
                      const next = [...dispatchLines];
                      next[i] = { ...next[i], sourceMaterialUnitId: e.target.value };
                      setDispatchLines(next);
                    }}
                    className={inputClass}
                  >
                    <option value="">Source unit…</option>
                    {units.map((u) => (
                      <option key={u.id} value={u.id}>
                        {unitLabel(u.id)}
                      </option>
                    ))}
                  </select>
                  <input
                    required
                    type="number"
                    min={1}
                    placeholder="Pieces"
                    value={line.quantityPieces}
                    onChange={(e) => {
                      const next = [...dispatchLines];
                      next[i] = { ...next[i], quantityPieces: e.target.value };
                      setDispatchLines(next);
                    }}
                    className={inputClass}
                  />
                  <input
                    required
                    type="number"
                    step="0.01"
                    placeholder="Length m"
                    value={line.totalLengthM}
                    onChange={(e) => {
                      const next = [...dispatchLines];
                      next[i] = { ...next[i], totalLengthM: e.target.value };
                      setDispatchLines(next);
                    }}
                    className={inputClass}
                  />
                </div>
              ))}
            </div>

            <Button type="submit" className="mt-2 justify-center">
              Dispatch
            </Button>
          </form>
        </Modal>
      )}

      {detailFor && (
        <Modal title="Transfer Detail" onClose={() => setDetailFor(null)}>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>{locationName(detailFor.from_location_id)} → {locationName(detailFor.to_location_id)}</span>
              <Badge value={detailFor.status} />
            </div>
            <div>
              <h3 className="mb-1 font-medium text-slate-700">Lines</h3>
              {detailFor.lines.map((l) => (
                <div key={l.id} className="mb-1 flex items-center justify-between rounded border border-slate-200 px-2 py-1.5">
                  <span className="font-mono text-xs">{l.material_unit_id.slice(0, 8)}</span>
                  <Button variant="secondary" onClick={() => setReceiveLine(l)}>
                    <Truck size={13} /> Receive
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {receiveLine && (
        <Modal title="Receive Transfer Line" onClose={() => setReceiveLine(null)}>
          <form onSubmit={submitReceive} className="flex flex-col gap-3">
            <ErrorBanner message={receiveError} />
            <p className="text-xs text-slate-500">
              Dispatched: {dispatchedTotal.toFixed(2)} m. Portions entered so far: {portionTotal.toFixed(2)} m. Remaining to account for:{" "}
              <span className={portionTotal > dispatchedTotal ? "font-medium text-red-600" : "font-medium"}>{(dispatchedTotal - portionTotal).toFixed(2)} m</span>
            </p>
            {portions.map((p, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr] gap-2">
                <input
                  required
                  type="number"
                  min={1}
                  placeholder="Pieces"
                  value={p.quantityPieces}
                  onChange={(e) => {
                    const next = [...portions];
                    next[i] = { ...next[i], quantityPieces: e.target.value };
                    setPortions(next);
                  }}
                  className={inputClass}
                />
                <input
                  required
                  type="number"
                  step="0.01"
                  placeholder="Length m"
                  value={p.totalLengthM}
                  onChange={(e) => {
                    const next = [...portions];
                    next[i] = { ...next[i], totalLengthM: e.target.value };
                    setPortions(next);
                  }}
                  className={inputClass}
                />
                <select
                  value={p.disposition}
                  onChange={(e) => {
                    const next = [...portions];
                    next[i] = { ...next[i], disposition: e.target.value as typeof p.disposition };
                    setPortions(next);
                  }}
                  className={inputClass}
                >
                  <option value="ACCEPTED">Accepted</option>
                  <option value="ON_HOLD">On Hold</option>
                  <option value="DAMAGED_DISCREPANT">Damaged / Discrepant</option>
                </select>
              </div>
            ))}
            <button
              type="button"
              className="text-left text-xs font-medium text-slate-500 underline"
              onClick={() => setPortions([...portions, { quantityPieces: "", totalLengthM: "", disposition: "ACCEPTED" }])}
            >
              + Add portion (split receipt across dispositions)
            </button>
            <Button type="submit" className="mt-2 justify-center">
              Record Receipt
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
