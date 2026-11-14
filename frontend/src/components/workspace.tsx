"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { CreateGroupMeeting } from "./class-sessions/create-group-meeting";
import { WorkspaceMeetingRoom } from "./class-sessions/workspace-meeting-room";
import { ActiveMeetingCard } from "./class-sessions/active-meeting-card";
import {
  MeetingPeoplePanel,
  MeetingChatSidePanel,
  type SessionRoomHandle,
  type MeetingRoomState,
} from "./class-sessions/session-room";
import type { ClassSession } from "@streamora/contracts";
import { useWorkspaceMeetings } from "@/lib/class-sessions/use-workspace-meetings";
import { getClassSession, listClassSessions } from "@/lib/class-sessions/api";
import { useWorkspaceGroup } from "@/lib/memberships/use-workspace-group";
import { useGroupPermissions } from "@/lib/memberships/use-group-permissions";
import { useGroupChat } from "@/lib/memberships/use-group-chat";
import { useWorkspacePanel } from "@/lib/memberships/use-workspace-panel";
import { useChatUnread } from "@/lib/memberships/use-chat-unread";

import { LivePlayer } from "./live-player";
import { WorkspaceChat } from "./workspace-chat";
import { WorkspaceThreads } from "./workspace-threads";
import { WorkspaceSearch } from "./workspace-search";
import { FilesPanel } from "./files/files-panel";
import { initialFiles, membersInitial, portrait } from "./demo-data";
import type { View, ChatMessage } from "./demo-data";
const chatTimeFormat = new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit",
  minute: "2-digit",
});

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
  view: baseView,
  channel: routeChannel = "trò-chuyện-chung",
  targetMessageId: routeMessageId,
  targetThreadId: routeThreadId,
}: {
  view: View;
  channel?: string;
  targetMessageId?: string;
  targetThreadId?: string;
}) {
  const router = useRouter();
  const [navigation, setNavigation] = useState<
    | { view: "chat"; channel: string; messageId?: string; threadId?: string }
    | { view: "files" }
    | null
  >(null);
  const chatNavigation = navigation?.view === "chat" ? navigation : null;
  const channel = chatNavigation?.channel ?? routeChannel;
  const targetMessageId = navigation
    ? chatNavigation?.messageId
    : routeMessageId;
  const targetThreadId = navigation ? chatNavigation?.threadId : routeThreadId;
  useEffect(() => {
    setNavigation(null);
    const restore = () => {
      const url = new URL(location.href);
      const match = url.pathname.match(/^\/community(?:\/([^/]+))?\/?$/);
      setNavigation(
        match
          ? {
              view: "chat",
              channel: decodeURIComponent(match[1] ?? "trò-chuyện-chung"),
              messageId: url.searchParams.get("messageId") ?? undefined,
              threadId: url.searchParams.get("threadId") ?? undefined,
            }
          : url.pathname === "/files"
            ? { view: "files" }
            : null,
      );
      if (url.pathname === "/files")
        setFilter(
          url.searchParams.get("type") === "recordings" ? "Bản ghi" : "Tất cả",
        );
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [baseView, routeChannel, routeMessageId, routeThreadId]);
  const { notify } = useToast();
  const { user } = useAuth();
  const workspaceGroup = useWorkspaceGroup();
  function openMeetingCreation() {
    if (workspaceGroup.groupId && permissions?.canHost)
      setModal("create-meeting");
  }
  const groupAccess = useGroupPermissions(workspaceGroup.groupId);
  const permissions = groupAccess.permissions;
  const rooms = useWorkspaceMeetings(
    workspaceGroup.groupId,
    !!permissions,
    groupAccess.revision,
  );
  const [meetingSelection, setMeetingSelection] = useState<{
    id: string;
    groupId: string;
  } | null>(null);
  const selectionRef = useRef(meetingSelection);
  selectionRef.current = meetingSelection;
  const activeMeetingId =
    meetingSelection?.groupId === workspaceGroup.groupId
      ? meetingSelection?.id
      : null;
  const [meetingMinimized, setMeetingMinimized] = useState(false);
  // Track live meetings across all groups
  const [liveGroupIds, setLiveGroupIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user || !workspaceGroup.groups.length) return;
    let active = true;
    const checkLiveGroups = async () => {
      try {
        const results = await Promise.allSettled(
          workspaceGroup.groups.map(async (g) => {
            const res = await listClassSessions(g.id, undefined, "LIVE");
            return {
              groupId: g.id,
              hasLive: res.items.some((s) => s.status === "LIVE"),
            };
          }),
        );
        if (!active) return;
        const liveSet = new Set<string>();
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.hasLive) {
            liveSet.add(r.value.groupId);
          }
        }
        if (
          workspaceGroup.groupId &&
          rooms.items.some((r) => r.status === "LIVE")
        ) {
          liveSet.add(workspaceGroup.groupId);
        }
        setLiveGroupIds(liveSet);
      } catch {
        // tolerate errors during live polling
      }
    };
    void checkLiveGroups();
    const interval = setInterval(checkLiveGroups, 15000);
    window.addEventListener("streamora:meetings-changed", checkLiveGroups);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("streamora:meetings-changed", checkLiveGroups);
    };
  }, [user?.id, workspaceGroup.groups, workspaceGroup.groupId]);

  useEffect(() => {
    if (!workspaceGroup.groupId) return;
    const hasLiveNow = rooms.items.some((r) => r.status === "LIVE");
    setLiveGroupIds((prev) => {
      if (prev.has(workspaceGroup.groupId!) === hasLiveNow) return prev;
      const next = new Set(prev);
      if (hasLiveNow) next.add(workspaceGroup.groupId!);
      else next.delete(workspaceGroup.groupId!);
      return next;
    });
  }, [rooms.items, workspaceGroup.groupId]);

  // Track pending room switch to show confirm dialog
  const [pendingRoomSwitch, setPendingRoomSwitch] =
    useState<ClassSession | null>(null);
  const [roomInfo, setRoomInfo] = useState<ClassSession | null>(null);
  const selectedMeeting =
    roomInfo?.id === activeMeetingId
      ? roomInfo
      : rooms.items.find((room) => room.id === activeMeetingId);
  useEffect(() => {
    if (
      selectedMeeting &&
      ["ENDED", "CANCELLED"].includes(selectedMeeting.status)
    ) {
      returnToChat();
    }
  }, [selectedMeeting?.status]);
  // Track notified live meetings to avoid duplicate toast notifications
  const notifiedLiveIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!workspaceGroup.groupId || !user) return;
    const currentIds = new Set(rooms.items.map((r) => r.id));
    rooms.items.forEach((room) => {
      if (room.status === "LIVE" && !notifiedLiveIds.current.has(room.id)) {
        notify(`📢 "${room.title}" đang diễn ra — bấm vào để tham gia!`, {
          tone: "info",
        });
        notifiedLiveIds.current.add(room.id);
      }
    });
    // Remove old ended rooms from notified set
    notifiedLiveIds.current.forEach((id) => {
      if (!currentIds.has(id)) notifiedLiveIds.current.delete(id);
    });
  }, [rooms.items, workspaceGroup.groupId, user?.id]);
  const roomRef = useRef<SessionRoomHandle>(null);
  const [roomState, setRoomState] = useState<MeetingRoomState | null>(null);
  const reportRoomState = useCallback((state: MeetingRoomState) => {
    if (selectionRef.current?.id === state.sessionId) setRoomState(state);
  }, []);
  const workspaceScope = useRef("");
  workspaceScope.current = `${user?.id ?? ""}:${workspaceGroup.groupId ?? ""}`;
  const switching = useRef(false);
  const [roomSwitching, setRoomSwitching] = useState(false);
  const view: View = activeMeetingId
    ? meetingMinimized
      ? "chat"
      : "meetings"
    : (navigation?.view ??
      (baseView === "meetings" ||
      (baseView === "live" && !!workspaceGroup.groupId)
        ? "chat"
        : baseView));
  const changeWorkspace = useCallback(
    async (apply: () => void) => {
      if (switching.current) return;
      switching.current = true;
      setRoomSwitching(true);
      const expected = workspaceScope.current;
      try {
        await roomRef.current?.leave();
        if (workspaceScope.current === expected) apply();
      } catch {
        notify("Chưa thể rời phòng hiện tại. Kiểm tra kết nối rồi thử lại.", {
          tone: "error",
        });
      } finally {
        switching.current = false;
        setRoomSwitching(false);
      }
    },
    [notify],
  );
  function returnToChat() {
    void changeWorkspace(() => {
      setMeetingSelection(null);
      setMeetingMinimized(false);
      setRoomInfo(null);
      setPanelTab("chat");
      setMembersView(false);
      const url = new URL(location.href);
      url.searchParams.delete("meetingId");
      history.pushState(null, "", url);
    });
  }
  function returnToMeeting() {
    setMeetingMinimized(false);
    const url = new URL(location.href);
    url.pathname = "/workspace";
    history.pushState(null, "", url);
  }
  const updateRoom = useCallback(
    (session: ClassSession) => {
      rooms.update(session);
      if (session.status === "ENDED" || session.status === "CANCELLED") {
        returnToChat();
        return;
      }
      if (selectionRef.current?.id === session.id)
        setRoomInfo((current) =>
          current?.id === session.id &&
          current.title === session.title &&
          current.status === session.status
            ? current
            : session,
        );
    },
    [rooms.update],
  );
  function openRoom(session: ClassSession) {
    if (
      session.id === activeMeetingId &&
      session.groupId === workspaceGroup.groupId
    ) {
      returnToMeeting();
      return;
    }
    if (session.groupId !== workspaceGroup.groupId) return;
    // If already in another room, show confirm dialog first
    if (activeMeetingId) {
      setPendingRoomSwitch(session);
      return;
    }
    void changeWorkspace(() => {
      setMeetingSelection({ id: session.id, groupId: session.groupId! });
      setMeetingMinimized(false);
      setRoomInfo(session);
      setMembersView(false);
      setMobileNav(false);
      setModal(null);
      setPanel(!matchMedia("(max-width: 900px)").matches);
      setPanelTab("chat");
      const url = new URL(location.href);
      url.searchParams.set("meetingId", session.id);
      url.searchParams.set("groupId", session.groupId!);
      url.searchParams.delete("create");
      url.searchParams.delete("tab");
      history.pushState(null, "", url);
    });
  }
  function confirmRoomSwitch() {
    const session = pendingRoomSwitch;
    setPendingRoomSwitch(null);
    if (!session) return;
    void changeWorkspace(() => {
      setMeetingSelection({ id: session.id, groupId: session.groupId! });
      setMeetingMinimized(false);
      setRoomInfo(session);
      setMembersView(false);
      setMobileNav(false);
      setModal(null);
      setPanel(!matchMedia("(max-width: 900px)").matches);
      setPanelTab("chat");
      const url = new URL(location.href);
      url.searchParams.set("meetingId", session.id);
      url.searchParams.set("groupId", session.groupId!);
      url.searchParams.delete("create");
      url.searchParams.delete("tab");
      history.pushState(null, "", url);
    });
  }
  async function openMeetingById(id: string) {
    const expected = workspaceScope.current;
    try {
      const room =
        rooms.items.find((item) => item.id === id) ??
        (await getClassSession(id)).session;
      if (workspaceScope.current === expected) openRoom(room);
    } catch {
      notify("Chưa thể mở cuộc họp. Kiểm tra quyền truy cập và thử lại.", {
        tone: "error",
      });
    }
  }
  function selectWorkspaceGroup(groupId: string) {
    if (groupId === workspaceGroup.groupId) return;
    void changeWorkspace(() => {
      setMeetingSelection(null);
      setRoomInfo(null);
      workspaceGroup.selectGroup(groupId);
    });
  }
  useEffect(() => {
    if (!user) {
      setMeetingSelection(null);
      return;
    }
    let current = true;
    const restore = async () => {
      const params = new URLSearchParams(location.search);
      const id = params.get("meetingId"),
        groupId = params.get("groupId");
      if (selectionRef.current?.id !== id) {
        try {
          await roomRef.current?.leave();
        } catch {
          const previous = selectionRef.current;
          if (current && previous) {
            workspaceGroup.selectGroup(previous.groupId);
            const url = new URL(location.href);
            url.searchParams.set("meetingId", previous.id);
            history.replaceState(null, "", url);
            notify("Chưa thể chuyển phòng. Kiểm tra kết nối rồi thử lại.", {
              tone: "error",
            });
          }
          return;
        }
      }
      if (current) {
        setMeetingSelection(id && groupId ? { id, groupId } : null);
        const chatPath = location.pathname.match(
          /^\/community(?:\/([^/]+))?\/?$/,
        );
        setMeetingMinimized(!!id && !!chatPath);
        setRoomInfo(null);
        if (id) {
          setPanel(!matchMedia("(max-width: 900px)").matches);
          setPanelTab("chat");
        }
      }
    };
    void restore();
    window.addEventListener("popstate", restore);
    return () => {
      current = false;
      window.removeEventListener("popstate", restore);
    };
  }, [user?.id]);
  const [membersView, setMembersView] = useState(false);
  const { panel, setPanel, setPanelPreference } = useWorkspacePanel(
    user?.id,
    view !== "files" && view !== "meetings",
  );
  const chatRead = useChatUnread(workspaceGroup.groupId, user?.id);
  const markChannelRead = useCallback(
    (id: string) => chatRead.markRead(channel, id),
    [channel, chatRead.markRead],
  );
  const markThreadRead = useCallback(
    (threadId: string, id: string) =>
      chatRead.markRead(`thread:${threadId}`, id),
    [chatRead.markRead],
  );
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
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [pendingMessages, setPendingMessages] = useState<ChatMessage[]>([]);
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const members = membersInitial;
  const [files, setFiles] = useState(initialFiles);
  const [filter, setFilter] = useState("Tất cả");
  const [mic, setMic] = useState(false);
  const meetingState =
    roomState?.sessionId === activeMeetingId ? roomState : null;
  const workspaceMic = activeMeetingId
    ? !!meetingState?.media?.micEnabled
    : mic;
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
  const [mobileNav, setMobileNav] = useState(false);
  const [localCustomChannels, setLocalCustomChannels] = useState<string[]>([]);
  const [activeRoomName, setActiveRoomName] = useState("Phòng học nhóm");
  const chatStorageKey = `streamora-chat-v2:${channel}`;
  const legacyChatStorageKey = `streamora-chat:${channel}`;
  const groupChat = useGroupChat(
    workspaceGroup.groupId,
    channel,
    channel !== "hỏi-đáp" ? targetMessageId : undefined,
  );
  const customChannels = workspaceGroup.groupId
    ? groupChat.channels.map((item) => item.name)
    : localCustomChannels;
  const confirmedMessages = useMemo<ChatMessage[]>(
    () =>
      groupChat.messages.map((message) => ({
        id: message.id,
        clientId: message.clientId,
        senderId: message.senderId,
        name: message.senderId === user?.id ? "Bạn" : message.senderName,
        initials: groupInitials(message.senderName),
        color: message.senderId === user?.id ? "violet" : "blue",
        text: message.text,
        time: chatTimeFormat.format(new Date(message.createdAt)),
        createdAt: message.createdAt,
        replyToId: message.replyToId,
        meetingId: message.meetingId,
        editedAt: message.editedAt,
        host: message.senderRole !== "VIEWER",
      })),
    [groupChat.messages, user?.id],
  );
  const messages = useMemo<ChatMessage[]>(() => {
    const confirmedMessageIds = new Set(
      confirmedMessages.map((message) => message.id),
    );
    const confirmedClientIds = new Set(
      confirmedMessages.flatMap((message) =>
        message.clientId ? [message.clientId] : [],
      ),
    );
    const visibleConfirmedMessages = confirmedMessages.filter((message) => {
      if (message.clientId) return true;
      const confirmedAt = Date.parse(message.createdAt ?? "");
      return !pendingMessages.some((pending) => {
        const pendingAt = Date.parse(pending.createdAt ?? "");
        return (
          pending.pending &&
          pending.senderId === message.senderId &&
          pending.text === message.text &&
          (pending.replyToId ?? null) === (message.replyToId ?? null) &&
          Number.isFinite(confirmedAt) &&
          Number.isFinite(pendingAt) &&
          Math.abs(confirmedAt - pendingAt) < 30_000
        );
      });
    });
    return workspaceGroup.groupId
      ? [
          ...visibleConfirmedMessages,
          ...pendingMessages.filter(
            (message) =>
              !confirmedMessageIds.has(message.id) &&
              !confirmedClientIds.has(message.clientId ?? ""),
          ),
        ].sort((left, right) => {
          const leftTime = Date.parse(left.createdAt ?? "");
          const rightTime = Date.parse(right.createdAt ?? "");
          if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime))
            return 0;
          return leftTime - rightTime;
        })
      : localMessages;
  }, [
    confirmedMessages,
    pendingMessages,
    workspaceGroup.groupId,
    localMessages,
  ]);
  const replyingTo = replyingToId
    ? messages.find((message) => message.id === replyingToId)
    : undefined;
  const cameraStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  useEffect(() => {
    if (!activeMeetingId) return;
    micStream.current?.getTracks().forEach((track) => track.stop());
    micStream.current = null;
    setMic(false);
  }, [activeMeetingId]);
  const localVideo = useRef<HTMLVideoElement>(null);
  const screenVideo = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const showMembers =
      new URLSearchParams(location.search).get("tab") === "members";
    setMembersView(showMembers);
    if (view === "chat") setPanelTab("members");
    if (showMembers || channel === "hỏi-đáp") setPanel(false);
    setMobileNav(false);
  }, [view, channel]);
  useEffect(() => {
    setPendingMessages([]);
    setReplyingToId(null);
  }, [workspaceGroup.groupId, channel]);
  useEffect(() => {
    const confirmedIds = new Set(
      groupChat.messages.map((message) => message.id),
    );
    const confirmedClientIds = new Set(
      groupChat.messages.map((message) => message.clientId),
    );
    setPendingMessages((current) => {
      const remaining = current.filter(
        (message) =>
          !confirmedIds.has(message.id ?? "") &&
          !confirmedClientIds.has(message.clientId ?? ""),
      );
      return remaining.length === current.length ? current : remaining;
    });
  }, [groupChat.messages]);
  useEffect(() => {
    setModal(null);
    setRecording(false);
    setPoll(false);
    [cameraStream, screenStream, micStream].forEach((ref) =>
      ref.current?.getTracks().forEach((track) => track.stop()),
    );
    setCamera(false);
    setMic(false);
    setSharing(false);
  }, [workspaceGroup.groupId]);
  useEffect(() => {
    if (
      permissions?.canHost &&
      new URLSearchParams(location.search).get("create") === "1"
    ) {
      setModal("create-meeting");
      const url = new URL(location.href);
      url.searchParams.delete("create");
      history.replaceState(null, "", url);
    }
  }, [workspaceGroup.groupId, permissions?.canHost]);
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
      if (user) setLocalMessages([]);
      else {
        const stored = localStorage.getItem(chatStorageKey);
        if (stored) setLocalMessages(JSON.parse(stored));
        else {
          const legacy = localStorage.getItem(legacyChatStorageKey);
          const legacyMessages = legacy ? JSON.parse(legacy) : [];
          const userMessages = Array.isArray(legacyMessages)
            ? legacyMessages.filter(
                (message): message is ChatMessage => message?.name === "Bạn",
              )
            : [];
          setLocalMessages(userMessages);
          if (userMessages.length)
            localStorage.setItem(chatStorageKey, JSON.stringify(userMessages));
          localStorage.removeItem(legacyChatStorageKey);
        }
      }
      const storedFiles = localStorage.getItem("streamora-files");
      if (storedFiles) setFiles(JSON.parse(storedFiles));
      const storedChannels = localStorage.getItem("streamora-channels");
      if (storedChannels) setLocalCustomChannels(JSON.parse(storedChannels));
      const roomId = location.pathname.split("/").pop() || "";
      setActiveRoomName(sessionStorage.getItem(roomId) || "Phòng học nhóm");
      if (new URLSearchParams(location.search).get("type") === "recordings")
        setFilter("Bản ghi");
      if (matchMedia("(max-width: 900px)").matches) setPanel(false);
    } catch {}
  }, [user?.id, channel, chatStorageKey, legacyChatStorageKey]);
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
  async function toggleMedia(kind: "camera" | "mic" | "screen") {
    if (kind === "mic" && activeMeetingId) {
      if (meetingState?.active && !meetingState.pending)
        await roomRef.current?.toggleMicrophone();
      return;
    }
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
              kind === "camera"
                ? {
                    video: {
                      width: { ideal: 1920, min: 640 },
                      height: { ideal: 1080, min: 480 },
                      frameRate: { ideal: 30, max: 60 },
                      facingMode: "user",
                      aspectRatio: { ideal: 1.7777777778 },
                    },
                  }
                : {
                    audio: {
                      echoCancellation: true,
                      noiseSuppression: true,
                      autoGainControl: true,
                    },
                  },
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
  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    if (workspaceGroup.groupId) {
      const text = draft.trim();
      const replyToId = replyingTo?.id;
      const clientId = crypto.randomUUID();
      const optimisticId = `pending:${clientId}`;
      const optimisticMessage: ChatMessage = {
        id: optimisticId,
        clientId,
        senderId: user?.id,
        name: "Bạn",
        initials: groupInitials(user?.fullName ?? "Bạn"),
        color: "violet",
        text,
        time: new Date().toLocaleTimeString("vi-VN", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        createdAt: new Date().toISOString(),
        replyToId,
        editedAt: null,
        host: Boolean(permissions && permissions.role !== "VIEWER"),
        pending: true,
      };
      setPendingMessages((current) => [...current, optimisticMessage]);
      setDraft("");
      setReplyingToId(null);
      try {
        const id = await groupChat.send(text, replyToId, clientId);
        setPendingMessages((current) =>
          current.map((message) =>
            message.id === optimisticId
              ? { ...message, id, pending: false }
              : message,
          ),
        );
      } catch (error) {
        setPendingMessages((current) =>
          current.filter((message) => message.id !== optimisticId),
        );
        setDraft((current) => current || text);
        if (replyToId) setReplyingToId((current) => current ?? replyToId);
        notify(
          error instanceof Error ? error.message : "Không thể gửi tin nhắn.",
        );
      }
      return;
    }
    if (user) {
      notify("Hãy chọn một nhóm trước khi gửi tin nhắn.");
      return;
    }
    const message: ChatMessage = {
      senderId: "local-user",
      name: "Bạn",
      initials: "BA",
      color: "violet",
      text: draft.trim(),
      time: new Date().toLocaleTimeString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      createdAt: new Date().toISOString(),
    };
    const next = [...localMessages, message];
    setLocalMessages(next);
    localStorage.setItem(chatStorageKey, JSON.stringify(next));
    setDraft("");
  }
  async function editMessage(id: string, text: string) {
    try {
      await groupChat.edit(id, text);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Không thể sửa tin nhắn.",
      );
      throw error;
    }
  }
  async function removeMessage(id: string) {
    try {
      await groupChat.remove(id);
      setPendingMessages((current) =>
        current.filter((message) => message.id !== id),
      );
      if (replyingToId === id) setReplyingToId(null);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Không thể xóa tin nhắn.",
      );
      throw error;
    }
  }
  const inviteUrl =
    typeof location === "undefined"
      ? ""
      : `${location.origin}${selectedMeeting ? `/meet/${selectedMeeting.joinCode}` : view === "room" ? location.pathname : "/workspace"}`;
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
        "Mô phỏng ghi hình đã bật. Ghi hình trên cloud sẽ được tích hợp ở T11.",
      );
    setRecording(!recording);
  }
  const title =
    view === "meetings"
      ? (selectedMeeting?.title ?? "Cuộc họp")
      : view === "live"
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
    const url = new URL(location.href);
    url.searchParams.delete("tab");
    history.replaceState(null, "", url);
    const target = new URL(event.currentTarget.href);
    const chatPath = target.pathname.match(/^\/community(?:\/([^/]+))?\/?$/);
    const filesPath = target.pathname === "/files";
    if (chatPath || filesPath) {
      event.preventDefault();
      if (workspaceGroup.groupId)
        target.searchParams.set("groupId", workspaceGroup.groupId);
      const apply = () => {
        if (chatPath) {
          setNavigation({
            view: "chat",
            channel: decodeURIComponent(chatPath[1] ?? "trò-chuyện-chung"),
          });
          if (activeMeetingId) {
            setMeetingMinimized(true);
            target.searchParams.set("meetingId", activeMeetingId);
          }
        } else {
          setNavigation({ view: "files" });
          setFilter(
            target.searchParams.get("type") === "recordings"
              ? "Bản ghi"
              : "Tất cả",
          );
          setMeetingSelection(null);
          setMeetingMinimized(false);
          setRoomInfo(null);
        }
        // Keep the sidebar mounted while changing the workspace content.
        if (target.href !== location.href) history.pushState(null, "", target);
      };
      if (filesPath && activeMeetingId) void changeWorkspace(apply);
      else apply();
      return;
    }
    if (activeMeetingId) {
      event.preventDefault();
      const href = event.currentTarget.href;
      void changeWorkspace(() => {
        setMeetingSelection(null);
        setMeetingMinimized(false);
        setRoomInfo(null);
        router.push(href);
      });
    }
  }

  const chatProps = {
    onRead: view === "chat" && !membersView ? markChannelRead : undefined,
    historyReady: !workspaceGroup.groupId || groupChat.historyReady,
    latestVersion: groupChat.latestVersion,
    onJumpToLatest: groupChat.loadLatest,
    hasNewer: groupChat.hasNewer,
    loadingNewer: groupChat.loadingNewer,
    loadingTarget: groupChat.loadingTarget,
    onLoadNewer: groupChat.loadNewer,
    targetMessageId,
    hasOlder: groupChat.hasOlder,
    loadingOlder: groupChat.loadingOlder,
    onLoadOlder: groupChat.loadOlder,
    messages,
    draft,
    onDraftChange: setDraft,
    onSubmit: sendMessage,
    currentUserId: user?.id,
    replyingTo,
    onReply: workspaceGroup.groupId
      ? (message: ChatMessage) => setReplyingToId(message.id ?? null)
      : undefined,
    onCancelReply: () => setReplyingToId(null),
    onEdit: workspaceGroup.groupId ? editMessage : undefined,
    onDelete: workspaceGroup.groupId ? removeMessage : undefined,
    onMeetingOpen: workspaceGroup.groupId
      ? (id: string) => void openMeetingById(id)
      : undefined,
    infoText: workspaceGroup.groupId
      ? "Cuộc trò chuyện được lưu trong cộng đồng"
      : user
        ? "Chọn một nhóm để tham gia cuộc trò chuyện"
        : "Bản trải nghiệm được lưu trên thiết bị này",
    disabled: workspaceGroup.groupId
      ? groupChat.status !== "connected"
      : Boolean(user),
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
          {workspaceGroup.groups.map((item) => {
            const hasLive = liveGroupIds.has(item.id);
            return (
              <button
                key={item.id}
                type="button"
                className={`community-icon ${item.id === workspaceGroup.groupId ? "selected" : ""}`}
                title={item.name}
                aria-label={`Mở nhóm ${item.name}`}
                disabled={roomSwitching}
                aria-current={
                  item.id === workspaceGroup.groupId ? "true" : undefined
                }
                onClick={() => {
                  selectWorkspaceGroup(item.id);
                  if (matchMedia("(max-width: 650px)").matches)
                    setMobileNav(true);
                }}
              >
                {groupInitials(item.name)}
                <span
                  className={`group-live-dot ${hasLive ? "has-live" : "no-live"}`}
                  aria-label={
                    hasLive
                      ? "Có phòng họp đang diễn ra"
                      : "Không có phòng họp đang diễn ra"
                  }
                  title={
                    hasLive
                      ? "Có cuộc họp đang diễn ra"
                      : "Không có cuộc họp đang diễn ra"
                  }
                />
              </button>
            );
          })}
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
        <div className="sidebar-scroll">
          <div className="channel-section">
            <div className="section-label">
              <ChevronDown size={12} /> Tổng quan
            </div>
            <button
              className={`channel ${membersView ? "selected" : ""}`}
              onClick={() => {
                if (activeMeetingId) {
                  setPanelPreference(true);
                  setPanelTab("members");
                  return;
                }
                void changeWorkspace(() => {
                  setMeetingSelection(null);
                  setRoomInfo(null);
                  const url = new URL(location.href);
                  url.searchParams.delete("meetingId");
                  url.searchParams.set("tab", "members");
                  history.replaceState(null, "", url);
                  setMembersView(true);
                  setPanel(false);
                  setPanelTab("members");
                  setMobileNav(false);
                });
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
              href={`/community${workspaceGroup.groupId ? `?groupId=${workspaceGroup.groupId}` : ""}`}
              onClick={navigateWorkspace}
              className={`channel ${!membersView && view === "chat" && channel === "trò-chuyện-chung" ? "selected" : ""}`}
            >
              <Hash size={19} /> trò-chuyện-chung{" "}
              {(chatRead.unread["trò-chuyện-chung"] ?? 0) > 0 && (
                <span
                  className="channel-unread-count"
                  aria-label={`${chatRead.unread["trò-chuyện-chung"]} tin nhắn chưa đọc`}
                >
                  {chatRead.unread["trò-chuyện-chung"]}
                </span>
              )}
            </Link>
            <Link
              className={`channel ${channel === "hỏi-đáp" ? "selected" : ""}`}
              href={`/community/${encodeURIComponent("hỏi-đáp")}${workspaceGroup.groupId ? `?groupId=${workspaceGroup.groupId}` : ""}`}
              onClick={navigateWorkspace}
            >
              <Hash size={19} /> hỏi-đáp
              {chatRead.questionsUnread > 0 && (
                <span
                  className="channel-unread-count"
                  aria-label={`${chatRead.questionsUnread} tin nhắn chưa đọc`}
                >
                  {chatRead.questionsUnread}
                </span>
              )}
            </Link>
            <Link
              className={`channel ${!membersView && view === "chat" && channel === "thông-báo" ? "selected" : ""}`}
              href={`/community/${encodeURIComponent("thông-báo")}${workspaceGroup.groupId ? `?groupId=${workspaceGroup.groupId}` : ""}`}
              onClick={navigateWorkspace}
            >
              <Hash size={19} /> thông-báo <Bell size={13} />
            </Link>
          </div>
          <div className="custom-channels">
            {customChannels.map((name) => (
              <Link
                key={name}
                href={`/community/${encodeURIComponent(name)}${workspaceGroup.groupId ? `?groupId=${workspaceGroup.groupId}` : ""}`}
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
              {permissions?.canHost && (
                <button
                  type="button"
                  aria-label="Tạo phòng học"
                  onClick={openMeetingCreation}
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
            <nav
              className="workspace-meeting-channels"
              aria-label="Phòng họp của lớp"
              aria-busy={rooms.loading || roomSwitching}
            >
              {rooms.items.map((room) => {
                const isCurrentActive = activeMeetingId === room.id;
                return (
                  <button
                    key={room.id}
                    type="button"
                    className={`channel workspace-meeting-channel ${!membersView && isCurrentActive ? "selected" : ""}`}
                    aria-current={
                      !membersView && isCurrentActive ? "page" : undefined
                    }
                    disabled={roomSwitching}
                    title={`${room.title} · ${room.status === "LIVE" ? "Đang diễn ra" : "Sắp diễn ra"}`}
                    onClick={() => {
                      if (isCurrentActive) {
                        returnToMeeting();
                        return;
                      }
                      openRoom(room);
                    }}
                  >
                    {room.status === "SCHEDULED" ? (
                      <CalendarDays size={18} />
                    ) : (
                      <Video size={19} />
                    )}
                    <span className="workspace-meeting-name">{room.title}</span>
                    <span
                      className={`workspace-meeting-status ${room.status.toLowerCase()}`}
                    >
                      {isCurrentActive && meetingMinimized
                        ? "Đang kết nối"
                        : room.status === "LIVE"
                          ? "Trực tiếp"
                          : "Đã lên lịch"}
                    </span>
                  </button>
                );
              })}
              {rooms.loading && !rooms.items.length && (
                <span className="workspace-meeting-loading" role="status">
                  Đang tải phòng…
                </span>
              )}
              {!!rooms.error && (
                <button
                  type="button"
                  className="channel"
                  onClick={() => void rooms.refresh()}
                >
                  <RefreshCw size={16} />
                  Tải lại phòng họp
                </button>
              )}
            </nav>
            {!workspaceGroup.groupId && !user && (
              <>
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
              </>
            )}
            {permissions?.canHost && (
              <button
                type="button"
                onClick={openMeetingCreation}
                className={`channel ${!membersView && view === "meet" ? "selected" : ""}`}
              >
                <Video size={19} /> Tạo cuộc họp / Lên lịch <Plus size={14} />
              </button>
            )}
            {workspaceGroup.groupId && (
              <Link
                href={`/groups/${workspaceGroup.groupId}/sessions`}
                className="channel"
                title="Xem toàn bộ lịch học của nhóm"
              >
                <CalendarDays size={18} /> Lịch học của nhóm
              </Link>
            )}
          </div>
          <div className="channel-section">
            <div className="section-label">
              <ChevronDown size={12} /> Thư viện
            </div>
            <Link
              href={`/files${workspaceGroup.groupId ? `?groupId=${workspaceGroup.groupId}` : ""}`}
              onClick={navigateWorkspace}
              className={`channel ${!membersView && view === "files" && filter !== "Bản ghi" ? "selected" : ""}`}
            >
              <Folder size={18} /> Tài liệu chung
            </Link>
            <Link
              href={`/files?type=recordings${workspaceGroup.groupId ? `&groupId=${workspaceGroup.groupId}` : ""}`}
              onClick={navigateWorkspace}
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
          label={workspaceMic ? "Tắt micro" : "Bật micro"}
          active={workspaceMic}
          disabled={
            !!activeMeetingId &&
            (!meetingState?.active ||
              meetingState.pending ||
              meetingState.media?.busy ||
              meetingState.media?.publishLocked ||
              roomSwitching)
          }
          onClick={() => toggleMedia("mic")}
        >
          {workspaceMic ? <Mic size={16} /> : <MicOff size={16} />}
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
                onClick={() => {
                  setMembersView(false);
                  const url = new URL(location.href);
                  url.searchParams.delete("tab");
                  history.replaceState(null, "", url);
                }}
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
                onClick={() => setPanelPreference(!panel)}
              >
                <Users size={18} />
              </IconButton>
            )}
          </div>
        </header>
        <div className="workspace-body">
          {activeMeetingId && meetingMinimized && (
            <ActiveMeetingCard
              title={selectedMeeting?.title ?? "Cuộc họp"}
              leaving={roomSwitching}
              onReturn={returnToMeeting}
              onLeave={returnToChat}
            />
          )}
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
                  revision={groupAccess.membershipRevision}
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
                {activeMeetingId && workspaceGroup.groupId && (
                  <div
                    style={{
                      display:
                        view === "meetings" && !meetingMinimized
                          ? "contents"
                          : "none",
                    }}
                  >
                    <WorkspaceMeetingRoom
                      key={activeMeetingId}
                      ref={roomRef}
                      sessionId={activeMeetingId}
                      groupId={workspaceGroup.groupId}
                      onSession={updateRoom}
                      onExit={returnToChat}
                      onState={reportRoomState}
                      onOpenPeople={() => {
                        setPanelPreference(true);
                        setPanelTab("members");
                      }}
                      onOpenChat={() => {
                        setPanelPreference(true);
                        setPanelTab("chat");
                      }}
                    />
                  </div>
                )}
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
                {view === "files" &&
                  (!user ? (
                    <div className="empty-state">
                      <Folder size={30} />
                      <h3>Thư viện tài liệu của nhóm</h3>
                      <p>Đăng nhập để xem tài liệu và bản ghi của bạn.</p>
                      <Link href="/auth" className="button primary">
                        Đăng nhập
                      </Link>
                    </div>
                  ) : workspaceGroup.loading || groupAccess.loading ? (
                    <LoadingState message="Đang tải thư viện…" />
                  ) : workspaceGroup.error ? (
                    <RequestError
                      error={workspaceGroup.error}
                      onRetry={() => void workspaceGroup.reload()}
                    />
                  ) : !workspaceGroup.groupId ? (
                    <div className="empty-state">
                      <Folder size={30} />
                      <h3>Chưa có nhóm học tập</h3>
                      <p>Tạo hoặc tham gia nhóm để xem tài liệu và bản ghi.</p>
                      <Link href="/groups" className="button primary">
                        Nhóm học tập
                      </Link>
                    </div>
                  ) : groupAccess.error ? (
                    <RequestError
                      error={groupAccess.error}
                      onRetry={() => void groupAccess.refresh()}
                    />
                  ) : permissions ? (
                    <FilesPanel
                      key={`${user.id}:${workspaceGroup.groupId}:${permissions.role}:${groupAccess.membershipRevision}`}
                      groupId={workspaceGroup.groupId}
                      userId={user.id}
                      permissions={permissions}
                      filter={filter}
                      onFilterChange={setFilter}
                    />
                  ) : null)}
                {view === "chat" &&
                  channel === "hỏi-đáp" &&
                  workspaceGroup.groupId && (
                    <WorkspaceThreads
                      key={workspaceGroup.groupId}
                      groupId={workspaceGroup.groupId}
                      targetMessageId={targetMessageId}
                      targetThreadId={targetThreadId}
                      userId={user?.id}
                      unread={chatRead.unread}
                      threadActivity={chatRead.threadActivity}
                      onRead={markThreadRead}
                    />
                  )}
                {view === "chat" &&
                  !(channel === "hỏi-đáp" && workspaceGroup.groupId) && (
                    <div className="community-chat">
                      <WorkspaceChat
                        key={`${workspaceGroup.groupId}:${channel}`}
                        {...chatProps}
                        welcome={
                          <div className="chat-welcome">
                            <div className="card-icon">
                              <Hash size={30} />
                            </div>
                            <h2>Mỗi kết nối bắt đầu bằng lời chào.</h2>
                            <p>
                              Chào mừng đến với <b>#{title}</b> của {group}.
                              <br />
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
                          <div
                            className={`avatar-speaking-wrapper ${
                              mic ? "speaking" : ""
                            }`}
                          >
                            {mic && (
                              <div
                                className="audio-sound-waves"
                                aria-hidden="true"
                              >
                                <span className="sound-wave wave-1" />
                                <span className="sound-wave wave-2" />
                                <span className="sound-wave wave-3" />
                              </div>
                            )}
                            <Avatar initials="BA" />
                          </div>
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
              {view !== "chat" && (
                <div className="panel-tabs">
                  <button
                    className={panelTab === "chat" ? "selected" : ""}
                    onClick={() => setPanelTab("chat")}
                  >
                    {view === "meetings" ? "Chat cuộc họp" : "Trò chuyện"}{" "}
                    {view !== "meetings" && <span>{messages.length}</span>}
                  </button>
                  <button
                    className={panelTab === "members" ? "selected" : ""}
                    onClick={() => setPanelTab("members")}
                  >
                    Thành viên
                  </button>
                  <IconButton
                    label="Đóng bảng bên"
                    onClick={() => setPanelPreference(false)}
                  >
                    <X size={16} />
                  </IconButton>
                </div>
              )}
              {view === "meetings" && activeMeetingId && panelTab === "chat" ? (
                <MeetingChatSidePanel
                  key={activeMeetingId}
                  sessionId={activeMeetingId}
                  participationId={roomState?.participationId ?? null}
                  canManage={!!roomState?.canManage}
                  canChat={roomState?.active || !!roomState?.canManage}
                  userId={roomState?.userId ?? user?.id}
                />
              ) : view !== "chat" && panelTab === "chat" ? (
                <WorkspaceChat
                  key={`${workspaceGroup.groupId}:${channel}`}
                  {...chatProps}
                />
              ) : view === "meetings" && activeMeetingId ? (
                roomState?.sessionId === activeMeetingId ? (
                  <MeetingPeoplePanel
                    state={roomState}
                    decide={(requestId, decision) =>
                      roomRef.current?.decide(requestId, decision) ??
                      Promise.resolve()
                    }
                  />
                ) : (
                  <LoadingState message="Đang tải người tham gia…" />
                )
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
                  revision={groupAccess.membershipRevision}
                  onClose={
                    view === "chat"
                      ? () => setPanelPreference(false)
                      : undefined
                  }
                />
              ) : null}
            </aside>
          )}
        </div>
      </div>
      {modal === "create-meeting" &&
        workspaceGroup.groupId &&
        permissions?.canHost && (
          <CreateGroupMeeting
            key={`${user?.id}:${workspaceGroup.groupId}`}
            groupId={workspaceGroup.groupId}
            groupName={group}
            onClose={() => setModal(null)}
            onCreated={(room) => {
              rooms.update(room);
              openRoom(room);
            }}
          />
        )}
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
      {modal &&
        modal !== "groups" &&
        modal !== "meet" &&
        modal !== "create-meeting" && (
          <div className="modal-backdrop" onClick={() => setModal(null)}>
            <section
              role="dialog"
              aria-modal="true"
              aria-label="Hộp thao tác"
              className={`modal ${modal === "search" ? "space-search-dialog" : ""}`}
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
                  <p>
                    {selectedMeeting
                      ? selectedMeeting.allowGuests
                        ? "Gửi liên kết cuộc họp. Khách cần đăng nhập và được chủ phòng duyệt."
                        : "Liên kết cuộc họp này chỉ dành cho thành viên trong Group."
                      : "Gửi liên kết này để mời mọi người vào không gian học tập."}
                  </p>
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
                  onSubmit={async (e) => {
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
                  <p className="space-search-description">
                    Tin nhắn và tài liệu, ngay trong tầm tay.
                  </p>
                  <div className="input-icon">
                    <Search size={18} />
                    <input
                      autoFocus
                      aria-label="Tìm trong không gian"
                      placeholder="Tìm tài liệu, cuộc trò chuyện…"
                      maxLength={100}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  {workspaceGroup.groupId && (
                    <WorkspaceSearch
                      groupId={workspaceGroup.groupId}
                      query={search}
                      onNavigate={() => setModal(null)}
                    />
                  )}
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
                        {!workspaceGroup.groupId &&
                          messages
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
                        {!workspaceGroup.groupId &&
                          !files.some((f) =>
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
                      !workspaceGroup.groupId && (
                        <p>Nhập từ khóa để tìm trong không gian.</p>
                      )
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
                    Áp dụng khi bắt đầu chia sẻ lần tiếp theo. Trình duyệt có
                    thể điều chỉnh theo thiết bị.
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
                    Camera, micro và chia sẻ màn hình sử dụng quyền thiết bị
                    thật và chỉ hiển thị cục bộ. Cuộc gọi nhiều người, ghi hình,
                    lưu tệp đang ở chế độ minh họa. Mục Thành viên sử dụng tài
                    khoản, nhóm và phân quyền thật.
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
                  onSubmit={async (e) => {
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
                      ["trò-chuyện-chung", "hỏi-đáp", "thông-báo"].includes(
                        name,
                      )
                    ) {
                      notify("Tên kênh đã tồn tại.");
                      return;
                    }
                    if (workspaceGroup.groupId) {
                      try {
                        await groupChat.createChannel(name);
                      } catch (error) {
                        notify(
                          error instanceof Error
                            ? error.message
                            : "Không thể tạo kênh.",
                        );
                        return;
                      }
                    } else {
                      const next = [...localCustomChannels, name];
                      setLocalCustomChannels(next);
                      localStorage.setItem(
                        "streamora-channels",
                        JSON.stringify(next),
                      );
                    }
                    location.href = `/community/${encodeURIComponent(name)}`;
                  }}
                >
                  <div className="card-icon">
                    <Hash />
                  </div>
                  <h2>Thêm một cuộc trò chuyện.</h2>
                  <p>
                    {workspaceGroup.groupId
                      ? "Kênh sẽ hiển thị cho mọi thành viên trong nhóm."
                      : "Kênh được lưu riêng trên trình duyệt này."}
                  </p>
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
                    Đây là mục tài liệu minh họa. Nội dung tệp chưa được lưu
                    trên máy chủ nên chưa thể tải xuống hoặc phát bản ghi.
                  </p>
                  <p>
                    Khi tích hợp thư viện thật, mục này sẽ mở tài liệu hoặc
                    trình phát bản ghi của cộng đồng.
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
      {/* Confirm room switch dialog */}
      {pendingRoomSwitch && (
        <div
          className="modal-backdrop"
          onClick={() => setPendingRoomSwitch(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="room-switch-dialog-title"
            className="modal room-switch-confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="room-switch-dialog-title">Rời phòng họp hiện tại?</h2>
            <p>
              Bạn đang trong phòng{" "}
              <strong>
                &ldquo;{selectedMeeting?.title ?? "phòng họp"}&rdquo;
              </strong>
              . Chuyển sang{" "}
              <strong>&ldquo;{pendingRoomSwitch.title}&rdquo;</strong> sẽ tự
              động rời phòng hiện tại.
            </p>
            <div className="room-switch-actions">
              <button
                className="button secondary"
                onClick={() => setPendingRoomSwitch(null)}
              >
                Ở lại
              </button>
              <button
                className="button danger"
                onClick={confirmRoomSwitch}
                disabled={roomSwitching}
              >
                <PhoneOff size={15} /> Rời và tham gia
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
