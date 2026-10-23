"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Group } from "@streamora/contracts";
import { useAuth } from "@/components/auth/auth-provider";
import { listGroups } from "@/lib/groups/api";

export function useWorkspaceGroup() {
  const { user } = useAuth();
  const [state, setState] = useState<{
    userId: string;
    groups: Group[];
    groupId: string | null;
  }>({ userId: "", groups: [], groupId: null });
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const groups: Group[] = [];
      let cursor: string | undefined;
      do {
        const page = await listGroups({ limit: 100, cursor });
        if (request !== sequence.current) return;
        groups.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const requested =
        new URLSearchParams(location.search).get("groupId") ??
        sessionStorage.getItem(`streamora-group:${user.id}`);
      const groupId =
        groups.find((group) => group.id === requested)?.id ??
        groups[0]?.id ??
        null;
      if (groupId)
        sessionStorage.setItem(`streamora-group:${user.id}`, groupId);
      setState({
        userId: user.id,
        groups,
        groupId,
      });
    } catch (cause) {
      if (request === sequence.current) setError(cause);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [user?.id]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  const current =
    state.userId === user?.id ? state : { groups: [], groupId: null };
  function selectGroup(groupId: string) {
    if (!user) return;
    setState((previous) => ({ ...previous, groupId }));
    sessionStorage.setItem(`streamora-group:${user.id}`, groupId);
    const url = new URL(location.href);
    url.searchParams.set("groupId", groupId);
    history.replaceState(null, "", url);
  }
  return { ...current, selectGroup, loading, error, reload: load };
}
