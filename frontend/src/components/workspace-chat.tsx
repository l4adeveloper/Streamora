"use client";
import Link from "next/link";

import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Check,
  Pencil,
  Reply,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { Avatar } from "./ui";
import type { ChatMessage } from "./demo-data";

const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

function belongsToSameGroup(
  previous: ChatMessage | undefined,
  current: ChatMessage | undefined,
) {
  if (!previous || !current) return false;
  const sameSender =
    previous.senderId && current.senderId
      ? previous.senderId === current.senderId
      : previous.name === current.name &&
        previous.initials === current.initials;
  if (!sameSender || !previous.createdAt || !current.createdAt) return false;
  const previousTime = Date.parse(previous.createdAt);
  const currentTime = Date.parse(current.createdAt);
  return (
    Number.isFinite(previousTime) &&
    Number.isFinite(currentTime) &&
    currentTime >= previousTime &&
    currentTime - previousTime <= MESSAGE_GROUP_WINDOW_MS
  );
}

export function WorkspaceChat({
  messages,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  draft,
  onDraftChange,
  onSubmit,
  currentUserId,
  replyingTo,
  onReply,
  onCancelReply,
  onEdit,
  onDelete,
  onMeetingOpen,
  welcome,
  showInfo = true,
  showHistoryLabel = true,
  placeholder = "Gửi lời nhắn đến mọi người…",
  infoText = "Cuộc trò chuyện được lưu trong cộng đồng",
  disabled = false,
}: {
  messages: ChatMessage[];
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<void>;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  currentUserId?: string;
  replyingTo?: ChatMessage;
  onReply?: (message: ChatMessage) => void;
  onCancelReply?: () => void;
  onEdit?: (id: string, text: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onMeetingOpen?: (id: string) => void;
  welcome?: ReactNode;
  showInfo?: boolean;
  showHistoryLabel?: boolean;
  placeholder?: string;
  infoText?: string;
  disabled?: boolean;
}) {
  const history = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);
  const pinned = useRef(true);
  const previous = useRef({ first: "", height: 0, count: 0 });
  useLayoutEffect(() => {
    const element = history.current;
    if (!element) return;
    const first = messages[0]?.id ?? "";
    const prev = previous.current;
    if (prev.count && first !== prev.first && messages.length > prev.count) {
      element.scrollTop += element.scrollHeight - prev.height;
    } else if (!prev.count || pinned.current) {
      element.scrollTop = element.scrollHeight;
    }
    previous.current = {
      first,
      height: element.scrollHeight,
      count: messages.length,
    };
  }, [messages]);

  function startReply(message: ChatMessage) {
    onReply?.(message);
    requestAnimationFrame(() => composer.current?.focus());
  }

  async function saveEdit(event: FormEvent, id: string) {
    event.preventDefault();
    if (!onEdit || !editDraft.trim() || actionId) return;
    setActionId(id);
    try {
      await onEdit(id, editDraft.trim());
      setEditingId(null);
      setEditDraft("");
    } catch {
      // The workspace displays the backend error and preserves the draft.
    } finally {
      setActionId(null);
    }
  }

  async function remove(id: string) {
    if (!onDelete || actionId || !confirm("Xóa tin nhắn này?")) return;
    setActionId(id);
    try {
      await onDelete(id);
    } catch {
      // The workspace displays the backend error.
    } finally {
      setActionId(null);
    }
  }

  return (
    <>
      <div
        className="chat-history"
        ref={history}
        onScroll={() => {
          const el = history.current;
          if (!el) return;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 64;
          previous.current.height = el.scrollHeight;
          if (el.scrollTop < 80 && !pinned.current && hasOlder && !loadingOlder)
            void onLoadOlder?.();
        }}
        role="log"
        aria-label="Lịch sử tin nhắn"
        tabIndex={0}
      >
        {hasOlder && (
          <button
            className="button secondary compact"
            disabled={loadingOlder}
            onClick={() => void onLoadOlder?.()}
          >
            {loadingOlder ? "Đang tải…" : "Tải tin nhắn trước"}
          </button>
        )}
        {welcome}
        {showInfo && (
          <div className="chat-info">
            <ShieldCheck size={14} />
            <span>{infoText}</span>
          </div>
        )}
        {showHistoryLabel && messages.length > 0 && (
          <div className="chat-date">
            <span /> Lịch sử trò chuyện <span />
          </div>
        )}
        <div className="messages">
          {messages.map((message, index) => {
            const continuation = belongsToSameGroup(
              messages[index - 1],
              message,
            );
            const continues = belongsToSameGroup(message, messages[index + 1]);
            const replyTarget = message.replyToId
              ? messages.find((candidate) => candidate.id === message.replyToId)
              : undefined;
            const ownMessage =
              Boolean(currentUserId) && message.senderId === currentUserId;
            const canAct = Boolean(
              message.id && !message.pending && !message.meetingId,
            );
            return (
              <div
                className={[
                  "message",
                  message.pending && "pending",
                  continuation && "continuation",
                  continues && "continues",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={
                  message.clientId ??
                  message.id ??
                  `${message.name}:${message.time}:${index}`
                }
                id={message.id ? `message-${message.id}` : undefined}
                aria-busy={message.pending || undefined}
              >
                <Avatar
                  initials={message.initials}
                  color={message.color}
                  small
                />
                <div className="message-content">
                  {continuation ? (
                    <span className="sr-only">
                      {message.name}, {message.time}
                    </span>
                  ) : (
                    <div className="message-meta">
                      <b title={message.name}>{message.name}</b>
                      {message.host && (
                        <span className="host-label">Giảng viên</span>
                      )}
                      <time dateTime={message.createdAt}>{message.time}</time>
                    </div>
                  )}
                  {message.replyToId && (
                    <button
                      type="button"
                      className="message-reply-preview"
                      onClick={() =>
                        replyTarget?.id &&
                        document
                          .getElementById(`message-${replyTarget.id}`)
                          ?.scrollIntoView({ block: "center" })
                      }
                      disabled={!replyTarget}
                    >
                      <Reply size={12} aria-hidden="true" />
                      {replyTarget ? (
                        <>
                          <b>{replyTarget.name}</b>
                          <span>{replyTarget.text}</span>
                        </>
                      ) : (
                        <span>Tin nhắn không còn tồn tại</span>
                      )}
                    </button>
                  )}
                  {editingId === message.id ? (
                    <form
                      className="message-edit-form"
                      onSubmit={(event) => void saveEdit(event, message.id!)}
                    >
                      <input
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        aria-label="Sửa nội dung tin nhắn"
                        maxLength={4000}
                        autoFocus
                        disabled={actionId === message.id}
                      />
                      <button
                        type="submit"
                        aria-label="Lưu thay đổi"
                        disabled={!editDraft.trim() || actionId === message.id}
                      >
                        <Check size={15} />
                      </button>
                      <button
                        type="button"
                        aria-label="Hủy sửa"
                        onClick={() => setEditingId(null)}
                        disabled={actionId === message.id}
                      >
                        <X size={15} />
                      </button>
                    </form>
                  ) : (
                    <div className="message-text">
                      <p>
                        {message.text
                          .split(/(\/meet\/[A-Z0-9]{12})/g)
                          .map((part, i) =>
                            /^\/meet\/[A-Z0-9]{12}$/.test(part) ? (
                              <Link
                                key={i}
                                href={part}
                                className="meeting-chat-link"
                                onClick={(event) => {
                                  if (
                                    message.meetingId &&
                                    onMeetingOpen &&
                                    !event.metaKey &&
                                    !event.ctrlKey &&
                                    !event.shiftKey &&
                                    !event.altKey
                                  ) {
                                    event.preventDefault();
                                    onMeetingOpen(message.meetingId);
                                  }
                                }}
                              >
                                Tham gia cuộc họp →
                              </Link>
                            ) : (
                              part
                            ),
                          )}
                      </p>
                      {message.editedAt && (
                        <small className="message-edited">(đã chỉnh sửa)</small>
                      )}
                    </div>
                  )}
                </div>
                {canAct &&
                  (onReply || (ownMessage && (onEdit || onDelete))) && (
                    <div
                      className="message-actions"
                      aria-label="Thao tác tin nhắn"
                    >
                      {onReply && (
                        <button
                          type="button"
                          aria-label={`Trả lời tin nhắn của ${message.name}`}
                          title="Trả lời"
                          onClick={() => startReply(message)}
                        >
                          <Reply size={15} />
                        </button>
                      )}
                      {ownMessage && onEdit && (
                        <button
                          type="button"
                          aria-label="Sửa tin nhắn"
                          title="Sửa"
                          onClick={() => {
                            setEditingId(message.id!);
                            setEditDraft(message.text);
                          }}
                        >
                          <Pencil size={14} />
                        </button>
                      )}
                      {ownMessage && onDelete && (
                        <button
                          type="button"
                          aria-label="Xóa tin nhắn"
                          title="Xóa"
                          disabled={actionId === message.id}
                          onClick={() => void remove(message.id!)}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  )}
              </div>
            );
          })}
        </div>
      </div>
      <form className="chat-form" onSubmit={onSubmit}>
        {replyingTo && (
          <div className="chat-replying">
            <Reply size={14} aria-hidden="true" />
            <span>
              Đang trả lời <b>{replyingTo.name}</b>
            </span>
            <button
              type="button"
              aria-label="Hủy trả lời"
              onClick={onCancelReply}
            >
              <X size={15} />
            </button>
          </div>
        )}
        <div className="chat-composer-row">
          <input
            ref={composer}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={placeholder}
            aria-label="Tin nhắn"
            disabled={disabled}
          />
          <button
            type="submit"
            aria-label="Gửi tin nhắn"
            disabled={disabled || !draft.trim()}
          >
            <Send size={17} />
          </button>
        </div>
      </form>
    </>
  );
}
