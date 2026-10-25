"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  CalendarDays,
  Copy,
  FileText,
  Folder,
  Hash,
  LayoutGrid,
  LoaderCircle,
  Link2,
  Menu,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Users,
  Video,
  VideoOff,
  Volume2,
  Waves,
  X,
  PhoneOff,
  Hand,
  BarChart3,
  Upload,
  Circle,
  ExternalLink,
} from "lucide-react";

import { Brand, Avatar, IconButton } from "./ui";
import { SessionIdentity } from "./shell/account-link";
import { ThemeToggle } from "./shell/theme-toggle";
import { useToast } from "./common/toast-provider";
import { useAuth } from "./auth/auth-provider";
import { LoadingState, RequestError } from "./common/feedback";
import { MembersPanel, NoGroupSelected } from "./memberships/members-panel";
import { GroupsListPage } from "./groups/groups-list-page";
import { MeetHub } from "./class-sessions/meet-hub";
import { useWorkspaceGroup } from "@/lib/memberships/use-workspace-group";
import { useGroupPermissions } from "@/lib/memberships/use-group-permissions";

import { LivePlayer } from "./live-player";
import { WorkspaceChat } from "./workspace-chat";
import { initialFiles, membersInitial, portrait } from "./demo-data";
import type { View, ChatMessage } from "./demo-data";
function ArrowUpRight() {
  return <ExternalLink size={15} />;
}
function groupInitials(name: string) {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) {
    const letters = Array.from(words[0]);
    return letters
      .slice(0, letters.length <= 4 ? 4 : 2)
      .join("")
      .toUpperCase();
  }
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("")
    .toUpperCase();
}
export function Workspace({
  view,
  channel = "trò-chuyện-chung",
}: {
  view: View;
  channel?: string;
}) {
  const { notify } = useToast();
  const { user } = useAuth();
  const workspaceGroup = useWorkspaceGroup();
  const groupAccess = useGroupPermissions(workspaceGroup.groupId);
  const permissions = groupAccess.permissions;
  const [membersView, setMembersView] = useState(false);
  const [panel, setPanel] = useState(true);
  const [panelTab, setPanelTab] = useState<"chat" | "members">(
    view === "chat" ? "members" : "chat",
  );
  const [modal, setModal] = useState<string | null>(null);
  const selectedGroup = workspaceGroup.groups.find(
    (item) => item.id === workspaceGroup.groupId,
  );
  const group =
    selectedGroup?.name ??
    (user
      ? workspaceGroup.loading
        ? "Đang tải nhóm…"
        : workspaceGroup.error
          ? "Chưa tải được nhóm"
          : "Chưa có nhóm học tập"
      : "Không gian trải nghiệm");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const members = membersInitial;
  const [files, setFiles] = useState(initialFiles);
  const [fileQuery, setFileQuery] = useState("");
  const [filter, setFilter] = useState("Tất cả");
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [fps, setFps] = useState("30");
  const [roomName, setRoomName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [poll, setPoll] = useState(false);
  const [pollQuestion, setPollQuestion] = useState(
    "Bạn đã hiểu phần cân bằng tải chưa?",
  );
  const [pollOptions, setPollOptions] = useState([
    "Đã hiểu rồi",
    "Cần giải thích thêm",
  ]);
  const [vote, setVote] = useState<number | null>(null);
  const [hand, setHand] = useState(false);
  const [upload, setUpload] = useState<{
    name: string;
    size: string;
    progress: number;
    paused: boolean;
  } | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [customChannels, setCustomChannels] = useState<string[]>([]);
  const [activeRoomName, setActiveRoomName] = useState("Phòng học nhóm");
  const chatStorageKey = `streamora-chat-v2:${channel}`;
  const legacyChatStorageKey = `streamora-chat:${channel}`;
  const cameraStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const screenVideo = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const showMembers =
      new URLSearchParams(location.search).get("tab") === "members";
    setMembersView(showMembers);
    if (showMembers) setPanel(false);
    setMobileNav(false);
  }, [view, channel]);
  useEffect(() => {
    setModal(null);
    setRecording(false);
    setPoll(false);
    setUpload(null);
    [cameraStream, screenStream, micStream].forEach((ref) =>
      ref.current?.getTracks().forEach((track) => track.stop()),
    );
    setCamera(false);
    setMic(false);
    setSharing(false);
  }, [workspaceGroup.groupId]);
  useEffect(() => {
    if (!workspaceGroup.groupId || groupAccess.loading) return;
    if (!permissions) {
      [cameraStream, screenStream, micStream].forEach((ref) =>
        ref.current?.getTracks().forEach((track) => track.stop()),
      );
      setCamera(false);
      setMic(false);
      setSharing(false);
      setModal(null);
      setRecording(false);
      setUpload(null);
    }
    if (!permissions?.canHost) {
      setPoll(false);
      setRecording(false);
      screenStream.current?.getTracks().forEach((track) => track.stop());
      setSharing(false);
    }
  }, [workspaceGroup.groupId, permissions, groupAccess.loading]);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(chatStorageKey);
      if (stored) setMessages(JSON.parse(stored));
      else {
        const legacy = localStorage.getItem(legacyChatStorageKey);
        const legacyMessages = legacy ? JSON.parse(legacy) : [];
        const userMessages = Array.isArray(legacyMessages)
          ? legacyMessages.filter(
              (message): message is ChatMessage => message?.name === "Bạn",
            )
          : [];
        setMessages(userMessages);
        if (userMessages.length)
          localStorage.setItem(chatStorageKey, JSON.stringify(userMessages));
        localStorage.removeItem(legacyChatStorageKey);
      }
      const storedFiles = localStorage.getItem("streamora-files");
      if (storedFiles) setFiles(JSON.parse(storedFiles));
      const storedChannels = localStorage.getItem("streamora-channels");
      if (storedChannels) setCustomChannels(JSON.parse(storedChannels));
      const roomId = location.pathname.split("/").pop() || "";
      setActiveRoomName(sessionStorage.getItem(roomId) || "Phòng học nhóm");
      if (new URLSearchParams(location.search).get("type") === "recordings")
        setFilter("Bản ghi");
      if (matchMedia("(max-width: 900px)").matches) setPanel(false);
    } catch {}
  }, [channel, chatStorageKey, legacyChatStorageKey]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(
      '[data-workspace-dialog="true"]',
    );
    const activeDialog = () =>
      dialog?.querySelector<HTMLElement>('.modal-overlay[role="dialog"]') ??
      dialog;
    const focusable = () =>
      Array.from(
        activeDialog()?.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, [tabindex="0"]',
        ) || [],
      ).filter((element) => !element.hasAttribute("disabled"));
    focusable()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (dialog?.querySelector('.modal-overlay[role="dialog"]')) return;
        const pickerOpen =
          CSS.supports("selector(select:open)") &&
          document.querySelector("select:open");
        if (!pickerOpen) setModal(null);
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, [modal]);
  useEffect(
    () => () => {
      [cameraStream, screenStream, micStream].forEach((ref) =>
        ref.current?.getTracks().forEach((track) => track.stop()),
      );
    },
    [],
  );
  useEffect(() => {
    if (localVideo.current) localVideo.current.srcObject = cameraStream.current;
  }, [camera]);
  useEffect(() => {
    if (screenVideo.current)
      screenVideo.current.srcObject = screenStream.current;
  }, [sharing]);
  useEffect(() => {
    if (!upload || upload.paused) return;
    const timer = setInterval(
      () =>
        setUpload((current) =>
          current
            ? { ...current, progress: Math.min(100, current.progress + 4) }
            : null,
        ),
      250,
    );
    return () => clearInterval(timer);
  }, [upload?.paused, upload?.name]);
  useEffect(() => {
    if (upload?.progress !== 100) return;
    const next = [
      {
        name: upload.name,
        kind: "Tài liệu",
        size: upload.size,
        date: "Vừa thêm (mẫu)",
      },
      ...files,
    ];
    setFiles(next);
    localStorage.setItem("streamora-files", JSON.stringify(next));
    setUpload(null);
    notify("Đã thêm mục tài liệu mẫu. Tệp chưa được tải lên máy chủ.");
  }, [upload?.progress]);
  async function toggleMedia(kind: "camera" | "mic" | "screen") {
    if (
      workspaceGroup.groupId &&
      (!permissions || (kind === "screen" && !permissions.canHost))
    )
      return;
    const current = kind === "camera" ? camera : kind === "mic" ? mic : sharing;
    const ref =
      kind === "camera"
        ? cameraStream
        : kind === "mic"
          ? micStream
          : screenStream;
    const setter =
      kind === "camera" ? setCamera : kind === "mic" ? setMic : setSharing;
    if (current) {
      ref.current?.getTracks().forEach((t) => t.stop());
      setter(false);
      return;
    }
    try {
      if (!navigator.mediaDevices) throw new Error();
      const stream =
        kind === "screen"
          ? await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: Number(fps) },
              audio: true,
            })
          : await navigator.mediaDevices.getUserMedia(
              kind === "camera" ? { video: true } : { audio: true },
            );
      ref.current = stream;
      setter(true);
      stream
        .getTracks()
        .forEach((track) => (track.onended = () => setter(false)));
    } catch {
      notify(
        "Chưa thể truy cập thiết bị. Hãy kiểm tra quyền camera, micro hoặc chia sẻ màn hình.",
      );
    }
  }
  function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    const message: ChatMessage = {
      name: "Bạn",
      initials: "BA",
      color: "violet",
      text: draft.trim(),
      time: new Date().toLocaleTimeString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };
    const next = [...messages, message];
    setMessages(next);
    localStorage.setItem(chatStorageKey, JSON.stringify(next));
    setDraft("");
  }
  const inviteUrl =
    typeof location === "undefined"
      ? ""
      : `${location.origin}${view === "room" ? location.pathname : "/rooms/htpt-buoi-05"}`;
  async function copyInvite() {
    const url = inviteUrl;
    try {
      await navigator.clipboard.writeText(url);
      notify("Đã sao chép liên kết mời.");
    } catch {
      notify("Bạn có thể sao chép liên kết trong hộp mời thành viên.");
    }
  }
  function toggleRecording() {
    if (workspaceGroup.groupId && !permissions?.canHost) return;
    if (recording) {
      const next = [
        {
          name: "Buổi 05 — Bản ghi minh họa",
          kind: "Bản ghi",
          size: "Mẫu giao diện",
          date: "Vừa thêm (mẫu)",
        },
        ...files,
      ];
      setFiles(next);
      localStorage.setItem("streamora-files", JSON.stringify(next));
      notify(
        "Đã thêm mục bản ghi mẫu vào thư viện. Chưa có dữ liệu âm thanh hoặc video.",
      );
    } else
      notify(
        "Mô phỏng ghi hình đã bật. Ghi hình thực tế cần kết nối LiveKit Egress.",
      );
    setRecording(!recording);
  }
  const title =
    view === "live"
      ? "Lớp học trực tiếp"
      : view === "meet"
        ? "Cuộc họp của bạn"
        : view === "files"
          ? "Tài liệu chung"
          : view === "chat"
            ? channel
            : activeRoomName;
  const currentSection = membersView
    ? "Thành viên"
    : view === "chat"
      ? channel.replaceAll("-", " ")
      : view === "files" && filter === "Bản ghi"
        ? "Bản ghi bài giảng"
        : view === "meet"
          ? "Tạo cuộc họp"
          : title;
  function navigateWorkspace(event: React.MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    setMembersView(false);
    setMobileNav(false);
  }
  const filteredFiles = files.filter(
    (file) =>
      file.name
        .toLocaleLowerCase("vi")
        .includes(fileQuery.toLocaleLowerCase("vi")) &&
      (filter === "Tất cả" || file.kind === filter),
  );
  const chatProps = {
    messages,
    draft,
    onDraftChange: setDraft,
    onSubmit: sendMessage,
  };
  return (
    <div className={`app-shell ${mobileNav ? "nav-open" : ""}`}>
      <aside className="community-rail" aria-label="Không gian và nhóm học tập">
        <Brand small href="/groups" label="Streamora, nhóm học tập" />
        <div className="rail-divider" />
        <nav className="workspace-groups" aria-label="Nhóm học tập của bạn">
          {workspaceGroup.loading && (
            <span className="rail-loading" role="status">
              <LoaderCircle
                size={20}
                className="ui-spinner"
                aria-hidden="true"
              />
              <span className="sr-only">Đang tải nhóm học tập…</span>
            </span>
          )}
          {workspaceGroup.groups.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`community-icon ${item.id === workspaceGroup.groupId ? "selected" : ""}`}
              title={item.name}
              aria-label={`Mở nhóm ${item.name}`}
              aria-current={
                item.id === workspaceGroup.groupId ? "true" : undefined
              }
              onClick={() => {
                workspaceGroup.selectGroup(item.id);
                if (matchMedia("(max-width: 650px)").matches)
                  setMobileNav(true);
              }}
            >
              {groupInitials(item.name)}
            </button>
          ))}
          {Boolean(workspaceGroup.error) && (
            <button
              type="button"
              className="community-icon"
              title="Chưa tải được nhóm. Thử lại"
              aria-label="Thử tải lại nhóm học tập"
              onClick={workspaceGroup.reload}
            >
              <RefreshCw size={18} />
            </button>
          )}
          {user &&
            !workspaceGroup.loading &&
            !workspaceGroup.error &&
            workspaceGroup.groups.length === 0 && (
              <Link
                className="community-icon"
                href="/groups"
                title="Bạn chưa tham gia nhóm nào"
                aria-label="Xem nhóm học tập"
              >
                <Users size={20} />
              </Link>
            )}
          <button
            type="button"
            className="add-community"
            title="Thêm nhóm học tập"
            aria-label="Thêm nhóm học tập"
            onClick={() => setModal("groups")}
          >
            <Plus size={22} />
          </button>
        </nav>
        <div className="rail-bottom">
          <IconButton label="Hướng dẫn" onClick={() => setModal("help")}>
            <CircleHelp size={21} />
          </IconButton>
        </div>
      </aside>
      <aside className="channel-sidebar">
        <button
          className="community-title"
          onClick={() => setModal("community-settings")}
        >
          <span className="community-logo">
            <Waves size={20} />
          </span>
          <div>
            <b>{group}</b>
            <small>Không gian học tập</small>
          </div>
          <ChevronDown size={15} />
        </button>
        <button className="sidebar-search" onClick={() => setModal("search")}>
          <Search size={15} /> Tìm trong không gian <kbd>⌘ K</kbd>
        </button>
        <div className="sidebar-scroll">
          <div className="channel-section">
            <div className="section-label">
              <ChevronDown size={12} /> Tổng quan
            </div>
            <button
              className={`channel ${membersView ? "selected" : ""}`}
              onClick={() => {
                setMembersView(true);
                setPanel(false);
                setPanelTab("members");
                setMobileNav(false);
              }}
            >
              <Users size={18} /> Thành viên
            </button>
          </div>
          <div className="channel-section">
            <div className="section-label">
              <ChevronDown size={12} /> Kênh trò chuyện{" "}
              <button title="Thêm kênh" onClick={() => setModal("channel")}>
                <Plus size={14} />
              </button>
            </div>
            <Link
              href="/community"
              onClick={navigateWorkspace}
              className={`channel ${!membersView && view === "chat" && channel === "trò-chuyện-chung" ? "selected" : ""}`}
            >
              <Hash size={19} /> trò-chuyện-chung{" "}
              <span className="unread-dot" />
            </Link>
            <button
              className="channel"
              onClick={() => {
                setModal("questions");
              }}
            >
              <Hash size={19} /> hỏi-đáp{" "}
              <span className="channel-count">3</span>
            </button>
            <button
              className="channel"
              onClick={() => setModal("notifications")}
            >
              <Hash size={19} /> thông-báo <Bell size={13} />
            </button>
          </div>
          <div className="custom-channels">
            {customChannels.map((name) => (
              <Link
                key={name}
                href={`/community/${encodeURIComponent(name)}`}
                onClick={navigateWorkspace}
                className={`channel ${!membersView && view === "chat" && channel === name ? "selected" : ""}`}
              >
                <Hash size={19} />
                {name}
              </Link>
            ))}
          </div>
          <div className="channel-section">
            <div className="section-label">
              <ChevronDown size={12} /> Phòng học{" "}
              <button
                type="button"
                aria-label="Tạo phòng học"
                onClick={() => setModal("meet")}
              >
                <Plus size={14} />
              </button>
            </div>
            {workspaceGroup.groupId && (
              <Link
                href={`/groups/${workspaceGroup.groupId}/sessions`}
                onClick={navigateWorkspace}
                className="channel"
              >
                <CalendarDays size={19} />
                Lịch học của nhóm
              </Link>
            )}
            <Link
              href="/workspace"
              onClick={navigateWorkspace}
              className={`channel live-channel ${!membersView && view === "live" ? "selected" : ""}`}
            >
              <Radio size={19} /> Lớp học trực tiếp{" "}
              <span className="live-dot" />
            </Link>
            <div className="channel-participants">
              <div className="stacked-avatars">
                <Avatar initials="NH" small />
                <Avatar initials="MA" color="pink" small />
                <Avatar initials="TP" color="blue" small />
              </div>
              <span>+21 đang tham gia</span>
            </div>
            <Link
              href="/rooms/nhom-01"
              onClick={navigateWorkspace}
              className={`channel ${!membersView && view === "room" ? "selected" : ""}`}
            >
              <Volume2 size={19} /> Phòng học nhóm <small>4</small>
            </Link>
            <button
              type="button"
              onClick={() => setModal("meet")}
              className={`channel ${!membersView && view === "meet" ? "selected" : ""}`}
            >
              <Video size={19} /> Tạo cuộc họp <Plus size={14} />
            </button>
          </div>
          <div className="channel-section">
            <div className="section-label">
              <ChevronDown size={12} /> Thư viện
            </div>
            <Link
              href="/files"
              onClick={(event) => {
                navigateWorkspace(event);
                setFilter("Tất cả");
              }}
              className={`channel ${!membersView && view === "files" && filter !== "Bản ghi" ? "selected" : ""}`}
            >
              <Folder size={18} /> Tài liệu chung <small>{files.length}</small>
            </Link>
            <Link
              href="/files?type=recordings"
              onClick={(event) => {
                navigateWorkspace(event);
                setFilter("Bản ghi");
              }}
              className={`channel ${!membersView && view === "files" && filter === "Bản ghi" ? "selected" : ""}`}
            >
              <Video size={18} /> Bản ghi bài giảng
            </Link>
          </div>
        </div>
      </aside>
      <div className="sidebar-user workspace-identity">
        <Link
          className="workspace-account"
          href={user ? "/account" : "/auth"}
          title={user ? `Tài khoản của ${user.fullName}` : "Đăng nhập"}
          aria-label={user ? `Tài khoản của ${user.fullName}` : "Đăng nhập"}
        >
          <SessionIdentity />
        </Link>
        <IconButton
          label={mic ? "Tắt micro" : "Bật micro"}
          active={mic}
          onClick={() => toggleMedia("mic")}
        >
          {mic ? <Mic size={16} /> : <MicOff size={16} />}
        </IconButton>
        <IconButton label="Cài đặt" onClick={() => setModal("settings")}>
          <Settings2 size={16} />
        </IconButton>
      </div>
      <div className="workspace">
        <header className="workspace-topbar">
          <nav
            className="breadcrumbs"
            aria-label="Đường dẫn không gian học tập"
          >
            <button
              className="mobile-menu"
              aria-label="Mở danh sách kênh"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu size={20} />
            </button>
            <span title={group}>{group}</span>
            <ChevronRight size={14} />
            <h1 aria-current="page" title={currentSection}>
              {currentSection}
            </h1>
          </nav>
          <div className="topbar-actions">
            <ThemeToggle />
            <IconButton label="Tìm kiếm" onClick={() => setModal("search")}>
              <Search size={18} />
            </IconButton>
            <IconButton
              label="Thông báo"
              onClick={() => setModal("notifications")}
            >
              <Bell size={18} />
              <i />
            </IconButton>
            <div className="vertical-divider" />
            {membersView && (
              <button
                className="button secondary workspace-back"
                aria-label="Quay lại không gian"
                title="Quay lại không gian"
                onClick={() => setMembersView(false)}
              >
                <ArrowLeft size={18} />
                <span>Quay lại không gian</span>
              </button>
            )}
            {!membersView && (
              <button
                className="button secondary workspace-invite"
                aria-label="Mời tham gia"
                title="Mời tham gia"
                onClick={() => setModal("invite")}
              >
                <Link2 size={18} />
                <span>Mời tham gia</span>
              </button>
            )}
            {!membersView && (
              <IconButton
                label={panel ? "Đóng bảng bên" : "Mở trò chuyện và thành viên"}
                active={panel}
                onClick={() => setPanel(!panel)}
              >
                <Users size={18} />
              </IconButton>
            )}
          </div>
        </header>
        <div className="workspace-body">
          <main
            className={`main-content view-${view} ${membersView ? "membership-main" : ""}`}
          >
            {membersView ? (
              !user ? (
                <div className="membership-empty">
                  <Users size={30} />
                  <h2>Đăng nhập để xem thành viên</h2>
                  <Link className="button primary" href="/auth">
                    Đăng nhập
                  </Link>
                </div>
              ) : workspaceGroup.loading ? (
                <LoadingState message="Đang tải nhóm học tập…" />
              ) : workspaceGroup.error ? (
                <RequestError
                  error={workspaceGroup.error}
                  onRetry={workspaceGroup.reload}
                />
              ) : !workspaceGroup.groupId ? (
                <NoGroupSelected />
              ) : groupAccess.loading ? (
                <LoadingState message="Đang kiểm tra quyền…" />
              ) : groupAccess.error ? (
                <RequestError
                  error={groupAccess.error}
                  onRetry={groupAccess.refresh}
                />
              ) : permissions ? (
                <MembersPanel
                  key={`${user.id}:${workspaceGroup.groupId}`}
                  groupId={workspaceGroup.groupId}
                  permissions={permissions}
                  revision={groupAccess.revision}
                  allowManagement
                />
              ) : null
            ) : workspaceGroup.groupId && !permissions ? (
              groupAccess.loading ? (
                <LoadingState message="Đang kiểm tra quyền…" />
              ) : (
                <RequestError
                  error={groupAccess.error}
                  onRetry={groupAccess.refresh}
                />
              )
            ) : (
              <>
                {view === "live" && (
                  <>
                    <div className="session-info">
                      <div>
                        <span className="presenter-mini">
                          <img src={portrait} alt="" />
                        </span>
                        <b>Nguyễn Hoàng</b>
                        <span className="presenter-badge">Giảng viên</span>
                        <span className="session-separator">·</span>
                        <MonitorUp size={14} />
                        <span>Đang chia sẻ màn hình</span>
                      </div>
                      <span>
                        <Users size={14} /> {members.length + 18} người tham gia
                      </span>
                    </div>
                    <LivePlayer screenVideo={screenVideo} sharing={sharing} />
                    <div className="live-toolbar">
                      <div className="toolbar-devices">
                        <button
                          className={`device-button ${mic ? "enabled" : ""}`}
                          onClick={() => toggleMedia("mic")}
                          title={mic ? "Tắt micro" : "Bật micro"}
                        >
                          {mic ? <Mic size={19} /> : <MicOff size={19} />}
                          <ChevronDown size={12} />
                        </button>
                        <button
                          className={`device-button ${camera ? "enabled" : ""}`}
                          onClick={() => toggleMedia("camera")}
                          title={camera ? "Tắt camera" : "Bật camera"}
                        >
                          {camera ? (
                            <Video size={19} />
                          ) : (
                            <VideoOff size={19} />
                          )}
                          <ChevronDown size={12} />
                        </button>
                        <button
                          className={`device-button ${hand ? "enabled" : ""}`}
                          title="Giơ tay"
                          onClick={() => {
                            setHand(!hand);
                            notify(hand ? "Đã hạ tay." : "Bạn đã giơ tay.");
                          }}
                        >
                          <Hand size={19} />
                        </button>
                      </div>
                      <div className="toolbar-options">
                        <button
                          className={recording ? "record-active" : ""}
                          disabled={
                            Boolean(workspaceGroup.groupId) &&
                            !permissions?.canHost
                          }
                          onClick={toggleRecording}
                        >
                          <Circle
                            size={15}
                            fill={recording ? "currentColor" : "none"}
                          />{" "}
                          {recording ? "Dừng ghi mẫu" : "Ghi hình"}
                          {recording && <span className="live-dot" />}
                        </button>
                        <button
                          disabled={
                            Boolean(workspaceGroup.groupId) &&
                            !permissions?.canHost
                          }
                          onClick={() => setModal("poll")}
                        >
                          <BarChart3 size={16} /> Bình chọn
                        </button>
                        <button
                          className={sharing ? "text-cyan" : ""}
                          disabled={
                            Boolean(workspaceGroup.groupId) &&
                            !permissions?.canHost
                          }
                          onClick={() => toggleMedia("screen")}
                        >
                          <MonitorUp size={16} />{" "}
                          {sharing ? "Dừng chia sẻ" : "Chia sẻ"}
                        </button>
                      </div>
                      <Link href="/meet" className="leave-button">
                        <PhoneOff size={17} /> Rời phòng
                      </Link>
                    </div>
                    {camera && (
                      <div className="local-camera-preview">
                        <video ref={localVideo} autoPlay playsInline muted />
                        <span>
                          Camera của bạn · Chỉ hiển thị trên thiết bị này
                        </span>
                      </div>
                    )}
                    <div className="session-bottom">
                      <div className="section-heading">
                        <h2>Trong buổi học này</h2>
                        <span>BUỔI 05</span>
                      </div>
                      <div className="lesson-resource">
                        <div className="file-symbol">
                          <FileText size={23} />
                        </div>
                        <div>
                          <b>Slide — Hệ thống phân tán.pdf</b>
                          <small>Được chia sẻ bởi Nguyễn Hoàng · 12,4 MB</small>
                        </div>
                        <Link href="/files" className="resource-link">
                          Xem tài liệu <ArrowRight size={15} />
                        </Link>
                      </div>
                      <div className="demo-caption">
                        <ShieldCheck size={12} /> Bản trải nghiệm · Nội dung,
                        người tham gia và trình phát được mô phỏng.
                      </div>
                    </div>
                  </>
                )}
                {view === "meet" && (
                  <div className="meet-page">
                    <div className="eyebrow">
                      <span className="status-dot" /> SẴN SÀNG KẾT NỐI
                    </div>
                    <h2>
                      Khoảng cách nhỏ lại.
                      <br />
                      <span>Ý tưởng lớn lên.</span>
                    </h2>
                    <p>
                      Tạo một cuộc họp mới hoặc tham gia cùng nhóm của bạn.
                      <br />
                      Chỉ cần một đường liên kết để bắt đầu.
                    </p>
                    <div className="meet-create-card">
                      <div className="card-icon">
                        <Video size={24} />
                      </div>
                      <h3>Bắt đầu một điều thú vị</h3>
                      <label htmlFor="room-name">Tên cuộc họp</label>
                      <input
                        id="room-name"
                        value={roomName}
                        onChange={(e) => setRoomName(e.target.value)}
                        placeholder="Ví dụ: Nhóm học tập cuối tuần"
                      />
                      <button
                        className="button primary"
                        disabled={
                          Boolean(workspaceGroup.groupId) &&
                          !permissions?.canHost
                        }
                        onClick={() => {
                          const code = `phong-${Date.now().toString(36)}`;
                          sessionStorage.setItem(
                            code,
                            roomName.trim() || "Cuộc họp mới",
                          );
                          location.href = `/rooms/${code}`;
                        }}
                      >
                        <Plus size={18} /> Tạo cuộc họp mới
                      </button>
                      <div className="or-divider">
                        <span /> hoặc tham gia bằng mã <span />
                      </div>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const raw = roomCode.trim();
                          const code = raw.includes("/rooms/")
                            ? raw.split("/rooms/").pop()?.split(/[?#]/)[0]
                            : raw;
                          if (!code || !/^[a-zA-Z0-9_-]{3,80}$/.test(code)) {
                            notify(
                              "Nhập mã phòng hợp lệ, ít nhất 3 ký tự (chữ, số, gạch ngang).",
                            );
                            return;
                          }
                          location.href = `/rooms/${code}`;
                        }}
                      >
                        <div className="input-icon">
                          <Link2 size={17} />
                          <input
                            aria-label="Mã hoặc liên kết cuộc họp"
                            placeholder="Nhập mã hoặc liên kết"
                            value={roomCode}
                            onChange={(e) => setRoomCode(e.target.value)}
                          />
                        </div>
                        <button
                          className="button secondary"
                          disabled={!roomCode.trim()}
                        >
                          Tham gia <ArrowRight size={16} />
                        </button>
                      </form>
                    </div>
                    <div className="meet-decoration">
                      <div className="orbit orbit-one" />
                      <div className="orbit orbit-two" />
                      <div className="meet-art-tile tile-one">
                        <Avatar initials="MA" color="pink" />
                        <span>Minh Anh</span>
                        <Mic size={15} />
                      </div>
                      <div className="meet-art-tile tile-two">
                        <Avatar initials="TP" color="blue" />
                        <span>Tuấn Phạm</span>
                        <MicOff size={15} />
                      </div>
                      <div className="meet-art-center">
                        <Waves size={54} />
                      </div>
                      <span className="art-spark spark-one">✦</span>
                      <span className="art-spark spark-two">✧</span>
                      <div className="meet-art-label">
                        <ShieldCheck size={17} /> Không gian cho mọi ý tưởng.
                      </div>
                    </div>
                  </div>
                )}
                {view === "files" && (
                  <div className="files-page">
                    <div className="files-banner">
                      <div className="file-banner-icon">
                        <Folder size={33} />
                      </div>
                      <div>
                        <span className="eyebrow">THƯ VIỆN CỘNG ĐỒNG</span>
                        <h2>Mọi kiến thức, một nơi.</h2>
                        <p>
                          Tài liệu và bản ghi luôn ở đây để bạn tiếp tục khám
                          phá.
                        </p>
                      </div>
                      <button
                        className="button primary"
                        disabled={
                          Boolean(workspaceGroup.groupId) &&
                          !permissions?.canUpload
                        }
                        onClick={() => fileInput.current?.click()}
                      >
                        <Upload size={16} /> Thêm tài liệu
                      </button>
                    </div>
                    <div className="file-controls">
                      <div className="file-filters">
                        {["Tất cả", "Tài liệu", "Bản ghi"]
                          .filter(
                            (item) =>
                              item !== "Bản ghi" ||
                              !workspaceGroup.groupId ||
                              permissions?.canViewRecordings,
                          )
                          .map((item) => (
                            <button
                              key={item}
                              onClick={() => setFilter(item)}
                              className={filter === item ? "selected" : ""}
                            >
                              {item}
                            </button>
                          ))}
                      </div>
                      <div className="input-icon">
                        <Search size={16} />
                        <input
                          placeholder="Tìm tên tài liệu…"
                          aria-label="Tìm tên tài liệu"
                          value={fileQuery}
                          onChange={(e) => setFileQuery(e.target.value)}
                        />
                      </div>
                    </div>
                    <input
                      type="file"
                      ref={fileInput}
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file)
                          setUpload({
                            name: file.name,
                            size: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
                            progress: 0,
                            paused: false,
                          });
                        e.target.value = "";
                      }}
                    />
                    {upload && (
                      <div className="upload-progress">
                        <Upload size={22} />
                        <div>
                          <b>{upload.name}</b>
                          <small>
                            {upload.paused
                              ? "Đã tạm dừng · Có thể tiếp tục"
                              : `Đang mô phỏng tải lên · ${upload.progress}%`}
                          </small>
                          <progress value={upload.progress} max="100" />
                        </div>
                        <button
                          className="button secondary compact"
                          onClick={() =>
                            setUpload({ ...upload, paused: !upload.paused })
                          }
                        >
                          {upload.paused ? (
                            <Play size={14} />
                          ) : (
                            <Pause size={14} />
                          )}{" "}
                          {upload.paused ? "Tiếp tục" : "Tạm dừng"}
                        </button>
                        <IconButton
                          label="Hủy tải lên"
                          onClick={() => setUpload(null)}
                        >
                          <X size={16} />
                        </IconButton>
                      </div>
                    )}
                    <div className="file-table">
                      <div className="file-table-heading">
                        <span>Tên tài liệu</span>
                        <span>Dung lượng</span>
                        <span>Được thêm</span>
                        <span />
                      </div>
                      {filteredFiles.map((file, index) => (
                        <button
                          key={`${file.name}-${index}`}
                          className="file-row"
                          onClick={() => {
                            setModal(`file:${file.name}`);
                          }}
                        >
                          <span>
                            <span
                              className={`file-symbol ${file.kind === "Bản ghi" ? "video-symbol" : ""}`}
                            >
                              {file.kind === "Bản ghi" ? (
                                <Video size={22} />
                              ) : (
                                <FileText size={22} />
                              )}
                            </span>
                            <span>
                              <b>{file.name}</b>
                              <small>{file.kind}</small>
                            </span>
                          </span>
                          <span>{file.size}</span>
                          <span>{file.date}</span>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                      {!filteredFiles.length && (
                        <div className="empty-state">
                          <Search size={30} />
                          <h3>Chưa tìm thấy tài liệu</h3>
                          <p>Thử một tên khác hoặc chọn bộ lọc khác.</p>
                        </div>
                      )}
                    </div>
                    <div className="file-disclaimer">
                      <ShieldCheck size={15} /> Thư viện mẫu lưu thông tin trên
                      trình duyệt. Tải lên và tạm dừng được mô phỏng; nội dung
                      tệp chưa được lưu.
                    </div>
                  </div>
                )}
                {view === "chat" && (
                  <div className="community-chat">
                    <WorkspaceChat
                      {...chatProps}
                      welcome={
                        <div className="chat-welcome">
                          <div className="card-icon">
                            <Hash size={30} />
                          </div>
                          <h2>Mỗi kết nối bắt đầu bằng lời chào.</h2>
                          <p>
                            Chào mừng đến với <b>#{title}</b> của {group}.<br />
                            Cùng đặt câu hỏi, chia sẻ kiến thức và giúp nhau
                            tiến bộ.
                          </p>
                          <button
                            className="button secondary compact"
                            onClick={() => setModal("invite")}
                          >
                            <Users size={15} /> Mời bạn bè
                          </button>
                        </div>
                      }
                    />
                  </div>
                )}
                {view === "room" && (
                  <div className="room-page">
                    <div className="room-banner">
                      <span className="status-dot" /> Phòng trải nghiệm · Thiết
                      bị chỉ hiển thị cục bộ{" "}
                      <span>
                        <Clock3 size={14} /> Sẵn sàng bắt đầu
                      </span>
                    </div>
                    <div className="meeting-grid">
                      <div
                        className={`participant-tile you ${mic ? "speaking" : ""}`}
                      >
                        {camera ? (
                          <video ref={localVideo} autoPlay playsInline muted />
                        ) : (
                          <Avatar initials="BA" />
                        )}
                        <div className="participant-label">
                          Bạn <small>Người tổ chức</small>
                          {mic ? <Mic size={15} /> : <MicOff size={15} />}
                        </div>
                      </div>
                      {members.slice(0, 3).map((name, index) => (
                        <div className="participant-tile" key={name}>
                          <Avatar
                            initials={name
                              .split(" ")
                              .map((n) => n[0])
                              .join("")}
                            color={["blue", "pink", "green"][index]}
                          />
                          <div className="participant-label">
                            {name}
                            <MicOff size={15} />
                          </div>
                          <span className="sample-label">Minh họa</span>
                        </div>
                      ))}
                    </div>
                    {sharing && (
                      <div className="room-screen">
                        <video ref={screenVideo} autoPlay playsInline muted />
                        <span>Màn hình của bạn</span>
                      </div>
                    )}
                    <div className="room-device-bar">
                      <button
                        className={`round-control ${mic ? "" : "off"}`}
                        onClick={() => toggleMedia("mic")}
                        aria-label={mic ? "Tắt micro" : "Bật micro"}
                      >
                        {mic ? <Mic /> : <MicOff />}
                      </button>
                      <button
                        className={`round-control ${camera ? "" : "off"}`}
                        onClick={() => toggleMedia("camera")}
                        aria-label={camera ? "Tắt camera" : "Bật camera"}
                      >
                        {camera ? <Video /> : <VideoOff />}
                      </button>
                      <button
                        className={`round-control ${sharing ? "active" : ""}`}
                        disabled={
                          Boolean(workspaceGroup.groupId) &&
                          !permissions?.canHost
                        }
                        onClick={() => toggleMedia("screen")}
                        aria-label="Chia sẻ màn hình"
                      >
                        <MonitorUp />
                      </button>
                      <button
                        className={`round-control ${recording ? "record-active" : ""}`}
                        disabled={
                          Boolean(workspaceGroup.groupId) &&
                          !permissions?.canHost
                        }
                        onClick={toggleRecording}
                        aria-label="Ghi hình mẫu"
                      >
                        <Circle size={21} />
                      </button>
                      <button
                        className="round-control"
                        onClick={() => setModal("poll")}
                        aria-label="Tạo bình chọn"
                        disabled={
                          Boolean(workspaceGroup.groupId) &&
                          !permissions?.canHost
                        }
                      >
                        <BarChart3 />
                      </button>
                      <button
                        className={`round-control ${hand ? "active" : ""}`}
                        onClick={() => setHand(!hand)}
                        aria-label="Giơ tay"
                      >
                        <Hand />
                      </button>
                      <Link
                        href="/meet"
                        className="round-control hangup"
                        aria-label="Rời cuộc họp"
                      >
                        <PhoneOff />
                      </Link>
                    </div>
                    <div className="room-bottom">
                      <span>
                        <ShieldCheck size={14} /> Thiết bị của bạn chỉ được bật
                        khi cho phép.
                      </span>
                      <button onClick={() => setModal("settings")}>
                        <Settings2 size={14} /> Thiết lập chia sẻ
                      </button>
                    </div>
                  </div>
                )}
                {poll && (!workspaceGroup.groupId || permissions?.canHost) && (
                  <div className="poll-card">
                    <div>
                      <BarChart3 size={19} />
                      <b>Bình chọn đang mở</b>
                      <IconButton
                        label="Đóng bình chọn"
                        onClick={() => setPoll(false)}
                      >
                        <X size={16} />
                      </IconButton>
                    </div>
                    <h3>{pollQuestion}</h3>
                    {pollOptions.map((option, index) => (
                      <button
                        key={index}
                        className={vote === index ? "selected" : ""}
                        onClick={() => setVote(index)}
                      >
                        <span>{option}</span>
                        {vote === index ? (
                          <Check size={17} />
                        ) : (
                          <Circle size={16} />
                        )}
                      </button>
                    ))}
                    <small>
                      {vote !== null
                        ? "Đã ghi nhận lựa chọn của bạn trong bản trải nghiệm."
                        : "Chọn một câu trả lời · Bình chọn minh họa"}
                    </small>
                  </div>
                )}
              </>
            )}
          </main>
          {panel && !membersView && (
            <aside className="right-panel">
              <div className="panel-tabs">
                <button
                  className={panelTab === "chat" ? "selected" : ""}
                  onClick={() => setPanelTab("chat")}
                >
                  Trò chuyện <span>{messages.length}</span>
                </button>
                <button
                  className={panelTab === "members" ? "selected" : ""}
                  onClick={() => setPanelTab("members")}
                >
                  Thành viên
                </button>
                <IconButton
                  label="Đóng bảng bên"
                  onClick={() => setPanel(false)}
                >
                  <X size={16} />
                </IconButton>
              </div>
              {panelTab === "chat" ? (
                <WorkspaceChat {...chatProps} />
              ) : !user ? (
                <div className="membership-empty">
                  <p>Đăng nhập để xem thành viên.</p>
                  <Link href="/auth" className="button primary">
                    Đăng nhập
                  </Link>
                </div>
              ) : workspaceGroup.loading ? (
                <LoadingState message="Đang tải nhóm học tập…" />
              ) : workspaceGroup.error ? (
                <RequestError
                  error={workspaceGroup.error}
                  onRetry={workspaceGroup.reload}
                />
              ) : !workspaceGroup.groupId ? (
                <NoGroupSelected />
              ) : groupAccess.loading ? (
                <LoadingState message="Đang kiểm tra quyền…" />
              ) : groupAccess.error ? (
                <RequestError
                  error={groupAccess.error}
                  onRetry={groupAccess.refresh}
                />
              ) : permissions ? (
                <MembersPanel
                  key={`${user.id}:${workspaceGroup.groupId}`}
                  groupId={workspaceGroup.groupId}
                  permissions={permissions}
                  revision={groupAccess.revision}
                />
              ) : null}
              <div className="panel-footer">
                <span className="status-dot" /> Mọi ý tưởng đều đáng được lắng
                nghe.
              </div>
            </aside>
          )}
        </div>
      </div>
      {modal === "groups" && (
        <div
          className="modal-backdrop groups-overlay-backdrop"
          onClick={() => setModal(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="groups-overlay-title"
            className="groups-overlay-dialog"
            data-workspace-dialog="true"
            onClick={(event) => event.stopPropagation()}
          >
            <GroupsListPage
              embedded
              onClose={() => setModal(null)}
              onGroupsChanged={workspaceGroup.reload}
            />
          </section>
        </div>
      )}
      {modal === "meet" && (
        <div
          className="modal-backdrop groups-overlay-backdrop meet-overlay-backdrop"
          onClick={() => setModal(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="meet-overlay-title"
            className="groups-overlay-dialog meet-overlay-dialog"
            data-workspace-dialog="true"
            onClick={(event) => event.stopPropagation()}
          >
            <MeetHub embedded onClose={() => setModal(null)} />
          </section>
        </div>
      )}
      {modal && modal !== "groups" && modal !== "meet" && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Hộp thao tác"
            className="modal"
            data-workspace-dialog="true"
            onClick={(e) => e.stopPropagation()}
          >
            <IconButton label="Đóng" onClick={() => setModal(null)}>
              <X size={20} />
            </IconButton>
            {modal === "invite" && (
              <>
                <div className="card-icon">
                  <Users />
                </div>
                <h2>Học cùng nhau, tốt hơn.</h2>
                <p>Gửi liên kết này để mời mọi người vào phòng trải nghiệm.</p>
                <div className="invite-link">
                  <code>{inviteUrl}</code>
                  <IconButton label="Sao chép liên kết" onClick={copyInvite}>
                    <Copy size={17} />
                  </IconButton>
                </div>
                <button className="button primary" onClick={copyInvite}>
                  <Copy size={16} /> Sao chép liên kết mời
                </button>
              </>
            )}
            {modal === "poll" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setPoll(true);
                  setVote(null);
                  setModal(null);
                }}
              >
                <div className="card-icon">
                  <BarChart3 />
                </div>
                <h2>Cùng lắng nghe mọi người.</h2>
                <p>Tạo bình chọn nhanh trong phòng trải nghiệm.</p>
                <label htmlFor="poll-question">Câu hỏi</label>
                <input
                  id="poll-question"
                  required
                  value={pollQuestion}
                  onChange={(e) => setPollQuestion(e.target.value)}
                />
                {pollOptions.map((option, index) => (
                  <label key={index}>
                    Lựa chọn {index + 1}
                    <input
                      required
                      value={option}
                      onChange={(e) =>
                        setPollOptions(
                          pollOptions.map((item, i) =>
                            i === index ? e.target.value : item,
                          ),
                        )
                      }
                    />
                  </label>
                ))}
                <button className="button primary" type="submit">
                  Mở bình chọn <ArrowRight size={16} />
                </button>
              </form>
            )}
            {modal === "search" && (
              <>
                <h2>Tìm trong không gian</h2>
                <div className="input-icon">
                  <Search size={18} />
                  <input
                    autoFocus
                    placeholder="Tìm tài liệu, cuộc trò chuyện…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="search-results">
                  {search.trim() ? (
                    <>
                      {files
                        .filter((f) =>
                          f.name
                            .toLocaleLowerCase("vi")
                            .includes(search.toLocaleLowerCase("vi")),
                        )
                        .map((f) => (
                          <Link key={f.name} href="/files">
                            <FileText size={17} />
                            {f.name}
                            <ArrowRight size={15} />
                          </Link>
                        ))}
                      {messages
                        .filter((m) =>
                          m.text
                            .toLocaleLowerCase("vi")
                            .includes(search.toLocaleLowerCase("vi")),
                        )
                        .map((m, i) => (
                          <Link key={i} href="/community">
                            <MessageCircle size={17} />
                            <span>
                              <b>{m.name}</b>
                              <small>{m.text}</small>
                            </span>
                          </Link>
                        ))}
                      {!files.some((f) =>
                        f.name
                          .toLocaleLowerCase("vi")
                          .includes(search.toLocaleLowerCase("vi")),
                      ) &&
                        !messages.some((m) =>
                          m.text
                            .toLocaleLowerCase("vi")
                            .includes(search.toLocaleLowerCase("vi")),
                        ) && <p>Không có kết quả phù hợp.</p>}
                    </>
                  ) : (
                    <p>Nhập từ khóa để tìm trong dữ liệu mẫu của cộng đồng.</p>
                  )}
                </div>
              </>
            )}
            {modal === "settings" && (
              <>
                <div className="card-icon">
                  <Settings2 />
                </div>
                <h2>Thiết lập của bạn</h2>
                <p>Điều chỉnh chất lượng chia sẻ phù hợp với nội dung.</p>
                <label htmlFor="fps">
                  Tốc độ khung hình khi chia sẻ màn hình
                </label>
                <select
                  id="fps"
                  value={fps}
                  onChange={(e) => setFps(e.target.value)}
                >
                  <option value="15">15 khung hình/giây · Tài liệu</option>
                  <option value="30">30 khung hình/giây · Cân bằng</option>
                  <option value="60">60 khung hình/giây · Chuyển động</option>
                </select>
                <p className="settings-note">
                  Áp dụng khi bắt đầu chia sẻ lần tiếp theo. Trình duyệt có thể
                  điều chỉnh theo thiết bị.
                </p>
                <button
                  className="button primary"
                  onClick={() => {
                    setModal(null);
                    notify("Đã lưu thiết lập chia sẻ cho phiên này.");
                  }}
                >
                  <Check size={17} /> Lưu thiết lập
                </button>
              </>
            )}
            {modal === "notifications" && (
              <>
                <div className="card-icon">
                  <Bell />
                </div>
                <h2>Thông báo của bạn</h2>
                <div className="notice">
                  <Radio size={20} />
                  <div>
                    <b>Buổi 05 đang diễn ra</b>
                    <p>Kiến trúc hệ thống phân tán · Phòng học trực tiếp</p>
                    <Link href="/workspace">
                      Vào lớp học <ArrowRight size={13} />
                    </Link>
                  </div>
                </div>
                <div className="notice">
                  <Folder size={20} />
                  <div>
                    <b>Tài liệu mới trong thư viện</b>
                    <p>Nguyễn Hoàng đã chia sẻ slide buổi học.</p>
                    <Link href="/files">
                      Xem thư viện <ArrowRight size={13} />
                    </Link>
                  </div>
                </div>
                <small>Thông báo minh họa</small>
              </>
            )}
            {modal === "help" && (
              <>
                <div className="card-icon">
                  <Clock3 />
                </div>
                <h2>Học theo nhịp của bạn.</h2>
                <p>
                  Chọn một kênh bên trái để trò chuyện, vào lớp hoặc mở thư
                  viện. Ở lớp trực tiếp, kéo thanh thời gian để tua lại; chọn
                  “Về trực tiếp” để theo kịp bài học.
                </p>
                <p>
                  Camera, micro và chia sẻ màn hình sử dụng quyền thiết bị thật
                  và chỉ hiển thị cục bộ. Cuộc gọi nhiều người, ghi hình, lưu
                  tệp đang ở chế độ minh họa. Mục Thành viên sử dụng tài khoản,
                  nhóm và phân quyền thật.
                </p>
                <button
                  className="button primary"
                  onClick={() => setModal(null)}
                >
                  Bắt đầu khám phá <ArrowRight size={16} />
                </button>
              </>
            )}
            {modal === "community-settings" && (
              <>
                <div className="card-icon">
                  <ShieldCheck />
                </div>
                <h2>{group}</h2>
                <p>Vai trò trong cộng đồng mẫu</p>
                <div className="role-row">
                  <span className="role-dot violet" />
                  <b>Người quản trị</b>
                  <span>Quản lý cộng đồng</span>
                </div>
                <div className="role-row">
                  <span className="role-dot green" />
                  <b>Giảng viên</b>
                  <span>Quản lý buổi học</span>
                </div>
                <div className="role-row">
                  <span className="role-dot blue" />
                  <b>Thành viên</b>
                  <span>Tham gia và trao đổi</span>
                </div>
                <p>
                  Quyền truy cập thực tế sẽ được xác thực bởi máy chủ khi tích
                  hợp đăng nhập.
                </p>
                <button
                  className="button primary"
                  onClick={() => setModal("invite")}
                >
                  <Users size={16} /> Mời thành viên
                </button>
              </>
            )}
            {modal === "channel" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = String(
                    new FormData(e.currentTarget).get("name") || "",
                  )
                    .trim()
                    .toLocaleLowerCase("vi")
                    .replace(/\s+/g, "-");
                  if (!name) return;
                  if (
                    customChannels.includes(name) ||
                    name === "trò-chuyện-chung"
                  ) {
                    notify("Tên kênh đã tồn tại.");
                    return;
                  }
                  const next = [...customChannels, name];
                  setCustomChannels(next);
                  localStorage.setItem(
                    "streamora-channels",
                    JSON.stringify(next),
                  );
                  location.href = `/community/${encodeURIComponent(name)}`;
                }}
              >
                <div className="card-icon">
                  <Hash />
                </div>
                <h2>Thêm một cuộc trò chuyện.</h2>
                <p>Kênh và tin nhắn được lưu riêng trên trình duyệt này.</p>
                <label htmlFor="channel-name">Tên kênh</label>
                <input
                  name="name"
                  required
                  maxLength={40}
                  id="channel-name"
                  placeholder="Ví dụ: thảo-luận-bài-tập"
                />
                <button className="button primary">
                  Tạo kênh <Plus size={15} />
                </button>
              </form>
            )}
            {modal === "questions" && (
              <>
                <div className="card-icon">
                  <MessageCircle />
                </div>
                <h2>Góc hỏi đáp</h2>
                <p>Cùng giải đáp những câu hỏi trong buổi học.</p>
                {[
                  "Khi nào nên dùng nhiều máy chủ?",
                  "Cân bằng tải xử lý lỗi như thế nào?",
                  "Làm sao để dữ liệu luôn nhất quán?",
                ].map((q) => (
                  <div className="question-item" key={q}>
                    <Hash size={17} />
                    {q}
                  </div>
                ))}
                <Link href="/community" className="button primary">
                  Thảo luận cùng mọi người <ArrowRight size={16} />
                </Link>
              </>
            )}
            {modal.startsWith("file:") && (
              <>
                <div className="card-icon">
                  <FileText />
                </div>
                <h2>{modal.slice(5)}</h2>
                <p>
                  Đây là mục tài liệu minh họa. Nội dung tệp chưa được lưu trên
                  máy chủ nên chưa thể tải xuống hoặc phát bản ghi.
                </p>
                <p>
                  Khi tích hợp thư viện thật, mục này sẽ mở tài liệu hoặc trình
                  phát bản ghi của cộng đồng.
                </p>
                <button
                  className="button primary"
                  onClick={() => setModal(null)}
                >
                  Đã hiểu <Check size={16} />
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
