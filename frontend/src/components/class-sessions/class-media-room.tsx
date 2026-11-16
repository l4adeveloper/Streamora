"use client";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
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
  Minimize2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Users,
  MonitorUp,
  MonitorOff,
  Circle,
  Square,
} from "lucide-react";
import type { ClassParticipationWithUser } from "@streamora/contracts";
import { listClassParticipants } from "@/lib/class-sessions/api";
import {
  useClassMedia,
  type MediaPeer,
} from "@/lib/class-sessions/use-class-media";
import { useClassRecording } from "@/lib/class-sessions/use-class-recording";
import { InlineNotice } from "@/components/common/feedback";
import { useToast } from "@/components/common/toast-provider";
import { useAuth } from "@/components/auth/auth-provider";
import "./media.css";

function useAudioSpeaking(
  stream?: MediaStream,
  active = true,
  fallbackSpeaking?: boolean,
) {
  const [speaking, setSpeaking] = useState(false);
  const speakingRef = useRef(false);

  useEffect(() => {
    if (!active || !stream) {
      setSpeaking(false);
      speakingRef.current = false;
      return;
    }

    const audioTracks = stream.getAudioTracks();
    const liveTrack = audioTracks.find(
      (t) => t.readyState === "live" && t.enabled,
    );
    if (!liveTrack) {
      setSpeaking(false);
      speakingRef.current = false;
      return;
    }

    const AudioContextClass =
      typeof window !== "undefined"
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext
        : null;

    if (!AudioContextClass) {
      return;
    }

    let ctx: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let analyserNode: AnalyserNode | null = null;
    let animFrame: number | null = null;
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    let isDisposed = false;

    try {
      ctx = new AudioContextClass();
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
      const mediaStream = new MediaStream([liveTrack]);
      sourceNode = ctx.createMediaStreamSource(mediaStream);
      analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.4;
      sourceNode.connect(analyserNode);

      const buffer = new Uint8Array(analyserNode.frequencyBinCount);

      const checkVolume = () => {
        if (isDisposed || !analyserNode) return;
        analyserNode.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i];
        }
        const avg = sum / buffer.length;
        const isSpeakingNow = avg > 12;

        if (isSpeakingNow) {
          if (clearTimer) {
            clearTimeout(clearTimer);
            clearTimer = null;
          }
          if (!speakingRef.current) {
            speakingRef.current = true;
            setSpeaking(true);
          }
        } else if (speakingRef.current && !clearTimer) {
          clearTimer = setTimeout(() => {
            speakingRef.current = false;
            setSpeaking(false);
            clearTimer = null;
          }, 400);
        }

        animFrame = requestAnimationFrame(checkVolume);
      };

      animFrame = requestAnimationFrame(checkVolume);
    } catch {
      // AudioContext fallback
    }

    return () => {
      isDisposed = true;
      if (animFrame) cancelAnimationFrame(animFrame);
      if (clearTimer) clearTimeout(clearTimer);
      try {
        sourceNode?.disconnect();
        analyserNode?.disconnect();
        void ctx?.close();
      } catch {}
    };
  }, [stream, active]);

  return fallbackSpeaking !== undefined
    ? fallbackSpeaking || speaking
    : speaking;
}

function MediaTile({
  stream,
  name,
  camera = true,
  screen = false,
  isLocal = false,
  enhanced = true,
  speaking,
}: {
  stream?: MediaStream;
  name: string;
  camera?: boolean;
  screen?: boolean;
  isLocal?: boolean;
  enhanced?: boolean;
  speaking?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element || !stream) return;
    element.srcObject = stream;
    void element.play().catch(() => {});
    return () => {
      element.srcObject = null;
    };
  }, [stream]);

  const isAudioSpeaking = useAudioSpeaking(stream, !screen, speaking);
  const isSpeaking =
    speaking !== undefined ? speaking || isAudioSpeaking : isAudioSpeaking;

  const isVideoMirrored = isLocal && !screen;
  const isVideoEnhanced = !screen && enhanced;
  const videoClasses = [
    screen ? "class-media-screen-video" : camera ? "" : "camera-off",
    isVideoMirrored ? "class-media-mirrored" : "",
    isVideoEnhanced ? "class-media-enhanced" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={`class-media-tile ${isSpeaking ? "speaking" : ""} ${isLocal && screen ? "class-media-self-screen" : ""}`}
    >
      {stream && (
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          aria-label={name}
          className={videoClasses}
        />
      )}
      {isLocal && screen && (
        <div className="class-media-self-screen-notice" role="status">
          <MonitorUp size={42} aria-hidden="true" />
          <strong>Bạn đang chia sẻ màn hình</strong>
          <p>
            Bản xem trước của bạn được ẩn khi toàn màn hình để tránh hình ảnh
            lặp lại. Nhấn Esc để xem lại bản xem trước.
          </p>
        </div>
      )}
      {!camera && !screen && (
        <div
          className={`class-media-avatar-container ${
            isSpeaking ? "speaking" : ""
          }`}
        >
          {isSpeaking && (
            <div className="audio-sound-waves" aria-hidden="true">
              <span className="sound-wave wave-1" />
              <span className="sound-wave wave-2" />
              <span className="sound-wave wave-3" />
            </div>
          )}
          <span className="class-media-avatar" aria-hidden="true">
            {name.slice(0, 1).toUpperCase()}
          </span>
        </div>
      )}
      <span className="class-media-name">{name}</span>
    </div>
  );
}

type WorkspaceMediaTile = {
  id: string;
  name: string;
  stream?: MediaStream;
  cameraEnabled?: boolean;
  isScreenShare?: boolean;
  isLocal?: boolean;
};

function WorkspaceTile({ tile }: { tile: WorkspaceMediaTile }) {
  return (
    <MediaTile
      stream={tile.stream}
      name={tile.isScreenShare ? `${tile.name} · Màn hình` : tile.name}
      camera={tile.cameraEnabled}
      screen={tile.isScreenShare}
      isLocal={tile.isLocal}
    />
  );
}

function MediaTray({
  label,
  icon: Icon,
  tiles,
  featuredId,
  onFeature,
}: {
  label: "CAMERA" | "SHARING";
  icon: typeof Video;
  tiles: WorkspaceMediaTile[];
  featuredId?: string;
  onFeature: (id: string | null) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="workspace-media-tray">
      <button
        type="button"
        className="workspace-media-tray-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon size={15} aria-hidden="true" />
        {label}
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <div id={id} hidden={!open}>
        {open &&
          (tiles.length > 0 ? (
            <MediaTrayRow
              label={label}
              tiles={tiles}
              featuredId={featuredId}
              onFeature={onFeature}
            />
          ) : (
            <p className="workspace-media-tray-empty">
              {label === "SHARING"
                ? "Chưa có chia sẻ màn hình"
                : "Chưa có camera"}
            </p>
          ))}
      </div>
    </div>
  );
}

function MediaTrayRow({
  label,
  tiles,
  featuredId,
  onFeature,
}: {
  label: string;
  tiles: WorkspaceMediaTile[];
  featuredId?: string;
  onFeature: (id: string | null) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const element = row.current;
    if (!element) return;
    const { scrollLeft, scrollWidth, clientWidth } = element;
    const left = scrollLeft > 1;
    const right = scrollLeft + clientWidth < scrollWidth - 1;
    setEdges((previous) =>
      previous.left === left && previous.right === right
        ? previous
        : { left, right },
    );
  }, []);

  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    updateEdges();
    return () => observer.disconnect();
  }, [updateEdges]);

  function scroll(direction: -1 | 1) {
    const element = row.current;
    if (!element) return;
    const firstTile = element.querySelector(".workspace-media-peer");
    const tileWidth = firstTile?.getBoundingClientRect().width ?? 0;
    element.scrollBy({
      left: direction * Math.max(tileWidth, element.clientWidth - tileWidth),
      behavior: "smooth",
    });
  }

  return (
    <div className="workspace-media-tray-row">
      <div className="workspace-media-peers" ref={row} onScroll={updateEdges}>
        <div className="workspace-media-peer-list">
          {tiles.map((tile) => {
            const selected = tile.id === featuredId;
            const name = tile.isScreenShare
              ? `${tile.name} · Màn hình`
              : tile.name;
            const action = selected ? "Bỏ ghim" : "Phóng to";
            return (
              <div key={tile.id} className="workspace-media-peer">
                <WorkspaceTile tile={tile} />
                <button
                  type="button"
                  className="workspace-pin-peer"
                  aria-label={`${action} ${name}`}
                  title={`${action} ${name}`}
                  onClick={() => onFeature(selected ? null : tile.id)}
                >
                  {selected ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {(edges.left || edges.right) && (
        <>
          <button
            type="button"
            className="workspace-media-arrow previous"
            aria-label={`Cuộn ${label} sang trái`}
            disabled={!edges.left}
            onClick={() => scroll(-1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            className="workspace-media-arrow next"
            aria-label={`Cuộn ${label} sang phải`}
            disabled={!edges.right}
            onClick={() => scroll(1)}
          >
            <ChevronRight size={18} />
          </button>
        </>
      )}
    </div>
  );
}

function ParticipantAudio({
  id,
  track,
  name,
  reportBlocked,
}: {
  id: string;
  track: MediaStreamTrack;
  name: string;
  reportBlocked: (id: string, blocked: boolean) => void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    const stream = new MediaStream([track]);
    element.srcObject = stream;
    void element.play().catch((error: unknown) => {
      if (
        element.srcObject === stream &&
        error instanceof DOMException &&
        error.name === "NotAllowedError"
      )
        reportBlocked(id, true);
    });
    return () => {
      element.srcObject = null;
      reportBlocked(id, false);
    };
  }, [id, track, reportBlocked]);
  return (
    <audio
      ref={audio}
      autoPlay
      aria-label={name}
      onPlaying={() => reportBlocked(id, false)}
    />
  );
}

function RoomAudio({ peers }: { peers: MediaPeer[] }) {
  const playback = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(new Set<string>());
  const reportBlocked = useCallback((id: string, value: boolean) => {
    setBlocked((current) => {
      if (current.has(id) === value) return current;
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return (
    <div ref={playback} style={{ display: "contents" }}>
      {peers.map((peer) => {
        const track = peer.stream.getAudioTracks()[0];
        return track ? (
          <ParticipantAudio
            key={peer.id}
            id={peer.id}
            track={track}
            name={peer.name}
            reportBlocked={reportBlocked}
          />
        ) : null;
      })}
      {blocked.size > 0 && (
        <button
          type="button"
          className="button secondary compact"
          onClick={() => {
            // Each play() must start during the same browser user gesture.
            for (const audio of playback.current?.querySelectorAll("audio") ??
              [])
              if (audio.paused) void audio.play().catch(() => {});
          }}
        >
          Bật âm thanh phòng
        </button>
      )}
    </div>
  );
}
export interface ClassMediaHandle {
  stop: () => void;
  toggleMicrophone: () => Promise<void>;
  mute: () => void;
}
export interface ClassMediaState {
  micEnabled: boolean;
  busy: boolean;
  publishLocked: boolean;
}
export function ClassMediaRoom({
  sessionId,
  participationId,
  revision = 0,
  ref,
  layout = "panel",
  headerDetail,
  emptyContent,
  actions,
  leaveAction,
  disabled = false,
  canManage = false,
  onState,
  micLocked = false,
}: {
  sessionId: string;
  participationId: string | null;
  revision?: number;
  ref?: Ref<ClassMediaHandle>;
  layout?: "panel" | "workspace";
  headerDetail?: ReactNode;
  emptyContent?: ReactNode;
  actions?: ReactNode;
  leaveAction?: ReactNode;
  disabled?: boolean;
  canManage?: boolean;
  onState?: (state: ClassMediaState) => void;
  micLocked?: boolean;
}) {
  const media = useClassMedia(
    sessionId,
    disabled ? null : participationId,
    micLocked,
  );
  const { user } = useAuth();
  const { notify } = useToast();
  const recording = useClassRecording({
    sessionId,
    participationId: disabled ? null : participationId,
    revision,
    enabled: !disabled,
    canManage,
    onNotice: (message, tone) => notify(message, { tone: tone ?? "success" }),
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [featuredId, setFeaturedId] = useState<string | null>(null);
  const [roster, setRoster] = useState<{
    visitId: string;
    people: ClassParticipationWithUser[];
  } | null>(null);
  const frame = useRef<HTMLElement>(null);
  useEffect(() => {
    if (disabled) media.stop();
  }, [disabled, media.stop]);
  useEffect(() => {
    if (disabled || !participationId) return;
    const visitId = participationId;
    let current = true;
    async function loadRoster() {
      const people: ClassParticipationWithUser[] = [];
      let cursor: string | undefined;
      do {
        const page = await listClassParticipants(sessionId, cursor);
        if (!current) return;
        people.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      setRoster({ visitId, people });
    }
    void loadRoster().catch(() => {});
    return () => {
      current = false;
    };
  }, [disabled, participationId, revision, sessionId]);
  const [audioId, setAudioId] = useState(""),
    [videoId, setVideoId] = useState("");
  const micOn =
    media.micEnabled &&
    !!media.preview
      ?.getAudioTracks()
      .some((track) => track.readyState === "live" && track.enabled);
  const cameraOn =
    media.cameraEnabled &&
    !!media.preview
      ?.getVideoTracks()
      .some((track) => track.readyState === "live" && track.enabled);
  useImperativeHandle(ref, () => ({
    stop: () => media.stop(),
    mute: media.applyMute,
    toggleMicrophone: async () => {
      if (!disabled && !media.busy && !media.publishLocked)
        await media.toggle("audio", audioId);
    },
  }));
  useEffect(() => {
    onState?.({
      micEnabled: micOn,
      busy: media.busy,
      publishLocked: media.publishLocked,
    });
  }, [onState, micOn, media.busy, media.publishLocked]);
  const labels = {
    idle: "Chưa kết nối video",
    connecting: "Đang kết nối video…",
    connected: "Đã kết nối video",
    reconnecting: "Đang khôi phục video…",
    closed: "Kết nối video đã đóng",
  };
  const sharing = Boolean(media.screenPreview);
  const screenPeers = media.peers.filter((peer) => peer.isScreenShare);
  const recordingLive = recording.recording;
  // While recording, a second screen share would be revoked by the server.
  const shareBlocked =
    !!recordingLive &&
    !sharing &&
    !media.screenPending &&
    screenPeers.length > 0;
  const shareLabel = sharing
    ? "Dừng chia sẻ màn hình"
    : media.screenPending
      ? "Hủy chia sẻ màn hình"
      : shareBlocked
        ? "Đang ghi hình: chỉ một người được chia sẻ màn hình"
        : "Chia sẻ màn hình";
  const shareButton = (
    <button
      type="button"
      className={
        layout === "workspace"
          ? `device-button ${sharing ? "enabled" : ""}`
          : "button secondary compact"
      }
      onClick={() => void media.toggleScreenShare()}
      aria-label={shareLabel}
      title={shareLabel}
      aria-pressed={sharing}
      disabled={
        disabled ||
        shareBlocked ||
        (!sharing &&
          !media.screenPending &&
          (media.publishLocked || media.status !== "connected"))
      }
    >
      {sharing || media.screenPending ? (
        <MonitorOff size={18} />
      ) : (
        <MonitorUp size={18} />
      )}
      {layout === "panel" && shareLabel}
    </button>
  );
  const people =
    participationId && roster?.visitId === participationId ? roster.people : [];
  const cameraPeers = media.peers.filter((peer) => !peer.isScreenShare);
  const presenterParticipant = recordingLive?.presenter?.participantId ?? null;
  const visibleScreens = screenPeers.map((peer) => peer.id).join(",");
  const endScreenShare = media.endScreenShare;
  useEffect(() => {
    // The server keeps the first share; end ours if someone else holds the slot.
    if (
      !presenterParticipant ||
      !media.screenParticipantId ||
      presenterParticipant === media.screenParticipantId ||
      !visibleScreens.split(",").includes(presenterParticipant)
    )
      return;
    endScreenShare(
      `Buổi học đang được ghi hình nên chỉ giữ chia sẻ màn hình của ${recordingLive?.presenter?.fullName ?? "người khác"}. Chia sẻ của bạn đã tắt.`,
    );
  }, [
    endScreenShare,
    media.screenParticipantId,
    presenterParticipant,
    recordingLive?.presenter?.fullName,
    visibleScreens,
  ]);
  const recordingPanel = (recordingLive || recording.phase === "saving") && (
    <div className="class-recording-status">
      {recordingLive && (
        <span className="class-recording-badge" role="status">
          <span className="class-recording-dot" aria-hidden="true" />
          {recordingLive.starting
            ? "Đang bắt đầu ghi hình trên máy chủ…"
            : "Buổi học đang được ghi hình trên máy chủ"}
        </span>
      )}
      {recording.phase === "saving" && (
        <span className="class-recording-saving" role="status">
          Đang hoàn tất bản ghi trên S3…
        </span>
      )}
      {recordingLive?.errorCode && (
        <span role="status">
          Chưa đồng bộ được bản ghi. Máy chủ đang thử lại.
        </span>
      )}
    </div>
  );
  const recordLabel = recording.canStop
    ? "Dừng ghi hình"
    : recording.phase === "starting"
      ? "Đang bắt đầu ghi…"
      : recordingLive
        ? `${recordingLive.recorderName} đang ghi hình`
        : "Ghi hình buổi học";
  const recordButton = (recording.canRecord || recording.canStop) && (
    <button
      type="button"
      className={
        layout === "workspace"
          ? `device-button class-record-button ${recording.canStop ? "recording" : ""}`
          : `button secondary compact class-record-button ${recording.canStop ? "recording" : ""}`
      }
      onClick={() =>
        recording.canStop ? recording.stop() : void recording.start()
      }
      aria-label={recordLabel}
      title={recordLabel}
      aria-pressed={recording.canStop}
      disabled={
        disabled ||
        recording.phase === "starting" ||
        recording.phase === "stopping" ||
        recording.phase === "saving" ||
        !participationId ||
        (!recording.canStop && !!recordingLive)
      }
    >
      {recording.canStop ? <Square size={16} /> : <Circle size={16} />}
      {layout === "panel" && recordLabel}
    </button>
  );
  const mediaFeedback = (
    <>
      {recordingPanel}
      {media.error && <InlineNotice tone="error">{media.error}</InlineNotice>}
      {media.publishLocked && (
        <InlineNotice>
          Mic, camera và chia sẻ màn hình đang bị khóa. Bạn vẫn có thể nghe và
          xem.
        </InlineNotice>
      )}
      {media.unavailablePeers.length > 0 && (
        <InlineNotice>
          Không nhận được âm thanh hoặc video từ{" "}
          {media.unavailablePeers.join(", ")}.{" "}
          <button
            type="button"
            className="button secondary compact"
            onClick={media.retrySubscriptions}
            disabled={media.status !== "connected"}
          >
            Thử kết nối lại media
          </button>
        </InlineNotice>
      )}
      {/* Screen shares carry tab/system audio, so play them like voices. */}
      <RoomAudio peers={media.peers} />
    </>
  );
  const publishingUsers = new Set(cameraPeers.map((peer) => peer.userId));
  const quietPeers = people
    .filter(
      (visit) =>
        visit.id !== participationId && !publishingUsers.has(visit.userId),
    )
    .map((visit) => ({
      id: visit.id,
      name: visit.user.fullName,
      stream: undefined,
      cameraEnabled: false,
      isScreenShare: false,
    }));
  const participants = [...cameraPeers, ...quietPeers];
  const localName = user?.fullName ?? "Bạn";
  const localScreen = media.screenPreview && (
    <MediaTile
      stream={media.screenPreview}
      name="Bạn · Màn hình"
      screen
      isLocal
    />
  );
  if (layout === "workspace") {
    const localCamera: WorkspaceMediaTile | undefined =
      media.preview || participationId
        ? {
            id: "local-camera",
            name: `${localName} · Bạn`,
            stream: media.preview ?? undefined,
            cameraEnabled: cameraOn,
            isLocal: true,
          }
        : undefined;
    const localShare: WorkspaceMediaTile | undefined = media.screenPreview
      ? {
          id: `local-screen:${media.screenPreview.id}`,
          name: "Bạn",
          stream: media.screenPreview,
          isScreenShare: true,
          isLocal: true,
        }
      : undefined;
    const cameras: WorkspaceMediaTile[] = localCamera
      ? [localCamera, ...participants]
      : participants;
    const screens: WorkspaceMediaTile[] = localShare
      ? [localShare, ...screenPeers]
      : screenPeers;
    const pinned = [...screens, ...cameras].find(
      (tile) => tile.id === featuredId,
    );
    const featured: WorkspaceMediaTile | undefined =
      pinned ?? screens[0] ?? participants[0] ?? localCamera;
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
          {(!featured || featured.isLocal) && canManage && (
            <span className="presenter-badge">Chủ phòng</span>
          )}
          <span className="workspace-call-connection" role="status">
            {headerDetail}
          </span>
          <span className="workspace-video-presence">
            <Users size={14} />
            {participationId
              ? `${Math.max(1, people.length)} người trong phòng`
              : labels[media.status]}
          </span>
        </div>
        {mediaFeedback}
        <div className="workspace-media-stage">
          {featured ? (
            <div className="workspace-media-feature">
              <WorkspaceTile tile={featured} />
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
        </div>
        <div className="workspace-media-trays">
          <MediaTray
            label="CAMERA"
            icon={Video}
            tiles={cameras}
            featuredId={pinned?.id}
            onFeature={setFeaturedId}
          />
          <MediaTray
            label="SHARING"
            icon={MonitorUp}
            tiles={screens}
            featuredId={pinned?.id}
            onFeature={setFeaturedId}
          />
        </div>
        <div className="workspace-call-controls">
          <div className="workspace-device-controls">
            <button
              type="button"
              className={`device-button ${micOn ? "enabled" : ""}`}
              onClick={() => void media.toggle("audio", audioId)}
              title={micOn ? "Tắt mic" : "Bật mic"}
              aria-label={micOn ? "Tắt mic" : "Bật mic"}
              aria-pressed={micOn}
              disabled={disabled || media.busy || media.publishLocked}
            >
              {micOn ? <Mic size={18} /> : <MicOff size={18} />}
            </button>
            <button
              type="button"
              className={`device-button ${cameraOn ? "enabled" : ""}`}
              onClick={() => void media.toggle("video", videoId)}
              title={cameraOn ? "Tắt camera" : "Bật camera"}
              aria-label={cameraOn ? "Tắt camera" : "Bật camera"}
              aria-pressed={cameraOn}
              disabled={disabled || media.busy || media.publishLocked}
            >
              {cameraOn ? <Video size={18} /> : <VideoOff size={18} />}
            </button>
            {shareButton}
            {recordButton}
            <button
              type="button"
              className="device-button"
              aria-label="Chọn thiết bị"
              title="Chọn thiết bị"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((value) => !value)}
              disabled={disabled || media.publishLocked}
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
                disabled={disabled || media.busy || media.publishLocked}
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
                onClick={media.disconnect}
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
                    disabled={media.busy || media.publishLocked}
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
                    disabled={media.busy || media.publishLocked}
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
      {mediaFeedback}
      <div className="class-media-devices">
        <label>
          Micro
          <select
            value={audioId}
            onChange={(e) => setAudioId(e.target.value)}
            disabled={media.busy || media.publishLocked}
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
            disabled={media.busy || media.publishLocked}
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
      <div className="class-media-grid">
        {localScreen && (
          <div className="class-media-presentation">{localScreen}</div>
        )}
        {screenPeers.map((peer) => (
          <div key={peer.id} className="class-media-presentation">
            <MediaTile
              stream={peer.stream}
              name={`${peer.name} · Màn hình`}
              screen
            />
          </div>
        ))}
        {media.preview || participationId ? (
          <MediaTile
            stream={media.preview ?? undefined}
            name={media.preview && !media.connected ? "Bạn · xem trước" : "Bạn"}
            camera={
              media.cameraEnabled && !!media.preview?.getVideoTracks().length
            }
            isLocal
          />
        ) : (
          <div className="class-media-placeholder">
            <Headphones size={32} />
            <span>Thiết bị đang tắt</span>
          </div>
        )}
        {participants.map((peer) => (
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
          onClick={() => void media.toggle("audio", audioId)}
          aria-pressed={micOn}
          disabled={media.busy || media.publishLocked}
        >
          {micOn ? <Mic size={16} /> : <MicOff size={16} />}
          {micOn ? "Tắt mic" : "Bật mic"}
        </button>
        <button
          className="button secondary compact"
          onClick={() => void media.toggle("video", videoId)}
          aria-pressed={cameraOn}
          disabled={media.busy || media.publishLocked}
        >
          {cameraOn ? <Video size={16} /> : <VideoOff size={16} />}
          {cameraOn ? "Tắt camera" : "Bật camera"}
        </button>
        {shareButton}
        {recordButton}
        {!media.connected && (
          <button
            className="button secondary"
            onClick={() => void media.checkDevices(audioId, videoId)}
            disabled={media.busy || media.publishLocked}
          >
            Kiểm tra thiết bị
          </button>
        )}
        {media.connected || media.preview ? (
          <button
            className="button secondary"
            onClick={media.disconnect}
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
