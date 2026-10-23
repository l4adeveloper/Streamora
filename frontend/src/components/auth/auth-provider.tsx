"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { LoginRequest, UpdateProfileRequest } from "@streamora/contracts";
import { authSession, type SessionSnapshot } from "@/lib/auth/session";

interface AuthState extends SessionSnapshot {
  login(dto: LoginRequest): Promise<void>;
  updateProfile(dto: UpdateProfileRequest): Promise<void>;
  logout(): Promise<void>;
  retry(): void;
}
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const current = useSyncExternalStore(
    authSession.subscribe,
    authSession.getSnapshot,
    authSession.getServerSnapshot,
  );
  const path = usePathname();
  useEffect(() => authSession.start(), []);
  const formNotice = path === "/" || path === "/login" || path === "/register";
  return (
    <AuthContext.Provider
      value={{
        ...current,
        login: authSession.login,
        updateProfile: authSession.updateProfile,
        logout: authSession.logout,
        retry: authSession.retry,
      }}
    >
      {children}
      {current.notice && !formNotice && current.phase !== "checking" && (
        <aside className="session-notice" role="status">
          <span>{current.notice}</span>
          {current.user ? (
            <button type="button" onClick={authSession.retry}>
              Thử lại
            </button>
          ) : (
            <Link href="/login">Đăng nhập</Link>
          )}
        </aside>
      )}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth requires AuthProvider");
  return auth;
}
