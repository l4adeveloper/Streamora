"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Captions, AlignLeft } from "lucide-react";
import type Hls from "hls.js";
import type { VideoPlaybackResponse } from "@streamora/contracts";
import { ApiError, asApiError } from "@/lib/api";
import {
  getVideoPlayback,
  getVideoProcessing,
  requestVideoProcessing,
} from "@/lib/files/api";
import { VideoPlayerControls } from "./video-player-controls";
import {
  getRecordingProgress,
  getRecordingPlayback,
  saveRecordingProgress,
} from "@/lib/recordings/api";
import {
  RecordingCaptionTrack,
  RecordingTranscriptPanel,
  recordingTranscriptStatus,
  useRecordingTranscript,
} from "./recording-transcript";

export function VideoPreview({
  fileId,
  name,
  recordingId,
  playbackMode = "VOD",
}: {
  fileId: string;
  name: string;
  recordingId?: string;
  playbackMode?: "VOD" | "LIVE_DVR";
}) {
  const [manifest, setManifest] = useState<VideoPlaybackResponse>();
  const [sourceId, setSourceId] = useState("");
  const [levels, setLevels] = useState<
    { index: number; width: number; height: number; bitrate: number }[]
  >([]);
  const [activeQuality, setActiveQuality] = useState("");
  const [nativeQuality, setNativeQuality] = useState("");
  const [variantId, setVariantId] = useState("");
  const nativeManual = useRef<{ width: number; height: number } | null>(null);
  const manual = useRef<{
    width: number;
    height: number;
    bitrate: number;
  } | null>(null);
  const pausedFrame = useRef<{ time: number; level: number } | null>(null);
  const denied = useRef(false);
  const [level, setLevel] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [requestingProcessing, setRequestingProcessing] = useState(false);
  const [processingError, setProcessingError] = useState("");
  const processingRequest = useRef<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const transcriptId = useId();
  const [captionsOn, setCaptionsOn] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const { transcript, requestFailed, retry } = useRecordingTranscript(
    fileId,
    playbackMode === "VOD",
  );
  const cues = transcript?.status === "READY" ? transcript.cues : undefined;
  const hasCaptions = !!cues?.length;
  const engine = useRef<Hls | null>(null);
  const bookmark = useRef({
    time: 0,
    paused: true,
    rate: 1,
    volume: 1,
    muted: false,
  });
  const sequence = useRef(0);
  const automaticRefreshAt = useRef(0);
  const networkSource = useRef("");
  const fallbackAvailable = useRef(false);
  const failedSources = useRef(new Set<string>());
  const remember = useCallback(() => {
    const element = video.current;
    if (
      element &&
      Number.isFinite(element.currentTime) &&
      (element.readyState > 0 || element.seeking || element.currentTime > 0)
    )
      bookmark.current = {
        time: element.currentTime,
        paused: element.paused,
        rate: element.playbackRate,
        volume: element.volume,
        muted: element.muted,
      };
  }, []);
  const refresh = useCallback(
    async (preferred = "", renewOnly = false, failedNetworkSource?: string) => {
      const request = ++sequence.current;
      remember();
      if (!renewOnly) setLoading(true);
      setError("");
      try {
        const response = recordingId
          ? await getRecordingPlayback(
              recordingId,
              bookmark.current.time,
              networkSource.current || undefined,
              failedNetworkSource,
              playbackMode,
            )
          : await getVideoPlayback(fileId);
        if (request !== sequence.current) return;
        // A viewer may seek again while the resolver request is in flight.
        // Keep the latest position, rather than the request's earlier snapshot.
        if (!renewOnly) remember();
        if ("sourceId" in response && typeof response.sourceId === "string") {
          if (
            failedNetworkSource &&
            failedSources.current.has(response.sourceId)
          )
            throw new ApiError(
              503,
              "PLAYBACK_SOURCE_UNAVAILABLE",
              "Các nguồn phát hiện chưa khả dụng. Hãy thử lại sau.",
            );
          networkSource.current = response.sourceId;
          fallbackAvailable.current =
            "fallbackAvailable" in response &&
            response.fallbackAvailable === true;
        }
        denied.current = false;
        if (nativeManual.current) {
          const preference = nativeManual.current;
          const selected = response.qualities?.find(
            (q) =>
              q.width === preference.width && q.height === preference.height,
          );
          if (!selected) throw new Error("Selected quality unavailable");
          // hls.js switches levels without replacing its MediaSource or buffer.
          if (!engine.current) setNativeQuality(selected.id);
          setVariantId(selected.id);
        }
        const source =
          response.sources.find((item) => item.id === preferred) ??
          response.sources.find((item) => item.kind === "hls") ??
          response.sources[0];
        setManifest(response);
        setSourceId(source?.id ?? "");
        if (!source) setLoading(false);
        if (!renewOnly) setRevision((value) => value + 1);
      } catch (cause) {
        if (request === sequence.current) {
          if (asApiError(cause).status === 403) denied.current = true;
          video.current?.pause();
          setManifest(undefined);
          setError(asApiError(cause).message);
          setLoading(false);
        }
      }
    },
    [fileId, recordingId, remember, playbackMode],
  );
  useEffect(() => {
    denied.current = false;
    networkSource.current = "";
    fallbackAvailable.current = false;
    failedSources.current.clear();
    let cancelled = false;
    void (async () => {
      if (recordingId && playbackMode === "VOD") {
        try {
          const progress = await getRecordingProgress(recordingId);
          if (cancelled) return;
          bookmark.current.time = progress.positionSeconds;
        } catch {
          if (cancelled) return;
        }
      }
      if (!cancelled) void refresh();
    })();
    return () => {
      cancelled = true;
      sequence.current++;
    };
  }, [refresh, recordingId, playbackMode]);
  useEffect(() => {
    const element = video.current;
    if (!recordingId || !element || playbackMode === "LIVE_DVR") return;
    let lastSaved = 0;
    const save = (force = false) => {
      if (
        element.readyState === 0 ||
        denied.current ||
        !Number.isFinite(element.currentTime) ||
        element.currentTime < 0
      )
        return;
      const now = Date.now();
      if (!force && now - lastSaved < 5000) return;
      lastSaved = now;
      void saveRecordingProgress(recordingId, element.currentTime).catch(
        () => {},
      );
    };
    const periodic = () => save();
    const flush = () => save(true);
    element.addEventListener("timeupdate", periodic);
    element.addEventListener("pause", flush);
    element.addEventListener("ended", flush);
    return () => {
      element.removeEventListener("timeupdate", periodic);
      element.removeEventListener("pause", flush);
      element.removeEventListener("ended", flush);
      flush();
    };
  }, [recordingId, manifest?.fileId, playbackMode]);
  const source = manifest?.sources.find((item) => item.id === sourceId);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.addEventListener("seeking", remember);
    return () => element.removeEventListener("seeking", remember);
  }, [manifest?.fileId, remember]);
  useEffect(() => {
    if (
      !manifest ||
      denied.current ||
      !["QUEUED", "PROCESSING"].includes(manifest.processing.status)
    )
      return;
    let cancelled = false;
    const timer = setInterval(() => {
      void getVideoProcessing(fileId)
        .then((status) => {
          if (cancelled) return;
          setManifest((previous) =>
            previous ? { ...previous, processing: status } : previous,
          );
          if (status.status === "READY") void refresh();
          else if (status.status === "FAILED") void refresh(sourceId);
        })
        .catch((cause) => {
          if (!cancelled && asApiError(cause).status === 403) {
            denied.current = true;
            video.current?.pause();
            setManifest(undefined);
            setError(asApiError(cause).message);
          }
        });
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fileId, manifest?.processing.status, refresh, sourceId]);
  useEffect(() => {
    if (!source || source.public || denied.current) return;
    const timer = setTimeout(
      () => {
        if (!denied.current) void refresh(sourceId, true);
      },
      Math.max(1000, Date.parse(source.expiresAt) - Date.now() - 15000),
    );
    return () => clearTimeout(timer);
  }, [source?.expiresAt, source?.public, sourceId, refresh]);
  useEffect(() => {
    const element = video.current;
    if (!element || !source) return;
    let cancelled = false;
    let instance: Hls | undefined;
    let nativeAttached = false;
    let mediaRecoveries = 0;
    setLevels([]);
    setLevel(-1);
    setLoading(true);
    function failure(message?: string) {
      if (cancelled) return;
      // Seeking after a URL expires obtains a fresh grant with current group rights.
      if (
        !source!.public &&
        Date.parse(source!.expiresAt) <= Date.now() + 1000 &&
        Date.now() - automaticRefreshAt.current > 5000
      ) {
        automaticRefreshAt.current = Date.now();
        void refresh(source!.id);
        return;
      }
      if (
        recordingId &&
        fallbackAvailable.current &&
        networkSource.current &&
        !failedSources.current.has(networkSource.current)
      ) {
        const failed = networkSource.current;
        failedSources.current.add(failed);
        void refresh(source!.id, false, failed);
        return;
      }
      setLoading(false);
      setError(
        message ??
          "Chưa phát được video. Trình duyệt có thể không hỗ trợ định dạng hoặc codec này. Hãy tải lại hoặc tải file xuống.",
      );
    }
    function restore() {
      const saved = bookmark.current;
      element!.playbackRate = saved.rate;
      element!.volume = saved.volume;
      element!.muted = saved.muted;
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
      setError("");
      setLoading(false);
    }
    element.addEventListener("loadedmetadata", restore, { once: true });
    const nativeFailure = () => {
      if (!instance && (source.kind !== "hls" || nativeAttached)) failure();
    };
    element.addEventListener("error", nativeFailure);
    if (source.kind === "hls") {
      void import("hls.js")
        .then(({ default: Hls }) => {
          if (cancelled) return;
          if (Hls.isSupported()) {
            instance = new Hls({
              maxBufferLength: 30,
              maxMaxBufferLength: 30,
              // Keep visited ranges when seeking in either direction. The browser
              // and hls.js quota recovery can evict media under memory pressure.
              backBufferLength: Infinity,
              frontBufferFlushThreshold: Infinity,
              xhrSetup: (xhr, url) => {
                xhr.withCredentials =
                  !source.public &&
                  !["Key-Pair-Id", "KeyName", "X-Amz-Signature"].some((key) =>
                    new URL(url, window.location.href).searchParams.has(key),
                  );
              },
              fetchSetup: (context, init) =>
                new Request(context.url, {
                  ...init,
                  credentials:
                    source.public ||
                    ["Key-Pair-Id", "KeyName", "X-Amz-Signature"].some((key) =>
                      new URL(
                        context.url,
                        window.location.href,
                      ).searchParams.has(key),
                    )
                      ? "omit"
                      : "include",
                }),
            });
            engine.current = instance;
            instance.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
              if (!cancelled) {
                setError("");
                setLevels(
                  data.levels
                    .map((item, index) => ({
                      index,
                      width: item.width,
                      height: item.height,
                      bitrate: item.bitrate,
                    }))
                    .filter((item) => item.height > 0)
                    .sort(
                      (a, b) =>
                        Math.min(b.width, b.height) -
                        Math.min(a.width, a.height),
                    ),
                );
              }
              const preference = manual.current;
              if (preference) {
                const index = data.levels.findIndex(
                  (l) =>
                    l.width === preference.width &&
                    l.height === preference.height,
                );
                if (index >= 0) {
                  instance!.currentLevel = index;
                  setLevel(index);
                } else {
                  instance!.stopLoad();
                  element.pause();
                  setLoading(false);
                  setError(
                    "Mức chất lượng đã chọn không còn khả dụng. Hãy chọn lại chất lượng.",
                  );
                }
              }
            });
            instance.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
              const l = instance!.levels[data.level];
              if (l && !cancelled) setActiveQuality(label(l.width, l.height));
            });
            instance.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
              const frame = pausedFrame.current;
              if (frame && Math.abs(element.currentTime - frame.time) > 0.1) {
                // A newer user seek takes precedence over a pending quality change.
                pausedFrame.current = null;
                return;
              }
              if (frame && data.frag.level === frame.level && element.paused) {
                // Refresh the decoded still frame after the old buffer was replaced.
                element.currentTime = Math.min(
                  frame.time + 0.001,
                  Math.max(0, element.duration - 0.01),
                );
                pausedFrame.current = null;
              }
            });
            instance.on(Hls.Events.ERROR, (_event, data) => {
              if (cancelled) return;
              if (data.response?.code === 403) {
                instance?.stopLoad();
                // Snapshot playback state before stopping; restoration should
                // preserve whether the viewer was playing before a CDN failure.
                remember();
                if (recordingId && fallbackAvailable.current) {
                  failure("Không tải được video. Hãy thử lại sau.");
                  return;
                }
                element.pause();
                if (
                  !source.public &&
                  Date.now() - automaticRefreshAt.current > 5000
                ) {
                  automaticRefreshAt.current = Date.now();
                  void refresh(source.id);
                } else failure("Không truy cập được video. Hãy thử lại.");
                return;
              }
              if (!data.fatal) return;
              if (
                data.type === Hls.ErrorTypes.MEDIA_ERROR &&
                mediaRecoveries++ === 0
              ) {
                instance?.recoverMediaError();
                return;
              }
              failure(
                data.type === Hls.ErrorTypes.NETWORK_ERROR
                  ? "Không tải được video. Hãy kiểm tra kết nối và thử lại."
                  : "Không giải mã được luồng video. Hãy thử lại hoặc chọn Bản gốc.",
              );
            });
            instance.attachMedia(element);
            instance.loadSource(source.url);
          } else if (element.canPlayType("application/vnd.apple.mpegurl")) {
            nativeAttached = true;
            element.src =
              manifest?.qualities?.find((q) => q.id === nativeQuality)?.url ??
              source.url;
            element.load();
          } else failure();
        })
        .catch(() =>
          failure(
            "Không khởi tạo được trình phát video. Hãy tải lại trang rồi thử lại.",
          ),
        );
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
    source?.public,
    nativeQuality,
    revision,
    refresh,
    recordingId,
    remember,
  ]);

  function toggleTranscript() {
    setTranscriptOpen((previous) => !previous);
  }

  function changeQuality(value: string) {
    if (value.startsWith("level:")) {
      const index = Number(value.slice(6));
      if (engine.current && levels.some((item) => item.index === index)) {
        const selected = levels.find((item) => item.index === index)!;
        setVariantId("");
        manual.current = {
          width: selected.width,
          height: selected.height,
          bitrate: selected.bitrate,
        };
        if (video.current?.paused)
          pausedFrame.current = {
            time: video.current.currentTime,
            level: index,
          };
        engine.current.currentLevel = index;
        setLevel(index);
      }
    } else if (value.startsWith("variant:")) {
      const selected = manifest?.qualities?.find(
        (q) => q.id === value.slice(8),
      );
      if (!selected) return;
      setError("");
      setVariantId(selected.id);
      manual.current = {
        width: selected.width,
        height: selected.height,
        bitrate: selected.bitrate,
      };
      nativeManual.current = { width: selected.width, height: selected.height };
      if (engine.current) {
        const index = engine.current.levels.findIndex(
          (l) => l.width === selected.width && l.height === selected.height,
        );
        if (index >= 0) {
          if (video.current?.paused)
            pausedFrame.current = {
              time: video.current.currentTime,
              level: index,
            };
          engine.current.currentLevel = index;
          setLevel(index);
        } else if (error && source) void refresh(source.id);
      } else {
        remember();
        setNativeQuality(selected.id);
        const adaptive = manifest?.sources.find((s) => s.kind === "hls");
        if (adaptive && source?.kind !== "hls") void refresh(adaptive.id);
      }
    } else if (value === sourceId && source?.kind === "hls") {
      manual.current = null;
      nativeManual.current = null;
      setNativeQuality("");
      setVariantId("");
      if (engine.current) engine.current.currentLevel = -1;
      setLevel(-1);
    } else if (value !== sourceId) {
      manual.current = null;
      nativeManual.current = null;
      pausedFrame.current = null;
      setNativeQuality("");
      setVariantId("");
      setLevel(-1);
      setActiveQuality("");
      void refresh(value);
    }
  }
  function label(width: number, height: number) {
    const short = Math.min(width, height),
      long = Math.max(width, height);
    return short >= 2160 && long >= 3840 ? "2160p (4K)" : `${short}p`;
  }
  return (
    <div className="video-preview">
      {manifest && (
        <>
          <div
            ref={layout}
            className={`video-preview-layout${transcriptOpen ? " transcript-open" : ""}`}
          >
            <VideoPlayerControls
              videoRef={video}
              fullscreenRef={layout}
              loading={loading}
              quality={
                variantId
                  ? `variant:${variantId}`
                  : level >= 0
                    ? `level:${level}`
                    : sourceId
              }
              qualities={[
                ...manifest.sources
                  .filter(
                    (item) =>
                      levels.length === 0 ||
                      item.id === "original" ||
                      item.kind === "hls",
                  )
                  .map((item) => ({
                    value: item.id,
                    label:
                      item.kind === "hls" &&
                      level < 0 &&
                      !nativeQuality &&
                      activeQuality
                        ? `Tự động · ${activeQuality}`
                        : item.label,
                  })),
                ...(manifest.qualities?.length ? [] : levels).map((item) => ({
                  value: `level:${item.index}`,
                  label: label(item.width, item.height),
                })),
                ...(manifest.qualities ?? []).map((q) => ({
                  value: `variant:${q.id}`,
                  label: q.label,
                })),
              ]}
              onQualityChange={changeQuality}
              onRefresh={
                manifest.canProcess
                  ? async () => {
                      if (requestingProcessing) return;
                      setRequestingProcessing(true);
                      setProcessingError("");
                      processingRequest.current ??= crypto.randomUUID();
                      try {
                        await requestVideoProcessing(
                          fileId,
                          processingRequest.current,
                        );
                        processingRequest.current = null;
                        await refresh(sourceId);
                      } catch (failure) {
                        setProcessingError(asApiError(failure).message);
                      } finally {
                        setRequestingProcessing(false);
                      }
                    }
                  : undefined
              }
              processing={
                requestingProcessing ||
                ["QUEUED", "PROCESSING"].includes(manifest.processing.status)
              }
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
                crossOrigin={
                  source?.public ||
                  (recordingId &&
                    (playbackMode === "LIVE_DVR" ||
                      networkSource.current !== "original"))
                    ? "anonymous"
                    : "use-credentials"
                }
                poster={manifest.thumbnail}
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
          {processingError && <p role="alert">{processingError}</p>}
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
            onClick={() => {
              failedSources.current.clear();
              void refresh(sourceId);
            }}
          >
            Thử lại video
          </button>
        </div>
      )}
    </div>
  );
}
