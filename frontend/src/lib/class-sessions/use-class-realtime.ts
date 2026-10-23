"use client";
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type {
  ClassRealtimeAck,
  ClassWatchSnapshot,
  ClassPresenceReceipt,
  ClassRealtimeInvalidation,
  ClassParticipationClosed,
} from "@streamora/contracts";
import { useAuth } from "@/components/auth/auth-provider";
import { authSession } from "@/lib/auth/session";

export type ClassConnectionStatus =
  "connecting" | "connected" | "reconnecting" | "expired";
export function useClassRealtime(
  sessionId: string | null,
  participationId: string | null,
  onChange: (kind: string) => void,
  onClosed: (event: ClassParticipationClosed) => void,
) {
  const { user } = useAuth();
  const callbacks = useRef({ onChange, onClosed });
  const desired = useRef(participationId);
  const wake = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<ClassConnectionStatus>("connecting");
  useEffect(() => {
    callbacks.current = { onChange, onClosed };
  });
  useEffect(() => {
    desired.current = participationId;
    wake.current?.();
  }, [participationId]);
  useEffect(() => {
    if (!user || !sessionId) return;
    let stopped = false,
      ready = false,
      busy = false,
      bound: string | null = null,
      blocked: string | null = null;
    let heartbeatMs = 10000,
      nextBeat = 0,
      nextAuth = 0;
    let reconnectAt = 0;
    const versions = new Map<string, bigint>();
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
              if (!stopped) callback({ accessToken });
            })
            .catch(() => {
              if (!stopped) callback({});
            });
        },
      },
    );
    const emit = <T>(
      event: string,
      data: unknown,
    ): Promise<ClassRealtimeAck<T>> =>
      socket.timeout(5000).emitWithAck(event, data);
    async function tick() {
      if (stopped || busy) return;
      if (!socket.connected) {
        if (!socket.active && Date.now() >= reconnectAt) socket.connect();
        return;
      }
      if (!ready) return;
      busy = true;
      try {
        if (Date.now() >= nextAuth) {
          const accessToken = await authSession.getAccessToken();
          if (stopped) return;
          const auth = await emit("auth:refresh", { accessToken });
          if (!auth.ok) {
            socket.disconnect();
            callbacks.current.onChange("auth");
            return;
          }
          nextAuth = Date.now() + 10000;
        }
        const id = desired.current;
        if (!id || id === blocked || (id === bound && Date.now() < nextBeat))
          return;
        const result = await emit<ClassPresenceReceipt>(
          id === bound ? "participation:heartbeat" : "participation:attach",
          { sessionId, participationId: id },
        );
        if (stopped) return;
        if (!result.ok) {
          bound = null;
          if (
            [
              "ADMISSION_REVOKED",
              "FORBIDDEN",
              "PARTICIPATION_NOT_FOUND",
            ].includes(result.error.code)
          ) {
            blocked = id;
            setStatus("expired");
          }
          callbacks.current.onChange("presence");
          return;
        }
        bound = id;
        nextBeat = Date.now() + heartbeatMs;
        setStatus("connected");
      } catch {
        if (!stopped) {
          bound = null;
          setStatus("reconnecting");
          callbacks.current.onChange("connection");
        }
      } finally {
        busy = false;
      }
    }
    socket.on("connect", () => {
      ready = false;
      bound = null;
      nextAuth = 0;
      nextBeat = 0;
      void emit<ClassWatchSnapshot>("session:watch", { sessionId })
        .then((result) => {
          if (stopped) return;
          if (!result.ok) {
            callbacks.current.onChange("access");
            setStatus("reconnecting");
            reconnectAt = Date.now() + 5000;
            socket.disconnect();
            return;
          }
          ready = true;
          heartbeatMs = result.data.heartbeatIntervalMs;
          setStatus("connected");
          callbacks.current.onChange("snapshot");
          void tick();
        })
        .catch(() => {
          if (!stopped) {
            setStatus("reconnecting");
            socket.disconnect();
          }
        });
    });
    for (const kind of [
      "session.changed",
      "session.ended",
      "queue.changed",
      "admission.changed",
      "participants.changed",
      "access.changed",
    ]) {
      socket.on(kind, (event: ClassRealtimeInvalidation) => {
        if (
          stopped ||
          event?.sessionId !== sessionId ||
          !/^\d+$/.test(event.version)
        )
          return;
        const version = BigInt(event.version);
        if (version <= (versions.get(kind) ?? -1n)) return;
        versions.set(kind, version);
        callbacks.current.onChange(kind);
      });
    }
    socket.on("participation.closed", (event: ClassParticipationClosed) => {
      if (stopped || event?.sessionId !== sessionId) return;
      if (event.participationId === desired.current) {
        blocked = event.participationId;
        bound = null;
      }
      callbacks.current.onClosed(event);
      callbacks.current.onChange("closed");
    });
    socket.on("session.access-revoked", (event: { sessionId: string }) => {
      if (event?.sessionId !== sessionId || stopped) return;
      ready = false;
      bound = null;
      callbacks.current.onChange("access-revoked");
      reconnectAt = Date.now() + 15000;
      socket.disconnect();
    });
    socket.on("disconnect", () => {
      ready = false;
      bound = null;
      if (!stopped) {
        setStatus("reconnecting");
        callbacks.current.onChange("connection");
      }
    });
    socket.on("connect_error", () => {
      if (!stopped) {
        setStatus("reconnecting");
        callbacks.current.onChange("connection");
      }
    });
    wake.current = () => void tick();
    const timer = setInterval(() => void tick(), 1000);
    const foreground = () => {
      nextBeat = 0;
      nextAuth = 0;
      void tick();
      callbacks.current.onChange("focus");
    };
    window.addEventListener("online", foreground);
    window.addEventListener("focus", foreground);
    setStatus("connecting");
    socket.connect();
    return () => {
      stopped = true;
      wake.current = null;
      clearInterval(timer);
      window.removeEventListener("online", foreground);
      window.removeEventListener("focus", foreground);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [sessionId, user?.id]);
  return status;
}
