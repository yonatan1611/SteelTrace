import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Check, FlaskConical } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Badge, Button, Card, ErrorBanner, Field, Modal, PageHeader, Spinner, inputClass } from "../components/ui";

interface OperationRow {
  id: string;
  project_id: string;
  reference_code: string;
  reconciliation_status: string;
  finalized_at: string | null;
  checked_by_membership_id: string | null;
  performed_at: string;
}
interface LookupRow {
  id: string;
  name: string;
}
interface MaterialUnitRow {
  id: string;
  internal_reference_code: string | null;
  diameter_mm: string;
  surface_type: string;
  grade_normalized: string;
  classification: string;
  remainingLengthM: string | null;
}

// A unit must be explicitly reclassified off PENDING_RECONCILIATION
// (§2.9's "never auto-classified as waste OR usable") before it can feed
// another operation — record_processing_operation rejects it server-side
// (processing_inputs cannot reference a PENDING_RECONCILIATION unit).
// Offering it in this picker at all just produces a confusing rejection
// after the form is filled out, so it's filtered out here too.
const VALID_PROCESSING_INPUT_CLASSIFICATIONS = new Set(["ORIGINAL", "PREPARED", "OFFCUT"]);
interface RemnantSuggestion {
  materialUnitId: string;
  remainingLengthM: number;
}

interface InputLine {
  materialUnitId: string;
  quantityConsumedPieces: string;
  lengthConsumedM: string;
}
interface OutputLine {
  quantityPieces: string;
  totalLengthM: string;
  classification: "PREPARED" | "OFFCUT" | "SCRAP";
}

export function ProcessingPage() {
  const [params] = useSearchParams();
  const highlight = params.get("highlight");

  const [ops, setOps] = useState<OperationRow[]>([]);
  const [projects, setProjects] = useState<LookupRow[]>([]);
  const [opTypes, setOpTypes] = useState<LookupRow[]>([]);
  const [locations, setLocations] = useState<LookupRow[]>([]);
  const [units, setUnits] = useState<MaterialUnitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ projectId: "", referenceCode: "", operationTypeId: "", storageLocationId: "" });
  const [inputs, setInputs] = useState<InputLine[]>([{ materialUnitId: "", quantityConsumedPieces: "", lengthConsumedM: "" }]);
  const [outputs, setOutputs] = useState<OutputLine[]>([{ quantityPieces: "", totalLengthM: "", classification: "PREPARED" }]);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [suggestQuery, setSuggestQuery] = useState({ diameterMm: "", surfaceType: "DEFORMED", grade: "", minLengthM: "" });
  const [suggestions, setSuggestions] = useState<RemnantSuggestion[] | null>(null);
  const [showSuggest, setShowSuggest] = useState(false);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setOps(await api.get<OperationRow[]>("/processing-operations"));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Failed to load processing operations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    api.get<LookupRow[]>("/projects").then(setProjects).catch(() => {});
    api.get<LookupRow[]>("/processing-operation-types").then(setOpTypes).catch(() => {});
    api.get<LookupRow[]>("/storage-locations").then(setLocations).catch(() => {});
    api
      .get<MaterialUnitRow[]>("/inventory?status=AVAILABLE&limit=500")
      .then((rows) => setUnits(rows.filter((u) => VALID_PROCESSING_INPUT_CLASSIFICATIONS.has(u.classification))))
      .catch(() => {});
  }, []);

  const sorted = useMemo(() => {
    if (!highlight) return ops;
    const idx = ops.findIndex((o) => o.id === highlight);
    if (idx <= 0) return ops;
    const copy = [...ops];
    const [item] = copy.splice(idx, 1);
    copy.unshift(item);
    return copy;
  }, [ops, highlight]);

  const totalInputM = inputs.reduce((s, i) => s + (Number(i.lengthConsumedM) || 0), 0);
  const totalOutputM = outputs.reduce((s, o) => s + (Number(o.totalLengthM) || 0), 0);
  const diff = totalOutputM - totalInputM;

  function unitLabel(id: string): string {
    const u = units.find((x) => x.id === id);
    return u ? `${u.internal_reference_code ?? id.slice(0, 8)} — Ø${u.diameter_mm}mm ${u.surface_type}, ${u.remainingLengthM}m left` : id.slice(0, 8);
  }

  async function runSuggest() {
    setSuggestions(null);
    try {
      const qs = new URLSearchParams({
        diameterMm: suggestQuery.diameterMm,
        surfaceType: suggestQuery.surfaceType,
        grade: suggestQuery.grade,
        minLengthM: suggestQuery.minLengthM,
      });
      setSuggestions(await api.get<RemnantSuggestion[]>(`/remnants/suggest?${qs.toString()}`));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not fetch remnant suggestions");
    }
  }

  async function submitForm(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const res = await api.post<{ operationId: string; outputs: { outputIndex: number; materialUnitId: string }[] }>("/processing-operations", {
        projectId: form.projectId,
        referenceCode: form.referenceCode,
        operationTypeId: form.operationTypeId,
        storageLocationId: form.storageLocationId,
        inputs: inputs.map((i) => ({ materialUnitId: i.materialUnitId, quantityConsumedPieces: Number(i.quantityConsumedPieces), lengthConsumedM: Number(i.lengthConsumedM) })),
        // POOLED only (§2.4's practical default: batch-level identity,
        // no claim to exact per-source attribution) — a simple
        // worker-facing form intentionally doesn't ask for a per-output
        // source/weight breakdown; that finer EXACT/KNOWN_PARTIAL
        // attribution remains possible via the API for a workflow that
        // tracks it, just not through this quick-entry form (Dev Rule
        // §5.7: keep day-to-day operations simple).
        outputs: outputs.map((o) => ({ attributionMode: "POOLED" as const, quantityPieces: Number(o.quantityPieces), totalLengthM: Number(o.totalLengthM), sources: [] })),
      });
      // Reclassify every output immediately to the classification the
      // worker chose in the same form — PENDING_RECONCILIATION is the
      // default on creation, and §2.9 requires an explicit action to move
      // off it (never inferred).
      for (let i = 0; i < res.outputs.length; i++) {
        await api.post(`/material-units/${res.outputs[i].materialUnitId}/reclassify`, {
          toClassification: outputs[i].classification,
          reason: "set at recording time",
        });
      }
      setShowForm(false);
      setForm({ projectId: "", referenceCode: "", operationTypeId: "", storageLocationId: "" });
      setInputs([{ materialUnitId: "", quantityConsumedPieces: "", lengthConsumedM: "" }]);
      setOutputs([{ quantityPieces: "", totalLengthM: "", classification: "PREPARED" }]);
      await reload();
    } catch (e) {
      setFormError(e instanceof ApiRequestError ? e.message : "Could not record operation");
    } finally {
      setBusy(false);
    }
  }

  async function finalize(op: OperationRow) {
    try {
      await api.post(`/processing-operations/${op.id}/finalize`);
      await reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not finalize operation");
    }
  }

  async function check(op: OperationRow) {
    try {
      await api.post(`/processing-operations/${op.id}/check`);
      await reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not check operation (maker may equal checker)");
    }
  }

  return (
    <div>
      <PageHeader
        title="Workshop Cutting, Bending & Remnant Reuse"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowSuggest(true)}>
              <Search size={14} /> Remnant-First
            </Button>
            <Button onClick={() => setShowForm(true)}>
              <FlaskConical size={14} /> New Operation
            </Button>
          </div>
        }
      />
      <ErrorBanner message={error} />

      {loading ? (
        <Spinner />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="py-2 pl-4">Reference</th>
                <th>Performed</th>
                <th>Reconciliation</th>
                <th>Finalized</th>
                <th>Checked</th>
                <th className="pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((op) => (
                <tr key={op.id} className={`border-b border-slate-100 ${op.id === highlight ? "bg-amber-50" : ""}`}>
                  <td className="py-2 pl-4 font-medium">{op.reference_code}</td>
                  <td>{new Date(op.performed_at).toLocaleString()}</td>
                  <td>
                    <Badge value={op.reconciliation_status} />
                  </td>
                  <td>{op.finalized_at ? "Yes" : "No"}</td>
                  <td>{op.checked_by_membership_id ? "Yes" : "No"}</td>
                  <td className="pr-4 text-right">
                    <div className="flex justify-end gap-1">
                      {!op.finalized_at && (
                        <Button variant="secondary" onClick={() => finalize(op)}>
                          Finalize
                        </Button>
                      )}
                      {op.finalized_at && !op.checked_by_membership_id && (
                        <button onClick={() => check(op)} className="rounded p-1.5 text-emerald-600 hover:bg-emerald-50" title="Check (maker-checker)">
                          <Check size={15} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-400">
                    No processing operations recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {showSuggest && (
        <Modal title="Remnant-First Assistant" onClose={() => setShowSuggest(false)}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Diameter (mm)">
              <input type="number" value={suggestQuery.diameterMm} onChange={(e) => setSuggestQuery({ ...suggestQuery, diameterMm: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Surface type">
              <select value={suggestQuery.surfaceType} onChange={(e) => setSuggestQuery({ ...suggestQuery, surfaceType: e.target.value })} className={inputClass}>
                <option value="DEFORMED">Deformed</option>
                <option value="PLAIN">Plain</option>
              </select>
            </Field>
            <Field label="Grade">
              <input value={suggestQuery.grade} onChange={(e) => setSuggestQuery({ ...suggestQuery, grade: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Minimum length (m)">
              <input type="number" value={suggestQuery.minLengthM} onChange={(e) => setSuggestQuery({ ...suggestQuery, minLengthM: e.target.value })} className={inputClass} />
            </Field>
          </div>
          <Button onClick={runSuggest} className="mt-3">
            Search available offcuts
          </Button>
          {suggestions && (
            <div className="mt-3 space-y-1">
              {suggestions.length === 0 ? (
                <p className="text-sm text-slate-400">No matching offcuts — a new bar will be needed.</p>
              ) : (
                suggestions.map((s) => (
                  <div key={s.materialUnitId} className="flex justify-between rounded border border-slate-200 px-2 py-1.5 text-sm">
                    <span className="font-mono text-xs">{s.materialUnitId.slice(0, 8)}</span>
                    <span>{s.remainingLengthM.toFixed(2)} m remaining</span>
                  </div>
                ))
              )}
            </div>
          )}
        </Modal>
      )}

      {showForm && (
        <Modal title="New Processing Operation" onClose={() => setShowForm(false)}>
          <form onSubmit={submitForm} className="flex flex-col gap-3">
            <ErrorBanner message={formError} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Project">
                <select required value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} className={inputClass}>
                  <option value="">Select…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reference code">
                <input required value={form.referenceCode} onChange={(e) => setForm({ ...form, referenceCode: e.target.value })} className={inputClass} placeholder="ST-PROC-0001" />
              </Field>
              <Field label="Operation type">
                <select required value={form.operationTypeId} onChange={(e) => setForm({ ...form, operationTypeId: e.target.value })} className={inputClass}>
                  <option value="">Select…</option>
                  {opTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Workshop location">
                <select required value={form.storageLocationId} onChange={(e) => setForm({ ...form, storageLocationId: e.target.value })} className={inputClass}>
                  <option value="">Select…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="border-t border-slate-100 pt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">Inputs</span>
                <button type="button" className="text-xs font-medium text-slate-500 underline" onClick={() => setInputs([...inputs, { materialUnitId: "", quantityConsumedPieces: "", lengthConsumedM: "" }])}>
                  + Add input
                </button>
              </div>
              {inputs.map((inp, i) => (
                <div key={i} className="mb-2 grid grid-cols-[2fr_1fr_1fr] gap-2">
                  <select
                    required
                    value={inp.materialUnitId}
                    onChange={(e) => {
                      const next = [...inputs];
                      next[i] = { ...next[i], materialUnitId: e.target.value };
                      setInputs(next);
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
                    value={inp.quantityConsumedPieces}
                    onChange={(e) => {
                      const next = [...inputs];
                      next[i] = { ...next[i], quantityConsumedPieces: e.target.value };
                      setInputs(next);
                    }}
                    className={inputClass}
                  />
                  <input
                    required
                    type="number"
                    step="0.01"
                    placeholder="Length m"
                    value={inp.lengthConsumedM}
                    onChange={(e) => {
                      const next = [...inputs];
                      next[i] = { ...next[i], lengthConsumedM: e.target.value };
                      setInputs(next);
                    }}
                    className={inputClass}
                  />
                </div>
              ))}
            </div>

            <div className="border-t border-slate-100 pt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">Outputs</span>
                <button
                  type="button"
                  className="text-xs font-medium text-slate-500 underline"
                  onClick={() => setOutputs([...outputs, { quantityPieces: "", totalLengthM: "", classification: "PREPARED" }])}
                >
                  + Add output
                </button>
              </div>
              {outputs.map((out, i) => (
                <div key={i} className="mb-2 grid grid-cols-[1fr_1fr_1fr] gap-2">
                  <select
                    value={out.classification}
                    onChange={(e) => {
                      const next = [...outputs];
                      next[i] = { ...next[i], classification: e.target.value as OutputLine["classification"] };
                      setOutputs(next);
                    }}
                    className={inputClass}
                  >
                    <option value="PREPARED">Prepared</option>
                    <option value="OFFCUT">Offcut</option>
                    <option value="SCRAP">Scrap</option>
                  </select>
                  <input
                    required
                    type="number"
                    min={1}
                    placeholder="Pieces"
                    value={out.quantityPieces}
                    onChange={(e) => {
                      const next = [...outputs];
                      next[i] = { ...next[i], quantityPieces: e.target.value };
                      setOutputs(next);
                    }}
                    className={inputClass}
                  />
                  <input
                    required
                    type="number"
                    step="0.01"
                    placeholder="Length m"
                    value={out.totalLengthM}
                    onChange={(e) => {
                      const next = [...outputs];
                      next[i] = { ...next[i], totalLengthM: e.target.value };
                      setOutputs(next);
                    }}
                    className={inputClass}
                  />
                </div>
              ))}
            </div>

            <div className={`flex justify-between rounded-md border px-3 py-2 text-sm ${Math.abs(diff) < 0.001 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
              <span>Total Input: {totalInputM.toFixed(2)} m</span>
              <span>Total Output: {totalOutputM.toFixed(2)} m</span>
              <span>Diff: {diff.toFixed(2)} m</span>
            </div>

            <Button type="submit" disabled={busy} className="justify-center">
              {busy ? "Recording…" : "Record Operation"}
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
