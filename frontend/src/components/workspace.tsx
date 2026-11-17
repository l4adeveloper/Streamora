"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  CalendarDays,
  Copy,
  Folder,
  Hash,
  LoaderCircle,
  Link2,
  Menu,
  Mic,
  MicOff,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  Video,
  Waves,
  X,
  PhoneOff,
  ExternalLink,
} from "lucide-react";

import { Brand, Avatar, IconButton } from "./ui";
import { SessionIdentity } from "./shell/account-link";
import { ThemeToggle } from "./shell/theme-toggle";
import { useToast } from "./common/toast-provider";
import { useAuth } from "./auth/auth-provider";
import { RequireSession } from "./auth/require-session";
import { AccountDialog } from "./auth/account-dialog";
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
import {
  MeetingsDashboardSidebar,
  MeetingsDashboardContent,
  type DashboardMeeting,
  type DashboardFilter,
} from "./class-sessions/meetings-dashboard";
import type { ClassSession, User } from "@streamora/contracts";
import { useWorkspaceMeetings } from "@/lib/class-sessions/use-workspace-meetings";
import { getClassSession, listClassSessions } from "@/lib/class-sessions/api";
import { useWorkspaceGroup } from "@/lib/memberships/use-workspace-group";
import { useGroupPermissions } from "@/lib/memberships/use-group-permissions";
import { useGroupChat } from "@/lib/memberships/use-group-chat";
import { useWorkspacePanel } from "@/lib/memberships/use-workspace-panel";
import { useChatUnread } from "@/lib/memberships/use-chat-unread";

import { WorkspaceChat } from "./workspace-chat";
import { WorkspaceThreads } from "./workspace-threads";
import { WorkspaceSearch } from "./workspace-search";
import { FilesPanel } from "./files/files-panel";
import type { ChatMessage } from "./workspace-chat.types";
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
type View = "meetings" | "files" | "chat" | "dashboard";

type WorkspaceProps = {
  view: View;
  channel?: string;
  targetMessageId?: string;
  targetThreadId?: string;
};

export function Workspace(props: WorkspaceProps) {
  return (
    <RequireSession preserveDestination>
      <SignedInWorkspace {...props} />
    </RequireSession>
  );
}

function SignedInWorkspace(props: WorkspaceProps) {
  const { user } = useAuth();
  return user ? <WorkspaceContent {...props} user={user} /> : null;
}

function WorkspaceContent({
  view: baseView,
  channel: routeChannel = "trò-chuyện-chung",
  targetMessageId: routeMessageId,
  targetThreadId: routeThreadId,
  user,
}: WorkspaceProps & { user: User }) {
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
  const [dashboardMode, setDashboardMode] = useState(baseView === "dashboard");
  const [dashboardMeetings, setDashboardMeetings] = useState<DashboardMeeting[]>([]);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardFilter, setDashboardFilter] = useState<DashboardFilter>("ALL");
  const [dashboardSearch, setDashboardSearch] = useState("");
  const [dashboardError, setDashboardError] = useState("");
  const dashboardRequest = useRef(0);

  useEffect(() => {
    const url = new URL(location.href);
    if (
      url.searchParams.get("view") === "dashboard" ||
      url.pathname === "/dashboard" ||
      baseView === "dashboard"
    ) {
      setDashboardMode(true);
    }
  }, [baseView]);

  useEffect(() => {
    setNavigation(null);
    const restore = () => {
      const url = new URL(location.href);
      const isDashboard =
        url.searchParams.get("view") === "dashboard" ||
        url.pathname === "/dashboard";
      setDashboardMode(isDashboard);
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
    if (!workspaceGroup.groups.length) return;
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
  }, [user.id, workspaceGroup.groups, workspaceGroup.groupId]);

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
    if (!workspaceGroup.groupId) return;
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
  }, [rooms.items, workspaceGroup.groupId, user.id]);

  const loadDashboardMeetings = useCallback(async () => {
    const request = ++dashboardRequest.current;
    if (!workspaceGroup.groups.length) {
      setDashboardMeetings((current) => (current.length ? [] : current));
      setDashboardLoading(false);
      setDashboardError("");
      return;
    }
    setDashboardLoading(true);
    setDashboardError("");
    try {
      // Fetch each active status separately so old history cannot hide a room
      // behind the first page of results. Include every page of scheduled rooms.
      const results = await Promise.all(
        workspaceGroup.groups.flatMap((group) =>
          (["LIVE", "SCHEDULED"] as const).map(async (status) => {
            const items: DashboardMeeting[] = [];
            let cursor: string | undefined;
            do {
              const page = await listClassSessions(group.id, cursor, status);
              if (request !== dashboardRequest.current) return [];
              items.push(
                ...page.items
                  .filter((item) => item.groupId === group.id && item.status === status)
                  .map((item) => ({ ...item, groupName: group.name })),
              );
              cursor = page.nextCursor ?? undefined;
            } while (cursor);
            return items;
          }),
        ),
      );
      if (request !== dashboardRequest.current) return;
      const map = new Map<string, DashboardMeeting>();
      for (const list of results) {
        for (const item of list) {
          map.set(item.id, item);
        }
      }
      const combined = Array.from(map.values());
      setDashboardMeetings(combined);
      setLiveGroupIds(new Set(
        combined.filter((item) => item.status === "LIVE" && item.groupId)
          .map((item) => item.groupId!),
      ));
    } catch {
      if (request === dashboardRequest.current)
        setDashboardError(
          "Chưa thể cập nhật cuộc họp. Vui lòng bấm Làm mới để thử lại.",
        );
    } finally {
      if (request === dashboardRequest.current) setDashboardLoading(false);
    }
  }, [workspaceGroup.groups, user.id]);

  useEffect(() => {
    if (dashboardMode) {
      void loadDashboardMeetings();
      const interval = setInterval(loadDashboardMeetings, 10000);
      window.addEventListener("streamora:meetings-changed", loadDashboardMeetings);
      return () => {
        dashboardRequest.current++;
        clearInterval(interval);
        window.removeEventListener(
          "streamora:meetings-changed",
          loadDashboardMeetings,
        );
      };
    }
  }, [dashboardMode, loadDashboardMeetings]);

  const roomRef = useRef<SessionRoomHandle>(null);
  const [roomState, setRoomState] = useState<MeetingRoomState | null>(null);
  const reportRoomState = useCallback((state: MeetingRoomState) => {
    if (selectionRef.current?.id === state.sessionId) setRoomState(state);
  }, []);
  const workspaceScope = useRef("");
  workspaceScope.current = `${user.id}:${workspaceGroup.groupId ?? ""}`;
  const switching = useRef(false);
  const [roomSwitching, setRoomSwitching] = useState(false);
  const view: View = dashboardMode
    ? "dashboard"
    : activeMeetingId
      ? meetingMinimized
        ? "chat"
        : "meetings"
      : (navigation?.view ??
        (baseView === "dashboard" || baseView === "meetings"
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
    setDashboardMode(false);
    setMeetingMinimized(false);
    const url = new URL(location.href);
    url.pathname = "/workspace";
    url.searchParams.delete("view");
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
      setDashboardMode(false);
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
      setDashboardMode(false);
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
      url.searchParams.delete("view");
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
      if (session.groupId && session.groupId !== workspaceGroup.groupId) {
        workspaceGroup.selectGroup(session.groupId);
      }
      setDashboardMode(false);
      setMeetingSelection({ id: session.id, groupId: session.groupId! });
      setMeetingMinimized(false);
      setRoomInfo(session);
      setMembersView(false);
      setMobileNav(false);
      setModal(null);
      setPanel(!matchMedia("(max-width: 900px)").matches);
      setPanelTab("chat");
      const url = new URL(location.href);
      url.pathname = "/workspace";
      url.searchParams.set("meetingId", session.id);
      url.searchParams.set("groupId", session.groupId!);
      url.searchParams.delete("view");
      url.searchParams.delete("create");
      url.searchParams.delete("tab");
      history.pushState(null, "", url);
    });
  }

  function openDashboardMode() {
    if (activeMeetingId) {
      setMeetingMinimized(true);
    }
    setDashboardMode(true);
    setMembersView(false);
    setMobileNav(false);
    const url = new URL(location.href);
    url.searchParams.set("view", "dashboard");
    history.pushState(null, "", url);
  }

  const handleJoinDashboardMeeting = useCallback(
    async (session: DashboardMeeting) => {
      if (!session.groupId) {
        router.push(`/meet/${session.joinCode}`);
        return;
      }

      if (activeMeetingId === session.id) {
        returnToMeeting();
        return;
      }

      if (activeMeetingId) {
        setPendingRoomSwitch(session);
        return;
      }

      void changeWorkspace(() => {
        if (session.groupId !== workspaceGroup.groupId)
          workspaceGroup.selectGroup(session.groupId!);
        setDashboardMode(false);
        setMembersView(false);
        setMobileNav(false);
        setMeetingSelection({ id: session.id, groupId: session.groupId! });
        setMeetingMinimized(false);
        setRoomInfo(session);
        setModal(null);
        setPanel(!matchMedia("(max-width: 900px)").matches);
        setPanelTab("chat");
        const url = new URL(location.href);
        url.pathname = "/workspace";
        url.searchParams.set("groupId", session.groupId!);
        url.searchParams.set("meetingId", session.id);
        url.searchParams.delete("view");
        url.searchParams.delete("create");
        url.searchParams.delete("tab");
        history.pushState(null, "", url);
      });
    },
    [
      activeMeetingId,
      changeWorkspace,
      returnToMeeting,
      router,
      workspaceGroup,
    ],
  );
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
        setMeetingMinimized(!!id && (!!chatPath || location.pathname === "/files"));
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
  }, [user.id]);
  const [membersView, setMembersView] = useState(false);
  const { panel, setPanel, setPanelPreference } = useWorkspacePanel(
    user.id,
    view !== "files" && view !== "meetings",
  );
  const chatRead = useChatUnread(workspaceGroup.groupId, user.id);
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
    (workspaceGroup.loading
      ? "Đang tải nhóm…"
      : workspaceGroup.error
        ? "Chưa tải được nhóm"
        : "Chưa có nhóm học tập");
  const [pendingMessages, setPendingMessages] = useState<ChatMessage[]>([]);
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("Tất cả");
  const [mic, setMic] = useState(false);
  const meetingState =
    roomState?.sessionId === activeMeetingId ? roomState : null;
  const workspaceMic = activeMeetingId
    ? !!meetingState?.media?.micEnabled
    : mic;
  const [mobileNav, setMobileNav] = useState(false);
  const groupChat = useGroupChat(
    workspaceGroup.groupId,
    channel,
    channel !== "hỏi-đáp" ? targetMessageId : undefined,
  );
  const customChannels = groupChat.channels.map((item) => item.name);
  const confirmedMessages = useMemo<ChatMessage[]>(
    () =>
      groupChat.messages.map((message) => ({
        id: message.id,
        clientId: message.clientId,
        senderId: message.senderId,
        name: message.senderId === user.id ? "Bạn" : message.senderName,
        initials: groupInitials(message.senderName),
        color: message.senderId === user.id ? "violet" : "blue",
        text: message.text,
        time: chatTimeFormat.format(new Date(message.createdAt)),
        createdAt: message.createdAt,
        replyToId: message.replyToId,
        meetingId: message.meetingId,
        editedAt: message.editedAt,
        host: message.senderRole !== "VIEWER",
      })),
    [groupChat.messages, user.id],
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
      : [];
  }, [
    confirmedMessages,
    pendingMessages,
    workspaceGroup.groupId,
  ]);
  const replyingTo = replyingToId
    ? messages.find((message) => message.id === replyingToId)
    : undefined;
  const micStream = useRef<MediaStream | null>(null);
  useEffect(() => {
    if (!activeMeetingId) return;
    micStream.current?.getTracks().forEach((track) => track.stop());
    micStream.current = null;
    setMic(false);
  }, [activeMeetingId]);
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
    micStream.current?.getTracks().forEach((track) => track.stop());
    setMic(false);
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
    if (!workspaceGroup.groupId || groupAccess.loading || permissions) return;
    micStream.current?.getTracks().forEach((track) => track.stop());
    setMic(false);
    setModal(null);
  }, [workspaceGroup.groupId, permissions, groupAccess.loading]);
  useEffect(() => {
    const type = new URLSearchParams(location.search).get("type");
    setFilter(type === "recordings" ? "Bản ghi" : "Tất cả");
    if (matchMedia("(max-width: 900px)").matches) setPanel(false);
  }, [channel, user.id]);
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
      // Native dialogs own focus and Escape while open above Workspace modals.
      if (document.querySelector("dialog[open]")) return;
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
      micStream.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );
  async function toggleMicrophone() {
    if (activeMeetingId) {
      if (meetingState?.active && !meetingState.pending)
        await roomRef.current?.toggleMicrophone();
      return;
    }
    if (workspaceGroup.groupId && !permissions) return;
    if (mic) {
      micStream.current?.getTracks().forEach((track) => track.stop());
      setMic(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStream.current = stream;
      setMic(true);
      stream.getTracks().forEach((track) => (track.onended = () => setMic(false)));
    } catch {
      notify("Chưa thể truy cập micro. Hãy kiểm tra quyền thiết bị.");
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
        senderId: user.id,
        name: "Bạn",
        initials: groupInitials(user.fullName),
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
    notify("Hãy chọn một nhóm trước khi gửi tin nhắn.");
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
      : `${location.origin}${selectedMeeting ? `/meet/${selectedMeeting.joinCode}` : "/workspace"}`;
  async function copyInvite() {
    const url = inviteUrl;
    try {
      await navigator.clipboard.writeText(url);
      notify("Đã sao chép liên kết mời.");
    } catch {
      notify("Bạn có thể sao chép liên kết trong hộp mời thành viên.");
    }
  }
  const title =
    view === "meetings"
      ? (selectedMeeting?.title ?? "Cuộc họp")
      : view === "files"
        ? "Tài liệu chung"
        : channel;
  const currentSection = dashboardMode
    ? "Dashboard cuộc họp"
    : membersView
      ? "Thành viên"
      : view === "chat"
        ? channel.replaceAll("-", " ")
        : view === "files" && filter === "Bản ghi"
          ? "Bản ghi bài giảng"
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
        } else {
          setNavigation({ view: "files" });
          setFilter(
            target.searchParams.get("type") === "recordings"
              ? "Bản ghi"
              : "Tất cả",
          );
        }
        if (activeMeetingId) {
          // Browsing the workspace must not leave or remount the active meeting.
          setMeetingMinimized(true);
          target.searchParams.set("meetingId", activeMeetingId);
        }
        // Keep the sidebar mounted while changing the workspace content.
        if (target.href !== location.href) history.pushState(null, "", target);
      };
      apply();
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
    currentUserId: user.id,
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
      : "Chọn một nhóm để tham gia cuộc trò chuyện",
    disabled: !workspaceGroup.groupId || groupChat.status !== "connected",
  };

  return (
    <div className={`app-shell ${mobileNav ? "nav-open" : ""}`}>
      <div className="workspace-navigation">
      <aside className="community-rail" aria-label="Không gian và nhóm học tập">
        <div className="brand-rail-item">
          <button
            type="button"
            className={`brand brand-small brand-mark-btn ${dashboardMode ? "selected" : ""}`}
            title="Cuộc họp"
            aria-label="Mở danh sách cuộc họp"
            aria-current={dashboardMode ? "true" : undefined}
            onClick={() => {
              if (dashboardMode) {
                void loadDashboardMeetings();
              } else {
                openDashboardMode();
              }
            }}
          >
            <span className="brand-mark">
              <Waves size={25} strokeWidth={2} />
            </span>
          </button>
        </div>
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
            const isSelected = !dashboardMode && item.id === workspaceGroup.groupId;
            return (
              <button
                key={item.id}
                type="button"
                className={`community-icon ${isSelected ? "selected" : ""}`}
                title={item.name}
                aria-label={`Mở nhóm ${item.name}`}
                disabled={roomSwitching}
                aria-current={
                  isSelected ? "true" : undefined
                }
                onClick={() => {
                  setDashboardMode(false);
                  const url = new URL(location.href);
                  url.searchParams.delete("view");
                  history.pushState(null, "", url);
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
            {!workspaceGroup.loading &&
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
      {dashboardMode ? (
        <MeetingsDashboardSidebar
          meetings={dashboardMeetings}
          filter={dashboardFilter}
          onFilterChange={(filter) => {
            setDashboardFilter(filter);
            setMobileNav(false);
          }}
        />
      ) : (
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
                {workspaceGroup.groupId && (
                  <button title="Thêm kênh" onClick={() => setModal("channel")}>
                    <Plus size={14} />
                  </button>
                )}
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
                      <span className="workspace-meeting-name">
                        {room.title}
                      </span>
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
              {permissions?.canHost && (
                <button
                  type="button"
                  onClick={openMeetingCreation}
                  className="channel"
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
      )}
      </div>
      <div className="sidebar-user workspace-identity">
        <button
          type="button"
          className="workspace-account"
          title={`Tài khoản của ${user.fullName}`}
          aria-label={`Tài khoản của ${user.fullName}`}
          aria-haspopup="dialog"
          onClick={() => setModal("account")}
        >
          <SessionIdentity />
        </button>
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
          onClick={toggleMicrophone}
        >
          {workspaceMic ? <Mic size={16} /> : <MicOff size={16} />}
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
            {dashboardMode ? (
              <>
                <span title="Streamora">Streamora</span>
                <ChevronRight size={14} />
                <h1 aria-current="page" title="Cuộc họp">
                  Cuộc họp
                </h1>
              </>
            ) : (
              <>
                <span title={group}>{group}</span>
                <ChevronRight size={14} />
                <h1 aria-current="page" title={currentSection}>
                  {currentSection}
                </h1>
              </>
            )}
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
            {dashboardMode ? (
              <button
                type="button"
                className="button primary compact"
                onClick={() => setModal("meet")}
              >
                <Plus size={16} />
                <span>Cuộc họp mới</span>
              </button>
            ) : membersView ? (
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
            ) : (
              <>
                <button
                  className="button secondary workspace-invite"
                  aria-label="Mời tham gia"
                  title="Mời tham gia"
                  onClick={() => setModal("invite")}
                >
                  <Link2 size={18} />
                  <span>Mời tham gia</span>
                </button>
                <IconButton
                  label={panel ? "Đóng bảng bên" : "Mở trò chuyện và thành viên"}
                  active={panel}
                  onClick={() => setPanelPreference(!panel)}
                >
                  <Users size={18} />
                </IconButton>
              </>
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
          {dashboardMode ? (
            <main className="main-content view-dashboard">
              <MeetingsDashboardContent
                meetings={dashboardMeetings}
                filter={dashboardFilter}
                search={dashboardSearch}
                onSearchChange={setDashboardSearch}
                onJoinMeeting={(session) => {
                  void handleJoinDashboardMeeting(session);
                }}
                onRefresh={() => {
                  void loadDashboardMeetings();
                }}
                loading={dashboardLoading || workspaceGroup.loading}
                error={dashboardError}
              />
            </main>
          ) : (
            <main
              className={`main-content view-${view} ${membersView ? "membership-main" : ""}`}
            >
            {membersView ? (
              workspaceGroup.loading ? (
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
                    className={
                      view === "meetings" && !meetingMinimized
                        ? "workspace-meeting-frame active"
                        : "workspace-meeting-frame hidden"
                    }
                    style={{
                      display:
                        view === "meetings" && !meetingMinimized
                          ? "flex"
                          : "none",
                      flexDirection: "column",
                      flex: 1,
                      minHeight: 0,
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
                {view === "files" &&
                  (workspaceGroup.loading || groupAccess.loading ? (
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
                  !workspaceGroup.groupId &&
                  (workspaceGroup.loading ? (
                    <LoadingState message="Đang tải nhóm học tập…" />
                  ) : workspaceGroup.error ? (
                    <RequestError
                      error={workspaceGroup.error}
                      onRetry={workspaceGroup.reload}
                    />
                  ) : (
                    <NoGroupSelected />
                  ))}
                {view === "chat" &&
                  channel === "hỏi-đáp" &&
                  workspaceGroup.groupId && (
                    <WorkspaceThreads
                      key={workspaceGroup.groupId}
                      groupId={workspaceGroup.groupId}
                      targetMessageId={targetMessageId}
                      targetThreadId={targetThreadId}
                      userId={user.id}
                      canManageThreads={
                        groupAccess.permissions?.canManageMembers ?? false
                      }
                      unread={chatRead.unread}
                      threadActivity={chatRead.threadActivity}
                      onRead={markThreadRead}
                    />
                  )}
                {view === "chat" &&
                  workspaceGroup.groupId &&
                  channel !== "hỏi-đáp" && (
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
              </>
            )}
          </main>
          )}
          {panel && !membersView && !dashboardMode && (
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
                  userId={roomState?.userId ?? user.id}
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
            key={`${user.id}:${workspaceGroup.groupId}`}
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
      {modal === "account" && <AccountDialog onClose={() => setModal(null)} />}
      {modal &&
        modal !== "account" &&
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
                  {!workspaceGroup.groupId && (
                    <p>Chọn một nhóm để tìm tin nhắn và tài liệu.</p>
                  )}
                </>
              )}
              {modal === "notifications" && (
                <>
                  <div className="card-icon">
                    <Bell />
                  </div>
                  <h2>Thông báo của bạn</h2>
                  <p>Không có thông báo mới.</p>
                </>
              )}
              {modal === "help" && (
                <>
                  <div className="card-icon">
                    <Clock3 />
                  </div>
                  <h2>Học theo nhịp của bạn.</h2>
                  <p>
                    Chọn nhóm học tập để trò chuyện, tham gia cuộc họp và xem tài liệu.
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
                  <p>Vai trò trong nhóm học tập</p>
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
                    if (!workspaceGroup.groupId) return;
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
                    location.href = `/community/${encodeURIComponent(name)}`;
                  }}
                >
                  <div className="card-icon">
                    <Hash />
                  </div>
                  <h2>Thêm một cuộc trò chuyện.</h2>
                  <p>Kênh sẽ hiển thị cho mọi thành viên trong nhóm.</p>
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
