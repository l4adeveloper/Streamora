"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Captions, AlignLeft } from "lucide-react";
import type Hls from "hls.js";
import type { VideoPlaybackResponse } from "@streamora/contracts";
import { asApiError } from "@/lib/api";
import { getVideoPlayback } from "@/lib/files/api";
import { VideoPlayerControls } from "./video-player-controls";
import {
  RecordingCaptionTrack,
  RecordingTranscriptPanel,
  recordingTranscriptStatus,
  useRecordingTranscript,
} from "./recording-transcript";

export function VideoPreview({
  fileId,
  name,
}: {
  fileId: string;
  name: string;
}) {
  const [manifest, setManifest] = useState<VideoPlaybackResponse>();
  const [sourceId, setSourceId] = useState("");
  const [levels, setLevels] = useState<{ index: number; height: number }[]>([]);
  const [level, setLevel] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const transcriptId = useId();
  const [captionsOn, setCaptionsOn] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const { transcript, requestFailed, retry } = useRecordingTranscript(fileId);
  const cues = transcript?.status === "READY" ? transcript.cues : undefined;
  const hasCaptions = !!cues?.length;
  const engine = useRef<Hls | null>(null);
  const bookmark = useRef({ time: 0, paused: true, rate: 1 });
  const sequence = useRef(0);
  const automaticRefreshAt = useRef(0);
  const remember = useCallback(() => {
    const element = video.current;
    if (element && element.readyState > 0)
      bookmark.current = {
        time: element.currentTime,
        paused: element.paused,
        rate: element.playbackRate,
      };
  }, []);
  const refresh = useCallback(
    async (preferred = "") => {
      const request = ++sequence.current;
      remember();
      setLoading(true);
      setError("");
      try {
        const response = await getVideoPlayback(fileId);
        if (request !== sequence.current) return;
        const source =
          response.sources.find((item) => item.id === preferred) ??
          response.sources.find((item) => item.kind === "hls") ??
          response.sources[0];
        if (!source) throw new Error("Missing playback source");
        setManifest(response);
        setSourceId(source.id);
        setRevision((value) => value + 1);
      } catch (cause) {
        if (request === sequence.current) {
          video.current?.pause();
          setManifest(undefined);
          setError(asApiError(cause).message);
          setLoading(false);
        }
      }
    },
    [fileId, remember],
  );
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [refresh]);
  const source = manifest?.sources.find((item) => item.id === sourceId);
  useEffect(() => {
    const element = video.current;
    if (!element || !source) return;
    let cancelled = false;
    let instance: Hls | undefined;
    setLevels([]);
    setLevel(-1);
    setLoading(true);
    function failure() {
      if (cancelled) return;
      // Seeking after a URL expires obtains a fresh grant with current group rights.
      if (
        Date.parse(source!.expiresAt) <= Date.now() + 1000 &&
        Date.now() - automaticRefreshAt.current > 5000
      ) {
        automaticRefreshAt.current = Date.now();
        void refresh(source!.id);
        return;
      }
      setLoading(false);
      setError(
        "Chưa phát được video. Trình duyệt có thể không hỗ trợ định dạng hoặc codec này. Hãy tải lại hoặc tải file xuống.",
      );
    }
    function restore() {
      const saved = bookmark.current;
      element!.playbackRate = saved.rate;
      if (saved.time > 0) {
        const time = Number.isFinite(element!.duration)
          ? Math.min(saved.time, Math.max(0, element!.duration - 0.05))
          : saved.time;
        try {
          element!.currentTime = time;
        } catch {
          /* Wait for seekable metadata on streaming containers. */
        }
      }
      if (!saved.paused) void element!.play().catch(() => {});
      setLoading(false);
    }
    element.addEventListener("loadedmetadata", restore, { once: true });
    const nativeFailure = () => {
      if (!instance) failure();
    };
    element.addEventListener("error", nativeFailure);
    if (source.kind === "hls") {
      void import("hls.js")
        .then(({ default: Hls }) => {
          if (cancelled) return;
          if (Hls.isSupported()) {
            instance = new Hls({ maxBufferLength: 30, backBufferLength: 30 });
            engine.current = instance;
            instance.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
              if (!cancelled)
                setLevels(
                  data.levels
                    .map((item, index) => ({ index, height: item.height }))
                    .filter((item) => item.height > 0),
                );
            });
            instance.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal) failure();
            });
            instance.attachMedia(element);
            instance.loadSource(source.url);
          } else if (element.canPlayType("application/vnd.apple.mpegurl")) {
            element.src = source.url;
            element.load();
          } else failure();
        })
        .catch(failure);
    } else {
      element.src = source.url;
      element.load();
    }
    return () => {
      cancelled = true;
      element.removeEventListener("loadedmetadata", restore);
      element.removeEventListener("error", nativeFailure);
      instance?.destroy();
      if (engine.current === instance) engine.current = null;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [
    source?.url,
    source?.kind,
    source?.id,
    source?.expiresAt,
    revision,
    refresh,
  ]);

  function toggleTranscript() {
    if (!transcriptOpen && document.fullscreenElement)
      void document.exitFullscreen().catch(() => {});
    setTranscriptOpen((previous) => !previous);
  }

  function changeQuality(value: string) {
    if (value.startsWith("level:")) {
      const index = Number(value.slice(6));
      if (engine.current && levels.some((item) => item.index === index)) {
        engine.current.currentLevel = index;
        setLevel(index);
      }
    } else if (value === sourceId && source?.kind === "hls") {
      if (engine.current) engine.current.currentLevel = -1;
      setLevel(-1);
    } else if (value !== sourceId) void refresh(value);
  }
  return (
    <div className="video-preview">
      {manifest && (
        <>
          <div
            className={`video-preview-layout${transcriptOpen ? " transcript-open" : ""}`}
          >
            <VideoPlayerControls
              videoRef={video}
              loading={loading}
              quality={level >= 0 ? `level:${level}` : sourceId}
              qualities={[
                ...manifest.sources
                  .filter(
                    (item) =>
                      levels.length === 0 ||
                      item.id === "original" ||
                      item.kind === "hls",
                  )
                  .map((item) => ({ value: item.id, label: item.label })),
                ...levels.map((item) => ({
                  value: `level:${item.index}`,
                  label: `${item.height}p`,
                })),
              ]}
              onQualityChange={changeQuality}
              onRefresh={() => void refresh(sourceId)}
              transcriptControls={
                <>
                  <button
                    type="button"
                    className="video-control-button"
                    aria-label="Phụ đề (CC)"
                    title={
                      recordingTranscriptStatus(transcript, requestFailed) ||
                      "Phụ đề (CC)"
                    }
                    aria-pressed={hasCaptions && captionsOn}
                    disabled={!hasCaptions}
                    onClick={() => setCaptionsOn((previous) => !previous)}
                  >
                    <Captions size={22} />
                  </button>
                  <button
                    type="button"
                    className="video-control-button"
                    aria-label="Bản chép lời"
                    title="Bản chép lời"
                    aria-expanded={transcriptOpen}
                    aria-controls={transcriptOpen ? transcriptId : undefined}
                    onClick={toggleTranscript}
                  >
                    <AlignLeft size={22} />
                  </button>
                </>
              }
            >
              <video
                ref={video}
                playsInline
                preload="metadata"
                aria-label={`Xem trước video: ${name}`}
              >
                {!!cues?.length && (
                  <RecordingCaptionTrack cues={cues} visible={captionsOn} />
                )}
              </video>
            </VideoPlayerControls>
            {transcriptOpen && (
              <RecordingTranscriptPanel
                id={transcriptId}
                videoRef={video}
                transcript={transcript}
                requestFailed={requestFailed}
                retry={retry}
                loading={loading}
              />
            )}
          </div>
          {manifest.processing.status === "NOT_REQUESTED" &&
            manifest.sources.length === 1 && (
              <p className="video-preview-note">
                Đang phát bản gốc. Các chất lượng khác sẽ xuất hiện khi video
                được xử lý.
              </p>
            )}
          {["QUEUED", "PROCESSING"].includes(manifest.processing.status) && (
            <p role="status">
              {manifest.processing.status === "QUEUED"
                ? "Video đang chờ xử lý."
                : "Đang tạo các chất lượng video"}
              {manifest.processing.progressPercent !== null
                ? ` · ${manifest.processing.progressPercent}%`
                : ""}
            </p>
          )}
          {manifest.processing.status === "FAILED" && (
            <p role="status">
              Chưa tạo được các chất lượng khác. Bạn vẫn có thể xem bản gốc.
            </p>
          )}
        </>
      )}
      {loading && <p role="status">Đang mở video…</p>}
      {error && (
        <div role="alert" className="library-error">
          <p>{error}</p>
          <button
            type="button"
            className="button secondary compact"
            onClick={() => void refresh(sourceId)}
          >
            Thử lại video
          </button>
        </div>
      )}
    </div>
  );
}
