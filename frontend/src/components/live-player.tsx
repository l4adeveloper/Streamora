"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Fullscreen,
  Mic,
  MicOff,
  MonitorUp,
  Pause,
  Play,
  Radio,
  Settings2,
  Volume2,
} from "lucide-react";

import { IconButton } from "./ui";
import { Presentation } from "./presentation";
import { time, portrait } from "./demo-data";
export function LivePlayer({
  screenVideo,
  sharing,
}: {
  screenVideo: React.RefObject<HTMLVideoElement | null>;
  sharing: boolean;
}) {
  const [liveEdge, setLiveEdge] = useState(2538);
  const [position, setPosition] = useState(1594);
  const [playing, setPlaying] = useState(true);
  const [atLive, setAtLive] = useState(false);
  const [speed, setSpeed] = useState("1");
  const [quality, setQuality] = useState("Tự động");
  const [volume, setVolume] = useState(true);
  const player = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    // Scale the sample slide like a shared screen without cropping its content.
    const fitSlide = () => {
      const scale = Math.min(
        element.clientWidth / 700,
        element.clientHeight / 400,
      );
      element.style.setProperty("--slide-scale", String(scale));
    };
    fitSlide();
    const observer = new ResizeObserver(fitSlide);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      setLiveEdge((current) => current + 1);
      if (playing)
        setPosition((current) => current + (atLive ? 1 : Number(speed)));
    }, 1000);
    return () => clearInterval(timer);
  }, [playing, atLive, speed]);
  useEffect(() => {
    if (!atLive && position >= liveEdge) {
      setAtLive(true);
      setPosition(liveEdge);
      setSpeed("1");
    }
  }, [position, liveEdge, atLive]);
  const goLive = () => {
    setPosition(liveEdge);
    setAtLive(true);
    setPlaying(true);
    setSpeed("1");
  };
  return (
    <div className="live-player" ref={player}>
      <div className="video-surface" ref={surface}>
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
        <div className="screen-badge">
          <MonitorUp size={12} />{" "}
          {sharing ? "Màn hình của bạn" : "Màn hình của Nguyễn Hoàng"}
        </div>
        <div className="speaker-inset">
          <img src={portrait} alt="Ảnh minh họa giảng viên" />
          <span>
            <i />
            <b>Nguyễn Hoàng</b>
            <Mic size={11} />
          </span>
        </div>
        <span className="player-demo-tag">MINH HỌA</span>
      </div>
      <div className="playback-console">
        <div className="dvr-status">
          <span className={atLive ? "is-live" : ""}>
            <span className="status-dot" />
            {atLive
              ? "Bạn đang xem trực tiếp"
              : `Bạn đang xem lại · chậm ${time(Math.max(0, liveEdge - position))}`}
          </span>
          <button
            onClick={goLive}
            className={`back-to-live ${atLive ? "at-live" : ""}`}
          >
            <Radio size={13} />
            {atLive ? "Đang trực tiếp" : "Về trực tiếp"}
            <ChevronRight size={13} />
          </button>
        </div>
        <div className="timeline-wrap">
          <div className="timeline-buffer" />
          <input
            type="range"
            min="0"
            max={liveEdge}
            value={Math.min(position, liveEdge)}
            step="1"
            aria-label="Tua lại buổi phát trực tiếp"
            style={
              {
                "--progress": `${Math.min((position / liveEdge) * 100, 100)}%`,
              } as React.CSSProperties
            }
            onChange={(e) => {
              setPosition(Number(e.target.value));
              setAtLive(Number(e.target.value) >= liveEdge);
            }}
          />
          <span className="timeline-live-edge" />
        </div>
        <div className="player-controls">
          <div>
            <IconButton
              label={playing ? "Tạm dừng" : "Phát"}
              onClick={() => {
                setPlaying(!playing);
                if (playing) setAtLive(false);
              }}
            >
              {playing ? (
                <Pause size={17} fill="currentColor" />
              ) : (
                <Play size={17} fill="currentColor" />
              )}
            </IconButton>
            <IconButton
              label={volume ? "Tắt âm thanh mẫu" : "Bật âm thanh mẫu"}
              onClick={() => setVolume(!volume)}
            >
              {volume ? <Volume2 size={18} /> : <MicOff size={18} />}
            </IconButton>
            <span className="playback-time">
              {time(Math.min(position, liveEdge))}
              <span>/ {time(liveEdge)}</span>
            </span>
            <span className="dvr-pill">TUA LẠI</span>
          </div>
          <div>
            <label className="player-select">
              <span className="sr-only">Tốc độ phát mẫu</span>
              <select
                aria-label="Tốc độ phát"
                value={speed}
                onChange={(e) => {
                  setSpeed(e.target.value);
                  if (e.target.value !== "1") setAtLive(false);
                }}
              >
                {["0.5", "1", "1.25", "1.5", "2"].map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
              <ChevronDown size={11} />
            </label>
            <label className="player-select">
              <Settings2 size={14} />
              <select
                aria-label="Chất lượng video"
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
              >
                {["Tự động", "720p", "1080p"].map((q) => (
                  <option key={q}>{q}</option>
                ))}
              </select>
              <ChevronDown size={11} />
            </label>
            <IconButton
              label="Toàn màn hình"
              onClick={async () => {
                if (document.fullscreenElement) await document.exitFullscreen();
                else await player.current?.requestFullscreen();
              }}
            >
              <Fullscreen size={17} />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
}
