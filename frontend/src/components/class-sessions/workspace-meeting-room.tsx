"use client";
import { useEffect, useState, type Ref } from "react";
import { useRouter } from "next/navigation";
import type {
  ClassSession,
  MeetPreview,
  MeetPreviewResponse,
} from "@streamora/contracts";
import { apiRequest, ApiError } from "@/lib/api";
import { LoadingState, RequestError } from "@/components/common/feedback";
import {
  SessionRoom,
  type SessionRoomHandle,
  type MeetingRoomState,
} from "./session-room";

export function WorkspaceMeetingRoom({
  sessionId,
  groupId,
  ref,
  onSession,
  onExit,
  onState,
  onOpenPeople,
}: {
  sessionId: string;
  groupId: string;
  ref?: Ref<SessionRoomHandle>;
  onSession: (session: ClassSession) => void;
  onExit: () => void;
  onState: (state: MeetingRoomState) => void;
  onOpenPeople: () => void;
}) {
  const router = useRouter();
  const [meeting, setMeeting] = useState<MeetPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setMeeting(null);
    setError(null);
    void apiRequest<MeetPreviewResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/access`,
    )
      .then(({ meet }) => {
        if (!current) return;
        if (meet.mode === "STANDALONE") {
          router.replace(`/meet/${meet.joinCode}`);
          return;
        }
        if (meet.groupId !== groupId)
          throw new ApiError(
            403,
            "FORBIDDEN",
            "Cuộc họp không thuộc lớp đang mở.",
          );
        setMeeting(meet);
      })
      .catch((error) => {
        if (current) setError(error);
      });
    return () => {
      current = false;
    };
  }, [sessionId, groupId, revision, router]);
  if (error)
    return (
      <RequestError error={error} onRetry={() => setRevision((x) => x + 1)} />
    );
  if (!meeting) return <LoadingState message="Đang mở phòng họp…" />;
  return (
    <SessionRoom
      key={sessionId}
      sessionId={sessionId}
      embedded
      ref={ref}
      onSession={onSession}
      onExit={onExit}
      onState={onState}
      onOpenPeople={onOpenPeople}
    />
  );
}
