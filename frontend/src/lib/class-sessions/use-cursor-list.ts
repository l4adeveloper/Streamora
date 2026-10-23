"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CursorPage } from "@streamora/contracts";

export function useCursorList<T extends { id: string }>(
  loader: (cursor?: string) => Promise<CursorPage<T>>,
  revision = 0,
) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const sequence = useRef(0),
    busy = useRef(false);
  const previousLoader = useRef(loader);
  const load = useCallback(
    async (after?: string) => {
      if (after && busy.current) return;
      const request = ++sequence.current;
      busy.current = true;
      setLoading(true);
      setError(null);
      try {
        const page = await loader(after);
        if (request !== sequence.current) return;
        setItems((current) =>
          after
            ? [
                ...current,
                ...page.items.filter(
                  (item) => !current.some((old) => old.id === item.id),
                ),
              ]
            : page.items,
        );
        setCursor(page.nextCursor);
      } catch (error) {
        if (request === sequence.current) {
          setError(error);
          if (!after) setItems([]);
        }
      } finally {
        if (request === sequence.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [loader],
  );
  useEffect(() => {
    if (previousLoader.current !== loader) {
      setItems([]);
      setCursor(null);
      previousLoader.current = loader;
    }
    void load();
    return () => {
      sequence.current++;
      busy.current = false;
    };
  }, [load, loader, revision]);
  return {
    items,
    cursor,
    loading,
    error,
    refresh: () => load(),
    more: () => (cursor ? load(cursor) : Promise.resolve()),
  };
}
