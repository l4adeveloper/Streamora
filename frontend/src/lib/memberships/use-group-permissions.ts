"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupPermissions, MembershipChanged } from "@streamora/contracts";
import { useAuth } from "@/components/auth/auth-provider";
import { authSession } from "@/lib/auth/session";
import { connectClassroom } from "@/lib/realtime";
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
  const [membershipRevision, setMembershipRevision] = useState(0);
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
    return () => {
      sequence.current++;
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("online", revalidate);
    };
  }, [refresh]);
  useEffect(() => {
    if (!user || !groupId) return;
    let latestVersion = 0n;
    const socket = connectClassroom();
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
      setMembershipRevision((value) => value + 1);
    });
    socket.connect();
    return () => {
      clearInterval(renew);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [key, user?.id, groupId, refresh]);
  const current =
    state.key === key
      ? state
      : { permissions: null, error: null, loading: Boolean(user && groupId) };
  return { ...current, refresh, revision, membershipRevision };
}
