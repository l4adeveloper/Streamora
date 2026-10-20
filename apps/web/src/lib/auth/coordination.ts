import "client-only";
import { AuthApiError } from "./api";

export const SESSION_REVISION_KEY = "streamora.auth.revision";
type EndReason = "logout" | "expired" | "disabled";
export interface SessionRevision {
  id: string;
  action: "changed" | "signed-out";
  reason?: EndReason;
}
let channel: BroadcastChannel | null = null;
function post(message: unknown) {
  try {
    channel?.postMessage(message);
  } catch {}
}
function revision(value: unknown): SessionRevision | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<SessionRevision>;
  if (
    typeof item.id !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(item.id) ||
    (item.action !== "changed" && item.action !== "signed-out")
  )
    return null;
  return {
    id: item.id,
    action: item.action,
    ...(item.reason === "logout" ||
    item.reason === "expired" ||
    item.reason === "disabled"
      ? { reason: item.reason }
      : {}),
  };
}
export function readRevision(): SessionRevision | null {
  try {
    return revision(
      JSON.parse(localStorage.getItem(SESSION_REVISION_KEY) ?? "null"),
    );
  } catch {
    return null;
  }
}
export function publishRevision(
  action: SessionRevision["action"],
  reason?: EndReason,
): SessionRevision {
  const next: SessionRevision = {
    id: crypto.randomUUID(),
    action,
    ...(reason ? { reason } : {}),
  };
  let stored = false;
  // Only a public event marker is persisted, never identity, credentials or tokens.
  try {
    localStorage.setItem(SESSION_REVISION_KEY, JSON.stringify(next));
    stored = true;
  } catch {}
  post({ type: "revision", revision: next, stored });
  return next;
}
export function publishProfile(revisionId: string | null) {
  post({ type: "profile", revisionId });
}
export function listenForSessionChanges(
  onRevision: (next: SessionRevision) => void,
  onProfile: (revisionId: string | null) => void,
) {
  const storage = (event: StorageEvent) => {
    if (event.key === SESSION_REVISION_KEY) {
      const current = readRevision();
      if (current) onRevision(current);
    }
  };
  window.addEventListener("storage", storage);
  try {
    channel = new BroadcastChannel("streamora.auth");
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data as {
        type?: unknown;
        revision?: unknown;
        revisionId?: unknown;
        stored?: unknown;
      } | null;
      if (message?.type === "revision") {
        const next = revision(message.revision);
        if (next) onRevision(message.stored ? (readRevision() ?? next) : next);
      } else if (
        message?.type === "profile" &&
        (typeof message.revisionId === "string" || message.revisionId === null)
      )
        onProfile(message.revisionId);
    };
  } catch {
    channel = null;
  }
  return () => {
    window.removeEventListener("storage", storage);
    channel?.close();
    channel = null;
  };
}
export async function withCookieLock<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new AuthApiError(
      0,
      "SYNC_UNAVAILABLE",
      "Trình duyệt chưa hỗ trợ đồng bộ phiên an toàn. Vui lòng cập nhật trình duyệt hoặc dùng Chrome, Edge, Firefox, Safari phiên bản mới.",
    );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    return await navigator.locks.request(
      "streamora-auth-cookie",
      { signal: controller.signal },
      work,
    );
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof AuthApiError))
      throw new AuthApiError(
        0,
        "SYNC_BUSY",
        "Phiên đang được cập nhật ở tab khác. Vui lòng thử lại.",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
