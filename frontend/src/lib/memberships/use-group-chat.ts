"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  GroupChatActionAck,
  GroupChatChannel,
  GroupChatChannelAck,
  GroupChatDeleted,
  GroupChatJoinAck,
  GroupChatMessage,
  GroupChatSendAck,
} from "@streamora/contracts";
import { authSession } from "@/lib/auth/session";

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
  return [...byId.values()]
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .slice(-500);
}

export function useGroupChat(groupId: string | null, channel: string) {
  const [messages, setMessages] = useState<GroupChatMessage[]>([]);
  const [channels, setChannels] = useState<GroupChatChannel[]>([]);
  const [status, setStatus] = useState<GroupChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    setMessages([]);
    setChannels([]);
    setError(null);
    if (!groupId) {
      setStatus("idle");
      return;
    }

    let active = true;
    setStatus("connecting");
    const base = (process.env.NEXT_PUBLIC_API_URL || "").replace(
      /\/api\/v1\/?$/,
      "",
    );
    if (base === "")
      console.warn(
        "[Streamora] NEXT_PUBLIC_API_URL is empty; realtime will use the current site origin.",
      );
    const socket = io(
      `${process.env.NEXT_PUBLIC_REALTIME_URL ?? base}/classroom`,
      {
        auth: (callback) => {
          void authSession
            .getAccessToken()
            .then((accessToken) => callback({ accessToken }))
            .catch(() => callback({}));
        },
        transports: ["websocket"],
      },
    );
    socketRef.current = socket;

    const receive = (value: unknown) => {
      if (
        !active ||
        !isMessage(value) ||
        value.groupId !== groupId ||
        value.channel !== channel
      )
        return;
      setMessages((current) => mergeMessages(current, [value]));
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
    socket.on("chat:channel.created", (value: unknown) => {
      if (!active || !isChannel(value) || value.groupId !== groupId) return;
      setChannels((current) => mergeChannels(current, [value]));
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
          setMessages((current) =>
            mergeMessages(
              current,
              ack.messages.filter(
                (message) =>
                  isMessage(message) &&
                  message.groupId === groupId &&
                  message.channel === channel,
              ),
            ),
          );
          setChannels((current) =>
            mergeChannels(
              current,
              ack.channels.filter(
                (candidate) =>
                  isChannel(candidate) && candidate.groupId === groupId,
              ),
            ),
          );
          setError(null);
          setStatus("connected");
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

    return () => {
      active = false;
      clearInterval(renew);
      socketRef.current = null;
      socket.disconnect();
    };
  }, [groupId, channel]);

  const send = useCallback(
    (text: string, replyToId?: string, clientId?: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = socketRef.current;
        if (!groupId || !socket?.connected || status !== "connected") {
          reject(new Error("Cuộc trò chuyện chưa kết nối."));
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("Gửi tin nhắn quá thời gian chờ.")),
          8000,
        );
        socket.emit(
          "chat:send",
          { groupId, channel, text, replyToId, clientId },
          (ack: GroupChatSendAck) => {
            clearTimeout(timer);
            if (ack?.ok) resolve(ack.id);
            else
              reject(
                new Error(ack?.error?.message ?? "Không thể gửi tin nhắn."),
              );
          },
        );
      }),
    [groupId, channel, status],
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
              setChannels((current) => mergeChannels(current, [ack.channel]));
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
    channels,
    status,
    error,
    send,
    edit,
    remove,
    createChannel,
  };
}
