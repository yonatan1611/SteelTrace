import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiRequestError } from "../lib/api";
import { Button, ErrorBanner, Field, inputClass } from "../components/ui";

export function AcceptInvitationPage() {
  const { acceptInvitation } = useAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await acceptInvitation(token, password || undefined, displayName || undefined);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not accept invitation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold text-slate-900">Accept invitation</h1>
        <p className="mb-5 text-sm text-slate-500">Paste the invitation token a Company Admin gave you. Password/name are only needed if you don't have an account yet.</p>
        <ErrorBanner message={error} />
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field label="Invitation token">
            <input required value={token} onChange={(e) => setToken(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Display name (new account only)">
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Password (new account only)">
            <input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
          </Field>
          <Button type="submit" disabled={busy} className="mt-2 justify-center">
            {busy ? "Joining…" : "Accept & join"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-500">
          <Link to="/login" className="font-medium text-slate-900 underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
