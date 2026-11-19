import { useState } from "react";
import type { FormEvent } from "react";
import { api, ApiRequestError } from "../lib/api";
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, inputClass } from "../components/ui";

interface OriginRow {
  bundle_id: string;
  confidence: string;
  contribution_weight: string | null;
  internal_reference_code: string;
  diameter_mm: string;
  grade: string;
  origin_type: string;
}
interface UnitGenealogy {
  materialUnitId: string;
  origins: OriginRow[];
}
interface SourceUnit {
  materialUnitId: string;
  origins: OriginRow[];
}
interface InstallationGenealogy {
  installationId: string;
  sourceUnits: SourceUnit[];
}
interface BundleGenealogy {
  originalLengthM: number;
  remainingInStockM: number;
  inTransitM: number;
  availableOffcutM: number;
  installedM: number;
  scrapM: number;
  adjustmentsM: number;
  accountedForM: number;
  fullyConserved: boolean;
  partiallyAttributedUnits: { materialUnitId: string; confidence: string; contributionWeight: string | null }[];
}

function OriginsTable({ origins }: { origins: OriginRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
          <th className="py-1.5">Bundle</th>
          <th>Diameter</th>
          <th>Grade</th>
          <th>Confidence</th>
          <th>Contribution</th>
        </tr>
      </thead>
      <tbody>
        {origins.map((o, i) => (
          <tr key={i} className="border-b border-slate-100">
            <td className="py-1.5 font-mono text-xs">{o.internal_reference_code}</td>
            <td>{o.diameter_mm} mm</td>
            <td>{o.grade}</td>
            <td>
              <Badge value={o.confidence} />
            </td>
            <td>{o.contribution_weight ?? <span className="text-xs text-slate-400">Known candidate set (no fabricated %)</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TraceabilityPage() {
  const [backwardId, setBackwardId] = useState("");
  const [unitResult, setUnitResult] = useState<UnitGenealogy | null>(null);
  const [installationResult, setInstallationResult] = useState<InstallationGenealogy | null>(null);
  const [backwardError, setBackwardError] = useState<string | null>(null);
  const [backwardBusy, setBackwardBusy] = useState(false);

  const [bundleId, setBundleId] = useState("");
  const [bundleResult, setBundleResult] = useState<BundleGenealogy | null>(null);
  const [forwardError, setForwardError] = useState<string | null>(null);
  const [forwardBusy, setForwardBusy] = useState(false);

  async function searchBackward(e: FormEvent) {
    e.preventDefault();
    setBackwardError(null);
    setUnitResult(null);
    setInstallationResult(null);
    setBackwardBusy(true);
    try {
      setUnitResult(await api.get<UnitGenealogy>(`/reports/genealogy/unit/${backwardId.trim()}`));
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        try {
          const installation = await api.get<InstallationGenealogy & { id: string }>(`/installations/${backwardId.trim()}`);
          setInstallationResult({ installationId: installation.id, sourceUnits: installation.sourceUnits });
        } catch (err2) {
          setBackwardError(err2 instanceof ApiRequestError ? err2.message : "No material unit or installation found with that ID");
        }
      } else {
        setBackwardError(err instanceof ApiRequestError ? err.message : "Lookup failed");
      }
    } finally {
      setBackwardBusy(false);
    }
  }

  async function searchForward(e: FormEvent) {
    e.preventDefault();
    setForwardError(null);
    setBundleResult(null);
    setForwardBusy(true);
    try {
      setBundleResult(await api.get<BundleGenealogy>(`/reports/genealogy/bundle/${bundleId.trim()}`));
    } catch (err) {
      setForwardError(err instanceof ApiRequestError ? err.message : "Bundle not found");
    } finally {
      setForwardBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Genealogy & Traceability Explorer" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Backward Genealogy — Unit / Installation → Source Bundles</h2>
          <form onSubmit={searchBackward} className="mb-3 flex gap-2">
            <Field label="Material unit ID or Installation ID">
              <input required value={backwardId} onChange={(e) => setBackwardId(e.target.value)} className={inputClass} placeholder="UUID" />
            </Field>
            <Button type="submit" disabled={backwardBusy} className="mt-auto">
              Search
            </Button>
          </form>
          <ErrorBanner message={backwardError} />
          {unitResult && <OriginsTable origins={unitResult.origins} />}
          {installationResult && (
            <div className="space-y-4">
              {installationResult.sourceUnits.map((su) => (
                <div key={su.materialUnitId}>
                  <p className="mb-1 font-mono text-xs text-slate-500">Unit {su.materialUnitId.slice(0, 8)}</p>
                  <OriginsTable origins={su.origins} />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Forward Genealogy — Bundle → Processing → Installed / Scrap</h2>
          <form onSubmit={searchForward} className="mb-3 flex gap-2">
            <Field label="Bundle ID">
              <input required value={bundleId} onChange={(e) => setBundleId(e.target.value)} className={inputClass} placeholder="UUID" />
            </Field>
            <Button type="submit" disabled={forwardBusy} className="mt-auto">
              Search
            </Button>
          </form>
          <ErrorBanner message={forwardError} />
          {bundleResult && (
            <div className="space-y-3 text-sm">
              <div className={`rounded-md border px-3 py-2 ${bundleResult.fullyConserved ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                {bundleResult.fullyConserved ? "Fully conserved." : "Not yet fully accounted for."}
              </div>
              <table className="w-full text-sm">
                <tbody>
                  <tr className="border-b border-slate-100">
                    <td className="py-1 text-slate-500">Original</td>
                    <td className="text-right font-medium">{bundleResult.originalLengthM.toFixed(2)} m</td>
                  </tr>
                  <tr className="border-b border-slate-100">
                    <td className="py-1 text-slate-500">In stock</td>
                    <td className="text-right">{bundleResult.remainingInStockM.toFixed(2)} m</td>
                  </tr>
                  <tr className="border-b border-slate-100">
                    <td className="py-1 text-slate-500">In transit</td>
                    <td className="text-right">{bundleResult.inTransitM.toFixed(2)} m</td>
                  </tr>
                  <tr className="border-b border-slate-100">
                    <td className="py-1 text-slate-500">Reusable offcut</td>
                    <td className="text-right">{bundleResult.availableOffcutM.toFixed(2)} m</td>
                  </tr>
                  <tr className="border-b border-slate-100">
                    <td className="py-1 text-slate-500">Installed</td>
                    <td className="text-right">{bundleResult.installedM.toFixed(2)} m</td>
                  </tr>
                  <tr className="border-b border-slate-100">
                    <td className="py-1 text-slate-500">Scrap</td>
                    <td className="text-right">{bundleResult.scrapM.toFixed(2)} m</td>
                  </tr>
                  <tr className="border-b border-slate-100">
                    <td className="py-1 text-slate-500">Adjustments</td>
                    <td className="text-right">{bundleResult.adjustmentsM.toFixed(2)} m</td>
                  </tr>
                  <tr>
                    <td className="py-1 font-medium text-slate-700">Accounted for</td>
                    <td className="text-right font-medium">{bundleResult.accountedForM.toFixed(2)} m</td>
                  </tr>
                </tbody>
              </table>

              {bundleResult.partiallyAttributedUnits.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-500">
                    Partially / pooled-attributed units (excluded from the strict conservation sum above — never a fabricated fractional share, CLAUDE.md §8 Q18):
                  </p>
                  <ul className="space-y-0.5 text-xs text-slate-500">
                    {bundleResult.partiallyAttributedUnits.map((u) => (
                      <li key={u.materialUnitId} className="flex justify-between">
                        <span className="font-mono">{u.materialUnitId.slice(0, 8)}</span>
                        <Badge value={u.confidence} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="text-xs text-slate-400">
                Per-structural-element installation detail isn't exposed by the API for a bundle yet — only the aggregate conservation figures above are available.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
