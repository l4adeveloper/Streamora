"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minimize,
  Mic,
  MonitorUp,
  Pause,
  Play,
  RotateCcw,
  Settings,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Presentation } from "./presentation";
import { time, portrait } from "./demo-data";
import styles from "./live-player.module.css";

const speeds = ["0.5", "0.75", "1", "1.25", "1.5", "2"];
const qualities = ["Tự động", "1080p", "720p"];
type SettingsPage = "main" | "speed" | "quality";

export function LivePlayer({
  screenVideo,
  sharing,
}: {
  screenVideo: React.RefObject<HTMLVideoElement | null>;
  sharing: boolean;
}) {
  const [timeline, setTimeline] = useState({ edge: 2538, position: 1594 });
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState("1");
  const [quality, setQuality] = useState("Tự động");
  const [volume, setVolume] = useState(75);
  const [muted, setMuted] = useState(false);
  const [awake, setAwake] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [menu, setMenu] = useState<SettingsPage | null>(null);
  const [notice, setNotice] = useState("");
  const player = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const settings = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const atLive = sharing || (playing && timeline.edge - timeline.position < 1);
  const controlsVisible = awake || !playing || menu !== null;
  const progress = Math.min(100, (timeline.position / timeline.edge) * 100);

  const wake = useCallback(() => {
    setAwake(true);
    clearTimeout(idle.current);
    idle.current = setTimeout(() => {
      if (!player.current?.querySelector(":focus-visible")) setAwake(false);
    }, 2600);
  }, []);
  useEffect(() => {
    wake();
    return () => clearTimeout(idle.current);
  }, [playing, menu, wake]);
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const fitSlide = () =>
      element.style.setProperty(
        "--slide-scale",
        String(Math.min(element.clientWidth / 700, element.clientHeight / 400)),
      );
    const observer = new ResizeObserver(fitSlide);
    observer.observe(element);
    fitSlide();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (sharing) return;
    const timer = setInterval(() => {
      setTimeline((current) => ({
        edge: current.edge + 1,
        position: playing
          ? Math.min(current.edge + 1, current.position + Number(speed))
          : current.position,
      }));
    }, 1000);
    return () => clearInterval(timer);
  }, [playing, speed, sharing]);
  useEffect(() => {
    if (atLive && speed !== "1") setSpeed("1");
  }, [atLive, speed]);
  useEffect(() => {
    const changed = () => {
      setFullscreen(document.fullscreenElement === player.current);
      wake();
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, [wake]);
  useEffect(() => {
    if (!menu) return;
    settings.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !settings.current?.contains(event.target as Node) &&
        !gear.current?.contains(event.target as Node)
      )
        setMenu(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 2200);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (sharing) {
      setPlaying(true);
      setMenu(null);
    }
  }, [sharing]);

  const togglePlay = () => {
    if (sharing && screenVideo.current) {
      if (playing) screenVideo.current.pause();
      else
        void screenVideo.current.play().catch(() => {
          setPlaying(false);
          setNotice("Chưa thể phát màn hình xem trước. Hãy thử lại.");
        });
    }
    setPlaying((current) => !current);
    wake();
  };
  const goLive = () => {
    setTimeline((current) => ({ ...current, position: current.edge }));
    setPlaying(true);
    setSpeed("1");
    wake();
  };
  const seek = (position: number) => {
    if (sharing) return;
    setTimeline((current) => ({
      ...current,
      position: Math.max(0, Math.min(current.edge, position)),
    }));
    wake();
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === player.current)
        await document.exitFullscreen();
      else await player.current?.requestFullscreen();
    } catch {
      setNotice("Trình duyệt chưa cho phép mở toàn màn hình.");
    }
  };
  const closeMenu = () => {
    setMenu(null);
    gear.current?.focus();
  };

  return (
    <div
      className={`live-player ${styles.frame}`}
      ref={player}
      tabIndex={0}
      role="region"
      aria-label="Trình phát xem trước buổi học"
      data-controls={controlsVisible ? "visible" : "hidden"}
      onPointerMove={wake}
      onPointerDown={wake}
      onFocusCapture={wake}
      onBlurCapture={wake}
      onPointerLeave={() => {
        if (!menu) setAwake(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu) {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
          return;
        }
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          (event.target as HTMLElement).closest(
            "input, button, select, textarea",
          )
        )
          return;
        const key = event.key.toLowerCase();
        if (key === " " || key === "k") {
          event.preventDefault();
          togglePlay();
        } else if (key === "f") {
          event.preventDefault();
          void toggleFullscreen();
        } else if (key === "m" && !sharing) {
          event.preventDefault();
          setMuted((current) => !current);
          wake();
        } else if (key === "arrowleft" || key === "arrowright") {
          event.preventDefault();
          seek(timeline.position + (key === "arrowleft" ? -5 : 5));
        }
      }}
    >
      <div className={`video-surface ${styles.surface}`} ref={surface}>
        {sharing ? (
          <video
            className="shared-screen"
            ref={screenVideo}
            autoPlay
            playsInline
            muted
          />
        ) : (
          <Presentation />
        )}
        <button
          type="button"
          className={styles.screenAction}
          aria-label={playing ? "Tạm dừng bản xem trước" : "Phát bản xem trước"}
          onClick={togglePlay}
          onDoubleClick={() => void toggleFullscreen()}
          tabIndex={-1}
        />
        <div className={`speaker-inset ${styles.speaker}`}>
          <img src={portrait} alt="Ảnh minh họa giảng viên" />
          <span>
            <i />
            <b>Nguyễn Hoàng</b>
            <Mic size={11} />
          </span>
        </div>
      </div>

      <div className={styles.topbar}>
        <div className={styles.heading}>
          <MonitorUp size={17} />
          <div>
            <strong>
              {sharing ? "Màn hình của bạn" : "Hệ thống phân tán"}
            </strong>
            <span>
              {sharing
                ? "Xem trước trên thiết bị này"
                : "Nguyễn Hoàng · Buổi 05"}
            </span>
          </div>
        </div>
        <span className={styles.demo}>{sharing ? "CỤC BỘ" : "MINH HỌA"}</span>
      </div>
      {!playing && (
        <button
          type="button"
          className={styles.bigPlay}
          aria-label="Tiếp tục phát"
          onClick={togglePlay}
        >
          <Play size={32} fill="currentColor" />
        </button>
      )}
      {notice && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}

      {menu && (
        <div
          className={styles.settings}
          ref={settings}
          role="dialog"
          aria-label="Cài đặt trình phát"
        >
          {menu === "main" ? (
            <>
              <div className={styles.menuHeading}>
                Cài đặt
                <button
                  type="button"
                  className={styles.menuClose}
                  aria-label="Đóng cài đặt"
                  onClick={closeMenu}
                >
                  <X size={16} />
                </button>
              </div>
              <button type="button" onClick={() => setMenu("speed")}>
                <span>Tốc độ phát</span>
                <b>{speed === "1" ? "Bình thường" : `${speed}×`}</b>
                <ChevronRight size={17} />
              </button>
              <button type="button" onClick={() => setMenu("quality")}>
                <span>Chất lượng</span>
                <b>{quality}</b>
                <ChevronRight size={17} />
              </button>
              <p>Chất lượng trong bản minh họa.</p>
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.menuBack}
                onClick={() => setMenu("main")}
              >
                <ChevronLeft size={18} />
                {menu === "speed" ? "Tốc độ phát" : "Chất lượng"}
              </button>
              <div
                className={styles.choices}
                role="group"
                aria-label={
                  menu === "speed" ? "Tốc độ phát" : "Chất lượng video"
                }
              >
                {(menu === "speed" ? speeds : qualities).map((value) => {
                  const selected =
                    value === (menu === "speed" ? speed : quality);
                  return (
                    <button
                      type="button"
                      key={value}
                      aria-pressed={selected}
                      onClick={() => {
                        if (menu === "speed") setSpeed(value);
                        else setQuality(value);
                        closeMenu();
                      }}
                    >
                      <span className={styles.check}>
                        {selected && <Check size={17} />}
                      </span>
                      <span>
                        {menu === "speed"
                          ? value === "1"
                            ? "Bình thường"
                            : `${value}×`
                          : value}
                      </span>
                      {value === "1080p" && <small>HD</small>}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      <div className={styles.controls}>
        <div className={styles.seek}>
          <input
            type="range"
            min="0"
            max={timeline.edge}
            value={
              sharing
                ? timeline.edge
                : Math.min(timeline.position, timeline.edge)
            }
            step="1"
            disabled={sharing}
            aria-label="Tua lại buổi phát trực tiếp"
            aria-valuetext={`${time(timeline.position)} trên ${time(timeline.edge)}`}
            style={
              { "--progress": `${sharing ? 100 : progress}%` } as CSSProperties
            }
            onChange={(event) => seek(Number(event.target.value))}
          />
        </div>
        <div className={styles.controlbar}>
          <div className={styles.controlGroup}>
            <button
              type="button"
              className={styles.icon}
              aria-label={playing ? "Tạm dừng" : "Phát"}
              title={playing ? "Tạm dừng (K)" : "Phát (K)"}
              onClick={togglePlay}
            >
              {playing ? (
                <Pause size={22} fill="currentColor" />
              ) : (
                <Play size={22} fill="currentColor" />
              )}
            </button>
            <button
              type="button"
              className={`${styles.icon} ${styles.rewind}`}
              disabled={sharing}
              aria-label="Tua lại 10 giây"
              title="Tua lại 10 giây"
              onClick={() => seek(timeline.position - 10)}
            >
              <RotateCcw size={21} />
              <span>10</span>
            </button>
            <div className={styles.volume}>
              <button
                type="button"
                className={styles.icon}
                disabled={sharing}
                aria-label={
                  muted || volume === 0
                    ? "Bật âm thanh mẫu"
                    : "Tắt âm thanh mẫu"
                }
                title={
                  sharing
                    ? "Bản xem trước màn hình không có âm thanh"
                    : muted
                      ? "Bật âm thanh (M)"
                      : "Tắt âm thanh (M)"
                }
                onClick={() => setMuted((current) => !current)}
              >
                {muted || volume === 0 ? (
                  <VolumeX size={22} />
                ) : (
                  <Volume2 size={22} />
                )}
              </button>
              <input
                type="range"
                min="0"
                max="100"
                value={muted ? 0 : volume}
                disabled={sharing}
                aria-label="Âm lượng bản xem trước"
                style={
                  { "--volume": `${muted ? 0 : volume}%` } as CSSProperties
                }
                onChange={(event) => {
                  setVolume(Number(event.target.value));
                  setMuted(false);
                }}
              />
            </div>
            <span className={styles.clock}>
              {time(Math.min(timeline.position, timeline.edge))}
              <span> / {time(timeline.edge)}</span>
            </span>
            <button
              type="button"
              className={styles.live}
              aria-label={atLive ? "Đang trực tiếp" : "Về trực tiếp"}
              title={
                atLive
                  ? "Đang ở thời điểm trực tiếp"
                  : "Trở về thời điểm trực tiếp"
              }
              data-live={atLive}
              disabled={sharing}
              onClick={goLive}
            >
              <span />
              TRỰC TIẾP
            </button>
          </div>
          <div className={styles.controlGroup}>
            {!atLive && timeline.edge - timeline.position >= 1 && (
              <span className={styles.delay}>
                −{time(Math.max(0, timeline.edge - timeline.position))}
              </span>
            )}
            <button
              type="button"
              className={styles.icon}
              ref={gear}
              disabled={sharing}
              aria-label="Cài đặt trình phát"
              aria-expanded={menu !== null}
              aria-haspopup="dialog"
              title="Cài đặt"
              onClick={() => setMenu((current) => (current ? null : "main"))}
            >
              <Settings size={22} />
            </button>
            <button
              type="button"
              className={styles.icon}
              aria-label={fullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"}
              title={
                fullscreen ? "Thoát toàn màn hình (F)" : "Toàn màn hình (F)"
              }
              onClick={() => void toggleFullscreen()}
            >
              {fullscreen ? <Minimize size={22} /> : <Maximize size={22} />}
            </button>
          </div>
        </div>
      </div>
      <span className={styles.accessibleStatus} role="status">
        {!playing ? "Đã tạm dừng" : atLive ? "Đang trực tiếp" : "Đang xem lại"}
      </span>
    </div>
  );
}
