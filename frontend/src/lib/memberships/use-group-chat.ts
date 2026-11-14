"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type {
  GroupChatActionAck,
  GroupChatChannel,
  GroupChatChannelAck,
  GroupChatDeleted,
  GroupChatJoinAck,
  GroupChatMessage,
  GroupChatSendAck,
} from "@streamora/contracts";
import { apiRequest } from "@/lib/api";
import type { CursorPage } from "@streamora/contracts";
import { authSession } from "@/lib/auth/session";
import { connectClassroom } from "@/lib/realtime";

export type GroupChatStatus = "idle" | "connecting" | "connected" | "error";

function isMessage(value: unknown): value is GroupChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<GroupChatMessage>;
  return (
    typeof message.id === "string" &&
    (message.clientId === undefined ||
      message.clientId === null ||
      typeof message.clientId === "string") &&
    typeof message.groupId === "string" &&
    typeof message.senderId === "string" &&
    typeof message.senderName === "string" &&
    typeof message.senderRole === "string" &&
    typeof message.channel === "string" &&
    typeof message.text === "string" &&
    (message.replyToId === undefined ||
      message.replyToId === null ||
      typeof message.replyToId === "string") &&
    typeof message.createdAt === "string" &&
    (message.editedAt === undefined ||
      message.editedAt === null ||
      typeof message.editedAt === "string")
  );
}

function isDeleted(value: unknown): value is GroupChatDeleted {
  if (!value || typeof value !== "object") return false;
  const deleted = value as Partial<GroupChatDeleted>;
  return (
    typeof deleted.id === "string" &&
    typeof deleted.groupId === "string" &&
    typeof deleted.channel === "string"
  );
}

function isChannel(value: unknown): value is GroupChatChannel {
  if (!value || typeof value !== "object") return false;
  const channel = value as Partial<GroupChatChannel>;
  return (
    typeof channel.id === "string" &&
    typeof channel.groupId === "string" &&
    typeof channel.name === "string" &&
    typeof channel.createdById === "string" &&
    typeof channel.createdAt === "string"
  );
}

function mergeChannels(
  current: GroupChatChannel[],
  incoming: GroupChatChannel[],
) {
  const byId = new Map(current.map((channel) => [channel.id, channel]));
  for (const channel of incoming) byId.set(channel.id, channel);
  return [...byId.values()].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function mergeMessages(
  current: GroupChatMessage[],
  incoming: GroupChatMessage[],
) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export function useGroupChat(
  groupId: string | null,
  channel: string,
  targetMessageId?: string,
) {
  const [messages, setMessages] = useState<GroupChatMessage[]>([]);
  const [channelList, setChannelList] = useState<{
    groupId: string | null;
    items: GroupChatChannel[];
  }>({ groupId, items: [] });
  const [status, setStatus] = useState<GroupChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [newerCursor, setNewerCursor] = useState<string | null>(null);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [loadingTarget, setLoadingTarget] = useState(false);
  const [latestVersion, setLatestVersion] = useState(0);
  const newerInFlight = useRef(false);
  const windowRevision = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const newerCursorRef = useRef(newerCursor);
  newerCursorRef.current = newerCursor;
  const context = useRef({ groupId, channel });
  if (
    context.current.groupId !== groupId ||
    context.current.channel !== channel
  )
    context.current = { groupId, channel };
  const olderInFlight = useRef(false);
  const historyContext = useRef<typeof context.current | null>(null);
  const retryIds = useRef(new Map<string, string>());
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    historyContext.current = null;
    windowRevision.current++;
    setNewerCursor(null);
    setLoadingNewer(false);
    setLoadingTarget(false);
    newerInFlight.current = false;
    const joinedContext = context.current;
    retryIds.current.clear();
    setMessages([]);
    setNextCursor(null);
    setLoadingOlder(false);
    olderInFlight.current = false;
    setChannelList((current) =>
      current.groupId === groupId ? current : { groupId, items: [] },
    );
    setError(null);
    if (!groupId) {
      setStatus("idle");
      return;
    }

    let active = true;
    setStatus("connecting");
    const socket = connectClassroom();
    socketRef.current = socket;
    const meetingsChanged = (value: { groupId?: string }) => {
      if (active && value?.groupId === groupId)
        window.dispatchEvent(
          new CustomEvent("streamora:meetings-changed", {
            detail: { groupId },
          }),
        );
    };
    socket.on("meeting.created", meetingsChanged);
    socket.on("meeting.updated", meetingsChanged);

    const receive = (value: unknown) => {
      if (
        !active ||
        !isMessage(value) ||
        value.groupId !== groupId ||
        value.channel !== channel
      )
        return;
      setMessages((current) =>
        newerCursorRef.current && !current.some((item) => item.id === value.id)
          ? current
          : mergeMessages(current, [value]),
      );
    };
    socket.on("chat:message", receive);
    socket.on("chat:message.updated", receive);
    socket.on("chat:message.deleted", (value: unknown) => {
      if (
        !active ||
        !isDeleted(value) ||
        value.groupId !== groupId ||
        value.channel !== channel
      )
        return;
      setMessages((current) =>
        current.filter((message) => message.id !== value.id),
      );
    });
    socket.on("chat:thread.created", (value: { groupId?: string }) => {
      if (active && value?.groupId === groupId)
        window.dispatchEvent(
          new CustomEvent("streamora:threads-changed", { detail: { groupId } }),
        );
    });
    socket.on("chat:channel.created", (value: unknown) => {
      if (!active || !isChannel(value) || value.groupId !== groupId) return;
      setChannelList((current) => ({
        groupId,
        items: mergeChannels(current.groupId === groupId ? current.items : [], [
          value,
        ]),
      }));
    });
    socket.on("connect", () => {
      if (!active) return;
      setStatus("connecting");
      socket.emit(
        "channel:join",
        { groupId, channel },
        (ack: GroupChatJoinAck) => {
          if (!active) return;
          if (!ack?.ok) {
            setStatus("error");
            setError(
              ack?.error?.message ?? "Không thể tham gia cuộc trò chuyện.",
            );
            return;
          }
          // Rejoining replaces the search window with the latest history.
          windowRevision.current++;
          olderInFlight.current = false;
          newerInFlight.current = false;
          setLoadingOlder(false);
          setLoadingNewer(false);
          setLoadingTarget(false);
          setNewerCursor(null);
          newerCursorRef.current = null;
          setNextCursor(ack.nextCursor ?? null);
          historyContext.current = joinedContext;
          setMessages(() =>
            mergeMessages(
              [],
              ack.messages.filter(
                (message) =>
                  isMessage(message) &&
                  message.groupId === groupId &&
                  message.channel === channel,
              ),
            ),
          );
          setChannelList((current) => ({
            groupId,
            items: mergeChannels(
              current.groupId === groupId ? current.items : [],
              ack.channels.filter(
                (candidate) =>
                  isChannel(candidate) && candidate.groupId === groupId,
              ),
            ),
          }));
          setError(null);
          setStatus("connected");
          meetingsChanged({ groupId });
        },
      );
    });
    socket.on("connect_error", () => {
      if (!active) return;
      setStatus("error");
      setError("Không thể kết nối trò chuyện trực tiếp.");
    });
    socket.on("disconnect", () => {
      if (!active) return;
      setStatus("connecting");
      setError("Đang kết nối lại cuộc trò chuyện…");
    });

    const renew = setInterval(() => {
      if (!socket.connected) {
        socket.connect();
        return;
      }
      void authSession
        .getAccessToken()
        .then((accessToken) => socket.emit("auth:refresh", { accessToken }))
        .catch(() => socket.disconnect());
    }, 15000);

    socket.connect();
    return () => {
      active = false;
      clearInterval(renew);
      socketRef.current = null;
      socket.disconnect();
    };
  }, [groupId, channel]);

  const loadLatest = useCallback(async () => {
    if (!groupId) return;
    const current = context.current;
    const revision = ++windowRevision.current;
    olderInFlight.current = false;
    newerInFlight.current = false;
    setLoadingOlder(false);
    setLoadingNewer(false);
    setLoadingTarget(true);
    try {
      const query = new URLSearchParams({ channel, limit: "20" });
      const page = await apiRequest<CursorPage<GroupChatMessage>>(
        `/groups/${groupId}/chat/messages?${query}`,
      );
      if (context.current !== current || windowRevision.current !== revision)
        return;
      setMessages(mergeMessages([], page.items));
      setNextCursor(page.nextCursor);
      setNewerCursor(null);
      newerCursorRef.current = null;
      setLatestVersion((version) => version + 1);
      setError(null);
    } catch {
      if (context.current === current && windowRevision.current === revision)
        setError("Không thể tải tin mới nhất. Hãy thử lại.");
    } finally {
      if (context.current === current && windowRevision.current === revision)
        setLoadingTarget(false);
    }
  }, [groupId, channel]);

  const loadHistoryPage = useCallback(
    async (direction: "before" | "after") => {
      const cursor = direction === "before" ? nextCursor : newerCursor;
      const inFlight = direction === "before" ? olderInFlight : newerInFlight;
      const setLoading =
        direction === "before" ? setLoadingOlder : setLoadingNewer;
      if (!groupId || !cursor || inFlight.current || loadingTarget) return;
      inFlight.current = true;
      setLoading(true);
      const current = context.current;
      const revision = windowRevision.current;
      try {
        const query = new URLSearchParams({
          channel,
          cursor,
          limit: "20",
          ...(direction === "after" ? { direction } : {}),
        });
        const page = await apiRequest<CursorPage<GroupChatMessage>>(
          `/groups/${groupId}/chat/messages?${query}`,
        );
        if (context.current !== current || windowRevision.current !== revision)
          return;
        setMessages((items) => mergeMessages(items, page.items));
        if (direction === "before") setNextCursor(page.nextCursor);
        else {
          setNewerCursor(page.nextCursor);
          newerCursorRef.current = page.nextCursor;
        }
      } catch {
        if (context.current === current && windowRevision.current === revision)
          setError(
            direction === "before"
              ? "Không thể tải tin cũ. Hãy thử lại."
              : "Không thể tải tin mới hơn. Hãy thử lại.",
          );
      } finally {
        if (
          context.current === current &&
          windowRevision.current === revision
        ) {
          inFlight.current = false;
          setLoading(false);
        }
      }
    },
    [groupId, channel, nextCursor, newerCursor, loadingTarget],
  );
  const loadOlder = useCallback(
    () => loadHistoryPage("before"),
    [loadHistoryPage],
  );
  const loadNewer = useCallback(
    () => loadHistoryPage("after"),
    [loadHistoryPage],
  );

  // Fetch the result's window directly instead of walking every history page.
  useEffect(() => {
    setLoadingTarget(false);
    if (
      !groupId ||
      !targetMessageId ||
      status !== "connected" ||
      historyContext.current !== context.current
    )
      return;
    if (messagesRef.current.some((message) => message.id === targetMessageId))
      return;
    let active = true;
    const current = context.current;
    const revision = ++windowRevision.current;
    olderInFlight.current = false;
    newerInFlight.current = false;
    setLoadingOlder(false);
    setLoadingNewer(false);
    setLoadingTarget(true);
    const query = new URLSearchParams({
      channel,
      around: targetMessageId,
      limit: "20",
    });
    void apiRequest<
      CursorPage<GroupChatMessage> & { newerCursor: string | null }
    >(`/groups/${groupId}/chat/messages?${query}`)
      .then((page) => {
        if (
          !active ||
          context.current !== current ||
          windowRevision.current !== revision
        )
          return;
        setMessages(mergeMessages([], page.items));
        setNextCursor(page.nextCursor);
        setNewerCursor(page.newerCursor);
        newerCursorRef.current = page.newerCursor;
        setError(null);
      })
      .catch(() => {
        if (
          active &&
          context.current === current &&
          windowRevision.current === revision
        )
          setError(
            "Không thể mở tin nhắn. Tin có thể đã bị xóa; hãy thử tìm lại.",
          );
      })
      .finally(() => {
        if (
          active &&
          context.current === current &&
          windowRevision.current === revision
        )
          setLoadingTarget(false);
      });
    return () => {
      active = false;
    };
  }, [groupId, channel, targetMessageId, status]);

  const send = useCallback(
    (text: string, replyToId?: string, clientId?: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = socketRef.current;
        const sendContext = context.current;
        if (!groupId || !socket?.connected || status !== "connected") {
          reject(new Error("Cuộc trò chuyện chưa kết nối."));
          return;
        }
        const retryKey = JSON.stringify([
          groupId,
          channel,
          text,
          replyToId ?? null,
        ]);
        const stableClientId =
          retryIds.current.get(retryKey) ?? clientId ?? crypto.randomUUID();
        retryIds.current.set(retryKey, stableClientId);
        const timer = setTimeout(
          () => reject(new Error("Gửi tin nhắn quá thời gian chờ.")),
          8000,
        );
        socket.emit(
          "chat:send",
          { groupId, channel, text, replyToId, clientId: stableClientId },
          (ack: GroupChatSendAck) => {
            clearTimeout(timer);
            if (ack?.ok) {
              retryIds.current.delete(retryKey);
              // After composing from an old search window, resume at the latest
              // history so the confirmed message is visible without leaving a gap.
              if (context.current === sendContext && newerCursorRef.current) {
                void loadLatest();
              }
              resolve(ack.id);
            } else
              reject(
                new Error(ack?.error?.message ?? "Không thể gửi tin nhắn."),
              );
          },
        );
      }),
    [groupId, channel, status, loadLatest],
  );

  const createChannel = useCallback(
    (name: string) =>
      new Promise<GroupChatChannel>((resolve, reject) => {
        const socket = socketRef.current;
        if (!groupId || !socket?.connected || status !== "connected") {
          reject(new Error("Cuộc trò chuyện chưa kết nối."));
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("Tạo kênh quá thời gian chờ.")),
          8000,
        );
        socket.emit(
          "chat:channel.create",
          { groupId, name },
          (ack: GroupChatChannelAck) => {
            clearTimeout(timer);
            if (ack?.ok) {
              if (context.current.groupId === groupId)
                setChannelList((current) => ({
                  groupId,
                  items: mergeChannels(
                    current.groupId === groupId ? current.items : [],
                    [ack.channel],
                  ),
                }));
              resolve(ack.channel);
            } else
              reject(new Error(ack?.error?.message ?? "Không thể tạo kênh."));
          },
        );
      }),
    [groupId, status],
  );

  const change = useCallback(
    (event: "chat:edit" | "chat:delete", id: string, text?: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = socketRef.current;
        if (!groupId || !socket?.connected || status !== "connected") {
          reject(new Error("Cuộc trò chuyện chưa kết nối."));
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("Thao tác quá thời gian chờ.")),
          8000,
        );
        socket.emit(
          event,
          { groupId, channel, id, ...(text === undefined ? {} : { text }) },
          (ack: GroupChatActionAck) => {
            clearTimeout(timer);
            if (ack?.ok) resolve(ack.id);
            else
              reject(
                new Error(
                  ack?.error?.message ?? "Không thể cập nhật tin nhắn.",
                ),
              );
          },
        );
      }),
    [groupId, channel, status],
  );

  const edit = useCallback(
    (id: string, text: string) => change("chat:edit", id, text),
    [change],
  );
  const remove = useCallback(
    (id: string) => change("chat:delete", id),
    [change],
  );

  return {
    messages,
    channels: channelList.groupId === groupId ? channelList.items : [],
    status,
    historyReady:
      historyContext.current === context.current && status === "connected",
    latestVersion,
    loadLatest,
    error,
    send,
    edit,
    remove,
    createChannel,
    loadOlder,
    loadingOlder,
    loadNewer,
    loadingNewer,
    loadingTarget,
    hasNewer: newerCursor !== null,
    hasOlder: nextCursor !== null,
  };
}
