"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  Play,
  RefreshCw,
  Settings,
  Volume2,
  VolumeX,
} from "lucide-react";

type Quality = { value: string; label: string };
const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
function timestamp(value: number) {
  const total = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const hours = Math.floor(total / 3600),
    minutes = Math.floor(total / 60) % 60,
    seconds = total % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, "0")}` : minutes}:${String(seconds).padStart(2, "0")}`;
}

export function VideoPlayerControls({
  videoRef,
  children,
  qualities,
  quality,
  onQualityChange,
  onRefresh,
  loading,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  children: ReactNode;
  qualities: Quality[];
  quality: string;
  onQualityChange(value: string): void;
  onRefresh(): void;
  loading: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const settings = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragging = useRef(false);
  const [media, setMedia] = useState({
    playing: false,
    time: 0,
    duration: 0,
    buffered: 0,
    volume: 1,
    muted: false,
    rate: 1,
  });
  const [buffering, setBuffering] = useState(false);
  const [visible, setVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [menu, setMenu] = useState<"main" | "quality" | "speed" | null>(null);
  const [seek, setSeek] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [menuHeight, setMenuHeight] = useState(280);
  const wake = useCallback(() => {
    setVisible(true);
    clearTimeout(idle.current);
    if (!videoRef.current?.paused && !menu)
      idle.current = setTimeout(() => {
        if (!frame.current?.querySelector(":focus-visible")) setVisible(false);
      }, 2500);
  }, [menu, videoRef]);
  useEffect(() => {
    wake();
    return () => clearTimeout(idle.current);
  }, [media.playing, wake]);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const resized = () =>
      setMenuHeight(Math.max(96, Math.min(340, element.clientHeight - 64)));
    const observer = new ResizeObserver(resized);
    observer.observe(element);
    resized();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const update = () => {
      const duration = Number.isFinite(element.duration)
        ? element.duration
        : element.seekable.length
          ? element.seekable.end(element.seekable.length - 1)
          : 0;
      let buffered = 0;
      for (let i = 0; i < element.buffered.length; i++)
        if (element.buffered.start(i) <= element.currentTime + 0.1)
          buffered = element.buffered.end(i);
      setMedia({
        playing: !element.paused && !element.ended,
        time: element.currentTime || 0,
        duration,
        buffered,
        volume: element.volume,
        muted: element.muted,
        rate: element.playbackRate,
      });
    };
    const ready = () => setBuffering(false),
      waiting = () => setBuffering(true);
    const events = [
      "loadedmetadata",
      "durationchange",
      "timeupdate",
      "progress",
      "play",
      "pause",
      "ended",
      "volumechange",
      "ratechange",
      "seeked",
    ];
    events.forEach((event) => element.addEventListener(event, update));
    ["playing", "canplay", "loadeddata", "error"].forEach((event) =>
      element.addEventListener(event, ready),
    );
    element.addEventListener("waiting", waiting);
    const changed = () =>
      setFullscreen(document.fullscreenElement === frame.current);
    document.addEventListener("fullscreenchange", changed);
    update();
    return () => {
      events.forEach((event) => element.removeEventListener(event, update));
      ["playing", "canplay", "loadeddata", "error"].forEach((event) =>
        element.removeEventListener(event, ready),
      );
      element.removeEventListener("waiting", waiting);
      document.removeEventListener("fullscreenchange", changed);
    };
  }, [videoRef]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!settings.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", outside);
    const focus = setTimeout(() => {
      const selected =
        menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
        menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
      selected?.focus();
      selected?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => {
      document.removeEventListener("pointerdown", outside);
      clearTimeout(focus);
    };
  }, [menu, menuHeight]);
  function closeMenu() {
    setMenu(null);
    gear.current?.focus();
  }
  async function togglePlay() {
    const element = videoRef.current;
    if (!element || loading) return;
    setNotice("");
    if (element.paused) {
      try {
        await element.play();
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError")
          return;
        setNotice("Chưa phát được video. Hãy thử lại.");
      }
    } else element.pause();
    wake();
  }
  function changeTime(time: number) {
    const element = videoRef.current;
    if (element && media.duration > 0)
      element.currentTime = Math.max(0, Math.min(time, media.duration));
  }
  function commitSeek(value: string) {
    changeTime(Number(value));
    dragging.current = false;
    setSeek(null);
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === frame.current)
        await document.exitFullscreen();
      else if (frame.current?.requestFullscreen)
        await frame.current.requestFullscreen();
      else
        (
          videoRef.current as
            (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
        )?.webkitEnterFullscreen?.();
    } catch {
      setNotice("Không mở được toàn màn hình trên trình duyệt này.");
    }
    wake();
  }
  const currentQuality =
    qualities.find((item) => item.value === quality)?.label ?? "Bản gốc";
  const time = seek ?? media.time;
  const played =
    media.duration > 0 ? Math.min(100, (time / media.duration) * 100) : 0;
  const buffered =
    media.duration > 0
      ? Math.min(100, (media.buffered / media.duration) * 100)
      : 0;
  return (
    <div
      ref={frame}
      className={`video-player ${visible || !media.playing || menu ? "show-controls" : "hide-controls"}`}
      role="region"
      aria-label="Trình phát video"
      tabIndex={0}
      onPointerMove={wake}
      onPointerDown={wake}
      onFocusCapture={wake}
      onClick={(event) => {
        if (event.target === videoRef.current) void togglePlay();
      }}
      onDoubleClick={(event) => {
        if (event.target === videoRef.current) void toggleFullscreen();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu) {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
          return;
        }
        if ((event.target as HTMLElement).closest("button,input,[role=menu]"))
          return;
        const element = videoRef.current;
        if (!element) return;
        const key = event.key.toLowerCase();
        if (
          ![
            " ",
            "k",
            "j",
            "l",
            "arrowleft",
            "arrowright",
            "arrowup",
            "arrowdown",
            "m",
            "f",
          ].includes(key)
        )
          return;
        event.preventDefault();
        wake();
        if (key === " " || key === "k") void togglePlay();
        else if (key === "arrowleft" || key === "j")
          changeTime(element.currentTime - (key === "j" ? 10 : 5));
        else if (key === "arrowright" || key === "l")
          changeTime(element.currentTime + (key === "l" ? 10 : 5));
        else if (key === "m") element.muted = !element.muted;
        else if (key === "f") void toggleFullscreen();
        else {
          element.volume = Math.max(
            0,
            Math.min(1, element.volume + (key === "arrowup" ? 0.05 : -0.05)),
          );
          element.muted = false;
        }
      }}
    >
      {children}
      {(loading || buffering) && (
        <div
          className="video-player-center video-player-spinner"
          aria-label="Đang tải video"
        >
          <LoaderCircle size={40} />
        </div>
      )}
      {!loading && !buffering && !media.playing && (
        <button
          type="button"
          className="video-player-center video-center-play"
          aria-label="Phát"
          onClick={() => void togglePlay()}
        >
          <Play size={38} fill="currentColor" />
        </button>
      )}
      <div className="video-control-bar">
        <input
          type="range"
          className="video-timeline"
          aria-label="Tua video"
          aria-valuetext={`${timestamp(time)} / ${timestamp(media.duration)}`}
          min={0}
          max={media.duration || 0.01}
          step={0.01}
          value={Math.min(time, media.duration || 0)}
          disabled={loading || media.duration === 0}
          style={
            {
              "--played": `${played}%`,
              "--buffered": `${buffered}%`,
            } as CSSProperties
          }
          onPointerDown={() => {
            dragging.current = true;
          }}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (dragging.current) setSeek(value);
            else changeTime(value);
          }}
          onPointerUp={(event) => commitSeek(event.currentTarget.value)}
          onPointerCancel={() => {
            dragging.current = false;
            setSeek(null);
          }}
          onBlur={(event) => {
            if (dragging.current) commitSeek(event.currentTarget.value);
          }}
        />
        <div className="video-control-row">
          <button
            type="button"
            className="video-control-button"
            aria-label={media.playing ? "Tạm dừng video" : "Phát video"}
            title={media.playing ? "Tạm dừng (K)" : "Phát (K)"}
            disabled={loading}
            onClick={() => void togglePlay()}
          >
            {media.playing ? (
              <Pause size={23} fill="currentColor" />
            ) : (
              <Play size={23} fill="currentColor" />
            )}
          </button>
          <div className="video-volume">
            <button
              type="button"
              className="video-control-button"
              aria-label={
                media.muted || media.volume === 0
                  ? "Bật âm thanh"
                  : "Tắt âm thanh"
              }
              title="Âm thanh (M)"
              onClick={() => {
                const element = videoRef.current;
                if (element) {
                  const unmute = element.muted || element.volume === 0;
                  if (element.volume === 0) element.volume = 0.5;
                  element.muted = !unmute;
                }
              }}
            >
              {media.muted || media.volume === 0 ? (
                <VolumeX size={22} />
              ) : (
                <Volume2 size={22} />
              )}
            </button>
            <input
              type="range"
              aria-label="Âm lượng"
              min={0}
              max={1}
              step={0.05}
              value={media.muted ? 0 : media.volume}
              onChange={(event) => {
                if (videoRef.current) {
                  videoRef.current.volume = Number(event.target.value);
                  videoRef.current.muted = false;
                }
              }}
            />
          </div>
          <span className="video-time" aria-live="off">
            {timestamp(time)} <span>/ {timestamp(media.duration)}</span>
          </span>
          <div className="video-control-spacer" />
          <div ref={settings} className="video-settings">
            {menu && (
              <div
                ref={menuRef}
                className="video-settings-menu"
                role="menu"
                style={{ maxHeight: menuHeight }}
                aria-label={
                  menu === "quality"
                    ? "Chất lượng video"
                    : menu === "speed"
                      ? "Tốc độ phát"
                      : "Cài đặt video"
                }
                onKeyDown={(event) => {
                  if (
                    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                  )
                    return;
                  const buttons = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button:not(:disabled)",
                    ),
                  );
                  const index = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : (index +
                            (event.key === "ArrowDown" ? 1 : -1) +
                            buttons.length) %
                          buttons.length;
                  buttons[next]?.focus();
                  event.preventDefault();
                }}
              >
                {menu !== "main" && (
                  <button
                    type="button"
                    className="video-menu-heading"
                    aria-label="Quay lại cài đặt"
                    onClick={() => setMenu("main")}
                  >
                    <ChevronLeft size={18} />
                    {menu === "quality" ? "Chất lượng" : "Tốc độ phát"}
                  </button>
                )}
                {menu === "main" ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => setMenu("quality")}
                    >
                      <span>Chất lượng</span>
                      <small>{currentQuality}</small>
                      <ChevronRight size={16} />
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => setMenu("speed")}
                    >
                      <span>Tốc độ phát</span>
                      <small>
                        {media.rate === 1 ? "Chuẩn" : `${media.rate}×`}
                      </small>
                      <ChevronRight size={16} />
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={loading}
                      onClick={() => {
                        onRefresh();
                        closeMenu();
                      }}
                    >
                      <RefreshCw size={16} />
                      <span>Cập nhật chất lượng</span>
                    </button>
                  </>
                ) : menu === "quality" ? (
                  qualities.map((item) => (
                    <button
                      type="button"
                      key={item.value}
                      role="menuitemradio"
                      aria-checked={item.value === quality}
                      disabled={loading}
                      onClick={() => {
                        onQualityChange(item.value);
                        closeMenu();
                      }}
                    >
                      <span className="video-menu-check">
                        {item.value === quality && <Check size={17} />}
                      </span>
                      {item.label}
                    </button>
                  ))
                ) : (
                  speeds.map((rate) => (
                    <button
                      type="button"
                      key={rate}
                      role="menuitemradio"
                      aria-checked={rate === media.rate}
                      disabled={loading}
                      onClick={() => {
                        if (videoRef.current)
                          videoRef.current.playbackRate = rate;
                        closeMenu();
                      }}
                    >
                      <span className="video-menu-check">
                        {rate === media.rate && <Check size={17} />}
                      </span>
                      {rate === 1 ? "Chuẩn (1×)" : `${rate}×`}
                    </button>
                  ))
                )}
              </div>
            )}
            <button
              ref={gear}
              type="button"
              className={`video-control-button ${menu ? "selected" : ""}`}
              aria-label="Cài đặt video"
              title="Cài đặt"
              aria-haspopup="menu"
              aria-expanded={!!menu}
              onClick={() => setMenu((value) => (value ? null : "main"))}
            >
              <Settings size={23} />
            </button>
          </div>
          <button
            type="button"
            className="video-control-button"
            aria-label={fullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"}
            title="Toàn màn hình (F)"
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <Minimize size={22} /> : <Maximize size={22} />}
          </button>
        </div>
      </div>
      {notice && (
        <p className="video-player-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
