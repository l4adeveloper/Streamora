"use client";

import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { Send, ShieldCheck } from "lucide-react";
import { Avatar } from "./ui";
import type { ChatMessage } from "./demo-data";

export function WorkspaceChat({
  messages,
  draft,
  onDraftChange,
  onSubmit,
  welcome,
}: {
  messages: ChatMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  welcome?: ReactNode;
}) {
  const history = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = history.current;
    if (!element) return;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }, [messages]);

  return (
    <>
      <div
        className="chat-history"
        ref={history}
        role="log"
        aria-label="Lịch sử tin nhắn"
        tabIndex={0}
      >
        {welcome}
        <div className="chat-info">
          <ShieldCheck size={14} />
          <span>Cuộc trò chuyện được lưu trong cộng đồng</span>
        </div>
        {messages.length > 0 && (
          <div className="chat-date">
            <span /> Hôm nay <span />
          </div>
        )}
        <div className="messages">
          {messages.map((message, index) => (
            <div className="message" key={index}>
              <Avatar initials={message.initials} color={message.color} small />
              <div>
                <div className="message-meta">
                  <b>{message.name}</b>
                  {message.host && (
                    <span className="host-label">Giảng viên</span>
                  )}
                  <time>{message.time}</time>
                </div>
                <p>{message.text}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
      <form className="chat-form" onSubmit={onSubmit}>
        <div>
          <input
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Gửi lời nhắn đến mọi người…"
            aria-label="Tin nhắn"
          />
          <button
            type="submit"
            aria-label="Gửi tin nhắn"
            disabled={!draft.trim()}
          >
            <Send size={17} />
          </button>
        </div>
        <small>
          <span className="status-dot" /> Cùng nhau tạo nên một không gian tích
          cực.
        </small>
      </form>
    </>
  );
}
