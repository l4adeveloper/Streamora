"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

// The browser and React must not both try to anchor a prepended history page.
export function useChatScroll({
  messages,
  targetMessageId,
  hasNewer,
  loadingTarget,
  latestVersion = 0,
}: {
  messages: readonly { id?: string }[];
  targetMessageId?: string;
  hasNewer: boolean;
  loadingTarget: boolean;
  latestVersion?: number;
}) {
  const history = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previous = useRef({ first: "", count: 0, height: 0, latestVersion });
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const jump = useRef<{
    id?: string;
    done?: string;
    frame?: number;
    finish?: (event?: Event | true) => void;
  }>({});
  const [highlightId, setHighlightId] = useState<string>();
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const state = useRef({ hasNewer, loadingTarget });
  const lastTop = useRef(0);
  state.current = { hasNewer, loadingTarget };

  const move = useCallback(
    (top: number, behavior: ScrollBehavior = "instant") => {
      const el = history.current;
      if (!el) return;
      el.scrollTo({ top, behavior });
      if (behavior !== "smooth") lastTop.current = el.scrollTop;
    },
    [],
  );

  const rememberAnchor = useCallback(() => {
    const el = history.current;
    if (!el) return;
    pinned.current = false;
    const top = el.getBoundingClientRect().top;
    const row = Array.from(
      el.querySelectorAll<HTMLElement>("[data-message-id]"),
    ).find((node) => node.getBoundingClientRect().bottom > top);
    anchor.current = row
      ? {
          id: row.dataset.messageId!,
          top: row.getBoundingClientRect().top - top,
        }
      : null;
    previous.current.height = el.scrollHeight;
  }, []);

  const stopJump = useCallback(() => {
    const active =
      jump.current.frame !== undefined || Boolean(jump.current.finish);
    if (jump.current.frame !== undefined)
      cancelAnimationFrame(jump.current.frame);
    jump.current.finish?.(true);
    jump.current.finish = undefined;
    jump.current.frame = undefined;
    return active;
  }, []);

  const scrollToLatest = useCallback(() => {
    stopJump();
    pinned.current = true;
    setAwayFromLatest(false);
    const el = history.current;
    if (el) move(el.scrollHeight);
  }, [stopJump, move]);

  useLayoutEffect(() => {
    const el = history.current;
    if (!el) return;
    if (jump.current.id !== targetMessageId) {
      stopJump();
      jump.current = { id: targetMessageId };
      clearTimeout(timer.current);
      setHighlightId(undefined);
    }
    const prev = previous.current;
    const first = messages[0]?.id ?? "";
    const target =
      targetMessageId && jump.current.done !== targetMessageId
        ? Array.from(
            el.querySelectorAll<HTMLElement>("[data-message-id]"),
          ).find((node) => node.dataset.messageId === targetMessageId)
        : undefined;
    if (latestVersion !== prev.latestVersion) {
      jump.current.done = targetMessageId;
      scrollToLatest();
    } else if (target) {
      stopJump();
      pinned.current = false;
      setAwayFromLatest(true);
      jump.current.done = targetMessageId;
      const offset =
        target.getBoundingClientRect().top - el.getBoundingClientRect().top;
      // Tall messages align at their beginning rather than hiding their first lines.
      const top = Math.max(
        0,
        Math.min(
          el.scrollHeight - el.clientHeight,
          el.scrollTop +
            offset -
            Math.max(16, (el.clientHeight - target.offsetHeight) / 2),
        ),
      );
      const reduced = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const showHighlight = () => {
        setHighlightId(targetMessageId);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setHighlightId(undefined), 5000);
      };
      // A replaced history window has no meaningful scroll distance to the old one.
      // Start nearby so navigation stays short even for a very old search result.
      const distance = Math.min(180, el.clientHeight / 3);
      move(Math.max(0, top - distance));
      if (reduced) {
        move(top);
        showHighlight();
      } else {
        const finish = (event?: Event | true) => {
          el.removeEventListener("scrollend", finish);
          jump.current.finish = undefined;
          jump.current.frame = undefined;
          lastTop.current = el.scrollTop;
          if (event !== true) showHighlight();
        };
        jump.current.finish = finish;
        jump.current.frame = requestAnimationFrame(() => {
          jump.current.frame = undefined;
          if (Math.abs(el.scrollTop - top) < 1) finish();
          else {
            el.addEventListener("scrollend", finish);
            move(top, "smooth");
          }
        });
      }
    } else if (targetMessageId && jump.current.done !== targetMessageId) {
      pinned.current = false;
    } else if (pinned.current || (!prev.count && !targetMessageId)) {
      move(el.scrollHeight);
    } else if (
      prev.count &&
      first !== prev.first &&
      messages.some((message) => message.id === prev.first)
    ) {
      const saved = anchor.current;
      const row =
        saved &&
        Array.from(el.querySelectorAll<HTMLElement>("[data-message-id]")).find(
          (node) => node.dataset.messageId === saved.id,
        );
      const delta =
        row && saved
          ? row.getBoundingClientRect().top -
            el.getBoundingClientRect().top -
            saved.top
          : el.scrollHeight - prev.height;
      move(el.scrollTop + delta);
      anchor.current = null;
    }
    previous.current = {
      first,
      count: messages.length,
      height: el.scrollHeight,
      latestVersion,
    };
  }, [
    messages,
    targetMessageId,
    latestVersion,
    stopJump,
    scrollToLatest,
    move,
  ]);

  useLayoutEffect(() => {
    const el = history.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (
        pinned.current &&
        !jump.current.finish &&
        !state.current.loadingTarget
      ) {
        move(el.scrollHeight);
      }
    });
    observer.observe(el);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [move]);

  useLayoutEffect(
    () => () => {
      stopJump();
      clearTimeout(timer.current);
    },
    [stopJump],
  );

  const onScroll = useCallback(() => {
    const el = history.current;
    if (
      !el ||
      jump.current.finish ||
      jump.current.frame !== undefined ||
      state.current.loadingTarget
    )
      return undefined;
    const delta = el.scrollTop - lastTop.current;
    lastTop.current = el.scrollTop;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    pinned.current = bottom && !state.current.hasNewer;
    setAwayFromLatest(!pinned.current);
    return delta;
  }, []);

  return {
    history,
    content,
    highlightId,
    awayFromLatest,
    rememberAnchor,
    scrollToLatest,
    onScroll,
    stopJump,
  };
}
