"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Hash,
  MessageCircle,
  Plus,
  ArrowLeft,
  Search,
  ChevronRight,
} from "lucide-react";
import type { CursorPage, GroupChatThread } from "@streamora/contracts";
import { apiRequest } from "@/lib/api";
import { useGroupChat } from "@/lib/memberships/use-group-chat";
import type { ChatMessage } from "./demo-data";
import { WorkspaceChat } from "./workspace-chat";

const chatTimeFormat = new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit",
  minute: "2-digit",
});
const EMPTY_COUNTS: Record<string, number> = {};
const EMPTY_ACTIVITY: Record<string, string> = {};

type ThreadSend = ChatMessage & {
  id: string;
  clientId: string;
  threadId: string;
  failed?: boolean;
};

export function WorkspaceThreads({
  groupId,
  userId,
  targetMessageId,
  targetThreadId,
  unread = EMPTY_COUNTS,
  threadActivity = EMPTY_ACTIVITY,
  onRead,
}: {
  groupId: string;
  userId?: string;
  targetMessageId?: string;
  targetThreadId?: string;
  unread?: Record<string, number>;
  threadActivity?: Record<string, string>;
  onRead?: (threadId: string, messageId: string) => Promise<boolean>;
}) {
  const [threads, setThreads] = useState<GroupChatThread[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<GroupChatThread | null>(null);
  const markSelectedRead = useCallback(
    (id: string) =>
      selected && onRead ? onRead(selected.id, id) : Promise.resolve(false),
    [selected?.id, onRead],
  );
  const [filter, setFilter] = useState("");
  const createInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [pending, setPending] = useState<ThreadSend[]>([]);
  const activeThread = useRef(selected?.id);
  activeThread.current = selected?.id;
  const [replyId, setReplyId] = useState<string>();
  const loadVersion = useRef(0);
  const chat = useGroupChat(
    selected ? groupId : null,
    selected ? `thread:${selected.id}` : "hỏi-đáp",
    selected?.id === targetThreadId ? targetMessageId : undefined,
  );
  async function load(next?: string) {
    const version = ++loadVersion.current;
    setBusy(true);
    try {
      const page = await apiRequest<CursorPage<GroupChatThread>>(
        `/groups/${groupId}/chat/threads?${new URLSearchParams(next ? { cursor: next } : {})}`,
      );
      if (version !== loadVersion.current) return;
      setThreads((current) => [
        ...new Map(
          (next ? [...current, ...page.items] : page.items).map((item) => [
            item.id,
            item,
          ]),
        ).values(),
      ]);
      setCursor(page.nextCursor);
      setError("");
    } catch {
      if (version === loadVersion.current)
        setError("Không thể tải chủ đề. Vui lòng thử lại.");
    } finally {
      if (version === loadVersion.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    const refresh = (event: Event) => {
      if ((event as CustomEvent).detail?.groupId === groupId) void load();
    };
    window.addEventListener("streamora:threads-changed", refresh);
    return () => {
      loadVersion.current++;
      window.removeEventListener("streamora:threads-changed", refresh);
    };
  }, [groupId]);
  useEffect(() => {
    const threadId = targetThreadId;
    let active = true;
    if (threadId && /^[a-f0-9-]{36}$/i.test(threadId))
      void apiRequest<{ thread: GroupChatThread }>(
        `/groups/${groupId}/chat/threads/${threadId}`,
      )
        .then((r) => {
          if (active) setSelected(r.thread);
        })
        .catch(() => {
          if (active) setError("Không thể mở chủ đề.");
        });
    return () => {
      active = false;
    };
  }, [groupId, targetThreadId]);
  const activityKey = JSON.stringify(threadActivity);
  const previousActivityKey = useRef(activityKey);
  useEffect(() => {
    if (previousActivityKey.current === activityKey) return;
    previousActivityKey.current = activityKey;
    void load();
  }, [activityKey]);
  const visibleThreads = threads
    .filter((thread) =>
      thread.title
        .normalize("NFC")
        .toLocaleLowerCase("vi")
        .includes(filter.trim().normalize("NFC").toLocaleLowerCase("vi")),
    )
    .sort(
      (a, b) =>
        (
          threadActivity[`thread:${b.id}`] ??
          b.lastMessageAt ??
          b.createdAt
        ).localeCompare(
          threadActivity[`thread:${a.id}`] ?? a.lastMessageAt ?? a.createdAt,
        ) || b.id.localeCompare(a.id),
    );
  const confirmed = useMemo<ChatMessage[]>(
    () =>
      chat.messages.map((m) => ({
        ...m,
        name: m.senderId === userId ? "Bạn" : m.senderName,
        initials: m.senderName.slice(0, 2).toUpperCase(),
        color: "violet",
        host: m.senderRole !== "VIEWER",
        time: chatTimeFormat.format(new Date(m.createdAt)),
      })),
    [chat.messages, userId],
  );
  const confirmedRef = useRef(confirmed);
  confirmedRef.current = confirmed;
  useEffect(() => {
    if (!selected) return;
    setPending((current) =>
      current.filter(
        (item) =>
          item.threadId !== selected.id ||
          !confirmed.some(
            (m) => m.id === item.id || m.clientId === item.clientId,
          ),
      ),
    );
  }, [confirmed, selected?.id]);
  const messages = useMemo(() => {
    const optimistic = pending.filter(
      (item) =>
        item.threadId === selected?.id &&
        !item.failed &&
        !confirmed.some(
          (m) => m.id === item.id || m.clientId === item.clientId,
        ),
    );
    return [...confirmed, ...optimistic].sort(
      (a, b) =>
        (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
        (a.id ?? "").localeCompare(b.id ?? ""),
    );
  }, [confirmed, pending, selected?.id]);
  async function sendMessage(item: ThreadSend) {
    setPending((current) => [
      ...current.filter((m) => m.clientId !== item.clientId),
      { ...item, failed: false, pending: true },
    ]);
    try {
      const id = await chat.send(
        item.text,
        item.replyToId ?? undefined,
        item.clientId,
      );
      setPending((current) =>
        current.map((m) =>
          m.clientId === item.clientId ? { ...m, id, pending: false } : m,
        ),
      );
    } catch {
      // Keep the exact message and retry ID without replacing a newer draft or another thread's input.
      if (
        activeThread.current === item.threadId &&
        confirmedRef.current.some((m) => m.clientId === item.clientId)
      )
        return;
      setPending((current) =>
        current.map((m) =>
          m.clientId === item.clientId ? { ...m, failed: true } : m,
        ),
      );
    }
  }
  return (
    <div className={`qa-layout ${selected ? "qa-selected" : ""}`}>
      <section className="qa-list" aria-label="Chủ đề hỏi đáp">
        <button
          className="qa-new-thread"
          type="button"
          aria-label="Tạo chủ đề"
          aria-expanded={creating}
          onClick={() => {
            setCreating(true);
            requestAnimationFrame(() => createInput.current?.focus());
          }}
        >
          <span className="qa-new-thread-label" aria-hidden="true">
            Tạo chủ đề
          </span>
          <span className="qa-new-thread-icon">
            <Plus size={21} aria-hidden="true" />
          </span>
        </button>
        {creating && (
          <form
            className="qa-create"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!title.trim() || mutating) return;
              setMutating(true);
              try {
                const result = await apiRequest<{ thread: GroupChatThread }>(
                  `/groups/${groupId}/chat/threads`,
                  { method: "POST", body: { title: title.trim() } },
                );
                setThreads((current) => [result.thread, ...current]);
                setSelected(result.thread);
                setCreating(false);
                setTitle("");
                setDraft("");
                setReplyId(undefined);
              } catch {
                setError("Không thể tạo chủ đề.");
              } finally {
                setMutating(false);
              }
            }}
          >
            <label htmlFor="qa-title">Chủ đề câu hỏi</label>
            <input
              ref={createInput}
              id="qa-title"
              autoFocus
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Bạn đang cần giải đáp điều gì?"
            />
            <div className="qa-create-actions">
              <button
                className="button primary compact"
                disabled={mutating || !title.trim()}
              >
                Tạo chủ đề
              </button>
              <button
                type="button"
                className="button secondary compact"
                onClick={() => setCreating(false)}
              >
                Hủy
              </button>
            </div>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="qa-list-tools">
          <label className="qa-filter">
            <Search size={15} />
            <input
              aria-label="Tìm chủ đề đã tải"
              placeholder="Tìm chủ đề…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
        </div>
        <div className="qa-list-caption">
          <span>
            {filter.trim()
              ? "KẾT QUẢ TRONG DANH SÁCH ĐÃ TẢI"
              : "CHỦ ĐỀ GẦN ĐÂY"}
          </span>
          <span>{visibleThreads.length}</span>
        </div>
        <div className="qa-thread-items">
          {filter.trim() && !visibleThreads.length && (
            <p className="qa-filter-empty">
              Chưa có chủ đề khớp “{filter.trim()}”. Thử từ khóa khác hoặc tải
              thêm chủ đề.
            </p>
          )}
          {!busy && !threads.length && (
            <div className="qa-empty">
              <MessageCircle size={36} />
              <h3>Chưa có câu hỏi nào</h3>
              <p>Hãy mở chủ đề đầu tiên cho không gian này.</p>
            </div>
          )}
          {visibleThreads.map((thread) => (
            <button
              key={thread.id}
              className={`qa-thread ${selected?.id === thread.id ? "selected" : ""}`}
              onClick={() => {
                if (selected?.id === thread.id) return;
                setSelected(thread);
                setDraft("");
                setReplyId(undefined);
              }}
            >
              <span className="qa-thread-icon">
                <MessageCircle size={17} />
              </span>
              <span className="qa-thread-copy">
                <b>{thread.title}</b>
                <small>
                  Tạo{" "}
                  {new Date(thread.createdAt).toLocaleDateString("vi-VN", {
                    day: "2-digit",
                    month: "2-digit",
                  })}{" "}
                  ·{" "}
                  {new Date(thread.createdAt).toLocaleTimeString("vi-VN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </small>
              </span>
              {(unread[`thread:${thread.id}`] ?? 0) > 0 && (
                <span
                  className="channel-unread-count"
                  aria-label={`${unread[`thread:${thread.id}`]} tin nhắn chưa đọc`}
                >
                  {unread[`thread:${thread.id}`]}
                </span>
              )}
              <ChevronRight size={15} className="qa-thread-arrow" />
            </button>
          ))}
          {cursor && (
            <button
              className="button secondary qa-load-more"
              disabled={busy}
              onClick={() => void load(cursor)}
            >
              Tải thêm chủ đề
            </button>
          )}
        </div>
      </section>
      <section className="qa-conversation" aria-label="Nội dung chủ đề">
        {selected ? (
          <>
            <header>
              <button
                aria-label="Về danh sách chủ đề"
                className="qa-back"
                onClick={() => setSelected(null)}
              >
                <ArrowLeft size={18} />
              </button>
              <span className="qa-topic-icon">
                <MessageCircle size={20} />
              </span>
              <div className="qa-topic-heading">
                <span>CHỦ ĐỀ HỎI ĐÁP</span>
                <h3>{selected.title}</h3>
                <small>
                  Tạo ngày{" "}
                  {new Date(selected.createdAt).toLocaleDateString("vi-VN")}
                </small>
              </div>
            </header>
            {(chat.error || error) && <p role="alert">{chat.error || error}</p>}
            {pending.some((m) => m.threadId === selected.id && m.failed) && (
              <div className="qa-send-errors" role="status">
                {pending
                  .filter((m) => m.threadId === selected.id && m.failed)
                  .map((item) => (
                    <div key={item.clientId}>
                      <span>
                        <b>Chưa gửi được tin nhắn</b>
                        <span>{item.text}</span>
                      </span>
                      <button
                        className="button secondary compact"
                        disabled={chat.status !== "connected"}
                        onClick={() => void sendMessage(item)}
                      >
                        Thử gửi lại
                      </button>
                    </div>
                  ))}
              </div>
            )}
            <WorkspaceChat
              key={selected.id}
              targetMessageId={
                selected.id === targetThreadId ? targetMessageId : undefined
              }
              messages={messages}
              historyReady={chat.historyReady}
              latestVersion={chat.latestVersion}
              onJumpToLatest={chat.loadLatest}
              onRead={onRead ? markSelectedRead : undefined}
              currentUserId={userId}
              draft={draft}
              onDraftChange={setDraft}
              disabled={chat.status !== "connected"}
              hasOlder={chat.hasOlder}
              loadingOlder={chat.loadingOlder}
              hasNewer={chat.hasNewer}
              loadingNewer={chat.loadingNewer}
              loadingTarget={chat.loadingTarget}
              onLoadNewer={chat.loadNewer}
              onLoadOlder={chat.loadOlder}
              replyingTo={messages.find((m) => m.id === replyId)}
              onReply={(m) => setReplyId(m.id)}
              onCancelReply={() => setReplyId(undefined)}
              onEdit={async (id, text) => {
                try {
                  await chat.edit(id, text);
                } catch (error) {
                  setError("Không thể sửa tin nhắn.");
                  throw error;
                }
              }}
              onDelete={async (id) => {
                try {
                  await chat.remove(id);
                } catch (error) {
                  setError("Không thể xóa tin nhắn.");
                  throw error;
                }
              }}
              onSubmit={(e) => {
                e.preventDefault();
                if (!draft.trim() || chat.status !== "connected") return;
                const clientId = crypto.randomUUID();
                const createdAt = new Date().toISOString();
                const own = confirmed.find((m) => m.senderId === userId);
                const item: ThreadSend = {
                  id: `pending:${clientId}`,
                  clientId,
                  threadId: selected.id,
                  senderId: userId,
                  name: "Bạn",
                  initials: own?.initials ?? "BA",
                  color: "violet",
                  host: own?.host,
                  text: draft.trim(),
                  replyToId: replyId ?? null,
                  createdAt,
                  time: new Date(createdAt).toLocaleTimeString("vi-VN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                  pending: true,
                };
                setDraft("");
                setReplyId(undefined);
                void sendMessage(item);
              }}
              showInfo={false}
              showHistoryLabel={false}
              placeholder="Viết câu trả lời hoặc chia sẻ ý kiến…"
              infoText="Thảo luận riêng theo chủ đề"
            />
          </>
        ) : (
          <div className="qa-empty">
            <Hash size={48} />
            <h2>Không gian cho mọi câu hỏi</h2>
            <p>Chọn một chủ đề bên trái hoặc tạo câu hỏi mới.</p>
          </div>
        )}
      </section>
    </div>
  );
}
