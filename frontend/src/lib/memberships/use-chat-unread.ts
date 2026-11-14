"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupChatReadState } from "@streamora/contracts";
import { apiRequest } from "@/lib/api";

const EMPTY: GroupChatReadState = { unread: {}, threadActivity: {} };

export function useChatUnread(
  groupId: string | null,
  userId: string | undefined,
) {
  const key = `${userId ?? ""}:${groupId ?? ""}`;
  const context = useRef(key);
  context.current = key;
  const [state, setState] = useState({ key: "", data: EMPTY });
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!groupId || !userId) return;
    const request = ++sequence.current;
    try {
      const data = await apiRequest<GroupChatReadState>(
        `/groups/${groupId}/chat/read-state`,
      );
      if (context.current === key && request === sequence.current)
        setState({ key, data });
    } catch {
      /* Keep the last confirmed counts during temporary connection failures. */
    }
  }, [groupId, userId, key]);
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (event: Event) => {
      if ((event as CustomEvent).detail?.groupId !== groupId) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 150);
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("streamora:chat-activity", schedule);
    window.addEventListener("streamora:threads-changed", schedule);
    window.addEventListener("focus", visible);
    window.addEventListener("online", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      sequence.current++;
      clearTimeout(timer);
      window.removeEventListener("streamora:chat-activity", schedule);
      window.removeEventListener("streamora:threads-changed", schedule);
      window.removeEventListener("focus", visible);
      window.removeEventListener("online", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [groupId, refresh]);
  const markRead = useCallback(
    async (channel: string, messageId: string) => {
      if (!groupId || !userId) return false;
      try {
        await apiRequest(`/groups/${groupId}/chat/read`, {
          method: "POST",
          body: { channel, messageId },
        });
        if (context.current === key) await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [groupId, userId, key, refresh],
  );
  const data = state.key === key ? state.data : EMPTY;
  const questionsUnread = Object.entries(data.unread).reduce(
    (sum, [channel, count]) =>
      sum + (channel.startsWith("thread:") ? count : 0),
    0,
  );
  return { ...data, questionsUnread, markRead };
}
