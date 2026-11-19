import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { Card, ErrorBanner, PageHeader, Spinner, StatCard, inputClass } from "../components/ui";

interface StockByDiameterRow {
  diameter_mm: string;
  surface_type: string;
  grade_normalized: string;
  available_length_m: string;
  available_mt: string;
}
interface ReorderAlertRow {
  diameter_mm: string;
  surface_type: string;
  item_code: string | null;
  reorder_threshold_mt: string;
  available_mt: string;
}
interface Kpis {
  totalInventoryMt: number;
  availableStockMt: number;
  reservedStockMt: number;
  onHoldMt: number;
  inTransitMt: number;
  installedMt: number;
  reusableOffcutMt: number;
  scrapMt: number;
  unallocatedCompanyStockMt: number;
  scrapPercentage: number;
  reusableRemnantRate: number;
  stockByDiameter: StockByDiameterRow[];
  reorderAlerts: ReorderAlertRow[];
  unreconciledOperationsCount: number;
  unreconciledTransfersCount: number;
}
interface ProjectRow {
  id: string;
  name: string;
}

function mt(n: number): string {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} MT`;
}

export function DashboardPage() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<ProjectRow[]>("/projects").then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = projectId ? `?projectId=${projectId}` : "";
    api
      .get<Kpis>(`/reports/kpis${qs}`)
      .then(setKpis)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  return (
    <div>
      <PageHeader
        title="Executive Dashboard"
        actions={
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputClass}>
            <option value="">Company-wide</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        }
      />
      <ErrorBanner message={error} />
      {loading || !kpis ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-6">
          {(kpis.unreconciledOperationsCount > 0 || kpis.unreconciledTransfersCount > 0) && (
            <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle size={16} />
              {kpis.unreconciledOperationsCount} unreconciled processing operation(s), {kpis.unreconciledTransfersCount} unreconciled transfer(s) need
              attention.
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            <StatCard label="Total Inventory" value={mt(kpis.totalInventoryMt)} hint="Bundle actual intake weight" />
            <StatCard label="Available Stock" value={mt(kpis.availableStockMt)} />
            <StatCard label="Reserved Stock" value={mt(kpis.reservedStockMt)} />
            <StatCard label="On Hold / Quarantined" value={mt(kpis.onHoldMt)} />
            <StatCard label="In Transit" value={mt(kpis.inTransitMt)} />
            <StatCard label="Installed" value={mt(kpis.installedMt)} />
            <StatCard label="Reusable Offcuts" value={mt(kpis.reusableOffcutMt)} />
            <StatCard label="Scrap %" value={`${kpis.scrapPercentage.toFixed(1)}%`} />
            <StatCard label="Reusable Remnant Rate" value={`${kpis.reusableRemnantRate.toFixed(1)}%`} />
            {!projectId && <StatCard label="Unallocated Company Stock" value={mt(kpis.unallocatedCompanyStockMt)} hint="No project assigned" />}
          </div>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Stock by Diameter & Surface Type</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="py-1.5">Diameter</th>
                  <th>Surface</th>
                  <th>Grade</th>
                  <th className="text-right">Available (m)</th>
                  <th className="text-right">Available (MT)</th>
                </tr>
              </thead>
              <tbody>
                {kpis.stockByDiameter.map((r, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-1.5">{r.diameter_mm} mm</td>
                    <td>{r.surface_type}</td>
                    <td>{r.grade_normalized}</td>
                    <td className="text-right">{Number(r.available_length_m).toLocaleString()}</td>
                    <td className="text-right">{Number(r.available_mt).toFixed(2)}</td>
                  </tr>
                ))}
                {kpis.stockByDiameter.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-slate-400">
                      No stock recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          <Card>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
              <AlertTriangle size={15} className="text-amber-500" /> Low-Stock Reorder Alerts
            </h2>
            {kpis.reorderAlerts.length === 0 ? (
              <p className="text-sm text-slate-400">No sizes are currently below their reorder threshold.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="py-1.5">Item</th>
                    <th>Diameter</th>
                    <th>Surface</th>
                    <th className="text-right">Available (MT)</th>
                    <th className="text-right">Threshold (MT)</th>
                  </tr>
                </thead>
                <tbody>
                  {kpis.reorderAlerts.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100 text-red-700">
                      <td className="py-1.5">{r.item_code ?? "—"}</td>
                      <td>{r.diameter_mm} mm</td>
                      <td>{r.surface_type}</td>
                      <td className="text-right">{Number(r.available_mt).toFixed(2)}</td>
                      <td className="text-right">{Number(r.reorder_threshold_mt).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
