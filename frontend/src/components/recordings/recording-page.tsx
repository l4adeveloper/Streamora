"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { VideoPreview } from "@/components/files/video-preview";
import { asApiError } from "@/lib/api";
import { getRecording } from "@/lib/recordings/api";

type Detail = Awaited<ReturnType<typeof getRecording>>;
export function RecordingPage({ recordingId }: { recordingId: string }) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void getRecording(recordingId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(asApiError(cause).message);
      });
    return () => {
      cancelled = true;
    };
  }, [recordingId]);
  return (
    <main className="page-shell">
      {detail && (
        <Link href={`/groups/${detail.recording.groupId}/recordings`}>
          ← Danh sách bản ghi
        </Link>
      )}
      {error && <p role="alert">{error}</p>}
      {!detail && !error && <p role="status">Đang tải bản ghi…</p>}
      {detail && (
        <>
          <h1>{detail.recording.title}</h1>
          {detail.playbackPath && detail.recording.fileId ? (
            <VideoPreview
              fileId={detail.recording.fileId}
              recordingId={recordingId}
              name={detail.recording.title}
            />
          ) : (
            <p role="status">
              {detail.recording.status === "FAILED"
                ? "Bản ghi lưu thất bại."
                : "Bản ghi chưa sẵn sàng để phát."}
            </p>
          )}
        </>
      )}
    </main>
  );
}
