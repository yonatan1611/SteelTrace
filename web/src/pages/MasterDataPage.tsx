import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, ApiRequestError } from "../lib/api";
import { Button, Card, ErrorBanner, Field, PageHeader, inputClass } from "../components/ui";

const TABS = [
  "Projects",
  "Location Nodes",
  "Storage Locations",
  "Rebar Catalog",
  "Structural Elements",
  "Reinforcement Purposes",
  "Shape Codes",
  "Suppliers & Manufacturers",
  "Team",
] as const;
type Tab = (typeof TABS)[number];

interface Row {
  id: string;
  [key: string]: unknown;
}

/** Generic "list existing + add one" section — every master-data table here shares this shape; only the fields differ. */
function Section<T extends Record<string, unknown>>({
  title,
  listPath,
  columns,
  emptyForm,
  buildPayload,
  renderField,
}: {
  title: string;
  listPath: string;
  columns: { key: string; label: string }[];
  emptyForm: T;
  buildPayload: (form: T) => Record<string, unknown>;
  renderField: (key: keyof T, form: T, setForm: (f: T) => void) => ReactNode;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [form, setForm] = useState<T>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    try {
      setRows(await api.get<Row[]>(listPath));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listPath]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post(listPath, buildPayload(form));
      setForm(emptyForm);
      await reload();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      <ErrorBanner message={error} />
      <table className="mb-4 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
            {columns.map((c) => (
              <th key={c.key} className="py-1.5">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-slate-100">
              {columns.map((c) => (
                <td key={c.key} className="py-1.5">
                  {String(r[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="py-3 text-center text-slate-400">
                None yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
        {Object.keys(emptyForm).map((key) => (
          <div key={key}>{renderField(key as keyof T, form, setForm)}</div>
        ))}
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Add"}
        </Button>
      </form>
    </Card>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <input value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} />
    </Field>
  );
}

export function MasterDataPage() {
  const [tab, setTab] = useState<Tab>("Projects");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState("");
  const [inviteResult, setInviteResult] = useState<{ token: string; expiresAt: string } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [deactivateId, setDeactivateId] = useState("");
  const [roles, setRoles] = useState<Row[]>([]);

  useEffect(() => {
    if (tab === "Team") api.get<Row[]>("/roles").then(setRoles).catch(() => {});
  }, [tab]);

  async function sendInvite(e: FormEvent) {
    e.preventDefault();
    setInviteError(null);
    try {
      setInviteResult(await api.post("/invitations", { invitedEmail: inviteEmail, roleId: inviteRoleId }));
    } catch (e) {
      setInviteError(e instanceof ApiRequestError ? e.message : "Could not create invitation (must be Company Admin)");
    }
  }

  async function deactivate(e: FormEvent) {
    e.preventDefault();
    setInviteError(null);
    try {
      await api.patch(`/memberships/${deactivateId}/deactivate`);
      setDeactivateId("");
    } catch (e) {
      setInviteError(e instanceof ApiRequestError ? e.message : "Could not deactivate membership");
    }
  }

  return (
    <div>
      <PageHeader title="Master Data" />
      <div className="mb-5 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-t-md px-3 py-2 text-sm font-medium ${tab === t ? "border-b-2 border-slate-900 text-slate-900" : "text-slate-500 hover:text-slate-800"}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Projects" && (
        <Section
          title="Projects"
          listPath="/projects"
          columns={[{ key: "name", label: "Name" }, { key: "building_type", label: "Building type" }]}
          emptyForm={{ name: "", buildingType: "" }}
          buildPayload={(f) => ({ name: f.name, buildingType: f.buildingType || undefined })}
          renderField={(key, form, setForm) =>
            key === "name" ? (
              <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            ) : (
              <TextField label="Building type" value={form.buildingType} onChange={(v) => setForm({ ...form, buildingType: v })} />
            )
          }
        />
      )}

      {tab === "Structural Elements" && (
        <Section
          title="Structural Element Types"
          listPath="/structural-element-types"
          columns={[{ key: "name", label: "Name" }, { key: "is_active", label: "Active" }]}
          emptyForm={{ name: "" }}
          buildPayload={(f) => ({ name: f.name })}
          renderField={(_key, form, setForm) => <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />}
        />
      )}

      {tab === "Reinforcement Purposes" && (
        <Section
          title="Reinforcement Purposes"
          listPath="/reinforcement-purposes"
          columns={[{ key: "name", label: "Name" }, { key: "is_active", label: "Active" }]}
          emptyForm={{ name: "" }}
          buildPayload={(f) => ({ name: f.name })}
          renderField={(_key, form, setForm) => <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />}
        />
      )}

      {tab === "Shape Codes" && (
        <Section
          title="Shape Codes"
          listPath="/shape-codes"
          columns={[{ key: "code", label: "Code" }, { key: "name", label: "Name" }]}
          emptyForm={{ code: "", name: "", activeDimensions: "" }}
          buildPayload={(f) => ({ code: f.code, name: f.name, activeDimensions: f.activeDimensions ? f.activeDimensions.split(",").map((s: string) => s.trim()) : [] })}
          renderField={(key, form, setForm) =>
            key === "code" ? (
              <TextField label="Code" value={form.code} onChange={(v) => setForm({ ...form, code: v })} />
            ) : key === "name" ? (
              <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            ) : (
              <TextField label="Active dimensions (comma-sep)" value={form.activeDimensions} onChange={(v) => setForm({ ...form, activeDimensions: v })} />
            )
          }
        />
      )}

      {tab === "Suppliers & Manufacturers" && (
        <div className="space-y-6">
          <Section
            title="Suppliers"
            listPath="/suppliers"
            columns={[{ key: "name", label: "Name" }, { key: "country", label: "Country" }]}
            emptyForm={{ name: "", country: "" }}
            buildPayload={(f) => ({ name: f.name, country: f.country || undefined })}
            renderField={(key, form, setForm) =>
              key === "name" ? (
                <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
              ) : (
                <TextField label="Country" value={form.country} onChange={(v) => setForm({ ...form, country: v })} />
              )
            }
          />
          <Section
            title="Manufacturers"
            listPath="/manufacturers"
            columns={[{ key: "name", label: "Name" }, { key: "country", label: "Country" }]}
            emptyForm={{ name: "", country: "" }}
            buildPayload={(f) => ({ name: f.name, country: f.country || undefined })}
            renderField={(key, form, setForm) =>
              key === "name" ? (
                <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
              ) : (
                <TextField label="Country" value={form.country} onChange={(v) => setForm({ ...form, country: v })} />
              )
            }
          />
        </div>
      )}

      {tab === "Storage Locations" && (
        <Section
          title="Storage Locations"
          listPath="/storage-locations"
          columns={[
            { key: "name", label: "Name" },
            { key: "location_type", label: "Type" },
            { key: "zone_code", label: "Zone" },
            { key: "rack_code", label: "Rack" },
            { key: "bay_code", label: "Bay" },
          ]}
          emptyForm={{ name: "", locationType: "WAREHOUSE", zoneCode: "", rackCode: "", bayCode: "" }}
          buildPayload={(f) => ({ name: f.name, locationType: f.locationType, zoneCode: f.zoneCode || undefined, rackCode: f.rackCode || undefined, bayCode: f.bayCode || undefined })}
          renderField={(key, form, setForm) => {
            if (key === "locationType") {
              return (
                <Field label="Type">
                  <select value={form.locationType} onChange={(e) => setForm({ ...form, locationType: e.target.value })} className={inputClass}>
                    <option value="WAREHOUSE">Warehouse</option>
                    <option value="PROCESSING_AREA">Processing area</option>
                    <option value="SITE">Site</option>
                    <option value="OTHER">Other</option>
                  </select>
                </Field>
              );
            }
            const labels: Record<string, string> = { name: "Name", zoneCode: "Zone", rackCode: "Rack", bayCode: "Bay" };
            return <TextField label={labels[key as string]} value={form[key] as string} onChange={(v) => setForm({ ...form, [key]: v })} />;
          }}
        />
      )}

      {tab === "Rebar Catalog" && (
        <Section
          title="Rebar Catalog"
          listPath="/rebar-catalog-items"
          columns={[
            { key: "item_code", label: "Code" },
            { key: "diameter_mm", label: "Dia (mm)" },
            { key: "surface_type", label: "Surface" },
            { key: "linear_density_kg_per_m", label: "Density (kg/m)" },
            { key: "reorder_threshold_mt", label: "Reorder (MT)" },
          ]}
          emptyForm={{ itemCode: "", diameterMm: "", surfaceType: "DEFORMED", linearDensityKgPerM: "", reorderThresholdMt: "" }}
          buildPayload={(f) => ({
            itemCode: f.itemCode,
            diameterMm: Number(f.diameterMm),
            surfaceType: f.surfaceType,
            linearDensityKgPerM: Number(f.linearDensityKgPerM),
            reorderThresholdMt: f.reorderThresholdMt ? Number(f.reorderThresholdMt) : undefined,
          })}
          renderField={(key, form, setForm) => {
            if (key === "surfaceType") {
              return (
                <Field label="Surface">
                  <select value={form.surfaceType} onChange={(e) => setForm({ ...form, surfaceType: e.target.value })} className={inputClass}>
                    <option value="DEFORMED">Deformed</option>
                    <option value="PLAIN">Plain</option>
                  </select>
                </Field>
              );
            }
            const labels: Record<string, string> = { itemCode: "Item code", diameterMm: "Diameter mm", linearDensityKgPerM: "Density kg/m", reorderThresholdMt: "Reorder threshold MT" };
            return <TextField label={labels[key as string]} value={form[key] as string} onChange={(v) => setForm({ ...form, [key]: v })} />;
          }}
        />
      )}

      {tab === "Location Nodes" && <LocationNodesSection />}

      {tab === "Team" && (
        <div className="space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Invite a team member</h2>
            <ErrorBanner message={inviteError} />
            <form onSubmit={sendInvite} className="flex flex-wrap items-end gap-2">
              <TextField label="Email" value={inviteEmail} onChange={setInviteEmail} />
              <Field label="Role">
                <select value={inviteRoleId} onChange={(e) => setInviteRoleId(e.target.value)} className={inputClass}>
                  <option value="">Select…</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {String(r.name)}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit">Send invitation</Button>
            </form>
            {inviteResult && (
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
                <p className="mb-1 text-slate-600">Invitation token (share with the invitee — no email delivery is wired up yet):</p>
                <code className="break-all text-xs">{inviteResult.token}</code>
              </div>
            )}
          </Card>
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Deactivate a membership</h2>
            <p className="mb-2 text-xs text-slate-500">
              No endpoint lists existing memberships yet — paste a membership ID directly.
            </p>
            <form onSubmit={deactivate} className="flex items-end gap-2">
              <TextField label="Membership ID" value={deactivateId} onChange={setDeactivateId} />
              <Button type="submit" variant="danger">
                Deactivate
              </Button>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}

function LocationNodesSection() {
  const [types, setTypes] = useState<Row[]>([]);
  const [projects, setProjects] = useState<Row[]>([]);
  const [newTypeName, setNewTypeName] = useState("");

  useEffect(() => {
    api.get<Row[]>("/location-node-types").then(setTypes).catch(() => {});
    api.get<Row[]>("/projects").then(setProjects).catch(() => {});
  }, []);

  async function addType(e: FormEvent) {
    e.preventDefault();
    await api.post("/location-node-types", { name: newTypeName });
    setNewTypeName("");
    setTypes(await api.get<Row[]>("/location-node-types"));
  }

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Location Node Types</h2>
        <p className="mb-2 text-xs text-slate-500">e.g. Building, Level/Floor, Zone — the shape of this company's installation-location hierarchy.</p>
        <ul className="mb-3 text-sm text-slate-600">
          {types.map((t) => (
            <li key={t.id}>{String(t.name)}</li>
          ))}
        </ul>
        <form onSubmit={addType} className="flex items-end gap-2">
          <TextField label="Name" value={newTypeName} onChange={setNewTypeName} />
          <Button type="submit">Add type</Button>
        </form>
      </Card>

      <Section
        title="Location Nodes"
        listPath="/location-nodes"
        columns={[{ key: "name", label: "Name" }, { key: "project_id", label: "Project" }]}
        emptyForm={{ name: "", projectId: "", locationNodeTypeId: "", parentId: "" }}
        buildPayload={(f) => ({ name: f.name, projectId: f.projectId, locationNodeTypeId: f.locationNodeTypeId, parentId: f.parentId || undefined })}
        renderField={(key, form, setForm) => {
          if (key === "projectId") {
            return (
              <Field label="Project">
                <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} className={inputClass}>
                  <option value="">Select…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {String(p.name)}
                    </option>
                  ))}
                </select>
              </Field>
            );
          }
          if (key === "locationNodeTypeId") {
            return (
              <Field label="Type">
                <select value={form.locationNodeTypeId} onChange={(e) => setForm({ ...form, locationNodeTypeId: e.target.value })} className={inputClass}>
                  <option value="">Select…</option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {String(t.name)}
                    </option>
                  ))}
                </select>
              </Field>
            );
          }
          if (key === "parentId") return <TextField label="Parent node ID (optional)" value={form.parentId} onChange={(v) => setForm({ ...form, parentId: v })} />;
          return <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />;
        }}
      />
    </div>
  );
}
