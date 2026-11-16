"use client";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, Video, X } from "lucide-react";
import type { ClassSession } from "@streamora/contracts";
import {
  createGroupSession,
  changeClassStatus,
} from "@/lib/class-sessions/api";
import { InlineNotice } from "@/components/common/feedback";
import { SessionForm } from "./session-form";
import "./sessions.css";

export function CreateGroupMeeting({
  groupId,
  groupName,
  onCreated,
  onClose,
}: {
  groupId: string;
  groupName: string;
  onCreated: (session: ClassSession) => void;
  onClose: () => void;
}) {
  const saved = useRef<ClassSession | null>(null);
  const startKey = useRef<string | null>(null);
  const [created, setCreated] = useState<ClassSession | null>(null);
  const [mode, setMode] = useState<"instant" | "scheduled">("instant");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="workspace-meeting-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-group-meeting-title"
        data-workspace-dialog="true"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="class-toolbar">
          <div className="class-row">
            {mode === "scheduled" ? (
              <CalendarDays size={22} />
            ) : (
              <Video size={22} />
            )}
            <h2 id="create-group-meeting-title">
              {mode === "scheduled" ? "Lên lịch buổi học" : "Tạo cuộc họp"}
            </h2>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label="Đóng tạo cuộc họp"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>

        {!created && (
          <div
            className="class-row"
            style={{
              marginTop: "12px",
              gap: "8px",
              borderBottom: "1px solid var(--border)",
              paddingBottom: "12px",
            }}
          >
            <button
              type="button"
              className={`button ${mode === "instant" ? "primary" : "secondary"} compact`}
              style={{ flex: 1 }}
              onClick={() => setMode("instant")}
            >
              <Video size={15} /> Họp ngay
            </button>
            <button
              type="button"
              className={`button ${mode === "scheduled" ? "primary" : "secondary"} compact`}
              style={{ flex: 1 }}
              onClick={() => setMode("scheduled")}
            >
              <CalendarDays size={15} /> Lên lịch buổi học
            </button>
          </div>
        )}

        <p className="meeting-group-context">
          Trong lớp <strong>{groupName}</strong>
          {mode === "scheduled" && (
            <span> · Lên lịch trước và chuẩn bị tài liệu</span>
          )}
        </p>
        {created && (
          <InlineNotice>
            {created.scheduledAt
              ? `Đã lên lịch "${created.title}". Bạn có thể tải tài liệu lên trước ở trạng thái chờ cho buổi học này.`
              : `Đã tạo "${created.title}". Bấm tiếp tục để hoàn tất mở phòng.`}
          </InlineNotice>
        )}
        <SessionForm
          groupId={groupId}
          key={mode}
          group
          meeting={mode === "instant"}
          label={
            created
              ? "Tiếp tục mở phòng"
              : mode === "scheduled"
                ? "Lên lịch buổi học"
                : "Tạo cuộc họp"
          }
          locked={!!created}
          onSave={async (body, key) => {
            if (!saved.current) {
              const { session } = await createGroupSession(
                groupId,
                {
                  title: body.title || undefined,
                  description: body.description ?? undefined,
                  scheduledAt: body.scheduledAt || undefined,
                  allowGuests: body.allowGuests,
                  createLessonFolder: body.createLessonFolder,
                  materialFileIds: body.materialFileIds,
                },
                key,
              );
              saved.current = session;
              window.dispatchEvent(
                new CustomEvent("streamora:meetings-changed", {
                  detail: { groupId },
                }),
              );
              if (mounted.current) setCreated(session);
            }
            let session = saved.current;
            if (!body.scheduledAt) {
              startKey.current ??= crypto.randomUUID();
              session = (
                await changeClassStatus(session.id, "start", startKey.current)
              ).session;
            }
            window.dispatchEvent(
              new CustomEvent("streamora:meetings-changed", {
                detail: { groupId },
              }),
            );
            if (mounted.current) onCreated(session);
          }}
        />
      </section>
    </div>
  );
}
