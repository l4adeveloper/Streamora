import { apiRequest } from "@/lib/api";

export interface RecordingItem {
  id: string;
  sessionId: string;
  title: string;
  status: string;
  fileId: string | null;
  fileStatus: string | null;
  startedAt: string;
  stoppedAt: string | null;
}
export interface RecordingProgress {
  positionSeconds: number;
  updatedAt: string | null;
}
export function listRecordings(groupId: string, cursor?: string) {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return apiRequest<{ items: RecordingItem[]; nextCursor: string | null }>(
    `/groups/${groupId}/recordings?${query}`,
    { method: "GET" },
  );
}
export function getRecording(recordingId: string) {
  return apiRequest<{
    recording: RecordingItem & { groupId: string };
    progress: RecordingProgress;
    playbackPath: string | null;
  }>(`/recordings/${recordingId}`, { method: "GET" });
}
export function getRecordingProgress(recordingId: string) {
  return apiRequest<RecordingProgress>(`/recordings/${recordingId}/progress`, {
    method: "GET",
  });
}
export function saveRecordingProgress(
  recordingId: string,
  positionSeconds: number,
) {
  return apiRequest<RecordingProgress>(`/recordings/${recordingId}/progress`, {
    method: "PUT",
    body: { positionSeconds, clientUpdatedAt: new Date().toISOString() },
  });
}
