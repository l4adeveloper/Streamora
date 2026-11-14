"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
export function timestamp(value: number) {
  const total = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const hours = Math.floor(total / 3600),
    minutes = Math.floor(total / 60) % 60,
    seconds = total % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, "0")}` : minutes}:${String(seconds).padStart(2, "0")}`;
}

export function VideoPlayerControls({
  videoRef,
  fullscreenRef,
  children,
  qualities,
  quality,
  onQualityChange,
  onRefresh,
  loading,
  transcriptControls,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  fullscreenRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  qualities: Quality[];
  quality: string;
  onQualityChange(value: string): void;
  onRefresh(): void;
  loading: boolean;
  transcriptControls?: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const settings = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const dragging = useRef<number | null>(null);
  const [media, setMedia] = useState({
    playing: false,
    time: 0,
    duration: 0,
    buffered: [] as { start: number; end: number }[],
    volume: 1,
    muted: false,
    rate: 1,
  });
  const [buffering, setBuffering] = useState(false);
  const [visible, setVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [menu, setMenu] = useState<"main" | "quality" | "speed" | null>(null);
  const [retainedMenu, setRetainedMenu] = useState<typeof menu>(null);
  const renderedMenu = menu ?? retainedMenu;
  const [feedback, setFeedback] = useState<{
    playing: boolean;
    id: number;
  } | null>(null);
  const [seek, setSeek] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [menuPosition, setMenuPosition] = useState({ right: 0, bottom: 0 });
  const menuHeight =
    14 +
    (renderedMenu === "main"
      ? 132
      : 48 +
        (renderedMenu === "speed" ? speeds.length : qualities.length) * 44);
  useEffect(() => {
    if (menu) {
      setRetainedMenu(menu);
      return;
    }
    const timer = setTimeout(() => setRetainedMenu(null), 140);
    return () => clearTimeout(timer);
  }, [menu]);
  useEffect(() => () => clearTimeout(feedbackTimer.current), []);
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
  useLayoutEffect(() => {
    const popup = menuRef.current;
    if (!renderedMenu || !popup) return;
    // The top layer lets the menu expand beyond a short player's clipped bounds,
    // while staying inside the preview dialog or fullscreen player in the DOM.
    if (!popup.matches(":popover-open")) popup.showPopover();
    const position = () => {
      const anchor = gear.current?.getBoundingClientRect();
      if (!anchor) return;
      setMenuPosition({
        right: Math.max(
          8,
          Math.min(
            window.innerWidth - anchor.right,
            window.innerWidth - popup.offsetWidth - 8,
          ),
        ),
        bottom: Math.max(
          8,
          Math.min(
            window.innerHeight - anchor.top + 12,
            window.innerHeight - menuHeight - 8,
          ),
        ),
      });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [renderedMenu, menuHeight]);
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const update = () => {
      const duration = Number.isFinite(element.duration)
        ? element.duration
        : element.seekable.length
          ? element.seekable.end(element.seekable.length - 1)
          : 0;
      const buffered = Array.from(
        { length: element.buffered.length },
        (_, i) => ({
          start: element.buffered.start(i),
          end: element.buffered.end(i),
        }),
      );
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
    const seeking = () => {
      update();
      setBuffering(element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
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
    const readyEvents = [
      "playing",
      "canplay",
      "loadeddata",
      "seeked",
      "error",
      "emptied",
    ];
    readyEvents.forEach((event) => element.addEventListener(event, ready));
    element.addEventListener("seeking", seeking);
    element.addEventListener("waiting", waiting);
    const changed = () =>
      setFullscreen(
        document.fullscreenElement ===
          (fullscreenRef?.current ?? frame.current),
      );
    document.addEventListener("fullscreenchange", changed);
    update();
    return () => {
      events.forEach((event) => element.removeEventListener(event, update));
      readyEvents.forEach((event) => element.removeEventListener(event, ready));
      element.removeEventListener("seeking", seeking);
      element.removeEventListener("waiting", waiting);
      document.removeEventListener("fullscreenchange", changed);
    };
  }, [videoRef, fullscreenRef]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!settings.current?.contains(event.target as Node)) setMenu(null);
    };
    // Changing submenu removes the focused button before the next focus timer.
    // Keep Escape scoped to the open menu during that gap, including in a dialog.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      gear.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", dismiss, true);
    const focus = setTimeout(() => {
      const selected =
        menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
        menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
      selected?.focus({ preventScroll: true });
    }, 0);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", dismiss, true);
      clearTimeout(focus);
    };
  }, [menu]);
  function closeMenu() {
    setMenu(null);
    gear.current?.focus();
  }
  function indicatePlayback(playing: boolean) {
    clearTimeout(feedbackTimer.current);
    setFeedback({ playing, id: performance.now() });
    feedbackTimer.current = setTimeout(() => setFeedback(null), 460);
  }
  async function togglePlay() {
    const element = videoRef.current;
    if (!element || loading) return;
    setNotice("");
    if (element.paused) {
      try {
        await element.play();
        indicatePlayback(true);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError")
          return;
        setNotice("Chưa phát được video. Hãy thử lại.");
      }
    } else {
      element.pause();
      indicatePlayback(false);
    }
    wake();
  }
  function changeTime(time: number) {
    const element = videoRef.current;
    if (!element || loading || media.duration <= 0) return;
    const target = Math.max(0, Math.min(time, media.duration));
    element.currentTime = target;
    // Do not fall back to the old time while a cold seek waits for media events.
    setMedia((previous) => ({ ...previous, time: target }));
  }
  function pointerTime(element: HTMLInputElement, clientX: number) {
    const bounds = element.getBoundingClientRect();
    // The thumb is 12px wide; its centre travels between the two 6px insets.
    const fraction =
      (clientX - bounds.left - 6) / Math.max(1, bounds.width - 12);
    return Math.max(0, Math.min(1, fraction)) * media.duration;
  }
  function commitSeek(time: number) {
    changeTime(time);
    dragging.current = null;
    setSeek(null);
  }
  async function toggleFullscreen() {
    const container = fullscreenRef?.current ?? frame.current;
    try {
      if (document.fullscreenElement === container)
        await document.exitFullscreen();
      else if (container?.requestFullscreen)
        await container.requestFullscreen();
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
  const percent = (seconds: number) =>
    media.duration > 0
      ? Math.max(0, Math.min(100, (seconds / media.duration) * 100))
      : 0;
  const played = percent(time);
  // A seek can leave gaps between downloaded ranges. Paint every range rather
  // than hiding previously loaded data beyond the current contiguous buffer.
  const buffered = [
    "#ffffff40 0%",
    ...media.buffered.flatMap(({ start, end }) => [
      `#ffffff40 ${percent(start)}%`,
      `#ffffff88 ${percent(start)}%`,
      `#ffffff88 ${percent(end)}%`,
      `#ffffff40 ${percent(end)}%`,
    ]),
    "#ffffff40 100%",
  ].join(", ");
  return (
    <div
      ref={frame}
      className={`video-player ${visible || !media.playing || menu ? "show-controls" : "hide-controls"}`}
      role="region"
      aria-label="Trình phát video"
      tabIndex={0}
      onPointerMove={wake}
      onPointerDown={(event) => {
        wake();
        if (event.target === videoRef.current)
          event.currentTarget.focus({ preventScroll: true });
      }}
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
        const target = event.target as HTMLElement;
        if (
          event.defaultPrevented ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.nativeEvent.isComposing ||
          menu ||
          target.closest(
            'textarea,select,[contenteditable]:not([contenteditable="false"]),[role=menu]',
          ) ||
          (target.closest("input") && !target.matches(".video-timeline"))
        )
          return;
        const element = videoRef.current;
        if (!element) return;
        const key = event.key.toLowerCase();
        const arrowSeek = key === "arrowleft" || key === "arrowright";
        if (target.closest("button,input") && !arrowSeek) return;
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
      {feedback && !loading && !buffering && (
        <div
          key={feedback.id}
          className="video-player-center video-playback-feedback"
          aria-hidden="true"
        >
          {feedback.playing ? (
            <Play size={32} fill="currentColor" />
          ) : (
            <Pause size={32} fill="currentColor" />
          )}
        </div>
      )}
      {!loading && !buffering && !media.playing && !feedback && (
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
              "--buffered-ranges": `linear-gradient(to right, ${buffered})`,
            } as CSSProperties
          }
          title="Tua video (←/→: 5 giây)"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            // Own the gesture so native range stepping cannot fight React updates.
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            const time = pointerTime(event.currentTarget, event.clientX);
            dragging.current = time;
            setSeek(time);
          }}
          onPointerMove={(event) => {
            if (dragging.current === null) return;
            const time = pointerTime(event.currentTarget, event.clientX);
            dragging.current = time;
            setSeek(time);
          }}
          onChange={(event) => {
            if (dragging.current === null)
              changeTime(Number(event.target.value));
          }}
          onPointerUp={(event) => {
            if (dragging.current === null) return;
            commitSeek(pointerTime(event.currentTarget, event.clientX));
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = null;
            setSeek(null);
          }}
          onLostPointerCapture={() => {
            dragging.current = null;
            setSeek(null);
          }}
          onBlur={() => {
            if (dragging.current !== null) commitSeek(dragging.current);
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
          {transcriptControls}
          <div ref={settings} className="video-settings">
            {renderedMenu && (
              <div
                ref={menuRef}
                className="video-settings-menu"
                data-state={menu ? "open" : "closed"}
                aria-hidden={!menu}
                inert={!menu}
                role="menu"
                popover="manual"
                style={{ ...menuPosition, height: menuHeight }}
                aria-label={
                  renderedMenu === "quality"
                    ? "Chất lượng video"
                    : renderedMenu === "speed"
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
                <div
                  key={renderedMenu}
                  className={`video-menu-content ${renderedMenu === "main" ? "video-menu-back" : "video-menu-forward"}`}
                >
                  {renderedMenu !== "main" && (
                    <button
                      type="button"
                      className="video-menu-heading"
                      aria-label="Quay lại cài đặt"
                      onClick={() => setMenu("main")}
                    >
                      <ChevronLeft size={18} />
                      {renderedMenu === "quality"
                        ? "Chất lượng"
                        : "Tốc độ phát"}
                    </button>
                  )}
                  {renderedMenu === "main" ? (
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
                          {media.rate === 1 ? "Bình thường" : `${media.rate}×`}
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
                  ) : renderedMenu === "quality" ? (
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
                        aria-label={rate === 1 ? "Bình thường" : `${rate}×`}
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
                        <span className="video-speed-value">
                          {rate === 1 ? "Bình thường" : rate}
                        </span>
                      </button>
                    ))
                  )}
                </div>
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
