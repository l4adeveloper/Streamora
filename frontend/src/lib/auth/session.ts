import "client-only";
import type {
  LoginRequest,
  LoginResponse,
  RefreshResponse,
  UpdateProfileRequest,
  User,
  UserResponse,
} from "@streamora/contracts";
import {
  AuthApiError,
  asAuthError,
  authRequest,
  type AuthRequestOptions,
} from "./api";
import {
  listenForSessionChanges,
  publishProfile,
  publishRevision,
  readRevision,
  withCookieLock,
  type SessionRevision,
} from "./coordination";

export interface SessionSnapshot {
  phase: "checking" | "authenticated" | "anonymous" | "error";
  user: User | null;
  notice: string;
}
const INITIAL: SessionSnapshot = { phase: "checking", user: null, notice: "" };
let snapshot = INITIAL;
let token: string | null = null;
let expiresAt = 0;
let lifetime = 0;
let epoch = 0;
let revisionId: string | null = null;
let refreshBackoffUntil = 0;
let refreshFlight: Promise<string> | null = null;
let restoreFlight: Promise<User | null> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let clients = 0;
let detach: (() => void) | undefined;
let lastFocusCheck = 0;
const listeners = new Set<() => void>();
type Context = { epoch: number; userId: string | null };
const context = (): Context => ({ epoch, userId: snapshot.user?.id ?? null });
const changed = () =>
  new AuthApiError(
    409,
    "SESSION_CHANGED",
    "Tài khoản hoặc phiên đăng nhập đã thay đổi. Vui lòng thực hiện lại thao tác.",
  );
function assertCurrent(expected: Context) {
  if (
    expected.epoch !== epoch ||
    (expected.userId !== null && expected.userId !== snapshot.user?.id)
  )
    throw changed();
}
function setSnapshot(next: SessionSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
  armTimer();
}
function clearAccess() {
  token = null;
  expiresAt = 0;
  lifetime = 0;
  clearTimeout(timer);
}
function endMessage(reason?: string) {
  return reason === "disabled"
    ? "Tài khoản đã bị khóa. Vui lòng liên hệ người quản trị."
    : reason === "logout"
      ? "Bạn đã đăng xuất ở tab khác."
      : "Phiên đăng nhập đã hết hạn hoặc bị thu hồi. Vui lòng đăng nhập lại.";
}
function kickRestore() {
  queueMicrotask(() => {
    if (clients && snapshot.phase === "checking")
      void restoreSession().catch(() => {});
  });
}
function adoptRevision(next: SessionRevision) {
  if (next.id === revisionId) return;
  revisionId = next.id;
  epoch++;
  clearAccess();
  setSnapshot({
    user: null,
    phase: next.action === "signed-out" ? "anonymous" : "checking",
    notice: next.action === "signed-out" ? endMessage(next.reason) : "",
  });
  if (next.action === "changed") kickRestore();
}
function checkRevision() {
  const next = readRevision();
  if (next) adoptRevision(next);
}
function commitRevision(
  action: SessionRevision["action"],
  reason?: SessionRevision["reason"],
) {
  revisionId = publishRevision(action, reason).id;
  epoch++;
}
function acceptGrant(grant: RefreshResponse, user: User) {
  if (
    typeof grant.accessToken !== "string" ||
    !Number.isSafeInteger(grant.expiresIn) ||
    grant.expiresIn <= 0 ||
    typeof user?.id !== "string" ||
    typeof user.fullName !== "string" ||
    typeof user.email !== "string" ||
    !["USER", "ADMIN"].includes(user.globalRole)
  )
    throw new AuthApiError(
      502,
      "SERVICE_UNAVAILABLE",
      "Máy chủ trả về dữ liệu chưa hợp lệ. Vui lòng thử lại.",
    );
  const previous = snapshot.user;
  if (previous && previous.id !== user.id) commitRevision("changed");
  const unchanged =
    previous &&
    previous.id === user.id &&
    previous.email === user.email &&
    previous.fullName === user.fullName &&
    previous.globalRole === user.globalRole;
  token = grant.accessToken;
  lifetime = grant.expiresIn * 1000;
  expiresAt = Date.now() + lifetime;
  refreshBackoffUntil = 0;
  setSnapshot({
    user: unchanged ? previous : user,
    phase: "authenticated",
    notice: "",
  });
}
const isTerminal = (error: AuthApiError) =>
  error.status === 401 || error.code === "USER_DISABLED";
async function terminate(error: AuthApiError, expected: Context) {
  await withCookieLock(async () => {
    checkRevision();
    if (epoch !== expected.epoch) return;
    const hadSession = Boolean(snapshot.user || revisionId);
    const disabled = error.code === "USER_DISABLED";
    if (disabled || (hadSession && error.code === "UNAUTHENTICATED")) {
      // A protected resource cannot clear the auth-path HttpOnly cookie itself.
      await authRequest<void>("/auth/logout").catch(() => {});
      checkRevision();
      if (epoch !== expected.epoch) return;
    }
    if (hadSession || disabled)
      commitRevision("signed-out", disabled ? "disabled" : "expired");
    else epoch++;
    clearAccess();
    setSnapshot({
      phase: "anonymous",
      user: null,
      notice:
        hadSession || disabled
          ? endMessage(disabled ? "disabled" : "expired")
          : "",
    });
  });
}
function refreshAccess(failedToken?: string): Promise<string> {
  checkRevision();
  // A late 401 can belong to the old token that another request already replaced.
  if (failedToken && token && token !== failedToken && snapshot.user)
    return Promise.resolve(token);
  if (refreshFlight) return refreshFlight;
  const expected = context();
  refreshFlight = withCookieLock(async () => {
    checkRevision();
    assertCurrent(expected);
    const grant = await authRequest<RefreshResponse>("/auth/refresh");
    const result = await authRequest<UserResponse>("/users/me", {
      method: "GET",
      token: grant.accessToken,
    });
    assertCurrent(expected);
    acceptGrant(grant, result.user);
    return grant.accessToken;
  })
    .catch(async (cause: unknown) => {
      const error = asAuthError(cause);
      checkRevision();
      if (epoch !== expected.epoch) throw changed();
      if (isTerminal(error)) await terminate(error, expected);
      else {
        refreshBackoffUntil = Date.now() + 30000;
        armTimer();
      }
      throw error;
    })
    .finally(() => {
      refreshFlight = null;
      if (snapshot.phase === "checking" && !restoreFlight) kickRestore();
    });
  return refreshFlight;
}
function restoreSession(): Promise<User | null> {
  if (restoreFlight) return restoreFlight;
  const expected = context();
  restoreFlight = (async () => {
    if (token && snapshot.user) {
      const result = await authenticatedRequest<UserResponse>("/users/me");
      assertCurrent(expected);
      setSnapshot({ ...snapshot, user: result.user, notice: "" });
    } else await refreshAccess();
    return snapshot.user;
  })()
    .catch((cause: unknown) => {
      const error = asAuthError(cause);
      if (error.status === 401 && snapshot.phase === "anonymous") return null;
      if (expected.epoch === epoch)
        setSnapshot({
          ...snapshot,
          phase: snapshot.user ? "authenticated" : "error",
          notice: error.message,
        });
      throw error;
    })
    .finally(() => {
      restoreFlight = null;
      if (snapshot.phase === "checking") kickRestore();
    });
  return restoreFlight;
}

/** Refresh/retry once on 401. Other HTTP errors and ambiguous network failures are never replayed. */
export async function authenticatedRequest<T>(
  path: string,
  options: Omit<AuthRequestOptions, "token"> = {},
): Promise<T> {
  const initiated = context();
  const hadUser = Boolean(snapshot.user);
  let requestOptions = { ...options };
  if (options.body !== undefined) {
    try {
      requestOptions = {
        ...options,
        body: JSON.parse(JSON.stringify(options.body)),
      };
    } catch {
      throw new AuthApiError(
        400,
        "VALIDATION_ERROR",
        "Dữ liệu gửi lên không hợp lệ.",
      );
    }
  }
  checkRevision();
  if (hadUser) assertCurrent(initiated);
  if (snapshot.phase === "checking") await restoreSession();
  const expected = hadUser ? initiated : context();
  assertCurrent(expected);
  if (!snapshot.user)
    throw new AuthApiError(401, "UNAUTHENTICATED", "Bạn cần đăng nhập.");
  let usedToken = token;
  if (!usedToken || expiresAt <= Date.now()) usedToken = await refreshAccess();
  assertCurrent(expected);
  const send = (current: string) =>
    authRequest<T>(path, {
      ...requestOptions,
      method: requestOptions.method ?? "GET",
      token: current,
    });
  try {
    const result = await send(usedToken);
    checkRevision();
    assertCurrent(expected);
    return result;
  } catch (cause) {
    const error = asAuthError(cause);
    checkRevision();
    assertCurrent(expected);
    if (error.code === "USER_DISABLED") {
      await terminate(error, expected);
      throw error;
    }
    if (error.status !== 401) throw error;
    const fresh = await refreshAccess(usedToken);
    assertCurrent(expected);
    try {
      const result = await send(fresh);
      checkRevision();
      assertCurrent(expected);
      return result;
    } catch (retryCause) {
      const retryError = asAuthError(retryCause);
      checkRevision();
      assertCurrent(expected);
      if (isTerminal(retryError)) await terminate(retryError, expected);
      throw retryError;
    }
  }
}
async function revalidate() {
  const expected = context();
  const result = await authenticatedRequest<UserResponse>("/users/me");
  assertCurrent(expected);
  const old = snapshot.user;
  if (
    old &&
    (snapshot.notice ||
      old.fullName !== result.user.fullName ||
      old.globalRole !== result.user.globalRole ||
      old.email !== result.user.email)
  )
    setSnapshot({ ...snapshot, user: result.user, notice: "" });
}
function backgroundFailure(cause: unknown) {
  const error = asAuthError(cause);
  if (snapshot.user && error.code !== "SESSION_CHANGED")
    setSnapshot({ ...snapshot, notice: error.message });
}
function armTimer() {
  clearTimeout(timer);
  if (!clients || !snapshot.user || !token) return;
  const early = Math.min(30000, lifetime / 10);
  const delay = Math.max(
    1000,
    expiresAt - Date.now() - early,
    refreshBackoffUntil - Date.now(),
  );
  timer = setTimeout(
    () => {
      if (document.visibilityState === "visible")
        void refreshAccess().catch(backgroundFailure);
    },
    Math.min(delay, 2147483647),
  );
}
function onFocus() {
  if (document.visibilityState !== "visible") return;
  checkRevision();
  if (Date.now() - lastFocusCheck < 1000) return;
  lastFocusCheck = Date.now();
  if (snapshot.phase === "checking") kickRestore();
  else if (snapshot.user) {
    armTimer();
    void revalidate().catch(backgroundFailure);
  }
}
export const authSession = {
  async getAccessToken(): Promise<string> {
    await authenticatedRequest<UserResponse>("/users/me");
    if (!token) throw changed();
    return token;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => snapshot,
  getServerSnapshot: () => INITIAL,
  start() {
    clients++;
    if (clients === 1) {
      const initialRevision = readRevision();
      if (snapshot === INITIAL) {
        revisionId = initialRevision?.id ?? null;
        if (initialRevision?.action === "signed-out")
          setSnapshot({ phase: "anonymous", user: null, notice: "" });
      } else checkRevision();
      detach = listenForSessionChanges(adoptRevision, (id) => {
        if (id === revisionId && snapshot.user)
          void revalidate().catch(backgroundFailure);
      });
      window.addEventListener("focus", onFocus);
      window.addEventListener("pageshow", onFocus);
      document.addEventListener("visibilitychange", onFocus);
      window.addEventListener("online", onFocus);
      if (snapshot.phase === "checking") void restoreSession().catch(() => {});
      armTimer();
    }
    return () => {
      clients--;
      if (!clients) {
        clearTimeout(timer);
        detach?.();
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("pageshow", onFocus);
        document.removeEventListener("visibilitychange", onFocus);
        window.removeEventListener("online", onFocus);
      }
    };
  },
  async login(dto: LoginRequest) {
    await withCookieLock(async () => {
      const result = await authRequest<LoginResponse>("/auth/login", {
        body: dto,
      });
      commitRevision("changed");
      acceptGrant(result, result.user);
    });
  },
  async updateProfile(dto: UpdateProfileRequest) {
    const expected = context();
    const result = await authenticatedRequest<UserResponse>("/users/me", {
      method: "PATCH",
      body: dto,
    });
    assertCurrent(expected);
    setSnapshot({ ...snapshot, user: result.user, notice: "" });
    publishProfile(revisionId);
  },
  async logout() {
    const expected = context();
    checkRevision();
    assertCurrent(expected);
    await withCookieLock(async () => {
      checkRevision();
      assertCurrent(expected);
      await authRequest<void>("/auth/logout");
      assertCurrent(expected);
      commitRevision("signed-out", "logout");
      clearAccess();
      setSnapshot({
        phase: "anonymous",
        user: null,
        notice: "Bạn đã đăng xuất thành công.",
      });
    });
  },
  retry() {
    if (snapshot.user) void refreshAccess().catch(backgroundFailure);
    else {
      setSnapshot({ ...snapshot, phase: "checking", notice: "" });
      void restoreSession().catch(() => {});
    }
  },
};
