"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { GroupPermissions, MembershipChanged } from "@streamora/contracts";
import { useAuth } from "@/components/auth/auth-provider";
import { authSession } from "@/lib/auth/session";
import { getGroupPermissions } from "./api";

// Shared by classrooms, files and recordings. No client role is authoritative.
export function useGroupPermissions(groupId: string | null) {
  const { user } = useAuth();
  const key = `${user?.id ?? ""}:${groupId ?? ""}`;
  const [state, setState] = useState<{
    key: string;
    permissions: GroupPermissions | null;
    error: unknown;
    loading: boolean;
  }>({ key: "", permissions: null, error: null, loading: true });
  const sequence = useRef(0);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (!user || !groupId) {
      setState({ key, permissions: null, error: null, loading: false });
      return;
    }
    try {
      const permissions = await getGroupPermissions(groupId);
      if (request === sequence.current)
        setState({ key, permissions, error: null, loading: false });
    } catch (error) {
      if (request === sequence.current)
        setState({ key, permissions: null, error, loading: false });
    }
  }, [key, groupId, user?.id]);
  useEffect(() => {
    void refresh();
    const revalidate = () => {
      void refresh();
      setRevision((value) => value + 1);
    };
    window.addEventListener("focus", revalidate);
    window.addEventListener("online", revalidate);
    // Reconcile missed events, revoked sessions and group deletion, including
    // when a proxy temporarily blocks sockets.
    const interval = setInterval(revalidate, 15000);
    return () => {
      sequence.current++;
      clearInterval(interval);
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("online", revalidate);
    };
  }, [refresh]);
  useEffect(() => {
    if (!user || !groupId) return;
    let latestVersion = 0n;
    const base = (
      process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000/api/v1"
    ).replace(/\/api\/v1\/?$/, "");
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
    socket.on("connect", () => {
      void refresh();
      setRevision((value) => value + 1);
    });
    const renew = setInterval(() => {
      if (socket.connected)
        void authSession
          .getAccessToken()
          .then((accessToken) => socket.emit("auth:refresh", { accessToken }))
          .catch(() => socket.disconnect());
      else socket.connect();
    }, 15000);
    socket.on("membership.changed", (event: MembershipChanged) => {
      if (
        event.groupId !== groupId ||
        event.userId !== user.id ||
        !/^\d+$/.test(event.version) ||
        BigInt(event.version) <= latestVersion
      )
        return;
      latestVersion = BigInt(event.version);
      // Fail closed while the authoritative state is refreshed.
      sequence.current++;
      setState({ key, permissions: null, error: null, loading: true });
      void refresh();
      setRevision((value) => value + 1);
    });
    return () => {
      clearInterval(renew);
      socket.disconnect();
    };
  }, [key, user?.id, groupId, refresh]);
  const current =
    state.key === key
      ? state
      : { permissions: null, error: null, loading: Boolean(user && groupId) };
  return { ...current, refresh, revision };
}
