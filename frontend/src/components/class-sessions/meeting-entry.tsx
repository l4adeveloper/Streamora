"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MeetPreview, MeetPreviewResponse } from "@streamora/contracts";
import { apiRequest } from "@/lib/api";
import { LoadingState, RequestError } from "@/components/common/feedback";
import { PageShell } from "@/components/shell/page-shell";
import { Workspace } from "@/components/workspace";
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
  const updateTitle = useCallback(
    (title: string) =>
      setMeeting((current) =>
        current && current.title !== title ? { ...current, title } : current,
      ),
    [],
  );
  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await apiRequest<MeetPreviewResponse>(
        code
          ? `/meets/${encodeURIComponent(code.toUpperCase())}`
          : `/sessions/${encodeURIComponent(sessionId!)}/access`,
      );
      setMeeting(result.meet);
      if (result.meet.mode === "WORKSPACE" && !workspace)
        router.replace(
          `/workspace/meetings/${result.meet.id}?groupId=${result.meet.groupId}`,
        );
      else if (result.meet.mode === "STANDALONE" && workspace)
        router.replace(`/meet/${result.meet.joinCode}`);
      else if (
        workspace &&
        new URLSearchParams(location.search).get("groupId") !==
          result.meet.groupId
      )
        router.replace(
          `/workspace/meetings/${result.meet.id}?groupId=${result.meet.groupId}`,
        );
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
  if (!meeting || (meeting.mode === "WORKSPACE") !== workspace)
    return <LoadingState message="Đang kiểm tra quyền tham gia…" />;
  const room = (
    <SessionRoom
      sessionId={workspace ? meeting.id : undefined}
      meetCode={workspace ? undefined : meeting.joinCode}
      embedded={workspace}
      onTitle={updateTitle}
    />
  );
  return workspace ? (
    <Workspace
      view="meetings"
      meetingTitle={meeting.title}
      meetingGroupId={meeting.groupId!}
      meetingCode={meeting.joinCode}
    >
      {room}
    </Workspace>
  ) : (
    room
  );
}
