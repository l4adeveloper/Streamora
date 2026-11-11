"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type {
  MeetingChatMessage,
  MeetingChatDeleted,
  MeetingChatJoinAck,
  MeetingChatSendAck,
} from "@streamora/contracts";
import { useAuth } from "@/components/auth/auth-provider";
import { authSession } from "@/lib/auth/session";

export type MeetingChatStatus = "idle" | "connecting" | "connected" | "error";

function isMessage(value: unknown): value is MeetingChatMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<MeetingChatMessage>;
  return (
    typeof m.id === "string" &&
    typeof m.sessionId === "string" &&
    typeof m.senderId === "string" &&
    typeof m.senderName === "string" &&
    typeof m.text === "string" &&
    typeof m.createdAt === "string"
  );
}

function mergeMessages(
  current: MeetingChatMessage[],
  incoming: MeetingChatMessage[],
): MeetingChatMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()]
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(-500);
}

/**
 * Realtime meeting-scoped chat.
 * Opens its own socket connection to /sessions namespace (same as useClassRealtime)
 * and emits meeting-chat:* events. The user must be an active participant
 * (participationId != null) to send messages.
 */
export function useMeetingChat(
  sessionId: string | null,
  /** Pass participationId when user is actively in the room; null means view-only. */
  participationId: string | null,
) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<MeetingChatMessage[]>([]);
  const [status, setStatus] = useState<MeetingChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<ReturnType<typeof io> | null>(null);

  useEffect(() => {
    if (!user || !sessionId) {
      setMessages([]);
      setStatus("idle");
      setError(null);
      return;
    }

    let active = true;
    setStatus("connecting");

    const base = (
      process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000/api/v1"
    ).replace(/\/api\/v1\/?$/, "");
    const socket = io(
      `${(process.env.NEXT_PUBLIC_REALTIME_URL ?? base).replace(/\/$/, "")}/sessions`,
      {
        autoConnect: false,
        transports: ["websocket"],
        auth: (callback) => {
          void authSession
            .getAccessToken()
            .then((accessToken) => {
              if (active) callback({ accessToken });
            })
            .catch(() => {
              if (active) callback({});
            });
        },
      },
    );
    socketRef.current = socket;

    function joinChat() {
      if (!active || !socket.connected) return;
      socket.emit(
        "meeting-chat:join",
        { sessionId },
        (rawAck: unknown) => {
          if (!active) return;
          const ack = rawAck as { ok: boolean; data?: any; error?: { message: string } };
          if (!ack?.ok) {
            setStatus("error");
            setError(
              ack?.error?.message ?? "Không thể tham gia chat phòng họp.",
            );
            return;
          }
          const payload = ack.data ?? ack;
          if (payload.ok === false) {
            setStatus("error");
            setError(
              payload.error?.message ?? "Không thể tham gia chat phòng họp.",
            );
            return;
          }
          const incoming = payload.messages ?? [];
          if (Array.isArray(incoming)) {
            setMessages((current) =>
              mergeMessages(
                current,
                incoming.filter(
                  (m: unknown) => isMessage(m) && m.sessionId === sessionId,
                ),
              ),
            );
          }
          setError(null);
          setStatus("connected");
        },
      );
    }

    socket.on("connect", () => {
      if (!active) return;
      setStatus("connecting");
      // Refresh auth then watch+join.
      void authSession
        .getAccessToken()
        .then((accessToken) => {
          if (!active || !socket.connected) return;
          return socket
            .timeout(5000)
            .emitWithAck("auth:refresh", { accessToken });
        })
        .then(() => {
          if (active && socket.connected) joinChat();
        })
        .catch(() => {
          if (active) joinChat();
        });
    });

    socket.on("meeting-chat:message", (value: unknown) => {
      if (!active || !isMessage(value) || value.sessionId !== sessionId) return;
      setMessages((current) => mergeMessages(current, [value]));
    });

    socket.on("meeting-chat:message.deleted", (value: unknown) => {
      if (!active) return;
      const deleted = value as Partial<MeetingChatDeleted>;
      if (typeof deleted?.id !== "string" || deleted.sessionId !== sessionId)
        return;
      setMessages((current) => current.filter((m) => m.id !== deleted.id));
    });

    socket.on("disconnect", () => {
      if (!active) return;
      setStatus("connecting");
    });

    socket.on("connect_error", () => {
      if (!active) return;
      setStatus("error");
      setError("Mất kết nối chat phòng họp.");
    });

    // Token refresh every 15 s.
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
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [sessionId, user?.id]);

  const send = useCallback(
    (text: string, replyToId?: string, clientId?: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = socketRef.current;
        if (!sessionId || !socket?.connected) {
          reject(new Error("Chat chưa kết nối."));
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("Gửi tin nhắn quá thời gian chờ.")),
          8000,
        );
        socket.emit(
          "meeting-chat:send",
          { sessionId, text, replyToId, clientId },
          (rawAck: unknown) => {
            clearTimeout(timer);
            const ack = rawAck as { ok: boolean; data?: any; error?: { message: string } };
            const payload = ack?.data ?? ack;
            if (payload?.ok) resolve(payload.id ?? payload.data?.id ?? "ok");
            else
              reject(
                new Error(
                  payload?.error?.message ??
                    ack?.error?.message ??
                    "Không thể gửi tin nhắn.",
                ),
              );
          },
        );
      }),
    [sessionId],
  );

  const remove = useCallback(
    (id: string) =>
      new Promise<void>((resolve, reject) => {
        const socket = socketRef.current;
        if (!sessionId || !socket?.connected) {
          reject(new Error("Chat chưa kết nối."));
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("Xóa tin nhắn quá thời gian chờ.")),
          8000,
        );
        socket.emit(
          "meeting-chat:delete",
          { sessionId, id },
          (rawAck: unknown) => {
            clearTimeout(timer);
            const ack = rawAck as { ok: boolean; data?: any; error?: { message: string } };
            const payload = ack?.data ?? ack;
            if (payload?.ok) resolve();
            else
              reject(
                new Error(
                  payload?.error?.message ??
                    ack?.error?.message ??
                    "Không thể xóa tin nhắn.",
                ),
              );
          },
        );
      }),
    [sessionId],
  );

  return { messages, status, error, send, remove };
}
