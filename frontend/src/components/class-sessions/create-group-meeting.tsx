"use client";
import { useEffect, useRef, useState } from "react";
import { Video, X } from "lucide-react";
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
            <Video size={22} />
            <h2 id="create-group-meeting-title">Tạo cuộc họp</h2>
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
        <p className="meeting-group-context">
          Trong lớp <strong>{groupName}</strong>
        </p>
        {created && (
          <InlineNotice>
            Đã tạo {created.title}. Bấm tiếp tục để hoàn tất mở phòng.
          </InlineNotice>
        )}
        <SessionForm
          group
          meeting
          label={created ? "Tiếp tục mở phòng" : "Tạo cuộc họp"}
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
