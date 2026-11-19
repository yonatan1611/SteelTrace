import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiRequestError } from "../lib/api";
import { Button, ErrorBanner, Field, inputClass } from "../components/ui";

export function RegisterPage() {
  const { register } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(email, password, displayName);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold text-slate-900">Create account</h1>
        <p className="mb-5 text-sm text-slate-500">
          A new account has no company membership yet — ask a Company Admin to invite you, or accept an invitation you already received.
        </p>
        <ErrorBanner message={error} />
        {done ? (
          <div className="space-y-3 text-sm text-slate-600">
            <p>Account created. Once a Company Admin invites you, accept the invitation to gain access.</p>
            <Link to="/login" className="font-medium text-slate-900 underline">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <Field label="Display name">
              <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputClass} />
            </Field>
            <Field label="Email">
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
            </Field>
            <Field label="Password">
              <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
            </Field>
            <Button type="submit" disabled={busy} className="mt-2 justify-center">
              {busy ? "Creating…" : "Create account"}
            </Button>
          </form>
        )}
        <p className="mt-4 text-center text-sm text-slate-500">
          <Link to="/login" className="font-medium text-slate-900 underline">
            Back to sign in
          </Link>
          {" · "}
          <Link to="/accept-invitation" className="font-medium text-slate-900 underline">
            Have an invitation?
          </Link>
        </p>
      </div>
    </div>
  );
}
