"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import type { GroupChatThread } from "@streamora/contracts";
import { apiRequest } from "@/lib/api";

export function ThreadRenameDialog({
  thread,
  onSaved,
  onClose,
}: {
  thread: GroupChatThread;
  onSaved: (thread: GroupChatThread) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const savingRef = useRef(false);
  const [title, setTitle] = useState(thread.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    input.current?.select();
    return () => {
      active.current = false;
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="modal qa-rename-dialog"
      aria-labelledby="qa-rename-heading"
      aria-describedby="qa-rename-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!savingRef.current) onClose();
      }}
    >
      <div className="qa-rename-heading">
        <h2 id="qa-rename-heading">Đổi tên chủ đề</h2>
        <button
          type="button"
          className="qa-icon-button"
          aria-label="Đóng đổi tên chủ đề"
          disabled={saving}
          onClick={onClose}
        >
          <X size={20} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </div>
      <p id="qa-rename-description">
        Tên rõ ràng giúp mọi người dễ tìm và theo dõi câu hỏi.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const nextTitle = title.trim();
          if (!nextTitle || savingRef.current) return;
          if (nextTitle === thread.title) {
            onClose();
            return;
          }
          savingRef.current = true;
          setSaving(true);
          setError("");
          try {
            const result = await apiRequest<{ thread: GroupChatThread }>(
              `/groups/${thread.groupId}/chat/threads/${thread.id}`,
              { method: "PATCH", body: { title: nextTitle } },
            );
            if (active.current) onSaved(result.thread);
          } catch {
            if (active.current)
              setError("Không thể đổi tên chủ đề. Vui lòng thử lại.");
          } finally {
            savingRef.current = false;
            if (active.current) setSaving(false);
          }
        }}
      >
        <label htmlFor="qa-rename-title">Tên chủ đề</label>
        <input
          ref={input}
          id="qa-rename-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={120}
          required
          readOnly={saving}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "qa-rename-error" : undefined}
        />
        {error && (
          <p id="qa-rename-error" role="alert">
            {error}
          </p>
        )}
        <div className="qa-rename-actions">
          <button
            type="button"
            className="button secondary compact"
            disabled={saving}
            onClick={onClose}
          >
            Hủy
          </button>
          <button
            className="button primary compact"
            disabled={saving || !title.trim()}
          >
            {saving && (
              <LoaderCircle
                size={16}
                className="ui-spinner"
                aria-hidden="true"
              />
            )}
            {saving ? "Đang lưu…" : "Lưu tên"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
