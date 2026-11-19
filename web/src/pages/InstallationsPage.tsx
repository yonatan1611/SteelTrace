import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Check, Repeat } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Badge, Button, Card, ErrorBanner, Field, Modal, PageHeader, Spinner, inputClass } from "../components/ui";

interface InstallationRow {
  id: string;
  project_id: string;
  structural_element_instance_id: string;
  reinforcement_purpose_id: string;
  status: string;
  installed_at: string;
  intended_usage_declaration_id: string | null;
}
interface LookupRow {
  id: string;
  name: string;
}
interface ElementInstanceRow {
  id: string;
  reference_code: string;
  project_id: string;
}
interface MaterialUnitRow {
  id: string;
  internal_reference_code: string | null;
  diameter_mm: string;
  classification: string;
  remainingLengthM: string | null;
}
export function InstallationsPage() {
  const [installations, setInstallations] = useState<InstallationRow[]>([]);
  const [projects, setProjects] = useState<LookupRow[]>([]);
  const [elements, setElements] = useState<ElementInstanceRow[]>([]);
  const [purposes, setPurposes] = useState<LookupRow[]>([]);
  const [units, setUnits] = useState<MaterialUnitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [supersedeTarget, setSupersedeTarget] = useState<InstallationRow | null>(null);
  const [form, setForm] = useState({ projectId: "", structuralElementInstanceId: "", reinforcementPurposeId: "", intendedUsageDeclarationId: "", materialUnitIds: [] as string[] });
  const [formError, setFormError] = useState<string | null>(null);
  const [lastDeviation, setLastDeviation] = useState<boolean | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setInstallations(await api.get<InstallationRow[]>("/installations"));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Failed to load installations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    api.get<LookupRow[]>("/projects").then(setProjects).catch(() => {});
    api.get<ElementInstanceRow[]>("/structural-element-instances").then(setElements).catch(() => {});
    api.get<LookupRow[]>("/reinforcement-purposes").then(setPurposes).catch(() => {});
    api.get<MaterialUnitRow[]>("/inventory?status=AVAILABLE&limit=500").then((rows) => setUnits(rows.filter((u) => u.classification === "PREPARED" || u.classification === "ORIGINAL"))).catch(() => {});
  }, []);

  function elementCode(id: string): string {
    return elements.find((e) => e.id === id)?.reference_code ?? id.slice(0, 8);
  }
  function purposeName(id: string): string {
    return purposes.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  }

  function openForm(prefill?: InstallationRow) {
    setLastDeviation(null);
    setFormError(null);
    if (prefill) {
      setForm({
        projectId: prefill.project_id,
        structuralElementInstanceId: prefill.structural_element_instance_id,
        reinforcementPurposeId: prefill.reinforcement_purpose_id,
        intendedUsageDeclarationId: prefill.intended_usage_declaration_id ?? "",
        materialUnitIds: [],
      });
      setSupersedeTarget(prefill);
    } else {
      setForm({ projectId: "", structuralElementInstanceId: "", reinforcementPurposeId: "", intendedUsageDeclarationId: "", materialUnitIds: [] });
      setSupersedeTarget(null);
    }
    setShowForm(true);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      if (supersedeTarget) {
        await api.post(`/installations/${supersedeTarget.id}/supersede`, {
          structuralElementInstanceId: form.structuralElementInstanceId,
          reinforcementPurposeId: form.reinforcementPurposeId,
          intendedUsageDeclarationId: form.intendedUsageDeclarationId || undefined,
          materialUnitIds: form.materialUnitIds,
        });
      } else {
        const res = await api.post<{ intendedVsActualMatch: boolean | null }>("/installations", {
          projectId: form.projectId,
          structuralElementInstanceId: form.structuralElementInstanceId,
          reinforcementPurposeId: form.reinforcementPurposeId,
          intendedUsageDeclarationId: form.intendedUsageDeclarationId || undefined,
          materialUnitIds: form.materialUnitIds,
        });
        setLastDeviation(res.intendedVsActualMatch === false);
      }
      setShowForm(false);
      await reload();
    } catch (e) {
      setFormError(e instanceof ApiRequestError ? e.message : "Could not record installation");
    }
  }

  async function verify(inst: InstallationRow) {
    try {
      await api.post(`/installations/${inst.id}/verify`);
      await reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not verify (maker may equal checker)");
    }
  }

  function toggleUnit(id: string) {
    setForm((f) => ({ ...f, materialUnitIds: f.materialUnitIds.includes(id) ? f.materialUnitIds.filter((x) => x !== id) : [...f.materialUnitIds, id] }));
  }

  return (
    <div>
      <PageHeader title="Site Installation" actions={<Button onClick={() => openForm()}>New Installation</Button>} />
      <ErrorBanner message={error} />

      {loading ? (
        <Spinner />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="py-2 pl-4">Element</th>
                <th>Purpose</th>
                <th>Installed</th>
                <th>Status</th>
                <th className="pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {installations.map((inst) => (
                <tr key={inst.id} className="border-b border-slate-100">
                  <td className="py-2 pl-4 font-medium">{elementCode(inst.structural_element_instance_id)}</td>
                  <td>{purposeName(inst.reinforcement_purpose_id)}</td>
                  <td>{new Date(inst.installed_at).toLocaleString()}</td>
                  <td>
                    <Badge value={inst.status} />
                  </td>
                  <td className="pr-4 text-right">
                    {inst.status === "ACTIVE" && (
                      <div className="flex justify-end gap-1">
                        <button onClick={() => verify(inst)} title="Verify (maker-checker)" className="rounded p-1.5 text-emerald-600 hover:bg-emerald-50">
                          <Check size={15} />
                        </button>
                        <button onClick={() => openForm(inst)} title="Supersede" className="rounded p-1.5 text-slate-500 hover:bg-slate-100">
                          <Repeat size={15} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {installations.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-400">
                    No installations recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {showForm && (
        <Modal title={supersedeTarget ? "Supersede Installation" : "New Installation"} onClose={() => setShowForm(false)}>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <ErrorBanner message={formError} />
            {!supersedeTarget && (
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
            )}
            <Field label="Structural element instance">
              <select required value={form.structuralElementInstanceId} onChange={(e) => setForm({ ...form, structuralElementInstanceId: e.target.value })} className={inputClass}>
                <option value="">Select…</option>
                {elements.filter((el) => !form.projectId || el.project_id === form.projectId).map((el) => (
                  <option key={el.id} value={el.id}>
                    {el.reference_code}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reinforcement purpose">
              <select required value={form.reinforcementPurposeId} onChange={(e) => setForm({ ...form, reinforcementPurposeId: e.target.value })} className={inputClass}>
                <option value="">Select…</option>
                {purposes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Intended usage declaration ID (optional — enables Intended vs Actual check; no browse list exists, paste the ID from where it was declared)">
              <input value={form.intendedUsageDeclarationId} onChange={(e) => setForm({ ...form, intendedUsageDeclarationId: e.target.value })} className={inputClass} placeholder="UUID" />
            </Field>
            <Field label="Material units (PREPARED/ORIGINAL, multi-select)">
              <div className="max-h-40 overflow-y-auto rounded-md border border-slate-300 p-2">
                {units.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 py-0.5 text-sm">
                    <input type="checkbox" checked={form.materialUnitIds.includes(u.id)} onChange={() => toggleUnit(u.id)} />
                    {u.internal_reference_code ?? u.id.slice(0, 8)} — Ø{u.diameter_mm}mm, {u.remainingLengthM}m
                  </label>
                ))}
                {units.length === 0 && <p className="text-xs text-slate-400">No PREPARED/ORIGINAL stock available.</p>}
              </div>
            </Field>
            <Button type="submit" disabled={form.materialUnitIds.length === 0} className="justify-center">
              {supersedeTarget ? "Supersede" : "Install"}
            </Button>
          </form>
        </Modal>
      )}

      {lastDeviation !== null && (
        <div className={`fixed bottom-4 right-4 rounded-md border px-3 py-2 text-sm shadow ${lastDeviation ? "border-amber-300 bg-amber-50 text-amber-800" : "border-emerald-300 bg-emerald-50 text-emerald-800"}`}>
          {lastDeviation ? "Installed — actual purpose differs from the declared intent." : "Installed — matches declared intent."}
          <button className="ml-3 underline" onClick={() => setLastDeviation(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
