"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  RecordingTranscriptCue,
  RecordingTranscriptResponse,
} from "@streamora/contracts";
import { getRecordingTranscript } from "@/lib/files/api";
import { timestamp } from "./video-player-controls";

export function useRecordingTranscript(fileId: string) {
  const [transcript, setTranscript] = useState<RecordingTranscriptResponse>();
  const [requestFailed, setRequestFailed] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await getRecordingTranscript(fileId);
        if (cancelled) return;
        setRequestFailed(false);
        setTranscript(result);
        if (result.status === "PENDING" || result.status === "PROCESSING")
          timer = setTimeout(() => void load(), 5000);
      } catch {
        if (!cancelled) setRequestFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fileId, revision]);
  return {
    transcript,
    requestFailed,
    retry: () => {
      setRequestFailed(false);
      setRevision((previous) => previous + 1);
    },
  };
}

function vttTime(timeMs: number) {
  return new Date(timeMs).toISOString().slice(11, 23);
}

export function RecordingCaptionTrack({
  cues,
  visible,
}: {
  cues: RecordingTranscriptCue[];
  visible: boolean;
}) {
  const track = useRef<HTMLTrackElement>(null);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const blocks = cues.map(({ startMs, endMs, text }) => {
      const escaped = text
        .replace(/\s+/g, " ")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return `${vttTime(startMs)} --> ${vttTime(endMs)} line:-4\n${escaped}`;
    });
    const objectUrl = URL.createObjectURL(
      new Blob([`WEBVTT\n\n${blocks.join("\n\n")}\n`], { type: "text/vtt" }),
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [cues]);
  useEffect(() => {
    if (track.current && url)
      track.current.track.mode = visible ? "showing" : "disabled";
  }, [visible, url]);
  return <track ref={track} kind="captions" src={url} label="Phụ đề tự động" />;
}

const statusText = {
  PENDING: "Phụ đề đang chờ xử lý…",
  PROCESSING: "Đang tạo phụ đề…",
  UNAVAILABLE: "Chưa có bản chép lời cho video này.",
  FAILED: "Không tạo được bản chép lời cho video này.",
  TOO_LONG: "Video từ 2 giờ trở lên chưa được hỗ trợ tạo bản chép lời.",
};

export function recordingTranscriptStatus(
  transcript: RecordingTranscriptResponse | undefined,
  requestFailed: boolean,
) {
  if (requestFailed) return "Chưa tải được bản chép lời.";
  if (!transcript) return "Đang tải bản chép lời…";
  if (transcript.status === "READY") {
    return transcript.cues.length ? "" : "Không phát hiện lời nói trong video.";
  }
  return statusText[transcript.status];
}

export function RecordingTranscriptPanel({
  id,
  videoRef,
  transcript,
  requestFailed,
  retry,
  loading,
}: {
  id: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  transcript?: RecordingTranscriptResponse;
  requestFailed: boolean;
  retry(): void;
  loading: boolean;
}) {
  const [current, setCurrent] = useState(-1);
  const rows = useRef<HTMLOListElement>(null);
  const cues = transcript?.status === "READY" ? transcript.cues : undefined;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !cues?.length) return;
    const update = () => {
      const time = video.currentTime * 1000;
      const active = cues.findIndex(
        ({ startMs, endMs }) => startMs <= time && time < endMs,
      );
      setCurrent(active);
    };
    const events = [
      "loadedmetadata",
      "timeupdate",
      "seeking",
      "seeked",
      "emptied",
    ];
    events.forEach((event) => video.addEventListener(event, update));
    update();
    return () =>
      events.forEach((event) => video.removeEventListener(event, update));
  }, [videoRef, cues]);

  useEffect(() => {
    const list = rows.current;
    const row = list?.children[current] as HTMLElement | undefined;
    if (!list || !row) return;
    const listBounds = list.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    if (rowBounds.top < listBounds.top || rowBounds.bottom > listBounds.bottom)
      list.scrollTop += rowBounds.top - listBounds.top - 8;
  }, [current, cues]);

  return (
    <aside
      id={id}
      className="recording-transcript"
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`}>Bản chép lời</h3>
      {cues?.length ? (
        <ol ref={rows}>
          {cues.map(({ startMs, text }, index) => (
            <li key={index}>
              <button
                type="button"
                aria-current={current === index ? "true" : undefined}
                disabled={loading}
                onClick={() => {
                  if (videoRef.current)
                    videoRef.current.currentTime = startMs / 1000;
                }}
              >
                <span className="transcript-time">
                  {timestamp(startMs / 1000)}
                </span>
                <span>{text}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : requestFailed ? (
        <>
          <p role="status">
            {recordingTranscriptStatus(transcript, requestFailed)}
          </p>
          <button
            type="button"
            className="button secondary compact"
            onClick={retry}
          >
            Tải lại
          </button>
        </>
      ) : (
        <p role="status">
          {recordingTranscriptStatus(transcript, requestFailed)}
        </p>
      )}
    </aside>
  );
}
