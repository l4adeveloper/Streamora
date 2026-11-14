"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import type { VideoPlaybackResponse } from "@streamora/contracts";
import { asApiError } from "@/lib/api";
import {
  getVideoPlayback,
  getVideoProcessing,
  acquireVideoGrant,
} from "@/lib/files/api";
import { VideoPlayerControls } from "./video-player-controls";

export function VideoPreview({
  fileId,
  name,
}: {
  fileId: string;
  name: string;
}) {
  const [manifest, setManifest] = useState<VideoPlaybackResponse>();
  const [sourceId, setSourceId] = useState("");
  const [levels, setLevels] = useState<
    { index: number; width: number; height: number; bitrate: number }[]
  >([]);
  const [activeQuality, setActiveQuality] = useState("");
  const [nativeQuality, setNativeQuality] = useState("");
  const [nativeHls, setNativeHls] = useState(false);
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
  const video = useRef<HTMLVideoElement>(null);
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
  const remember = useCallback(() => {
    const element = video.current;
    if (element && element.readyState > 0)
      bookmark.current = {
        time: element.currentTime,
        paused: element.paused,
        rate: element.playbackRate,
        volume: element.volume,
        muted: element.muted,
      };
  }, []);
  const refresh = useCallback(
    async (preferred = "", renewOnly = false) => {
      const request = ++sequence.current;
      remember();
      if (!renewOnly) setLoading(true);
      setError("");
      try {
        const response = await getVideoPlayback(fileId);
        await acquireVideoGrant(response);
        if (request !== sequence.current) return;
        denied.current = false;
        if (nativeManual.current) {
          const preference = nativeManual.current;
          const selected = response.qualities?.find(
            (q) =>
              q.width === preference.width && q.height === preference.height,
          );
          if (!selected) throw new Error("Selected quality unavailable");
          setNativeQuality(selected.id);
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
    [fileId, remember],
  );
  useEffect(() => {
    denied.current = false;
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [refresh]);
  const source = manifest?.sources.find((item) => item.id === sourceId);
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
    if (!source || denied.current) return;
    const timer = setTimeout(
      () => {
        if (!denied.current) void refresh(sourceId, true);
      },
      Math.max(1000, Date.parse(source.expiresAt) - Date.now() - 15000),
    );
    return () => clearTimeout(timer);
  }, [source?.expiresAt, sourceId, refresh]);
  useEffect(() => {
    const element = video.current;
    if (!element || !source) return;
    let cancelled = false;
    let instance: Hls | undefined;
    setLevels([]);
    setNativeHls(false);
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
            instance = new Hls({
              maxBufferLength: 30,
              maxMaxBufferLength: 30,
              backBufferLength: 30,
              xhrSetup: (xhr) => {
                xhr.withCredentials = true;
              },
              fetchSetup: (context, init) =>
                new Request(context.url, { ...init, credentials: "include" }),
            });
            engine.current = instance;
            instance.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
              if (!cancelled)
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
              if (data.response?.code === 403) {
                denied.current = true;
                instance?.stopLoad();
                element.pause();
                setError("Quyền xem video đã hết hiệu lực. Hãy mở lại video.");
                setLoading(false);
                return;
              }
              if (data.fatal) failure();
            });
            instance.attachMedia(element);
            instance.loadSource(source.url);
          } else if (element.canPlayType("application/vnd.apple.mpegurl")) {
            setNativeHls(true);
            element.src =
              manifest?.qualities?.find((q) => q.id === nativeQuality)?.url ??
              source.url;
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
  }, [source?.url, source?.kind, source?.id, nativeQuality, revision, refresh]);

  function changeQuality(value: string) {
    if (value.startsWith("level:")) {
      const index = Number(value.slice(6));
      if (engine.current && levels.some((item) => item.index === index)) {
        const selected = levels.find((item) => item.index === index)!;
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
      nativeManual.current = { width: selected.width, height: selected.height };
      remember();
      setNativeQuality(value.slice(8));
    } else if (value === sourceId && source?.kind === "hls") {
      manual.current = null;
      nativeManual.current = null;
      setNativeQuality("");
      if (engine.current) engine.current.currentLevel = -1;
      setLevel(-1);
    } else if (value !== sourceId) void refresh(value);
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
          <VideoPlayerControls
            videoRef={video}
            loading={loading}
            quality={
              nativeQuality
                ? `variant:${nativeQuality}`
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
              ...levels.map((item) => ({
                value: `level:${item.index}`,
                label: label(item.width, item.height),
              })),
              ...(nativeHls && source?.kind === "hls"
                ? (manifest.qualities ?? []).map((q) => ({
                    value: `variant:${q.id}`,
                    label: q.label,
                  }))
                : []),
            ]}
            onQualityChange={changeQuality}
            onRefresh={() => void refresh(sourceId)}
          >
            <video
              ref={video}
              playsInline
              crossOrigin="use-credentials"
              poster={manifest.thumbnail}
              preload="metadata"
              aria-label={`Xem trước video: ${name}`}
            />
          </VideoPlayerControls>
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
