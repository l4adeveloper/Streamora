"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  Video,
  Plus,
  Search,
  Users,
  CalendarDays,
  Radio,
  ArrowRight,
  Clock,
  RefreshCw,
  Link2,
  X,
  Sparkles,
  ChevronDown,
} from "lucide-react";
import type { ClassSession } from "@streamora/contracts";
import { displayTime, meetCodeInput } from "@/lib/class-sessions/display";
import { useRouter } from "next/navigation";
import "./meetings-dashboard.css";

export type DashboardMeeting = ClassSession & {
  groupName?: string;
};

type FilterType = "ALL" | "LIVE" | "SCHEDULED" | "ENDED";

export function MeetingsDashboardSidebar({
  meetings,
  selectedId,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  onSelectMeeting,
  onJoinMeeting,
  onCreateMeet,
  loading = false,
}: {
  meetings: DashboardMeeting[];
  selectedId: string | null;
  filter: FilterType;
  onFilterChange: (filter: FilterType) => void;
  search: string;
  onSearchChange: (search: string) => void;
  onSelectMeeting: (id: string | null) => void;
  onJoinMeeting: (session: DashboardMeeting) => void;
  onCreateMeet: () => void;
  loading?: boolean;
}) {
  const filtered = useMemo(() => {
    return meetings.filter((item) => {
      if (filter === "LIVE" && item.status !== "LIVE") return false;
      if (filter === "SCHEDULED" && item.status !== "SCHEDULED") return false;
      if (filter === "ENDED" && !["ENDED", "CANCELLED"].includes(item.status))
        return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const matchTitle = item.title.toLowerCase().includes(q);
        const matchGroup = item.groupName?.toLowerCase().includes(q) ?? false;
        return matchTitle || matchGroup;
      }
      return true;
    });
  }, [meetings, filter, search]);

  const liveList = useMemo(
    () => filtered.filter((m) => m.status === "LIVE"),
    [filtered],
  );
  const scheduledList = useMemo(
    () => filtered.filter((m) => m.status === "SCHEDULED"),
    [filtered],
  );
  const endedList = useMemo(
    () => filtered.filter((m) => ["ENDED", "CANCELLED"].includes(m.status)),
    [filtered],
  );

  const liveCount = useMemo(
    () => meetings.filter((m) => m.status === "LIVE").length,
    [meetings],
  );
  const scheduledCount = useMemo(
    () => meetings.filter((m) => m.status === "SCHEDULED").length,
    [meetings],
  );

  return (
    <aside className="channel-sidebar meetings-dashboard-sidebar">
      <div className="meetings-sidebar-header">
        <div className="meetings-sidebar-brand">
          <div className="meetings-sidebar-logo">
            <Video size={19} />
          </div>
          <div>
            <b>Cuộc họp</b>
            <small>Dashboard phòng học</small>
          </div>
        </div>
        <button
          type="button"
          className="meetings-sidebar-add-btn"
          title="Tạo cuộc họp mới"
          aria-label="Tạo cuộc họp mới"
          onClick={onCreateMeet}
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="meetings-sidebar-search-box">
        <div className="meetings-search-input-wrapper">
          <Search size={14} className="meetings-search-icon" />
          <input
            type="text"
            placeholder="Tìm cuộc họp, lớp học…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="meetings-search-input"
          />
          {search && (
            <button
              type="button"
              className="meetings-search-clear"
              onClick={() => onSearchChange("")}
              aria-label="Xóa tìm kiếm"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="meetings-sidebar-filters">
        <button
          type="button"
          className={`meetings-filter-chip ${filter === "ALL" ? "active" : ""}`}
          onClick={() => onFilterChange("ALL")}
        >
          Tất cả <span>{meetings.length}</span>
        </button>
        <button
          type="button"
          className={`meetings-filter-chip ${filter === "LIVE" ? "active" : ""} ${liveCount > 0 ? "has-live" : ""}`}
          onClick={() => onFilterChange("LIVE")}
        >
          {liveCount > 0 && <span className="meetings-live-dot" />}
          Trực tiếp <span>{liveCount}</span>
        </button>
        <button
          type="button"
          className={`meetings-filter-chip ${filter === "SCHEDULED" ? "active" : ""}`}
          onClick={() => onFilterChange("SCHEDULED")}
        >
          Lên lịch <span>{scheduledCount}</span>
        </button>
      </div>

      <div className="sidebar-scroll meetings-sidebar-scroll">
        {loading && meetings.length === 0 ? (
          <div className="meetings-sidebar-loading">
            <RefreshCw size={16} className="ui-spinner" />
            <span>Đang tải cuộc họp…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="meetings-sidebar-empty">
            <p>Không tìm thấy cuộc họp phù hợp.</p>
          </div>
        ) : (
          <>
            {liveList.length > 0 && (
              <div className="channel-section meetings-sidebar-section">
                <div className="section-label meetings-section-label live">
                  <span className="meetings-live-dot pulse" />
                  <span>ĐANG DIỄN RA</span>
                  <span className="meetings-badge-count">{liveList.length}</span>
                </div>
                {liveList.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={`channel meetings-sidebar-item live ${selectedId === session.id ? "selected" : ""}`}
                    onClick={() => {
                      onSelectMeeting(session.id);
                      onJoinMeeting(session);
                    }}
                    title={`${session.title} · ${session.groupName ?? "Cuộc họp"}`}
                  >
                    <div className="meetings-item-icon live">
                      <Radio size={15} />
                    </div>
                    <div className="meetings-item-meta">
                      <span className="meetings-item-title">{session.title}</span>
                      <span className="meetings-item-subtitle">
                        {session.groupName ?? "Meet độc lập"}
                      </span>
                    </div>
                    <span className="meetings-item-action-pill">Vào ngay</span>
                  </button>
                ))}
              </div>
            )}

            {scheduledList.length > 0 && (
              <div className="channel-section meetings-sidebar-section">
                <div className="section-label meetings-section-label">
                  <ChevronDown size={12} />
                  <span>SẮP DIỄN RA</span>
                  <span className="meetings-badge-count">
                    {scheduledList.length}
                  </span>
                </div>
                {scheduledList.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={`channel meetings-sidebar-item ${selectedId === session.id ? "selected" : ""}`}
                    onClick={() => onSelectMeeting(session.id)}
                    title={`${session.title} · ${session.groupName ?? "Cuộc họp"}`}
                  >
                    <div className="meetings-item-icon">
                      <CalendarDays size={15} />
                    </div>
                    <div className="meetings-item-meta">
                      <span className="meetings-item-title">{session.title}</span>
                      <span className="meetings-item-subtitle">
                        {session.scheduledAt
                          ? displayTime(session.scheduledAt)
                          : (session.groupName ?? "Sắp tới")}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {endedList.length > 0 && (
              <div className="channel-section meetings-sidebar-section">
                <div className="section-label meetings-section-label muted">
                  <ChevronDown size={12} />
                  <span>ĐÃ KẾT THÚC</span>
                  <span className="meetings-badge-count">
                    {endedList.length}
                  </span>
                </div>
                {endedList.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={`channel meetings-sidebar-item ended ${selectedId === session.id ? "selected" : ""}`}
                    onClick={() => onSelectMeeting(session.id)}
                    title={`${session.title} · Đã kết thúc`}
                  >
                    <div className="meetings-item-icon muted">
                      <Clock size={15} />
                    </div>
                    <div className="meetings-item-meta">
                      <span className="meetings-item-title">{session.title}</span>
                      <span className="meetings-item-subtitle">
                        {session.groupName ?? "Đã đóng"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

export function MeetingsDashboardContent({
  meetings,
  selectedId,
  onJoinMeeting,
  onCreateMeet,
  onRefresh,
  loading = false,
}: {
  meetings: DashboardMeeting[];
  selectedId: string | null;
  onJoinMeeting: (session: DashboardMeeting) => void;
  onCreateMeet: () => void;
  onRefresh: () => void;
  loading?: boolean;
}) {
  const router = useRouter();
  const [quickCode, setQuickCode] = useState("");
  const [codeError, setCodeError] = useState("");

  const liveMeetings = useMemo(
    () => meetings.filter((m) => m.status === "LIVE"),
    [meetings],
  );

  const scheduledMeetings = useMemo(
    () => meetings.filter((m) => m.status === "SCHEDULED"),
    [meetings],
  );

  function handleQuickJoin(e: FormEvent) {
    e.preventDefault();
    const result = meetCodeInput(quickCode, window.location.origin);
    if (!result) {
      setCodeError("Mã phòng gồm 12 ký tự hoặc đường dẫn liên kết.");
      return;
    }
    setCodeError("");
    router.push(`/meet/${result}`);
  }

  return (
    <div className="meetings-dashboard-main">
      <div className="meetings-dashboard-hero">
        <div className="meetings-dashboard-hero-content">
          <div className="meetings-hero-badge">
            <Sparkles size={14} />
            <span>TRUNG TÂM PHÒNG HỌC & CUỘC HỌP</span>
          </div>
          <h1>Cuộc họp đang diễn ra</h1>
          <p>
            Theo dõi và tham gia trực tiếp vào các buổi học, cuộc thảo luận nhóm
            đang diễn ra ngay tại đây.
          </p>
        </div>
        <div className="meetings-dashboard-hero-actions">
          <button
            type="button"
            className="button secondary compact"
            onClick={onRefresh}
            disabled={loading}
            title="Làm mới danh sách cuộc họp"
          >
            <RefreshCw size={15} className={loading ? "ui-spinner" : ""} />
            <span>Làm mới</span>
          </button>
          <button
            type="button"
            className="button primary compact"
            onClick={onCreateMeet}
          >
            <Plus size={16} />
            <span>Tạo cuộc họp mới</span>
          </button>
        </div>
      </div>

      <div className="meetings-dashboard-body">
        {/* SECTION 1: CUỘC HỌP ĐANG DIỄN RA (LIVE) */}
        <section className="meetings-section" aria-labelledby="live-heading">
          <div className="meetings-section-heading">
            <div className="meetings-heading-left">
              <span className="live-pulse-indicator" />
              <h2 id="live-heading">Đang diễn ra</h2>
              <span className="meetings-count-pill live">
                {liveMeetings.length} trực tiếp
              </span>
            </div>
          </div>

          {liveMeetings.length > 0 ? (
            <div className="meetings-live-grid">
              {liveMeetings.map((session) => (
                <article
                  key={session.id}
                  className={`meeting-live-card ${selectedId === session.id ? "highlighted" : ""}`}
                >
                  <div className="meeting-card-glow" />
                  <div className="meeting-card-header">
                    <span className="meeting-live-status-tag">
                      <span className="live-dot-wave" />
                      TRỰC TIẾP
                    </span>
                    <span className="meeting-group-tag" title={session.groupName}>
                      <Users size={12} />
                      <span>{session.groupName ?? "Meet độc lập"}</span>
                    </span>
                  </div>

                  <div className="meeting-card-content">
                    <h3 className="meeting-card-title">{session.title}</h3>
                    {session.description ? (
                      <p className="meeting-card-desc">{session.description}</p>
                    ) : (
                      <p className="meeting-card-desc empty">
                        Không có mô tả chi tiết cho cuộc họp này.
                      </p>
                    )}
                  </div>

                  <div className="meeting-card-info-row">
                    <span className="meeting-card-time">
                      <Clock size={13} />
                      <span>
                        Bắt đầu:{" "}
                        {displayTime(session.startedAt || session.createdAt)}
                      </span>
                    </span>
                  </div>

                  <div className="meeting-card-footer">
                    <button
                      type="button"
                      className="button primary meeting-enter-btn"
                      onClick={() => onJoinMeeting(session)}
                      title={`Vào thẳng cuộc họp: ${session.title}`}
                    >
                      <Video size={17} />
                      <span>Vào thẳng cuộc họp</span>
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="meetings-live-empty-banner">
              <div className="empty-icon-wrapper">
                <Radio size={38} />
              </div>
              <div className="empty-text">
                <h3>Hiện chưa có cuộc họp nào đang diễn ra</h3>
                <p>
                  Khi giảng viên hoặc thành viên mở một cuộc họp trực tiếp trong
                  nhóm học tập, cuộc họp sẽ xuất hiện tại đây để bạn vào thẳng
                  ngay lập tức.
                </p>
              </div>
              <button
                type="button"
                className="button secondary"
                onClick={onCreateMeet}
              >
                <Plus size={16} /> Bắt đầu cuộc họp ngay
              </button>
            </div>
          )}
        </section>

        {/* SECTION 2: CUỘC HỌP SẮP DIỄN RA & THAM GIA BẰNG MÃ */}
        <div className="meetings-secondary-grid">
          <section
            className="meetings-section"
            aria-labelledby="scheduled-heading"
          >
            <div className="meetings-section-heading">
              <div className="meetings-heading-left">
                <CalendarDays size={18} className="text-muted" />
                <h2 id="scheduled-heading">Cuộc họp đã lên lịch</h2>
                <span className="meetings-count-pill">
                  {scheduledMeetings.length}
                </span>
              </div>
            </div>

            {scheduledMeetings.length > 0 ? (
              <div className="meetings-scheduled-list">
                {scheduledMeetings.map((session) => (
                  <article key={session.id} className="meeting-scheduled-item">
                    <div className="scheduled-date-badge">
                      <CalendarDays size={18} />
                    </div>
                    <div className="scheduled-details">
                      <h4>{session.title}</h4>
                      <div className="scheduled-meta">
                        <span className="scheduled-group">
                          <Users size={12} /> {session.groupName ?? "Nhóm học tập"}
                        </span>
                        <span className="meta-separator">·</span>
                        <span className="scheduled-time">
                          {displayTime(session.scheduledAt)}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="button secondary compact scheduled-join-btn"
                      onClick={() => onJoinMeeting(session)}
                    >
                      Vào phòng
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="meetings-empty-mini">
                <p>Chưa có cuộc họp nào được lên lịch trước.</p>
              </div>
            )}
          </section>

          <section className="meetings-section" aria-labelledby="join-code-heading">
            <div className="meetings-section-heading">
              <div className="meetings-heading-left">
                <Link2 size={18} className="text-muted" />
                <h2 id="join-code-heading">Tham gia bằng mã phòng</h2>
              </div>
            </div>

            <div className="meetings-code-card">
              <p>
                Nhập mã 12 ký tự hoặc dán liên kết cuộc họp bạn nhận được để tham
                gia trực tiếp:
              </p>
              <form onSubmit={handleQuickJoin} className="meetings-code-form">
                <input
                  type="text"
                  placeholder="Ví dụ: ABCD-1234-EFGH hoặc link"
                  value={quickCode}
                  onChange={(e) => {
                    setQuickCode(e.target.value);
                    setCodeError("");
                  }}
                  className="meetings-code-input"
                />
                <button
                  type="submit"
                  className="button primary"
                  disabled={!quickCode.trim()}
                >
                  Tham gia
                </button>
              </form>
              {codeError && <span className="meetings-code-error">{codeError}</span>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
