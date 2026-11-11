"use client";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from "react";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Headphones,
  Unplug,
  Settings2,
  Maximize2,
  ChevronDown,
  Users,
} from "lucide-react";
import { useClassMedia } from "@/lib/class-sessions/use-class-media";
import { InlineNotice } from "@/components/common/feedback";
import { useAuth } from "@/components/auth/auth-provider";
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
export interface ClassMediaHandle {
  stop: () => void;
}
export function ClassMediaRoom({
  sessionId,
  participationId,
  ref,
  layout = "panel",
  headerDetail,
  emptyContent,
  actions,
  leaveAction,
  disabled = false,
  canManage = false,
}: {
  sessionId: string;
  participationId: string | null;
  ref?: Ref<ClassMediaHandle>;
  layout?: "panel" | "workspace";
  headerDetail?: ReactNode;
  emptyContent?: ReactNode;
  actions?: ReactNode;
  leaveAction?: ReactNode;
  disabled?: boolean;
  canManage?: boolean;
}) {
  const media = useClassMedia(sessionId, participationId);
  const { user } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [featuredId, setFeaturedId] = useState<string | null>(null);
  const frame = useRef<HTMLElement>(null);
  useEffect(() => {
    if (disabled) media.stop();
  }, [disabled, media.stop]);
  useImperativeHandle(ref, () => ({ stop: () => media.stop() }), [media.stop]);
  const [audioId, setAudioId] = useState(""),
    [videoId, setVideoId] = useState("");
  const labels = {
    idle: "Chưa kết nối video",
    connecting: "Đang kết nối video…",
    connected: "Đã kết nối video",
    reconnecting: "Đang khôi phục video…",
    closed: "Kết nối video đã đóng",
  };
  if (layout === "workspace") {
    const featured =
      media.peers.find((peer) => peer.id === featuredId) ?? media.peers[0];
    const localName = user?.fullName ?? "Bạn";
    return (
      <section
        ref={frame}
        className="class-media-room workspace-media-room"
        aria-labelledby="class-media-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") setSettingsOpen(false);
        }}
      >
        <h2 id="class-media-title" className="sr-only">
          Mic và camera
        </h2>
        <div className="workspace-media-presenter">
          <span className="workspace-presenter-avatar" aria-hidden="true">
            {(featured?.name ?? localName).slice(0, 1).toUpperCase()}
          </span>
          <b>{featured?.name ?? localName}</b>
          {!featured && canManage && (
            <span className="presenter-badge">Chủ phòng</span>
          )}
          <span className="workspace-call-connection" role="status">
            {headerDetail}
          </span>
          <span className="workspace-video-presence">
            <Users size={14} />
            {media.status === "connected"
              ? `${media.peers.length + 1} đang kết nối video`
              : labels[media.status]}
          </span>
        </div>
        {media.error && <InlineNotice tone="error">{media.error}</InlineNotice>}
        <div className="workspace-media-stage">
          {featured ? (
            <div className="workspace-media-feature">
              <MediaTile
                stream={featured.stream}
                name={featured.name}
                camera={featured.cameraEnabled}
              />
            </div>
          ) : media.preview ? (
            <div className="workspace-media-feature">
              <MediaTile
                stream={media.preview}
                name={`${localName} · Bạn`}
                local
                camera={
                  media.cameraEnabled &&
                  media.preview.getVideoTracks().length > 0
                }
              />
            </div>
          ) : (
            <div className="workspace-media-empty">
              {emptyContent ?? (
                <>
                  <Headphones size={42} />
                  <strong>Thiết bị đang tắt</strong>
                  <p>Bật thiết bị hoặc kết nối để nghe cuộc họp.</p>
                </>
              )}
            </div>
          )}
          {featured && media.preview && (
            <div className="workspace-media-local">
              <MediaTile
                stream={media.preview}
                name="Bạn"
                local
                camera={
                  media.cameraEnabled &&
                  media.preview.getVideoTracks().length > 0
                }
              />
            </div>
          )}
          {media.peers.length > 1 && (
            <div className="workspace-media-peers">
              {media.peers
                .filter((peer) => peer.id !== featured?.id)
                .map((peer) => (
                  <div key={peer.id} className="workspace-media-peer">
                    <MediaTile
                      stream={peer.stream}
                      name={peer.name}
                      camera={peer.cameraEnabled}
                    />
                    <button
                      type="button"
                      className="workspace-pin-peer"
                      aria-label={`Hiển thị ${peer.name}`}
                      onClick={() => setFeaturedId(peer.id)}
                    >
                      <Maximize2 size={13} />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
        <div className="workspace-call-controls">
          <div className="workspace-device-controls">
            <button
              type="button"
              className={`device-button ${media.micEnabled ? "enabled" : ""}`}
              onClick={() => void media.toggle("audio")}
              title={media.micEnabled ? "Tắt mic" : "Bật mic"}
              aria-label={media.micEnabled ? "Tắt mic" : "Bật mic"}
              aria-pressed={media.micEnabled}
              disabled={disabled || media.busy}
            >
              {media.micEnabled ? <Mic size={18} /> : <MicOff size={18} />}
            </button>
            <button
              type="button"
              className={`device-button ${media.cameraEnabled ? "enabled" : ""}`}
              onClick={() => void media.toggle("video")}
              title={media.cameraEnabled ? "Tắt camera" : "Bật camera"}
              aria-label={media.cameraEnabled ? "Tắt camera" : "Bật camera"}
              aria-pressed={media.cameraEnabled}
              disabled={disabled || media.busy}
            >
              {media.cameraEnabled ? (
                <Video size={18} />
              ) : (
                <VideoOff size={18} />
              )}
            </button>
            <button
              type="button"
              className="device-button"
              aria-label="Chọn thiết bị"
              title="Chọn thiết bị"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((value) => !value)}
              disabled={disabled}
            >
              <ChevronDown size={17} />
            </button>
            {!media.connected && (
              <button
                type="button"
                className="device-button"
                aria-label="Kiểm tra thiết bị"
                title="Kiểm tra thiết bị"
                onClick={() => void media.checkDevices(audioId, videoId)}
                disabled={
                  disabled ||
                  media.busy ||
                  (!media.micEnabled && !media.cameraEnabled)
                }
              >
                <Settings2 size={17} />
              </button>
            )}
            <button
              type="button"
              className="device-button"
              aria-label="Toàn màn hình"
              title="Toàn màn hình"
              onClick={() => {
                const action = document.fullscreenElement
                  ? document.exitFullscreen()
                  : frame.current?.requestFullscreen();
                void action?.catch(() => {});
              }}
            >
              <Maximize2 size={17} />
            </button>
          </div>
          <div className="workspace-call-actions">
            {!media.connected && !disabled && participationId && (
              <button
                type="button"
                className="button primary compact"
                onClick={() => void media.join()}
                disabled={media.busy}
              >
                {media.busy
                  ? "Đang kết nối…"
                  : media.preview
                    ? "Kết nối mic/camera"
                    : "Kết nối để nghe"}
              </button>
            )}
            {media.connected && (
              <button
                type="button"
                className="workspace-call-action"
                aria-label="Ngắt thiết bị"
                title="Ngắt thiết bị"
                onClick={() => media.stop()}
                disabled={media.busy}
              >
                <Unplug size={15} />
                <span className="workspace-call-action-label">
                  Ngắt thiết bị
                </span>
              </button>
            )}
            {actions}
          </div>
          <div className="workspace-call-leave">{leaveAction}</div>
          {settingsOpen && (
            <div className="workspace-device-menu">
              <div className="class-media-devices">
                <label>
                  Micro
                  <select
                    value={audioId}
                    onChange={(event) => setAudioId(event.target.value)}
                    disabled={media.busy || media.connected}
                  >
                    <option value="">Thiết bị mặc định</option>
                    {media.devices
                      .filter((device) => device.kind === "audioinput")
                      .map((device, index) => (
                        <option
                          key={device.deviceId || index}
                          value={device.deviceId}
                        >
                          {device.label || `Micro ${index + 1}`}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Camera
                  <select
                    value={videoId}
                    onChange={(event) => setVideoId(event.target.value)}
                    disabled={media.busy || media.connected}
                  >
                    <option value="">Thiết bị mặc định</option>
                    {media.devices
                      .filter((device) => device.kind === "videoinput")
                      .map((device, index) => (
                        <option
                          key={device.deviceId || index}
                          value={device.deviceId}
                        >
                          {device.label || `Camera ${index + 1}`}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <button
                type="button"
                className="button secondary compact"
                onClick={() => setSettingsOpen(false)}
              >
                Xong
              </button>
            </div>
          )}
        </div>
      </section>
    );
  }
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
        <p className="class-muted">Tham gia phòng trước khi kết nối video.</p>
      )}
    </section>
  );
}
