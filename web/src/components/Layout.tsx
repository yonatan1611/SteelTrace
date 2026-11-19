import { useState } from "react";
import type { FormEvent } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Package,
  Warehouse,
  Truck,
  FileSpreadsheet,
  Hammer,
  Building2,
  ClipboardCheck,
  GitBranch,
  Settings,
  Search,
  ChevronDown,
  LogOut,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { resolveReferenceCode } from "../lib/search";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/bundles", label: "Bundles & GRN", icon: Package },
  { to: "/inventory", label: "Inventory", icon: Warehouse },
  { to: "/transfers", label: "Transfers", icon: Truck },
  { to: "/bbs", label: "BBS", icon: FileSpreadsheet },
  { to: "/processing", label: "Processing", icon: Hammer },
  { to: "/installations", label: "Installations", icon: Building2 },
  { to: "/counts", label: "Stock Counts", icon: ClipboardCheck },
  { to: "/traceability", label: "Traceability", icon: GitBranch },
  { to: "/master-data", label: "Master Data", icon: Settings },
];

function CompanySwitcher() {
  const { session, switchCompany } = useAuth();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  if (!session) return null;

  const active = session.memberships.find((m) => m.companyId === session.activeCompanyId);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        {active?.companyName ?? "Select company"}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {session.memberships.map((m) => (
            <button
              key={m.membershipId}
              disabled={switching}
              onClick={async () => {
                setSwitching(true);
                try {
                  await switchCompany(m.companyId);
                } finally {
                  setSwitching(false);
                  setOpen(false);
                }
              }}
              className={`flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                m.companyId === session.activeCompanyId ? "bg-slate-50 font-medium text-slate-900" : "text-slate-600"
              }`}
            >
              <span>{m.companyName}</span>
              <span className="text-xs text-slate-400">{m.roleName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReferenceSearchBar() {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "searching" | "not-found">("idle");
  const navigate = useNavigate();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setStatus("searching");
    try {
      const result = await resolveReferenceCode(value);
      if (result) {
        navigate(result.path);
        setValue("");
        setStatus("idle");
      } else {
        setStatus("not-found");
      }
    } catch {
      setStatus("not-found");
    }
  }

  return (
    <form onSubmit={onSubmit} className="relative flex-1 max-w-sm">
      <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setStatus("idle");
        }}
        placeholder="ST-BND-0001, ST-PROC-..., ST-REM-..., or UUID"
        className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-8 pr-3 text-sm placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
      />
      {status === "searching" && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">...</span>}
      {status === "not-found" && (
        <span className="absolute left-0 top-full mt-1 text-xs text-red-600">No bundle, operation, or unit matches that code.</span>
      )}
    </form>
  );
}

export function Layout() {
  const { session, logout } = useAuth();

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="px-4 py-4 text-lg font-semibold text-slate-900">SteelTrace</div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium ${
                  isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-3 text-xs text-slate-500">{session?.displayName || session?.email}</div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-slate-200 bg-white px-6 py-3">
          <ReferenceSearchBar />
          <div className="ml-auto flex items-center gap-3">
            <CompanySwitcher />
            <button onClick={logout} title="Log out" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800">
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
