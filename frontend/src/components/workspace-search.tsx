"use client";
import Link from "next/link";
import {
  ArrowUpRight,
  Hash,
  MessageCircle,
  Search,
  LoaderCircle,
} from "lucide-react";
import {
  ChatSearchHighlight,
  chatSearchExcerpt,
} from "./chat-search-highlight";
import { useEffect, useRef, useState } from "react";
import type { CursorPage, GroupChatMessage } from "@streamora/contracts";
import { apiRequest } from "@/lib/api";

export function WorkspaceSearch({
  groupId,
  query,
  onNavigate,
}: {
  groupId: string;
  query: string;
  onNavigate?: () => void;
}) {
  const [items, setItems] = useState<GroupChatMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  async function load(next?: string, version = generation.current) {
    setBusy(true);
    try {
      let result: CursorPage<GroupChatMessage> = {
        items: [],
        nextCursor: next ?? null,
      };
      // Skip sparse pages automatically, with a bounded number of requests per action.
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({
          q: query.trim(),
          limit: "20",
          ...(result.nextCursor ? { cursor: result.nextCursor } : {}),
        });
        result = await apiRequest<CursorPage<GroupChatMessage>>(
          `/groups/${groupId}/chat/search?${params}`,
        );
        if (version !== generation.current) return;
        if (result.items.length || !result.nextCursor) break;
      }
      if (version !== generation.current) return;
      setItems((old) =>
        [
          ...new Map(
            (next ? [...old, ...result.items] : result.items).map((item) => [
              item.id,
              item,
            ]),
          ).values(),
        ].sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        ),
      );
      setCursor(result.nextCursor);
      setError("");
    } catch {
      if (version === generation.current)
        setError("Không thể tìm kiếm. Vui lòng thử lại.");
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    const version = ++generation.current;
    setItems([]);
    setCursor(null);
    setError("");
    setBusy(false);
    if (!query.trim()) return;
    setBusy(true);
    const timer = setTimeout(() => void load(undefined, version), 300);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [groupId, query]);
  if (!query.trim())
    return (
      <div className="space-search-empty">
        <Search size={28} />
        <b>Tìm lại điều bạn cần</b>
        <p>
          Nhập một từ hoặc cụm từ trong tin nhắn.
          <br />
          Tìm trên tất cả kênh và chủ đề hỏi đáp.
        </p>
      </div>
    );
  return (
    <section
      className="workspace-chat-search"
      aria-label="Kết quả tìm tin nhắn"
      aria-busy={busy}
    >
      <div className="space-search-summary">
        <span>
          <MessageCircle size={15} /> Tin nhắn
        </span>
        <span aria-live="polite">
          {busy && !items.length
            ? "Đang tìm…"
            : `${items.length} kết quả${cursor ? " đã tìm thấy" : ""}`}
        </span>
      </div>
      <div className="space-search-items">
        {items.map((m) => {
          const thread = m.channel.startsWith("thread:");
          return (
            <Link
              key={m.id}
              className="space-search-result"
              onClick={onNavigate}
              href={`/community/${encodeURIComponent(thread ? "hỏi-đáp" : m.channel)}?groupId=${groupId}${thread ? `&threadId=${m.channel.slice(7)}` : ""}`}
            >
              <div className="space-search-result-meta">
                <span>
                  {thread ? <MessageCircle size={13} /> : <Hash size={13} />}{" "}
                  {thread ? "hỏi-đáp · chủ đề" : m.channel}
                </span>
                <time dateTime={m.createdAt}>
                  {new Date(m.createdAt).toLocaleDateString("vi-VN", {
                    day: "2-digit",
                    month: "2-digit",
                  })}{" "}
                  ·{" "}
                  {new Date(m.createdAt).toLocaleTimeString("vi-VN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <div className="space-search-result-body">
                <span className="space-search-avatar" aria-hidden="true">
                  {m.senderName
                    .split(/\s+/)
                    .slice(-2)
                    .map((n) => n[0])
                    .join("")}
                </span>
                <div>
                  <b>{m.senderName}</b>
                  <p>
                    <ChatSearchHighlight
                      text={chatSearchExcerpt(m.text, query)}
                      query={query}
                    />
                  </p>
                </div>
                <ArrowUpRight
                  size={17}
                  className="space-search-open"
                  aria-label={thread ? "Mở chủ đề" : "Mở kênh"}
                />
              </div>
            </Link>
          );
        })}
      </div>
      {busy && (
        <div className="space-search-status" role="status">
          <LoaderCircle size={16} className="ui-spinner" /> Đang tìm trong lịch
          sử…
        </div>
      )}
      {error && (
        <p className="space-search-status" role="alert">
          {error}
        </p>
      )}
      {!busy && !error && !items.length && (
        <div className="space-search-empty">
          <Search size={28} />
          <b>
            {cursor
              ? "Đang tìm sâu hơn trong lịch sử"
              : "Chưa tìm thấy tin nhắn"}
          </b>
          <p>
            {cursor
              ? "Bạn có thể tiếp tục tìm trong các tin nhắn cũ hơn."
              : "Thử một cụm từ ngắn hơn hoặc kiểm tra lại chính tả."}
          </p>
        </div>
      )}
      {cursor && (
        <button
          className="button secondary space-search-more"
          disabled={busy}
          onClick={() => void load(cursor)}
        >
          Tìm thêm trong lịch sử
        </button>
      )}
      {error && (
        <button
          className="button secondary space-search-more"
          onClick={() => void load()}
        >
          Thử lại
        </button>
      )}
    </section>
  );
}
