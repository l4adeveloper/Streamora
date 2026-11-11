"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  MessageSquare,
  Reply,
  Send,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui";
import type { MeetingChatMessage } from "@streamora/contracts";
import type { MeetingChatStatus } from "@/lib/class-sessions/use-meeting-chat";

const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

function belongsToSameGroup(
  prev: MeetingChatMessage | undefined,
  curr: MeetingChatMessage | undefined,
): boolean {
  if (!prev || !curr) return false;
  if (prev.senderId !== curr.senderId) return false;
  const pt = Date.parse(prev.createdAt),
    ct = Date.parse(curr.createdAt);
  return (
    Number.isFinite(pt) &&
    Number.isFinite(ct) &&
    ct >= pt &&
    ct - pt <= MESSAGE_GROUP_WINDOW_MS
  );
}

function groupInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) {
    const letters = Array.from(words[0]);
    return letters.slice(0, letters.length <= 4 ? 4 : 2).join("").toUpperCase();
  }
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0])
    .join("")
    .toUpperCase();
}

function getColor(senderId: string, currentUserId?: string): "violet" | "blue" {
  return senderId === currentUserId ? "violet" : "blue";
}

export function MeetingChatPanel({
  messages,
  status,
  error,
  currentUserId,
  canDelete,
  onSend,
  onDelete,
  onClose,
}: {
  messages: MeetingChatMessage[];
  status: MeetingChatStatus;
  error: string | null;
  currentUserId?: string;
  canDelete?: boolean;
  onSend: (text: string, replyToId?: string, clientId?: string) => Promise<string>;
  onDelete?: (id: string) => Promise<void>;
  onClose?: () => void;
}) {
  const historyRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<MeetingChatMessage | null>(null);
  const [pendingMessages, setPendingMessages] = useState<
    (MeetingChatMessage & { _pending?: boolean; _clientId?: string })[]
  >([]);
  const [actionId, setActionId] = useState<string | null>(null);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = historyRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }, [messages, pendingMessages]);

  // Remove confirmed pending messages.
  useEffect(() => {
    if (pendingMessages.length === 0) return;
    const confirmedIds = new Set(messages.map((m) => m.id));
    const confirmedClientIds = new Set(
      messages.flatMap((m) => (m.clientId ? [m.clientId] : [])),
    );
    setPendingMessages((current) =>
      current.filter(
        (m) =>
          !confirmedIds.has(m.id) &&
          !(m._clientId && confirmedClientIds.has(m._clientId)),
      ),
    );
  }, [messages]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || status === "error") return;
    const replyToId = replyingTo?.id;
    const clientId = crypto.randomUUID();
    const optimistic: MeetingChatMessage & {
      _pending: boolean;
      _clientId: string;
    } = {
      id: `pending:${clientId}`,
      clientId,
      sessionId: "",
      senderId: currentUserId ?? "",
      senderName: "Bạn",
      senderRole: "VIEWER",
      text,
      replyToId: replyToId ?? null,
      createdAt: new Date().toISOString(),
      _pending: true,
      _clientId: clientId,
    };
    setPendingMessages((c) => [...c, optimistic]);
    setDraft("");
    setReplyingTo(null);
    try {
      await onSend(text, replyToId, clientId);
    } catch {
      setPendingMessages((c) => c.filter((m) => m._clientId !== clientId));
      setDraft((c) => c || text);
      if (replyToId) setReplyingTo((c) => c ?? replyingTo);
    }
  }

  async function handleDelete(id: string) {
    if (!onDelete || actionId || !confirm("Xóa tin nhắn này?")) return;
    setActionId(id);
    try {
      await onDelete(id);
    } finally {
      setActionId(null);
    }
  }

  function startReply(message: MeetingChatMessage) {
    setReplyingTo(message);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  // Combined sorted list: confirmed + pending not yet reflected.
  const confirmedClientIds = new Set(
    messages.flatMap((m) => (m.clientId ? [m.clientId] : [])),
  );
  const confirmedIds = new Set(messages.map((m) => m.id));
  const visiblePending = pendingMessages.filter(
    (m) =>
      !confirmedIds.has(m.id) &&
      !(m._clientId && confirmedClientIds.has(m._clientId)),
  );
  const all = [...messages, ...visiblePending].sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.id.localeCompare(b.id),
  );

  return (
    <section className="meeting-chat-panel" aria-label="Chat phòng họp">
      <div className="meeting-chat-header">
        <MessageSquare size={16} aria-hidden="true" />
        <span>Chat phòng họp</span>
        <span className="meeting-chat-status" role="status">
          {status === "connected" ? (
            <span className="meeting-chat-status-dot connected" />
          ) : status === "connecting" ? (
            <span className="meeting-chat-status-dot connecting" />
          ) : (
            <WifiOff size={12} aria-label="Mất kết nối" />
          )}
        </span>
        {onClose && (
          <button
            type="button"
            className="meeting-chat-close"
            aria-label="Đóng chat"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {error && (
        <div className="meeting-chat-error" role="alert">
          {error}
        </div>
      )}

      <div
        className="meeting-chat-history"
        ref={historyRef}
        role="log"
        aria-label="Lịch sử tin nhắn phòng họp"
        tabIndex={0}
      >
        {all.length === 0 && status === "connected" && (
          <p className="meeting-chat-empty">
            Chưa có tin nhắn nào. Hãy bắt đầu cuộc trò chuyện!
          </p>
        )}
        {all.map((message, index) => {
          const pending = "_pending" in message && message._pending;
          const continuation = belongsToSameGroup(all[index - 1], message);
          const ownMessage = message.senderId === currentUserId;
          const replyTarget =
            message.replyToId
              ? all.find((m) => m.id === message.replyToId)
              : undefined;
          const canAct =
            !pending &&
            message.id &&
            !message.id.startsWith("pending:");
          const canDeleteMsg =
            canAct && onDelete && (ownMessage || canDelete);

          return (
            <div
              key={message.id}
              id={`mchat-${message.id}`}
              className={[
                "meeting-chat-message",
                pending && "pending",
                continuation && "continuation",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-busy={pending ? true : undefined}
            >
              <Avatar
                initials={groupInitials(message.senderName)}
                color={getColor(message.senderId, currentUserId)}
                small
              />
              <div className="meeting-chat-content">
                {!continuation && (
                  <div className="meeting-chat-meta">
                    <b title={message.senderName}>
                      {ownMessage ? "Bạn" : message.senderName}
                    </b>
                    {message.senderRole !== "VIEWER" && (
                      <span className="meeting-chat-role">
                        {message.senderRole === "ADMIN"
                          ? "Quản trị"
                          : "Giảng viên"}
                      </span>
                    )}
                    <time dateTime={message.createdAt}>
                      {new Date(message.createdAt).toLocaleTimeString("vi-VN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                )}
                {message.replyToId && (
                  <button
                    type="button"
                    className="meeting-chat-reply-preview"
                    onClick={() => {
                      if (replyTarget?.id) {
                        document
                          .getElementById(`mchat-${replyTarget.id}`)
                          ?.scrollIntoView({ block: "center" });
                      }
                    }}
                    disabled={!replyTarget}
                  >
                    <Reply size={11} aria-hidden="true" />
                    {replyTarget ? (
                      <>
                        <b>{replyTarget.senderName}</b>
                        <span>{replyTarget.text}</span>
                      </>
                    ) : (
                      <span>Tin nhắn không còn tồn tại</span>
                    )}
                  </button>
                )}
                <p className="meeting-chat-text">{message.text}</p>
              </div>
              {canAct && (
                <div className="meeting-chat-actions">
                  <button
                    type="button"
                    aria-label={`Trả lời ${message.senderName}`}
                    title="Trả lời"
                    onClick={() => startReply(message)}
                  >
                    <Reply size={13} />
                  </button>
                  {canDeleteMsg && (
                    <button
                      type="button"
                      aria-label="Xóa tin nhắn"
                      title="Xóa"
                      disabled={actionId === message.id}
                      onClick={() => void handleDelete(message.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <form className="meeting-chat-form" onSubmit={(e) => void handleSubmit(e)}>
        {replyingTo && (
          <div className="meeting-chat-replying">
            <Reply size={13} aria-hidden="true" />
            <span>
              Trả lời <b>{replyingTo.senderName}</b>
            </span>
            <button
              type="button"
              aria-label="Hủy trả lời"
              onClick={() => setReplyingTo(null)}
            >
              <X size={13} />
            </button>
          </div>
        )}
        <div className="meeting-chat-composer">
          <input
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              status === "error"
                ? (error || "Không thể kết nối chat")
                : "Nhắn tin với mọi người trong phòng…"
            }
            aria-label="Tin nhắn phòng họp"
            disabled={status === "error"}
            maxLength={4000}
          />
          <button
            type="submit"
            aria-label="Gửi tin nhắn"
            disabled={status === "error" || !draft.trim()}
          >
            <Send size={16} />
          </button>
        </div>
        {status === "connecting" && (
          <p className="meeting-chat-info">Đang kết nối chat…</p>
        )}
        {status === "error" && error && (
          <p className="meeting-chat-info" style={{ color: "var(--danger, #ef4444)" }}>
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
