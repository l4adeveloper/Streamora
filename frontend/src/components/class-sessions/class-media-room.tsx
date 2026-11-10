"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, Headphones, Unplug } from "lucide-react";
import { useClassMedia } from "@/lib/class-sessions/use-class-media";
import { InlineNotice } from "@/components/common/feedback";
import "./media.css";

function MediaTile({
  stream,
  name,
  local = false,
  camera = true,
}: {
  stream: MediaStream;
  name: string;
  local?: boolean;
  camera?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    void element
      .play()
      .then(() => setBlocked(false))
      .catch(() => setBlocked(true));
    return () => {
      element.srcObject = null;
    };
  }, [stream]);
  return (
    <div className="class-media-tile">
      <video
        ref={video}
        autoPlay
        playsInline
        muted={local}
        aria-label={name}
        className={camera ? "" : "camera-off"}
      />
      {!camera && (
        <span className="class-media-avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="class-media-name">{name}</span>
      {blocked && !local && (
        <button
          className="button secondary compact class-media-play"
          onClick={() =>
            void video.current?.play().then(() => setBlocked(false))
          }
        >
          Bật âm thanh
        </button>
      )}
    </div>
  );
}
export function ClassMediaRoom({
  sessionId,
  participationId,
}: {
  sessionId: string;
  participationId: string | null;
}) {
  const media = useClassMedia(sessionId, participationId);
  const [audioId, setAudioId] = useState(""),
    [videoId, setVideoId] = useState("");
  const labels = {
    idle: "Chưa kết nối video",
    connecting: "Đang kết nối video…",
    connected: "Đã kết nối video",
    reconnecting: "Đang khôi phục video…",
    closed: "Kết nối video đã đóng",
  };
  return (
    <section
      className="class-panel class-media-room"
      aria-labelledby="class-media-title"
    >
      <div className="class-toolbar">
        <h2 id="class-media-title">Mic và camera</h2>
        <span role="status" className="class-connection">
          {labels[media.status]}
        </span>
      </div>
      {media.error && <InlineNotice tone="error">{media.error}</InlineNotice>}
      {!media.connected && (
        <>
          <p className="class-muted">
            Kiểm tra thiết bị trước khi kết nối. Bạn cũng có thể vào chỉ để nghe
            mà không mở mic/camera.
          </p>
          <div className="class-media-devices">
            <label>
              Micro
              <select
                value={audioId}
                onChange={(e) => setAudioId(e.target.value)}
                disabled={media.busy}
              >
                <option value="">Thiết bị mặc định</option>
                {media.devices
                  .filter((d) => d.kind === "audioinput")
                  .map((d, i) => (
                    <option value={d.deviceId} key={d.deviceId || i}>
                      {d.label || `Micro ${i + 1}`}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Camera
              <select
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
                disabled={media.busy}
              >
                <option value="">Thiết bị mặc định</option>
                {media.devices
                  .filter((d) => d.kind === "videoinput")
                  .map((d, i) => (
                    <option value={d.deviceId} key={d.deviceId || i}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </>
      )}
      <div className="class-media-grid">
        {media.preview ? (
          <MediaTile
            stream={media.preview}
            name="Bạn · xem trước"
            local
            camera={media.cameraEnabled}
          />
        ) : (
          <div className="class-media-placeholder">
            <Headphones size={32} />
            <span>Thiết bị đang tắt</span>
          </div>
        )}
        {media.peers.map((peer) => (
          <MediaTile
            key={peer.id}
            stream={peer.stream}
            name={peer.name}
            camera={peer.cameraEnabled}
          />
        ))}
      </div>
      <div className="class-actions">
        <button
          className="button secondary compact"
          onClick={() => media.toggle("audio")}
          aria-pressed={media.micEnabled}
          disabled={media.busy}
        >
          {media.micEnabled ? <Mic size={16} /> : <MicOff size={16} />}
          {media.micEnabled ? "Tắt mic" : "Bật mic"}
        </button>
        <button
          className="button secondary compact"
          onClick={() => media.toggle("video")}
          aria-pressed={media.cameraEnabled}
          disabled={media.busy}
        >
          {media.cameraEnabled ? <Video size={16} /> : <VideoOff size={16} />}
          {media.cameraEnabled ? "Tắt camera" : "Bật camera"}
        </button>
        {!media.connected && (
          <button
            className="button secondary"
            onClick={() => void media.checkDevices(audioId, videoId)}
            disabled={media.busy || (!media.micEnabled && !media.cameraEnabled)}
          >
            Kiểm tra thiết bị
          </button>
        )}
        {media.connected || media.preview ? (
          <button
            className="button secondary"
            onClick={() => media.stop()}
            disabled={media.busy}
          >
            <Unplug size={16} />
            Ngắt thiết bị
          </button>
        ) : null}
        {!media.connected && (
          <button
            className="button primary"
            onClick={() => void media.join()}
            disabled={!participationId || media.busy}
          >
            {media.busy
              ? "Đang chuẩn bị…"
              : media.preview
                ? "Kết nối mic/camera"
                : "Kết nối để nghe"}
          </button>
        )}
      </div>
      {!participationId && (
        <p className="class-muted">
          Tham gia phòng trước khi kết nối video.
        </p>
      )}
    </section>
  );
}
