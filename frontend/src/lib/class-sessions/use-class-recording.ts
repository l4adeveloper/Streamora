"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClassRecording,
  ClassRecordingLayout,
  ClassRecordingStateResponse,
} from "@streamora/contracts";
import { asApiError } from "@/lib/api";
import { uploadFile } from "@/lib/files/upload";
import {
  completeClassRecording,
  failClassRecording,
  getClassRecording,
  heartbeatClassRecording,
  startClassRecording,
  stopClassRecording,
  updateClassRecordingLayout,
} from "./api";
import { ClassRecorder, recordingSupported, type RecorderScene } from "./class-recorder";

export type RecordingPhase = "idle" | "starting" | "recording" | "saving";
interface Active {
  recording: ClassRecording;
  recorder: ClassRecorder;
  groupId: string;
  title: string;
  heartbeat: ReturnType<typeof setInterval>;
}

function fileName(title: string, startedAt: number, extension: string) {
  const time = new Date(startedAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${pad(time.getDate())}-${pad(time.getMonth() + 1)}-${time.getFullYear()} ${pad(time.getHours())}h${pad(time.getMinutes())}`;
  // Keep the name valid for every file system and the 255-character limit.
  return `${title.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").trim() || "Buổi học"} - ${stamp}.${extension}`.slice(-200);
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function useClassRecording({
  sessionId,
  participationId,
  revision,
  enabled,
  onNotice,
}: {
  sessionId: string;
  participationId: string | null;
  revision: number;
  /** False once the room closes; an active recording is then saved. */
  enabled: boolean;
  onNotice: (message: string, tone?: "error") => void;
}) {
  const [state, setState] = useState<ClassRecordingStateResponse | null>(null);
  const [phase, setPhase] = useState<RecordingPhase>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [fallback, setFallback] = useState<{ blob: Blob; name: string } | null>(null);
  const active = useRef<Active | null>(null);
  const mounted = useRef(true);
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const supported = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await getClassRecording(sessionId);
      if (mounted.current) setState(next);
      return next;
    } catch {
      return null;
    }
  }, [sessionId]);

  // Saving is not tied to this component: leaving the room still uploads.
  const finish = useCallback(async () => {
    const current = active.current;
    if (!current) return;
    active.current = null;
    clearInterval(current.heartbeat);
    if (mounted.current) {
      setPhase("saving");
      setProgress(0);
    }
    const { recording, recorder } = current;
    void stopClassRecording(sessionId, recording.id).catch(() => {});
    const blob = await recorder.stop();
    const name = fileName(current.title, recorder.startedAt, recorder.extension);
    try {
      if (!blob.size) throw new Error("EMPTY_RECORDING");
      const file = new File([blob], name, { type: recorder.fileType });
      const upload = await uploadFile(file, current.groupId, {
        signal: new AbortController().signal,
        onSession: () => {},
        onProgress: (percent) => {
          if (mounted.current) setProgress(percent);
        },
        source: "LOCAL_RECORDING",
        sessionId,
      });
      const saved: { file?: { id: string } } = await upload.complete();
      if (!saved.file) throw new Error("UPLOAD_INCOMPLETE");
      await completeClassRecording(sessionId, recording.id, saved.file.id);
      notice.current("Đã lưu bản ghi vào Bản ghi bài giảng.");
    } catch {
      void failClassRecording(sessionId, recording.id).catch(() => {});
      // Never lose the recording: offer it for download, or save it now if
      // the room is already gone.
      if (mounted.current) setFallback({ blob, name });
      else download(blob, name);
      notice.current(
        "Không tải được bản ghi lên thư viện. Hãy tải file về máy để giữ lại bản ghi.",
        "error",
      );
    } finally {
      if (mounted.current) {
        setPhase("idle");
        setProgress(null);
        void load();
      }
    }
  }, [load, sessionId]);

  useEffect(() => {
    mounted.current = true;
    supported.current = recordingSupported();
    return () => {
      mounted.current = false;
      void finish();
    };
  }, [finish]);

  useEffect(() => {
    if (enabled && participationId) void load();
  }, [enabled, load, participationId, revision]);

  // Another manager may stop the recording; the recorder then saves its file.
  useEffect(() => {
    const mine = active.current?.recording.id;
    if (mine && state?.recording?.id === mine && state.recording.status !== "RECORDING")
      void finish();
  }, [finish, state]);
  useEffect(() => {
    if ((!enabled || !participationId) && active.current) void finish();
  }, [enabled, finish, participationId]);

  useEffect(() => {
    if (phase === "idle") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  async function start(scene: RecorderScene) {
    if (!participationId || active.current || phase !== "idle") return;
    if (!supported.current) {
      notice.current("Trình duyệt này chưa hỗ trợ ghi hình. Hãy dùng Chrome hoặc Edge mới.", "error");
      return;
    }
    setPhase("starting");
    setFallback(null);
    try {
      const { recording } = await startClassRecording(sessionId, participationId);
      const info = state ?? (await load());
      if (!info?.groupId) throw new Error("RECORDING_REQUIRES_GROUP");
      const recorder = new ClassRecorder(scene, () => {
        notice.current("Trình duyệt dừng ghi hình đột ngột. Đang lưu phần đã ghi.", "error");
        void finish();
      });
      const heartbeat = setInterval(() => {
        void heartbeatClassRecording(sessionId, recording.id).catch((error) => {
          if (asApiError(error).status === 409) void finish();
        });
      }, 15000);
      active.current = {
        recording,
        recorder,
        groupId: info.groupId,
        title: info.title,
        heartbeat,
      };
      setPhase("recording");
      setState((current) => (current ? { ...current, recording } : current));
    } catch (error) {
      setPhase("idle");
      const failure = asApiError(error);
      notice.current(
        failure.code === "UNKNOWN_ERROR"
          ? "Không thể bắt đầu ghi hình. Hãy thử lại."
          : failure.message,
        "error",
      );
    }
  }

  const updateScene = useCallback((scene: RecorderScene) => {
    active.current?.recorder.update(scene);
  }, []);

  async function setLayout(layout: Partial<ClassRecordingLayout>) {
    const recording = state?.recording;
    if (!recording || recording.status !== "RECORDING") return;
    // Apply locally first so the presenter sees the change immediately.
    setState((current) =>
      current?.recording
        ? {
            ...current,
            recording: {
              ...current.recording,
              layout: { ...current.recording.layout, ...layout },
            },
          }
        : current,
    );
    try {
      const { recording: saved } = await updateClassRecordingLayout(
        sessionId,
        recording.id,
        layout,
      );
      if (mounted.current) setState((current) => (current ? { ...current, recording: saved } : current));
    } catch (error) {
      notice.current(asApiError(error).message, "error");
      void load();
    }
  }

  const live = state?.recording?.status === "RECORDING" ? state.recording : null;
  return {
    recording: live,
    canRecord: !!state?.canRecord,
    isRecorder: phase === "recording",
    phase,
    progress,
    fallback,
    downloadFallback: () => {
      if (fallback) download(fallback.blob, fallback.name);
      setFallback(null);
    },
    start,
    stop: () => void finish(),
    updateScene,
    setLayout,
  };
}
