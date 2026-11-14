"use client";
import Link from "next/link";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Check,
  LoaderCircle,
  Pencil,
  Reply,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { Avatar } from "./ui";
import type { ChatMessage } from "./demo-data";
import { useChatScroll } from "@/lib/memberships/use-chat-scroll";

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
  targetMessageId,
  historyReady = true,
  latestVersion = 0,
  onJumpToLatest,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  hasNewer = false,
  loadingNewer = false,
  loadingTarget = false,
  onLoadNewer,
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
  historyReady?: boolean;
  latestVersion?: number;
  onJumpToLatest?: () => Promise<void>;
  targetMessageId?: string;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<void>;
  hasNewer?: boolean;
  loadingNewer?: boolean;
  loadingTarget?: boolean;
  onLoadNewer?: () => Promise<void>;
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
  const composer = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);
  const scroll = useChatScroll({
    messages,
    targetMessageId,
    hasNewer,
    loadingTarget,
    latestVersion,
  });
  const { history, highlightId } = scroll;
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const userScrolling = useRef(false);
  const autoFilledPage = useRef("");
  useEffect(() => {
    const el = history.current;
    if (
      !el ||
      !historyReady ||
      !hasOlder ||
      loadingOlder ||
      loadingTarget ||
      targetMessageId ||
      hasNewer ||
      !onLoadOlder
    )
      return;
    const page = [messages[0]?.id, messages.at(-1)?.id, messages.length].join(
      ":",
    );
    if (
      el.scrollHeight > el.clientHeight + 1 ||
      autoFilledPage.current === page
    )
      return;
    autoFilledPage.current = page;
    void onLoadOlder();
  }, [
    messages,
    historyReady,
    hasOlder,
    loadingOlder,
    loadingTarget,
    targetMessageId,
    hasNewer,
    onLoadOlder,
    history,
  ]);

  function loadOlder() {
    scroll.rememberAnchor();
    return onLoadOlder?.();
  }
  function interruptScroll() {
    userScrolling.current = true;
    const interrupted = scroll.stopJump();
    const el = history.current;
    if (el && interrupted)
      el.scrollTo({ top: el.scrollTop, behavior: "instant" });
  }

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
      <div className="chat-scroll-region">
        <div
          className="chat-history"
          ref={history}
          onWheel={interruptScroll}
          onPointerDown={interruptScroll}
          onTouchStart={interruptScroll}
          onKeyDown={(event) => {
            if (
              [
                "ArrowUp",
                "ArrowDown",
                "PageUp",
                "PageDown",
                "Home",
                "End",
                " ",
              ].includes(event.key)
            )
              interruptScroll();
          }}
          onScroll={() => {
            const el = history.current;
            if (!el) return;
            const delta = scroll.onScroll();
            if (delta === undefined || !userScrolling.current || loadingTarget)
              return;
            if (delta < 0 && el.scrollTop < 160 && hasOlder && !loadingOlder)
              void loadOlder();
            if (
              delta > 0 &&
              el.scrollHeight - el.scrollTop - el.clientHeight < 160 &&
              hasNewer &&
              !loadingNewer
            )
              void onLoadNewer?.();
          }}
          role="log"
          aria-label="Lịch sử tin nhắn"
          tabIndex={0}
        >
          <div ref={scroll.content} className="chat-history-content">
            {hasOlder && (
              <div className="chat-history-page-control">
                <button
                  type="button"
                  className="chat-history-more"
                  disabled={loadingOlder || loadingTarget}
                  onClick={() => void loadOlder()}
                >
                  {loadingOlder && (
                    <LoaderCircle
                      size={13}
                      className="ui-spinner"
                      aria-hidden="true"
                    />
                  )}
                  {loadingOlder ? "Đang tải tin cũ…" : "Xem tin nhắn cũ hơn"}
                </button>
              </div>
            )}
            {historyReady && !hasOlder && !loadingTarget && welcome}
            {historyReady && !hasOlder && !loadingTarget && showInfo && (
              <div className="chat-info">
                <ShieldCheck size={14} />
                <span>{infoText}</span>
              </div>
            )}
            {historyReady &&
              !hasOlder &&
              !loadingTarget &&
              showHistoryLabel &&
              messages.length > 0 && (
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
                const continues = belongsToSameGroup(
                  message,
                  messages[index + 1],
                );
                const replyTarget = message.replyToId
                  ? messageById.get(message.replyToId)
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
                      message.id === highlightId && "search-target",
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
                    data-message-id={message.id}
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
                          <time dateTime={message.createdAt}>
                            {message.time}
                          </time>
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
                          onSubmit={(event) =>
                            void saveEdit(event, message.id!)
                          }
                        >
                          <input
                            value={editDraft}
                            onChange={(event) =>
                              setEditDraft(event.target.value)
                            }
                            aria-label="Sửa nội dung tin nhắn"
                            maxLength={4000}
                            autoFocus
                            disabled={actionId === message.id}
                          />
                          <button
                            type="submit"
                            aria-label="Lưu thay đổi"
                            disabled={
                              !editDraft.trim() || actionId === message.id
                            }
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
                            <small className="message-edited">
                              (đã chỉnh sửa)
                            </small>
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
            {hasNewer && (
              <div className="chat-history-page-control">
                <button
                  type="button"
                  className="chat-history-more"
                  disabled={loadingNewer || loadingTarget}
                  onClick={() => void onLoadNewer?.()}
                >
                  {loadingNewer ? "Đang tải tin mới…" : "Xem tin nhắn mới hơn"}
                </button>
              </div>
            )}
          </div>
        </div>
        {(scroll.awayFromLatest || hasNewer) && (
          <button
            type="button"
            className="chat-jump-latest button secondary compact"
            disabled={loadingTarget}
            onClick={() => {
              if (hasNewer && onJumpToLatest) void onJumpToLatest();
              else scroll.scrollToLatest();
            }}
          >
            Đi tới tin mới nhất ↓
          </button>
        )}
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
