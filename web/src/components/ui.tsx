import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-slate-200 bg-white p-4 ${className}`}>{children}</div>;
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex items-center justify-between">
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      {actions}
    </div>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </Card>
  );
}

const BADGE_COLORS: Record<string, string> = {
  AVAILABLE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  RESERVED: "bg-amber-50 text-amber-700 border-amber-200",
  CONSUMED: "bg-slate-100 text-slate-600 border-slate-200",
  DISPATCHED: "bg-blue-50 text-blue-700 border-blue-200",
  INSTALLED: "bg-violet-50 text-violet-700 border-violet-200",
  ON_HOLD: "bg-red-50 text-red-700 border-red-200",
  ORIGINAL: "bg-slate-100 text-slate-600 border-slate-200",
  PENDING_RECONCILIATION: "bg-amber-50 text-amber-700 border-amber-200",
  PREPARED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  OFFCUT: "bg-blue-50 text-blue-700 border-blue-200",
  SCRAP: "bg-red-50 text-red-700 border-red-200",
  OPENING_STOCK: "bg-slate-100 text-slate-600 border-slate-200",
  GRN_PURCHASE: "bg-sky-50 text-sky-700 border-sky-200",
  ACCEPTED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  DAMAGED_DISCREPANT: "bg-red-50 text-red-700 border-red-200",
  BALANCED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  UNRECONCILED: "bg-red-50 text-red-700 border-red-200",
  EXACT: "bg-emerald-50 text-emerald-700 border-emerald-200",
  KNOWN_PARTIAL: "bg-amber-50 text-amber-700 border-amber-200",
  POOLED: "bg-slate-100 text-slate-600 border-slate-200",
  ACTIVE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  SUPERSEDED: "bg-slate-100 text-slate-500 border-slate-200",
};

export function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-slate-400">—</span>;
  const classes = BADGE_COLORS[value] ?? "bg-slate-100 text-slate-600 border-slate-200";
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${classes}`}>{value.replace(/_/g, " ")}</span>;
}

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  className?: string;
}) {
  const base = "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
  const variants: Record<string, string> = {
    primary: "bg-slate-900 text-white hover:bg-slate-700",
    secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
    danger: "bg-red-600 text-white hover:bg-red-500",
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{message}</div>;
}

export function Spinner() {
  return <div className="py-10 text-center text-sm text-slate-400">Loading…</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

// w-full + min-w-0 matter here: a bare <select> auto-sizes to its widest
// <option> text (e.g. a material-unit picker's long "code — Ø12mm, Nm
// left" labels), which inside a CSS grid row forces the whole grid wider
// than its container — observed firsthand as a horizontal scrollbar on
// the New Processing Operation modal. min-w-0 overrides the grid item's
// default min-width:auto (content-based), letting w-full actually shrink
// it to the assigned column track instead.
export const inputClass =
  "w-full min-w-0 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
