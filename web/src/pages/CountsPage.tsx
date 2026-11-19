import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Eye } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Badge, Button, Card, ErrorBanner, Field, Modal, PageHeader, Spinner, inputClass } from "../components/ui";

interface CountRow {
  id: string;
  storage_location_id: string;
  reference_code: string;
  count_date: string;
  status: string;
  verified_by_membership_id: string | null;
}
interface CountLineRow {
  id: string;
  material_unit_id: string;
  system_pieces: number;
  system_length_m: string;
  counted_pieces: number;
  counted_length_m: string;
  variance_length_m: string;
  investigation_notes: string | null;
}
interface CountDetail extends CountRow {
  lines: CountLineRow[];
}
interface LookupRow {
  id: string;
  name: string;
}
interface MaterialUnitRow {
  id: string;
  internal_reference_code: string | null;
  current_storage_location_id: string | null;
  total_length_m: string;
}

interface CountLineForm {
  materialUnitId: string;
  countedPieces: string;
  countedLengthM: string;
}

export function CountsPage() {
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [locations, setLocations] = useState<LookupRow[]>([]);
  const [units, setUnits] = useState<MaterialUnitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ storageLocationId: "", referenceCode: "", countDate: new Date().toISOString().slice(0, 10) });
  const [lines, setLines] = useState<CountLineForm[]>([{ materialUnitId: "", countedPieces: "", countedLengthM: "" }]);
  const [formError, setFormError] = useState<string | null>(null);

  const [detail, setDetail] = useState<CountDetail | null>(null);
  const [adjustments, setAdjustments] = useState<Record<string, { amount: string; reason: string }>>({});
  const [verifyError, setVerifyError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setCounts(await api.get<CountRow[]>("/physical-counts"));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Failed to load stock counts");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    api.get<LookupRow[]>("/storage-locations").then(setLocations).catch(() => {});
    api.get<MaterialUnitRow[]>("/inventory?limit=1000").then(setUnits).catch(() => {});
  }, []);

  function locationName(id: string): string {
    return locations.find((l) => l.id === id)?.name ?? id.slice(0, 8);
  }
  function unitLabel(id: string): string {
    const u = units.find((x) => x.id === id);
    return u ? `${u.internal_reference_code ?? id.slice(0, 8)} (system: ${u.total_length_m}m)` : id.slice(0, 8);
  }

  async function submitCount(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      await api.post("/physical-counts", {
        storageLocationId: form.storageLocationId,
        referenceCode: form.referenceCode,
        countDate: form.countDate,
        lines: lines.map((l) => ({ materialUnitId: l.materialUnitId, countedPieces: Number(l.countedPieces), countedLengthM: Number(l.countedLengthM) })),
      });
      setShowForm(false);
      setForm({ storageLocationId: "", referenceCode: "", countDate: new Date().toISOString().slice(0, 10) });
      setLines([{ materialUnitId: "", countedPieces: "", countedLengthM: "" }]);
      await reload();
    } catch (e) {
      setFormError(e instanceof ApiRequestError ? e.message : "Could not record stock count");
    }
  }

  async function openDetail(c: CountRow) {
    setDetail(await api.get<CountDetail>(`/physical-counts/${c.id}`));
    setAdjustments({});
    setVerifyError(null);
  }

  async function submitVerify(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setVerifyError(null);
    try {
      const adjustmentPayload = Object.entries(adjustments)
        .filter(([, v]) => v.amount && Number(v.amount) !== 0)
        .map(([lineId, v]) => ({ physicalStockCountLineId: lineId, measurementBasis: "LENGTH" as const, amount: Number(v.amount), adjustmentType: "CORRECTION" as const, reason: v.reason }));
      await api.post(`/physical-counts/${detail.id}/verify`, { adjustments: adjustmentPayload });
      setDetail(null);
      await reload();
    } catch (e) {
      setVerifyError(e instanceof ApiRequestError ? e.message : "Could not verify (maker may equal checker)");
    }
  }

  return (
    <div>
      <PageHeader title="Physical Stock Counts" actions={<Button onClick={() => setShowForm(true)}>Record Count</Button>} />
      <ErrorBanner message={error} />

      {loading ? (
        <Spinner />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="py-2 pl-4">Reference</th>
                <th>Location</th>
                <th>Date</th>
                <th>Status</th>
                <th>Verified</th>
                <th className="pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((c) => (
                <tr key={c.id} className="border-b border-slate-100">
                  <td className="py-2 pl-4 font-medium">{c.reference_code}</td>
                  <td>{locationName(c.storage_location_id)}</td>
                  <td>{c.count_date.slice(0, 10)}</td>
                  <td>
                    <Badge value={c.status} />
                  </td>
                  <td>{c.verified_by_membership_id ? <Badge value="ACCEPTED" /> : <span className="text-xs text-slate-400">pending</span>}</td>
                  <td className="pr-4 text-right">
                    <button onClick={() => openDetail(c)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100" title="View / verify">
                      <Eye size={15} />
                    </button>
                  </td>
                </tr>
              ))}
              {counts.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-400">
                    No stock counts recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {showForm && (
        <Modal title="Record Physical Stock Count" onClose={() => setShowForm(false)}>
          <form onSubmit={submitCount} className="flex flex-col gap-3">
            <ErrorBanner message={formError} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Storage location">
                <select required value={form.storageLocationId} onChange={(e) => setForm({ ...form, storageLocationId: e.target.value })} className={inputClass}>
                  <option value="">Select…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reference code">
                <input required value={form.referenceCode} onChange={(e) => setForm({ ...form, referenceCode: e.target.value })} className={inputClass} placeholder="COUNT-0001" />
              </Field>
              <Field label="Count date">
                <input required type="date" value={form.countDate} onChange={(e) => setForm({ ...form, countDate: e.target.value })} className={inputClass} />
              </Field>
            </div>

            <div className="border-t border-slate-100 pt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">Counted units</span>
                <button type="button" className="text-xs font-medium text-slate-500 underline" onClick={() => setLines([...lines, { materialUnitId: "", countedPieces: "", countedLengthM: "" }])}>
                  + Add line
                </button>
              </div>
              {lines.map((l, i) => (
                <div key={i} className="mb-2 grid grid-cols-[2fr_1fr_1fr] gap-2">
                  <select
                    required
                    value={l.materialUnitId}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...next[i], materialUnitId: e.target.value };
                      setLines(next);
                    }}
                    className={inputClass}
                  >
                    <option value="">Unit…</option>
                    {units.filter((u) => u.current_storage_location_id === form.storageLocationId).map((u) => (
                      <option key={u.id} value={u.id}>
                        {unitLabel(u.id)}
                      </option>
                    ))}
                  </select>
                  <input
                    required
                    type="number"
                    min={0}
                    placeholder="Counted pieces"
                    value={l.countedPieces}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...next[i], countedPieces: e.target.value };
                      setLines(next);
                    }}
                    className={inputClass}
                  />
                  <input
                    required
                    type="number"
                    step="0.01"
                    min={0}
                    placeholder="Counted length m"
                    value={l.countedLengthM}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...next[i], countedLengthM: e.target.value };
                      setLines(next);
                    }}
                    className={inputClass}
                  />
                </div>
              ))}
            </div>

            <Button type="submit" className="justify-center">
              Record Count
            </Button>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={`Count ${detail.reference_code}`} onClose={() => setDetail(null)}>
          <form onSubmit={submitVerify} className="flex flex-col gap-3">
            <ErrorBanner message={verifyError} />
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-left uppercase text-slate-500">
                  <th className="py-1">Unit</th>
                  <th className="text-right">System (m)</th>
                  <th className="text-right">Counted (m)</th>
                  <th className="text-right">Variance (m)</th>
                  <th>Adjustment</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => {
                  const variance = Number(l.variance_length_m);
                  return (
                    <tr key={l.id} className="border-b border-slate-100">
                      <td className="py-1 font-mono">{l.material_unit_id.slice(0, 8)}</td>
                      <td className="text-right">{l.system_length_m}</td>
                      <td className="text-right">{l.counted_length_m}</td>
                      <td className={`text-right ${variance !== 0 ? "font-medium text-amber-600" : ""}`}>{variance}</td>
                      <td>
                        {variance !== 0 && !detail.verified_by_membership_id && (
                          <div className="flex gap-1">
                            <input
                              type="number"
                              step="0.01"
                              placeholder="Amount"
                              value={adjustments[l.id]?.amount ?? ""}
                              onChange={(e) => setAdjustments({ ...adjustments, [l.id]: { amount: e.target.value, reason: adjustments[l.id]?.reason ?? "" } })}
                              className={`${inputClass} w-20`}
                            />
                            <input
                              placeholder="Reason"
                              value={adjustments[l.id]?.reason ?? ""}
                              onChange={(e) => setAdjustments({ ...adjustments, [l.id]: { amount: adjustments[l.id]?.amount ?? "", reason: e.target.value } })}
                              className={`${inputClass} w-28`}
                            />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!detail.verified_by_membership_id && (
              <Button type="submit" className="justify-center">
                Verify count (with approved adjustments)
              </Button>
            )}
          </form>
        </Modal>
      )}
    </div>
  );
}
