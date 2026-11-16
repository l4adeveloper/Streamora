"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClassRecordingStateResponse } from "@streamora/contracts";
import { asApiError } from "@/lib/api";
import {
  getClassRecording,
  startClassRecording,
  stopClassRecording,
} from "./api";

/** The browser controls recording; IVS and the backend own its lifetime. */
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
  enabled: boolean;
  onNotice: (message: string, tone?: "error") => void;
}) {
  const [state, setState] = useState<ClassRecordingStateResponse | null>(null);
  const [pending, setPending] = useState<"starting" | "stopping" | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const load = useCallback(async () => {
    try {
      const next = await getClassRecording(sessionId);
      if (mounted.current) setState(next);
    } catch {
      /* Keep the last known state during a temporary network failure. */
    }
  }, [sessionId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    }; // Leaving never stops cloud recording.
  }, []);
  useEffect(() => {
    if (!enabled || !participationId) return;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [enabled, participationId, revision, load]);
  async function start() {
    if (!participationId || busy.current) return;
    busy.current = true;
    setPending("starting");
    try {
      const { recording } = await startClassRecording(
        sessionId,
        participationId,
      );
      if (mounted.current)
        setState((current) => (current ? { ...current, recording } : current));
      await load();
      notice.current(
        "Đã yêu cầu ghi hình trên máy chủ. Bạn có thể rời phòng mà không mất bản ghi.",
      );
    } catch (error) {
      notice.current(asApiError(error).message, "error");
    } finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  }
  async function stop() {
    const recording = state?.recording;
    if (!recording || busy.current) return;
    busy.current = true;
    setPending("stopping");
    try {
      const result = await stopClassRecording(sessionId, recording.id);
      if (mounted.current)
        setState((current) =>
          current ? { ...current, recording: result.recording } : current,
        );
      notice.current(
        "Đang hoàn tất bản ghi trên S3. Các chất lượng và phụ đề sẽ được xử lý sau đó.",
      );
    } catch (error) {
      notice.current(asApiError(error).message, "error");
    } finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  }
  const live =
    state?.recording?.status === "RECORDING" ? state.recording : null;
  return {
    recording: live,
    canRecord: !!state?.canRecord,
    canStop: !!live && !!state?.canRecord,
    phase:
      pending ??
      (state?.recording?.status === "SAVING"
        ? "saving"
        : live
          ? "recording"
          : "idle"),
    start,
    stop,
  };
}
