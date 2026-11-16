"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { asApiError } from "@/lib/api";
import { listRecordings, type RecordingItem } from "@/lib/recordings/api";

export function RecordingsPage({ groupId }: { groupId: string }) {
  const [items, setItems] = useState<RecordingItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void listRecordings(groupId)
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setCursor(result.nextCursor);
        setLoading(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(asApiError(cause).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);
  async function more() {
    if (!cursor) return;
    setLoading(true);
    try {
      const result = await listRecordings(groupId, cursor);
      setItems((previous) => [...previous, ...result.items]);
      setCursor(result.nextCursor);
      setError("");
    } catch (cause) {
      setError(asApiError(cause).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="page-shell">
      <Link href={`/groups/${groupId}`}>← Về nhóm</Link>
      <h1>Bản ghi buổi học</h1>
      {error && <p role="alert">{error}</p>}
      {!loading && items.length === 0 && !error && <p>Chưa có bản ghi.</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <Link href={`/recordings/${item.id}`}>{item.title}</Link>
            <span>
              {" "}
              ·{" "}
              {item.status === "SAVED" && item.fileStatus === "AVAILABLE"
                ? "Đã lưu"
                : item.status === "FAILED"
                  ? "Lưu thất bại"
                  : "Đang xử lý"}
            </span>
          </li>
        ))}
      </ul>
      {cursor && (
        <button type="button" onClick={() => void more()} disabled={loading}>
          Xem thêm
        </button>
      )}
      {loading && <p role="status">Đang tải…</p>}
    </main>
  );
}
