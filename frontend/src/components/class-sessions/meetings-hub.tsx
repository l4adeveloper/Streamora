"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Plus, Video, Link2, ArrowUpRight } from "lucide-react";
import type {
  ClassSession,
  ClassSessionStatus,
  Group,
} from "@streamora/contracts";
import { useGroupPermissions } from "@/lib/memberships/use-group-permissions";
import { useCursorList } from "@/lib/class-sessions/use-cursor-list";
import {
  createGroupSession,
  changeClassStatus,
  listClassSessions,
} from "@/lib/class-sessions/api";
import {
  displayTime,
  sessionHref,
  statusLabels,
} from "@/lib/class-sessions/display";
import {
  EmptyState,
  LoadingState,
  RequestError,
  InlineNotice,
} from "@/components/common/feedback";
import { SessionForm } from "./session-form";
import { SessionStatus } from "./session-card";
import "./sessions.css";

export function MeetingsHub({
  groups,
  groupId,
  onSelect,
}: {
  groups: Group[];
  groupId: string | null;
  onSelect: (id: string) => void;
}) {
  const router = useRouter();
  const access = useGroupPermissions(groupId);
  const [filter, setFilter] = useState<ClassSessionStatus | "">("");
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(0);
  const saved = useRef<ClassSession | null>(null);
  const startKey = useRef<string | null>(null);
  const [created, setCreated] = useState<ClassSession | null>(null);
  useEffect(() => {
    setCreating(new URLSearchParams(location.search).get("create") === "1");
    saved.current = null;
    startKey.current = null;
    setCreated(null);
  }, [groupId]);
  const loader = useCallback(
    (cursor?: string) =>
      groupId
        ? listClassSessions(groupId, cursor, filter || undefined)
        : Promise.resolve({ items: [], nextCursor: null }),
    [groupId, filter],
  );
  const list = useCursorList(loader, revision + access.revision);
  useEffect(() => {
    const refresh = () => setRevision((x) => x + 1);
    const create = () => setCreating(true);
    window.addEventListener("streamora:meeting-create", create);
    window.addEventListener("focus", refresh);
    window.addEventListener("streamora:meetings-changed", refresh);
    const timer = setInterval(refresh, 15000);
    return () => {
      window.removeEventListener("streamora:meeting-create", create);
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("streamora:meetings-changed", refresh);
    };
  }, []);
  const selected = groups.find((g) => g.id === groupId);
  return (
    <div className="meetings-hub">
      <header className="meetings-intro">
        <div className="meeting-icon">
          <Video size={26} />
        </div>
        <div>
          <span className="eyebrow">KHÔNG GIAN KẾT NỐI</span>
          <h1>Meeting</h1>
          <p>Gặp gỡ, học tập và cộng tác cùng lớp của bạn.</p>
        </div>
        <Link href="/meet" className="button secondary">
          <ArrowUpRight size={16} /> Meeting độc lập
        </Link>
      </header>
      <div className="meeting-group-tabs" role="tablist" aria-label="Lớp học">
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            id={`meeting-tab-${g.id}`}
            aria-controls="meeting-group-panel"
            aria-selected={g.id === groupId}
            onClick={() => onSelect(g.id)}
          >
            {g.name}
          </button>
        ))}
      </div>
      <section
        id="meeting-group-panel"
        role="tabpanel"
        aria-labelledby={groupId ? `meeting-tab-${groupId}` : undefined}
      >
        <div className="class-toolbar meetings-list-toolbar">
          <div>
            <h2>{selected?.name ?? "Cuộc họp của lớp"}</h2>
            <p className="class-muted">
              Cuộc họp và lịch học được lưu cùng lớp học này.
            </p>
          </div>
          {access.permissions?.canHost && (
            <button
              type="button"
              className="button primary"
              onClick={() => setCreating((x) => !x)}
            >
              <Plus size={17} />
              {creating ? "Đóng biểu mẫu" : "Tạo cuộc họp"}
            </button>
          )}
        </div>
        {creating && access.permissions?.canHost && groupId && (
          <section className="class-panel meeting-create-panel">
            <h2>Tạo cuộc họp · {selected?.name}</h2>
            {created && (
              <InlineNotice>
                Đã tạo cuộc họp. Bạn có thể tiếp tục mở phòng hoặc{" "}
                <Link href={sessionHref(created)}>mở liên kết đã tạo</Link>.
              </InlineNotice>
            )}
            <SessionForm
              key={groupId}
              group
              meeting
              label={created ? "Tiếp tục mở cuộc họp" : "Tạo cuộc họp"}
              locked={!!created}
              onSave={async (body, key) => {
                if (!saved.current) {
                  const result = await createGroupSession(
                    groupId,
                    {
                      title: body.title || undefined,
                      description: body.description ?? undefined,
                      scheduledAt: body.scheduledAt || undefined,
                      allowGuests: body.allowGuests,
                    },
                    key,
                  );
                  saved.current = result.session;
                  setCreated(result.session);
                  setRevision((x) => x + 1);
                }
                if (!body.scheduledAt) {
                  startKey.current ??= crypto.randomUUID();
                  await changeClassStatus(
                    saved.current.id,
                    "start",
                    startKey.current,
                  );
                }
                router.push(sessionHref(saved.current));
              }}
            />
          </section>
        )}
        <div className="meeting-filters" role="group" aria-label="Lọc cuộc họp">
          {(
            [
              ["", "Tất cả"],
              ["LIVE", "Đang diễn ra"],
              ["SCHEDULED", "Sắp diễn ra"],
              ["ENDED", "Đã kết thúc"],
              ["CANCELLED", "Đã hủy"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {!!access.error && (
          <RequestError error={access.error} onRetry={access.refresh} />
        )}
        {!!list.error && (
          <RequestError error={list.error} onRetry={list.refresh} />
        )}
        {list.loading && <LoadingState message="Đang tải cuộc họp…" />}
        {!groupId && (
          <EmptyState
            title="Chưa có lớp học"
            description="Tạo hoặc tham gia một nhóm để tổ chức cuộc họp cùng lớp."
          />
        )}
        {groupId && !list.loading && !list.error && !list.items.length && (
          <EmptyState
            title="Chưa có cuộc họp"
            description="Các cuộc họp của lớp sẽ xuất hiện tại đây."
          />
        )}
        <div className="meeting-cards">
          {list.items.map((session) => (
            <article
              key={session.id}
              className={`meeting-card ${session.status.toLowerCase()}`}
            >
              <div className="class-toolbar">
                <span className="meeting-card-icon">
                  <Video size={22} />
                </span>
                <SessionStatus status={session.status} />
              </div>
              <h3>
                <Link href={sessionHref(session)}>{session.title}</Link>
              </h3>
              <p className="class-muted">
                <CalendarDays size={15} />
                {displayTime(session.scheduledAt)}
              </p>
              <p className="class-muted">
                <Link2 size={15} />
                {session.allowGuests
                  ? "Cho phép khách · chủ phòng duyệt"
                  : "Chỉ thành viên trong Group"}
              </p>
              <Link
                className={`button ${session.status === "LIVE" ? "primary" : "secondary"}`}
                href={sessionHref(session)}
              >
                {session.status === "LIVE"
                  ? "Tham gia cuộc họp"
                  : session.status === "SCHEDULED"
                    ? "Xem cuộc họp"
                    : "Xem thông tin"}
                <ArrowUpRight size={16} />
              </Link>
            </article>
          ))}
        </div>
        {list.cursor && (
          <button
            type="button"
            className="button secondary"
            disabled={list.loading}
            onClick={() => void list.more()}
          >
            Xem thêm cuộc họp
          </button>
        )}
      </section>
    </div>
  );
}
