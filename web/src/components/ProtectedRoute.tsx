import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Button } from "./ui";

/** Shown when a logged-in user has a session but no active company yet (fresh registration, or every membership deactivated) — requireTenantAuth rejects every tenant route until one is picked. */
function SelectCompanyPrompt() {
  const { session, switchCompany, logout } = useAuth();
  if (!session) return null;

  if (session.memberships.length === 0) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50 text-center">
        <p className="text-sm text-slate-600">You don't belong to any company yet. Ask a Company Admin to invite you.</p>
        <Button variant="secondary" onClick={logout}>
          Log out
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50">
      <p className="text-sm text-slate-600">Choose a company to continue</p>
      <div className="flex flex-col gap-2">
        {session.memberships.map((m) => (
          <Button key={m.membershipId} variant="secondary" onClick={() => switchCompany(m.companyId)}>
            {m.companyName} — {m.roleName}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();

  if (loading) return null;
  if (!session) return <Navigate to="/login" replace />;
  if (!session.activeCompanyId) return <SelectCompanyPrompt />;
  return <>{children}</>;
}
