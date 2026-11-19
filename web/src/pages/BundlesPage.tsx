import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { QrCode, Check, Lock } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Badge, Button, Card, ErrorBanner, Field, Modal, PageHeader, Spinner, inputClass } from "../components/ui";

interface BundleRow {
  id: string;
  internal_reference_code: string;
  diameter_mm: string;
  grade: string;
  surface_type: string;
  origin_type: string;
  heat_number: string | null;
  initial_disposition: string;
  approved_by_membership_id: string | null;
  rootMaterialUnitId: string | null;
  remainingLengthM: string | null;
  rollingMarginKg: string | null;
}
interface InventoryRow {
  id: string;
  status: string;
}
interface LookupRow {
  id: string;
  name: string;
}
interface StorageLocationRow {
  id: string;
  name: string;
}

const emptyForm = {
  storageLocationId: "",
  projectId: "",
  internalReferenceCode: "",
  diameterMm: "",
  grade: "",
  standard: "",
  heatNumber: "",
  pieceCount: "",
  barLengthM: "",
  surfaceType: "DEFORMED" as "DEFORMED" | "PLAIN",
  originType: "GRN_PURCHASE" as "OPENING_STOCK" | "GRN_PURCHASE",
  grnReference: "",
  poReference: "",
  deliveryNoteNumber: "",
  vehicleInfo: "",
  weighbridgeTicketNumber: "",
  mtcReference: "",
  actualWeightKg: "",
  supplierId: "",
  manufacturerId: "",
  initialDisposition: "ACCEPTED" as "ACCEPTED" | "ON_HOLD" | "DAMAGED_DISCREPANT",
};

export function BundlesPage() {
  const [params] = useSearchParams();
  const highlight = params.get("highlight");

  const [bundles, setBundles] = useState<BundleRow[]>([]);
  const [statusByUnitId, setStatusByUnitId] = useState<Record<string, string>>({});
  const [storageLocations, setStorageLocations] = useState<StorageLocationRow[]>([]);
  const [projects, setProjects] = useState<LookupRow[]>([]);
  const [suppliers, setSuppliers] = useState<LookupRow[]>([]);
  const [manufacturers, setManufacturers] = useState<LookupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showRegister, setShowRegister] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [qrFor, setQrFor] = useState<BundleRow | null>(null);
  const [qrData, setQrData] = useState<{ svgDataUrl: string; payload: string } | null>(null);

  const [releaseFor, setReleaseFor] = useState<BundleRow | null>(null);
  const [releaseReason, setReleaseReason] = useState("");

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const [b, inv] = await Promise.all([api.get<BundleRow[]>("/bundles"), api.get<InventoryRow[]>("/inventory?limit=1000")]);
      setBundles(b);
      const map: Record<string, string> = {};
      for (const u of inv) map[u.id] = u.status;
      setStatusByUnitId(map);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Failed to load bundles");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    api.get<StorageLocationRow[]>("/storage-locations").then(setStorageLocations).catch(() => {});
    api.get<LookupRow[]>("/projects").then(setProjects).catch(() => {});
    api.get<LookupRow[]>("/suppliers").then(setSuppliers).catch(() => {});
    api.get<LookupRow[]>("/manufacturers").then(setManufacturers).catch(() => {});
  }, []);

  const sorted = useMemo(() => {
    if (!highlight) return bundles;
    const idx = bundles.findIndex((b) => b.id === highlight);
    if (idx <= 0) return bundles;
    const copy = [...bundles];
    const [item] = copy.splice(idx, 1);
    copy.unshift(item);
    return copy;
  }, [bundles, highlight]);

  async function submitRegister(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await api.post("/bundles", {
        storageLocationId: form.storageLocationId,
        projectId: form.projectId || undefined,
        internalReferenceCode: form.internalReferenceCode,
        diameterMm: Number(form.diameterMm),
        grade: form.grade,
        standard: form.standard || undefined,
        heatNumber: form.heatNumber || undefined,
        pieceCount: Number(form.pieceCount),
        barLengthM: Number(form.barLengthM),
        surfaceType: form.surfaceType,
        originType: form.originType,
        grnReference: form.grnReference || undefined,
        poReference: form.poReference || undefined,
        deliveryNoteNumber: form.deliveryNoteNumber || undefined,
        vehicleInfo: form.vehicleInfo || undefined,
        weighbridgeTicketNumber: form.weighbridgeTicketNumber || undefined,
        mtcReference: form.mtcReference || undefined,
        actualWeightKg: form.actualWeightKg ? Number(form.actualWeightKg) : undefined,
        supplierId: form.supplierId || undefined,
        manufacturerId: form.manufacturerId || undefined,
        initialDisposition: form.initialDisposition,
      });
      setShowRegister(false);
      setForm(emptyForm);
      await reload();
    } catch (e) {
      setFormError(e instanceof ApiRequestError ? e.message : "Could not register bundle");
    } finally {
      setBusy(false);
    }
  }

  async function approve(b: BundleRow) {
    try {
      await api.post(`/bundles/${b.id}/approve`);
      await reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not approve bundle");
    }
  }

  async function openQr(b: BundleRow) {
    setQrFor(b);
    setQrData(null);
    try {
      setQrData(await api.get(`/bundles/${b.id}/qr`));
    } catch {
      setQrData(null);
    }
  }

  async function submitRelease(e: FormEvent) {
    e.preventDefault();
    if (!releaseFor?.rootMaterialUnitId) return;
    try {
      await api.post(`/material-units/${releaseFor.rootMaterialUnitId}/release-hold`, { reason: releaseReason });
      setReleaseFor(null);
      setReleaseReason("");
      await reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not release hold");
    }
  }

  return (
    <div>
      <PageHeader title="Bundles & GRN Receiving" actions={<Button onClick={() => setShowRegister(true)}>Register Bundle / GRN</Button>} />
      <ErrorBanner message={error} />

      {loading ? (
        <Spinner />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="py-2 pl-4">Code</th>
                <th>Origin</th>
                <th>Diameter</th>
                <th>Surface</th>
                <th>Grade</th>
                <th>Heat #</th>
                <th className="text-right">Remaining (m)</th>
                <th className="text-right">Rolling Margin (kg)</th>
                <th>Status</th>
                <th>Approval</th>
                <th className="pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((b) => {
                const status = b.rootMaterialUnitId ? statusByUnitId[b.rootMaterialUnitId] : undefined;
                return (
                  <tr key={b.id} className={`border-b border-slate-100 ${b.id === highlight ? "bg-amber-50" : ""}`}>
                    <td className="py-2 pl-4 font-medium">{b.internal_reference_code}</td>
                    <td>
                      <Badge value={b.origin_type} />
                    </td>
                    <td>{b.diameter_mm} mm</td>
                    <td>{b.surface_type}</td>
                    <td>{b.grade}</td>
                    <td>{b.heat_number ?? "—"}</td>
                    <td className="text-right">{b.remainingLengthM ? Number(b.remainingLengthM).toFixed(1) : "—"}</td>
                    <td className="text-right">{b.rollingMarginKg ? Number(b.rollingMarginKg).toFixed(1) : "—"}</td>
                    <td>
                      <Badge value={status ?? b.initial_disposition} />
                    </td>
                    <td>{b.approved_by_membership_id ? <Badge value="ACCEPTED" /> : <span className="text-xs text-slate-400">pending</span>}</td>
                    <td className="pr-4 text-right">
                      <div className="flex justify-end gap-1">
                        <button title="QR code" onClick={() => openQr(b)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100">
                          <QrCode size={15} />
                        </button>
                        {!b.approved_by_membership_id && (
                          <button title="Approve (maker-checker)" onClick={() => approve(b)} className="rounded p-1.5 text-emerald-600 hover:bg-emerald-50">
                            <Check size={15} />
                          </button>
                        )}
                        {status === "ON_HOLD" && (
                          <button title="Release hold" onClick={() => setReleaseFor(b)} className="rounded p-1.5 text-amber-600 hover:bg-amber-50">
                            <Lock size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-6 text-center text-slate-400">
                    No bundles registered yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {showRegister && (
        <Modal title="Register Bundle / GRN" onClose={() => setShowRegister(false)}>
          <form onSubmit={submitRegister} className="flex flex-col gap-3">
            <ErrorBanner message={formError} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Internal reference code">
                <input required value={form.internalReferenceCode} onChange={(e) => setForm({ ...form, internalReferenceCode: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Storage location">
                <select required value={form.storageLocationId} onChange={(e) => setForm({ ...form, storageLocationId: e.target.value })} className={inputClass}>
                  <option value="">Select…</option>
                  {storageLocations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Project (optional)">
                <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} className={inputClass}>
                  <option value="">Unallocated</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Origin type">
                <select value={form.originType} onChange={(e) => setForm({ ...form, originType: e.target.value as typeof form.originType })} className={inputClass}>
                  <option value="GRN_PURCHASE">GRN Purchase</option>
                  <option value="OPENING_STOCK">Opening Stock</option>
                </select>
              </Field>
              <Field label="Diameter (mm)">
                <input required type="number" step="0.1" value={form.diameterMm} onChange={(e) => setForm({ ...form, diameterMm: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Surface type">
                <select value={form.surfaceType} onChange={(e) => setForm({ ...form, surfaceType: e.target.value as typeof form.surfaceType })} className={inputClass}>
                  <option value="DEFORMED">Deformed</option>
                  <option value="PLAIN">Plain</option>
                </select>
              </Field>
              <Field label="Grade">
                <input required value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Standard">
                <input value={form.standard} onChange={(e) => setForm({ ...form, standard: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Piece count">
                <input required type="number" min={1} value={form.pieceCount} onChange={(e) => setForm({ ...form, pieceCount: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Bar length (m)">
                <input required type="number" step="0.01" value={form.barLengthM} onChange={(e) => setForm({ ...form, barLengthM: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Heat / casting number">
                <input value={form.heatNumber} onChange={(e) => setForm({ ...form, heatNumber: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Actual weight (kg)">
                <input type="number" step="0.01" value={form.actualWeightKg} onChange={(e) => setForm({ ...form, actualWeightKg: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Supplier">
                <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} className={inputClass}>
                  <option value="">—</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Manufacturer">
                <select value={form.manufacturerId} onChange={(e) => setForm({ ...form, manufacturerId: e.target.value })} className={inputClass}>
                  <option value="">—</option>
                  {manufacturers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {form.originType === "GRN_PURCHASE" && (
              <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3">
                <Field label="GRN reference">
                  <input value={form.grnReference} onChange={(e) => setForm({ ...form, grnReference: e.target.value })} className={inputClass} />
                </Field>
                <Field label="PO reference">
                  <input value={form.poReference} onChange={(e) => setForm({ ...form, poReference: e.target.value })} className={inputClass} />
                </Field>
                <Field label="Delivery note number">
                  <input value={form.deliveryNoteNumber} onChange={(e) => setForm({ ...form, deliveryNoteNumber: e.target.value })} className={inputClass} />
                </Field>
                <Field label="Vehicle info">
                  <input value={form.vehicleInfo} onChange={(e) => setForm({ ...form, vehicleInfo: e.target.value })} className={inputClass} />
                </Field>
                <Field label="Weighbridge ticket #">
                  <input value={form.weighbridgeTicketNumber} onChange={(e) => setForm({ ...form, weighbridgeTicketNumber: e.target.value })} className={inputClass} />
                </Field>
                <Field label="MTC reference">
                  <input value={form.mtcReference} onChange={(e) => setForm({ ...form, mtcReference: e.target.value })} className={inputClass} />
                </Field>
              </div>
            )}

            <Field label="Initial disposition">
              <select
                value={form.initialDisposition}
                onChange={(e) => setForm({ ...form, initialDisposition: e.target.value as typeof form.initialDisposition })}
                className={inputClass}
              >
                <option value="ACCEPTED">Accepted</option>
                <option value="ON_HOLD">On Hold (quarantine)</option>
                <option value="DAMAGED_DISCREPANT">Damaged / Discrepant (quarantine)</option>
              </select>
            </Field>

            <Button type="submit" disabled={busy} className="mt-2 justify-center">
              {busy ? "Registering…" : "Register bundle"}
            </Button>
          </form>
        </Modal>
      )}

      {qrFor && (
        <Modal title={`QR — ${qrFor.internal_reference_code}`} onClose={() => setQrFor(null)}>
          {qrData ? (
            <div className="flex flex-col items-center gap-3">
              <img src={qrData.svgDataUrl} alt="QR code" className="h-56 w-56" />
              <code className="text-xs text-slate-500">{qrData.payload}</code>
            </div>
          ) : (
            <Spinner />
          )}
        </Modal>
      )}

      {releaseFor && (
        <Modal title={`Release Hold — ${releaseFor.internal_reference_code}`} onClose={() => setReleaseFor(null)}>
          <form onSubmit={submitRelease} className="flex flex-col gap-3">
            <Field label="Reason for release">
              <input required value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} className={inputClass} />
            </Field>
            <Button type="submit" className="justify-center">
              Release
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
