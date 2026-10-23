import type { ClassSession, ClassSessionStatus } from "@streamora/contracts";
export const statusLabels: Record<ClassSessionStatus, string> = {
  SCHEDULED: "Chưa bắt đầu",
  LIVE: "Đang diễn ra",
  ENDED: "Đã kết thúc",
  CANCELLED: "Đã hủy",
};
export const sessionHref = (session: ClassSession) =>
  session.kind === "MEET"
    ? `/meet/${session.joinCode}`
    : `/sessions/${session.id}`;
export const displayTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("vi-VN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Không đặt lịch trước";
export function localDateInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function utcDateInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) &&
    localDateInput(date.toISOString()) === value
    ? date.toISOString()
    : null;
}
export function meetCodeInput(value: string, origin: string) {
  const raw = value.trim();
  if (/^[A-Za-z0-9]{12}$/.test(raw)) return raw.toUpperCase();
  try {
    const url = new URL(raw, origin);
    const match = /^\/meet\/([a-zA-Z0-9]{12})\/?$/.exec(url.pathname);
    return url.origin === origin && match ? match[1].toUpperCase() : null;
  } catch {
    return null;
  }
}
