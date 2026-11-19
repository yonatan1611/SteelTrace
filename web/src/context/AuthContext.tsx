import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, setAuthToken } from "../lib/api";

export interface Membership {
  membershipId: string;
  companyId: string;
  companyName: string;
  roleId: string;
  roleName: string;
}

interface LoginResponse {
  token: string;
  userId: string;
  email: string;
  displayName: string;
  memberships: Membership[];
  activeCompanyId: string | null;
}

interface SwitchCompanyResponse {
  token: string;
  activeCompanyId: string;
  activeMembershipId: string;
  roleName: string;
}

export interface Session {
  token: string;
  userId: string;
  email: string;
  displayName: string;
  memberships: Membership[];
  activeCompanyId: string | null;
  roleName: string | null;
}

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  acceptInvitation: (token: string, password?: string, displayName?: string) => Promise<void>;
  switchCompany: (companyId: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const STORAGE_KEY = "steeltrace.session";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Session;
        setAuthToken(parsed.token);
        setSession(parsed);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    setLoading(false);
  }, []);

  const persist = useCallback((next: Session | null) => {
    setSession(next);
    setAuthToken(next?.token ?? null);
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.post<LoginResponse>("/auth/login", { email, password });
      const next: Session = {
        token: res.token,
        userId: res.userId,
        email: res.email,
        displayName: res.displayName,
        memberships: res.memberships,
        activeCompanyId: res.activeCompanyId,
        roleName: res.memberships.find((m) => m.companyId === res.activeCompanyId)?.roleName ?? null,
      };
      persist(next);
    },
    [persist],
  );

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    await api.post("/auth/register", { email, password, displayName });
  }, []);

  const acceptInvitation = useCallback(
    async (token: string, password?: string, displayName?: string) => {
      interface AcceptResponse {
        token: string;
        userId: string;
        companyId: string;
        membershipId: string;
        roleName: string;
      }
      const res = await api.post<AcceptResponse>("/invitations/accept", { token, password, displayName });
      // The accept response doesn't carry email/full membership list — a
      // follow-up login-style refresh via /api/auth/login isn't possible
      // here (no password guarantee on an existing account), so build the
      // session directly from what accept returned; switching to another
      // company later re-fetches a fresh token with the full list anyway.
      const next: Session = {
        token: res.token,
        userId: res.userId,
        email: "",
        displayName: "",
        memberships: [{ membershipId: res.membershipId, companyId: res.companyId, companyName: "", roleId: "", roleName: res.roleName }],
        activeCompanyId: res.companyId,
        roleName: res.roleName,
      };
      persist(next);
    },
    [persist],
  );

  const switchCompany = useCallback(
    async (companyId: string) => {
      const res = await api.post<SwitchCompanyResponse>("/auth/switch-company", { companyId });
      setSession((prev) => {
        if (!prev) return prev;
        const next: Session = { ...prev, token: res.token, activeCompanyId: res.activeCompanyId, roleName: res.roleName };
        setAuthToken(next.token);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    },
    [],
  );

  const logout = useCallback(() => persist(null), [persist]);

  const value = useMemo<AuthContextValue>(
    () => ({ session, loading, login, register, acceptInvitation, switchCompany, logout }),
    [session, loading, login, register, acceptInvitation, switchCompany, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
