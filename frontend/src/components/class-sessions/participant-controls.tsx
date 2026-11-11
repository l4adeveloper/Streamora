"use client";

import { useCallback, useId, useRef, useState } from "react";
import type { ClassParticipationWithUser } from "@streamora/contracts";
import {
  InlineNotice,
  LoadingState,
  RequestError,
} from "@/components/common/feedback";
import { useToast } from "@/components/common/toast-provider";
import { asApiError } from "@/lib/api";
import * as api from "@/lib/class-sessions/api";
import { displayTime } from "@/lib/class-sessions/display";
import { useCursorList } from "@/lib/class-sessions/use-cursor-list";

export function ParticipantControls({
  sessionId,
  participant,
  onChange,
}: {
  sessionId: string;
  participant: ClassParticipationWithUser;
  onChange: () => void;
}) {
  const { notify } = useToast();
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const heading = useId();
  const banButton = useRef<HTMLButtonElement>(null);
  const userId = participant.userId;

  async function run(work: () => Promise<unknown>, message: string) {
    setPending(true);
    setError(null);
    try {
      await work();
      notify(message, { tone: "success" });
      setConfirm(false);
    } catch (failure) {
      const apiError = asApiError(failure);
      if (apiError.code === "MEDIA_REVOCATION_PENDING") {
        notify(apiError.message, { tone: "info" });
        setConfirm(false);
      } else setError(failure);
    } finally {
      setPending(false);
      onChange();
    }
  }

  return (
    <div className="class-participant-controls">
      <div
        className="class-actions"
        aria-label={`Điều khiển ${participant.user.fullName}`}
      >
        <button
          type="button"
          className="button secondary compact"
          disabled={pending || confirm || participant.micLocked}
          onClick={() =>
            void run(
              () => api.muteClassParticipant(sessionId, userId),
              "Đã gửi yêu cầu tắt mic.",
            )
          }
        >
          Yêu cầu tắt mic
        </button>
        <button
          type="button"
          className="button secondary compact"
          disabled={pending || confirm}
          onClick={() =>
            void run(
              () =>
                api.muteClassParticipant(
                  sessionId,
                  userId,
                  !participant.micLocked,
                ),
              participant.micLocked
                ? "Đã mở khóa quyền phát."
                : "Đã khóa quyền phát mic và camera.",
            )
          }
        >
          {participant.micLocked ? "Mở khóa mic" : "Khóa mic"}
        </button>
        <button
          ref={banButton}
          type="button"
          className="button danger compact"
          disabled={pending || confirm}
          onClick={() => {
            setError(null);
            setReason("");
            setConfirm(true);
          }}
        >
          Chặn
        </button>
      </div>
      {confirm && (
        <form
          className="class-confirm"
          aria-labelledby={heading}
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () => api.banClassParticipant(sessionId, userId, reason.trim()),
              "Đã chặn người tham gia.",
            );
          }}
        >
          <h3 id={heading}>Chặn {participant.user.fullName} khỏi buổi học?</h3>
          <label>
            Lý do (tùy chọn)
            <input
              autoFocus
              value={reason}
              maxLength={500}
              disabled={pending}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="class-actions">
            <button
              type="submit"
              className="button danger compact"
              disabled={pending}
            >
              Xác nhận chặn
            </button>
            <button
              type="button"
              className="button secondary compact"
              disabled={pending}
              onClick={() => {
                setConfirm(false);
                requestAnimationFrame(() => banButton.current?.focus());
              }}
            >
              Quay lại
            </button>
          </div>
        </form>
      )}
      {!!error && <RequestError error={error} />}
    </div>
  );
}

export function ClassBanList({
  sessionId,
  revision,
}: {
  sessionId: string;
  revision: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="class-ban-list"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Danh sách bị chặn</summary>
      {open && <BanEntries sessionId={sessionId} revision={revision} />}
    </details>
  );
}

function BanEntries({
  sessionId,
  revision,
}: {
  sessionId: string;
  revision: number;
}) {
  const { notify } = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const loader = useCallback(
    async (cursor?: string) => {
      const page = await api.listClassBans(sessionId, cursor);
      return {
        ...page,
        items: page.items.map((entry) => ({ ...entry, id: entry.userId })),
      };
    },
    [sessionId],
  );
  const list = useCursorList(loader, revision);

  async function unban(userId: string) {
    setPending(userId);
    setError(null);
    try {
      await api.unbanClassParticipant(sessionId, userId);
      notify("Đã gỡ chặn. Người dùng có thể tự vào lại nếu còn quyền.", {
        tone: "success",
      });
      await list.refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      {!!error && <RequestError error={error} />}
      {!!list.error && (
        <RequestError error={list.error} onRetry={list.refresh} />
      )}
      {list.loading && <LoadingState message="Đang tải danh sách bị chặn…" />}
      {!list.loading && !list.error && !list.items.length && (
        <InlineNotice>Chưa có ai bị chặn.</InlineNotice>
      )}
      <ul className="class-people">
        {list.items.map((entry) => (
          <li key={entry.id}>
            <div>
              <strong>{entry.fullName ?? entry.userId}</strong>
              <span>Đã chặn lúc {displayTime(entry.bannedAt)}</span>
              {entry.reason && <span>{entry.reason}</span>}
            </div>
            <button
              type="button"
              className="button secondary compact"
              disabled={!!pending}
              onClick={() => void unban(entry.userId)}
            >
              Gỡ chặn
            </button>
          </li>
        ))}
      </ul>
      {list.cursor && (
        <button
          type="button"
          className="button secondary compact"
          disabled={list.loading}
          onClick={() => void list.more()}
        >
          Xem thêm người bị chặn
        </button>
      )}
    </>
  );
}
