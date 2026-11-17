"use client";

import { useMemo } from "react";
import {
  ArrowRight,
  CalendarDays,
  RefreshCw,
  Search,
  Video,
} from "lucide-react";
import type { ClassSession } from "@streamora/contracts";
import { displayTime } from "@/lib/class-sessions/display";
import "./meetings-dashboard.css";

export type DashboardMeeting = ClassSession & { groupName?: string };
export type DashboardFilter = "ALL" | "LIVE" | "SCHEDULED";

const filters = [
  { value: "ALL", label: "Tất cả cuộc họp", icon: Video },
  { value: "LIVE", label: "Đang diễn ra", icon: Video },
  { value: "SCHEDULED", label: "Đã lên lịch", icon: CalendarDays },
] as const;

function isUpcomingMeeting(meeting: DashboardMeeting) {
  return (
    !!meeting.groupId &&
    (meeting.status === "LIVE" || meeting.status === "SCHEDULED")
  );
}

export function MeetingsDashboardSidebar({
  meetings,
  filter,
  onFilterChange,
}: {
  meetings: DashboardMeeting[];
  filter: DashboardFilter;
  onFilterChange: (filter: DashboardFilter) => void;
}) {
  const active = meetings.filter(isUpcomingMeeting);
  return (
    <aside className="channel-sidebar meetings-dashboard-sidebar">
      <div className="meetings-sidebar-heading">
        <span className="meetings-sidebar-icon">
          <Video size={20} />
        </span>
        <div>
          <b>Cuộc họp</b>
          <small>Tham gia nhanh</small>
        </div>
      </div>
      <nav className="meetings-filter-nav" aria-label="Lọc cuộc họp">
        {filters.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            className={`meetings-filter-item ${filter === value ? "selected" : ""}`}
            aria-pressed={filter === value}
            onClick={() => onFilterChange(value)}
          >
            <Icon size={17} />
            <span>{label}</span>
            <small>
              {value === "ALL"
                ? active.length
                : active.filter((item) => item.status === value).length}
            </small>
          </button>
        ))}
      </nav>
    </aside>
  );
}

export function MeetingsDashboardContent({
  meetings,
  filter,
  search,
  onSearchChange,
  onJoinMeeting,
  onRefresh,
  loading = false,
  error,
}: {
  meetings: DashboardMeeting[];
  filter: DashboardFilter;
  search: string;
  onSearchChange: (value: string) => void;
  onJoinMeeting: (session: DashboardMeeting) => void;
  onRefresh: () => void;
  loading?: boolean;
  error?: string;
}) {
  const groups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("vi");
    const map = new Map<
      string,
      { id: string; name: string; meetings: DashboardMeeting[] }
    >();
    for (const meeting of meetings) {
      if (
        !isUpcomingMeeting(meeting) ||
        (filter !== "ALL" && meeting.status !== filter)
      )
        continue;
      const name = meeting.groupName ?? "Nhóm học tập";
      if (
        query &&
        !`${name} ${meeting.title}`.toLocaleLowerCase("vi").includes(query)
      )
        continue;
      const group = map.get(meeting.groupId!) ?? {
        id: meeting.groupId!,
        name,
        meetings: [],
      };
      group.meetings.push(meeting);
      map.set(group.id, group);
    }
    const time = (item: DashboardMeeting) =>
      Date.parse(item.scheduledAt ?? item.createdAt);
    for (const group of map.values()) {
      group.meetings.sort(
        (a, b) =>
          Number(b.status === "LIVE") - Number(a.status === "LIVE") ||
          time(a) - time(b) ||
          a.id.localeCompare(b.id),
      );
    }
    return [...map.values()].sort(
      (a, b) =>
        Number(b.meetings[0].status === "LIVE") -
          Number(a.meetings[0].status === "LIVE") ||
        time(a.meetings[0]) - time(b.meetings[0]) ||
        a.name.localeCompare(b.name, "vi"),
    );
  }, [meetings, filter, search]);

  return (
    <div className="meetings-dashboard-main" aria-busy={loading}>
      <div className="meetings-page-heading">
        <div>
          <h2>Cuộc họp của bạn</h2>
          <p>Vào nhanh cuộc họp trong các nhóm học tập.</p>
        </div>
        <button
          type="button"
          className="button secondary compact meetings-refresh"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Làm mới cuộc họp"
        >
          <RefreshCw size={15} className={loading ? "ui-spinner" : ""} />
          <span>Làm mới</span>
        </button>
      </div>
      <div className="meetings-list-toolbar">
        <label className="meetings-search">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            aria-label="Tìm nhóm hoặc cuộc họp"
            placeholder="Tìm nhóm hoặc cuộc họp…"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
        <span className="meetings-result-count" aria-live="polite">
          {groups.length} nhóm
        </span>
      </div>
      {error && (
        <p className="meetings-load-error" role="alert">
          {error}
        </p>
      )}
      {groups.length > 0 ? (
        <div className="meetings-group-list">
          {groups.map((group) => (
            <section
              key={group.id}
              className="meetings-group"
              aria-labelledby={`meeting-group-${group.id}`}
            >
              <div className="meetings-group-heading">
                <span className="meetings-group-avatar" aria-hidden="true">
                  {group.name
                    .trim()
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((word) => Array.from(word)[0])
                    .join("")
                    .toUpperCase()}
                </span>
                <h3 id={`meeting-group-${group.id}`}>{group.name}</h3>
                <span>{group.meetings.length} cuộc họp</span>
              </div>
              <div className="meetings-group-rooms">
                {group.meetings.map((meeting) => {
                  const live = meeting.status === "LIVE";
                  return (
                    <article key={meeting.id} className="meetings-room-row">
                      <span
                        className={`meetings-room-icon ${live ? "is-live" : ""}`}
                        aria-hidden="true"
                      >
                        {live ? (
                          <Video size={19} />
                        ) : (
                          <CalendarDays size={19} />
                        )}
                      </span>
                      <div className="meetings-room-info">
                        <h4>{meeting.title}</h4>
                        <p>
                          {live
                            ? "Cuộc họp đang mở"
                            : displayTime(meeting.scheduledAt)}
                        </p>
                      </div>
                      <span
                        className={`meetings-room-status ${live ? "is-live" : ""}`}
                      >
                        {live && <i />}
                        {live ? "Đang diễn ra" : "Đã lên lịch"}
                      </span>
                      <button
                        type="button"
                        className={`button compact ${live ? "primary" : "secondary"}`}
                        aria-label={`${live ? "Tham gia" : "Mở phòng"} ${meeting.title}`}
                        onClick={() => onJoinMeeting(meeting)}
                      >
                        {live ? "Tham gia" : "Mở phòng"}
                        <ArrowRight size={15} />
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="meetings-empty" role="status">
          {loading ? (
            <RefreshCw size={24} className="ui-spinner" />
          ) : (
            <CalendarDays size={26} />
          )}
          <b>
            {loading
              ? "Đang tải cuộc họp…"
              : search.trim()
                ? "Không tìm thấy cuộc họp"
                : "Chưa có cuộc họp nào"}
          </b>
          {!loading && (
            <p>
              {search.trim()
                ? "Thử tìm bằng tên nhóm hoặc tên cuộc họp khác."
                : "Cuộc họp đang diễn ra hoặc đã lên lịch của nhóm sẽ xuất hiện ở đây."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
