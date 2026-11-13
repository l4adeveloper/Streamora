"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClassSession, ClassSessionStatus } from "@streamora/contracts";
import { useAuth } from "@/components/auth/auth-provider";
import { listClassSessions } from "./api";

const emptySessions: ClassSession[] = [];
const visible = (session: ClassSession) =>
  ["LIVE", "SCHEDULED"].includes(session.status);
const ordered = (items: ClassSession[]) =>
  items.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

/** The sidebar only contains rooms from the currently authorized group. */
export function useWorkspaceMeetings(
  groupId: string | null,
  enabled: boolean,
  revision: number,
) {
  const { user } = useAuth();
  const scope = `${user?.id ?? ""}:${groupId ?? ""}`;
  const [state, setState] = useState<{
    scope: string;
    items: ClassSession[];
    loading: boolean;
    error: unknown;
  }>({ scope: "", items: [], loading: false, error: null });
  const generation = useRef(0);
  const flight = useRef<{
    scope: string;
    promise: Promise<void>;
    again?: boolean;
  } | null>(null);
  const refresh = useCallback((): Promise<void> => {
    if (!user || !groupId || !enabled) return Promise.resolve();
    if (flight.current?.scope === scope) {
      flight.current.again = true;
      return flight.current.promise;
    }
    const ticket = ++generation.current;
    const loadStatus = async (status: ClassSessionStatus) => {
      const items: ClassSession[] = [];
      let cursor: string | undefined;
      do {
        const page = await listClassSessions(groupId, cursor, status);
        if (ticket !== generation.current) return [];
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    };
    setState((current) => ({
      scope,
      items: current.scope === scope ? current.items : [],
      loading: true,
      error: null,
    }));
    const promise = Promise.all([loadStatus("LIVE"), loadStatus("SCHEDULED")])
      .then((pages) => {
        if (ticket === generation.current)
          setState({
            scope,
            items: ordered(
              pages
                .flat()
                .filter((item) => item.groupId === groupId && visible(item)),
            ),
            loading: false,
            error: null,
          });
      })
      .catch((error) => {
        if (ticket === generation.current)
          setState({ scope, items: [], loading: false, error });
      })
      .finally(() => {
        if (flight.current?.promise === promise) {
          const again = flight.current.again;
          flight.current = null;
          if (again && ticket === generation.current)
            queueMicrotask(() => void refresh());
        }
      });
    flight.current = { scope, promise };
    return promise;
  }, [scope, groupId, user?.id, enabled]);
  useEffect(() => {
    const refreshGroup = (event: Event) => {
      const changed = (event as CustomEvent<{ groupId?: string }>).detail
        ?.groupId;
      if (!changed || changed === groupId) void refresh();
    };
    void refresh();
    window.addEventListener("streamora:meetings-changed", refreshGroup);
    window.addEventListener("focus", refreshGroup);
    window.addEventListener("online", refreshGroup);
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      generation.current++;
      flight.current = null;
      clearInterval(timer);
      window.removeEventListener("streamora:meetings-changed", refreshGroup);
      window.removeEventListener("focus", refreshGroup);
      window.removeEventListener("online", refreshGroup);
    };
  }, [refresh, revision, groupId]);
  const update = useCallback(
    (session: ClassSession) => {
      if (session.groupId !== groupId) return;
      setState((current) =>
        current.scope !== scope
          ? current
          : {
              ...current,
              items: ordered([
                ...current.items.filter((item) => item.id !== session.id),
                ...(visible(session) ? [session] : []),
              ]),
            },
      );
    },
    [scope, groupId],
  );
  return {
    items: state.scope === scope && enabled ? state.items : emptySessions,
    loading: enabled && (state.scope !== scope || state.loading),
    error: state.scope === scope && enabled ? state.error : null,
    refresh,
    update,
  };
}
