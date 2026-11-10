"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MeetPreview, MeetPreviewResponse } from "@streamora/contracts";
import { apiRequest } from "@/lib/api";
import { LoadingState, RequestError } from "@/components/common/feedback";
import { PageShell } from "@/components/shell/page-shell";
import { SessionRoom } from "./session-room";

export function MeetingEntry({
  code,
  sessionId,
  workspace = false,
}: {
  code?: string;
  sessionId?: string;
  workspace?: boolean;
}) {
  const router = useRouter();
  const [meeting, setMeeting] = useState<MeetPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await apiRequest<MeetPreviewResponse>(
        code
          ? `/meets/${encodeURIComponent(code.toUpperCase())}`
          : `/sessions/${encodeURIComponent(sessionId!)}/access`,
      );
      setMeeting(result.meet);
      if (result.meet.mode === "WORKSPACE")
        router.replace(
          `/workspace?groupId=${result.meet.groupId}&meetingId=${result.meet.id}`,
        );
      else if (result.meet.mode === "STANDALONE" && workspace)
        router.replace(`/meet/${result.meet.joinCode}`);
    } catch (error) {
      setMeeting(null);
      setError(error);
    }
  }, [code, sessionId, workspace, router]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error)
    return (
      <PageShell title="Không thể tham gia cuộc họp">
        <RequestError error={error} onRetry={load} />
      </PageShell>
    );
  if (!meeting || meeting.mode === "WORKSPACE" || workspace)
    return <LoadingState message="Đang kiểm tra quyền tham gia…" />;
  const room = <SessionRoom meetCode={meeting.joinCode} />;
  return room;
}
