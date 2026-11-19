import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Upload, Check, Eye } from "lucide-react";
import { api, ApiRequestError, postMultipart } from "../lib/api";
import { Badge, Button, Card, ErrorBanner, Field, Modal, PageHeader, Spinner, inputClass } from "../components/ui";

interface BbsScheduleRow {
  id: string;
  project_id: string;
  reference_code: string;
  drawing_number: string | null;
  status: string;
  approved_by_membership_id: string | null;
  created_at: string;
}
interface BbsLineRow {
  id: string;
  bar_mark: string;
  diameter_mm: string;
  surface_type: string;
  grade_normalized: string;
  cut_length_m: string;
  bars_per_member: number;
  member_count: number;
  total_bars_required: number;
}
interface BbsDetail extends BbsScheduleRow {
  lines: BbsLineRow[];
}
interface LookupRow {
  id: string;
  name: string;
}
interface ImportResult {
  bbsScheduleId: string;
  format: string;
  linesImported: number;
  rowErrors: string[];
  warnings: string[];
}

export function BbsPage() {
  const [schedules, setSchedules] = useState<BbsScheduleRow[]>([]);
  const [projects, setProjects] = useState<LookupRow[]>([]);
  const [purposes, setPurposes] = useState<LookupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detail, setDetail] = useState<BbsDetail | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importFields, setImportFields] = useState({
    projectId: "",
    referenceCode: "",
    defaultGrade: "",
    defaultShapeCodeCode: "",
    stirrupShapeCodeCode: "",
    defaultReinforcementPurposeId: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setSchedules(await api.get<BbsScheduleRow[]>("/bbs"));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Failed to load BBS schedules");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    api.get<LookupRow[]>("/projects").then(setProjects).catch(() => {});
    api.get<LookupRow[]>("/reinforcement-purposes").then(setPurposes).catch(() => {});
  }, []);

  function projectName(id: string): string {
    return projects.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  }

  async function openDetail(s: BbsScheduleRow) {
    setDetail(await api.get<BbsDetail>(`/bbs/${s.id}`));
  }

  async function approve(s: BbsScheduleRow) {
    try {
      await api.post(`/bbs/${s.id}/approve`);
      await reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not approve schedule");
    }
  }

  async function submitImport(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setImportError(null);
    setImportResult(null);
    setBusy(true);
    try {
      const fields: Record<string, string> = { projectId: importFields.projectId, referenceCode: importFields.referenceCode };
      if (importFields.defaultGrade) fields.defaultGrade = importFields.defaultGrade;
      if (importFields.defaultShapeCodeCode) fields.defaultShapeCodeCode = importFields.defaultShapeCodeCode;
      if (importFields.stirrupShapeCodeCode) fields.stirrupShapeCodeCode = importFields.stirrupShapeCodeCode;
      if (importFields.defaultReinforcementPurposeId) fields.defaultReinforcementPurposeId = importFields.defaultReinforcementPurposeId;
      const result = await postMultipart<ImportResult>("/bbs/import", fields, file);
      setImportResult(result);
      await reload();
    } catch (e) {
      setImportError(e instanceof ApiRequestError ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Bar Bending Schedules"
        actions={
          <Button onClick={() => setShowImport(true)}>
            <Upload size={14} /> Upload Excel BBS
          </Button>
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
                <th>Project</th>
                <th>Drawing #</th>
                <th>Status</th>
                <th>Approval</th>
                <th className="pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id} className="border-b border-slate-100">
                  <td className="py-2 pl-4 font-medium">{s.reference_code}</td>
                  <td>{projectName(s.project_id)}</td>
                  <td>{s.drawing_number ?? "—"}</td>
                  <td>
                    <Badge value={s.status} />
                  </td>
                  <td>{s.approved_by_membership_id ? <Badge value="ACCEPTED" /> : <span className="text-xs text-slate-400">pending</span>}</td>
                  <td className="pr-4 text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => openDetail(s)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100" title="View lines">
                        <Eye size={15} />
                      </button>
                      {!s.approved_by_membership_id && (
                        <button onClick={() => approve(s)} className="rounded p-1.5 text-emerald-600 hover:bg-emerald-50" title="Approve">
                          <Check size={15} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {schedules.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-400">
                    No BBS schedules yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {detail && (
        <Modal title={`BBS ${detail.reference_code}`} onClose={() => setDetail(null)}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left uppercase text-slate-500">
                <th className="py-1">Mark</th>
                <th>Dia</th>
                <th>Surface</th>
                <th>Grade</th>
                <th className="text-right">Cut (m)</th>
                <th className="text-right">Per member</th>
                <th className="text-right">Members</th>
                <th className="text-right">Total bars</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((l) => (
                <tr key={l.id} className="border-b border-slate-100">
                  <td className="py-1">{l.bar_mark}</td>
                  <td>{l.diameter_mm}</td>
                  <td>{l.surface_type}</td>
                  <td>{l.grade_normalized}</td>
                  <td className="text-right">{l.cut_length_m}</td>
                  <td className="text-right">{l.bars_per_member}</td>
                  <td className="text-right">{l.member_count}</td>
                  <td className="text-right">{l.total_bars_required}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}

      {showImport && (
        <Modal
          title="Upload Excel BBS / Takeoff"
          onClose={() => {
            setShowImport(false);
            setImportResult(null);
          }}
        >
          <form onSubmit={submitImport} className="flex flex-col gap-3">
            <ErrorBanner message={importError} />
            <Field label="Project">
              <select required value={importFields.projectId} onChange={(e) => setImportFields({ ...importFields, projectId: e.target.value })} className={inputClass}>
                <option value="">Select…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reference code">
              <input required value={importFields.referenceCode} onChange={(e) => setImportFields({ ...importFields, referenceCode: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Default grade (Format B has no Grade column)">
              <input value={importFields.defaultGrade} onChange={(e) => setImportFields({ ...importFields, defaultGrade: e.target.value })} className={inputClass} placeholder="e.g. B500BWR" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Default shape code">
                <input value={importFields.defaultShapeCodeCode} onChange={(e) => setImportFields({ ...importFields, defaultShapeCodeCode: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Stirrup shape code">
                <input value={importFields.stirrupShapeCodeCode} onChange={(e) => setImportFields({ ...importFields, stirrupShapeCodeCode: e.target.value })} className={inputClass} />
              </Field>
            </div>
            <Field label="Default reinforcement purpose">
              <select value={importFields.defaultReinforcementPurposeId} onChange={(e) => setImportFields({ ...importFields, defaultReinforcementPurposeId: e.target.value })} className={inputClass}>
                <option value="">—</option>
                {purposes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Workbook file">
              <input required type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
            </Field>
            <Button type="submit" disabled={busy} className="justify-center">
              {busy ? "Importing…" : "Import"}
            </Button>

            {importResult && (
              <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
                <p>
                  Format <strong>{importResult.format}</strong> — {importResult.linesImported} line(s) imported.
                </p>
                {importResult.warnings.length > 0 && (
                  <ul className="mt-2 list-inside list-disc text-amber-700">
                    {importResult.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                {importResult.rowErrors.length > 0 && (
                  <ul className="mt-2 list-inside list-disc text-red-700">
                    {importResult.rowErrors.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </form>
        </Modal>
      )}
    </div>
  );
}
