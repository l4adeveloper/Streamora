"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Stage,
  StageStream,
  LocalStageStream,
  StageParticipantInfo,
} from "amazon-ivs-web-broadcast";
import type { JoinClassMediaResponse } from "@streamora/contracts";
import { apiRequest, asApiError } from "@/lib/api";

export interface MediaPeer {
  id: string;
  name: string;
  stream: MediaStream;
  micEnabled: boolean;
  cameraEnabled: boolean;
}
export type MediaStatus =
  "idle" | "connecting" | "connected" | "reconnecting" | "closed";
export function deviceError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (["NotAllowedError", "SecurityError"].includes(name))
    return "Bạn chưa cho phép truy cập mic/camera. Bạn vẫn có thể vào phòng chỉ để nghe.";
  if (["NotFoundError", "DevicesNotFoundError"].includes(name))
    return "Không tìm thấy thiết bị đã chọn. Hãy chọn lại mic/camera hoặc vào chỉ để nghe.";
  if (["NotReadableError", "OverconstrainedError"].includes(name))
    return "Thiết bị đang bận hoặc không đáp ứng cấu hình. Hãy chọn thiết bị khác.";
  return "Không thể mở mic/camera. Hãy kiểm tra quyền và thiết bị.";
}
export function useClassMedia(
  sessionId: string,
  participationId: string | null,
) {
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<MediaPeer[]>([]);
  const [micEnabled, setMic] = useState(true),
    [cameraEnabled, setCamera] = useState(true);
  const [connection, setConnection] = useState<JoinClassMediaResponse | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const stream = useRef<MediaStream | null>(null);
  const stage = useRef<Stage | null>(null);
  const localStreams = useRef<LocalStageStream[]>([]);
  const remote = useRef(new Map<string, MediaPeer>());
  const clientId = useRef<string | null>(null),
    requestId = useRef<string | null>(null);
  const currentConnection = useRef<JoinClassMediaResponse | null>(null);
  const generation = useRef(0),
    locked = useRef(false);
  const settings = useRef({ micEnabled, cameraEnabled });
  settings.current = { micEnabled, cameraEnabled };
  const currentStatus = useRef(status);
  currentStatus.current = status;
  const root = `/sessions/${encodeURIComponent(sessionId)}`;

  const stop = useCallback(
    (notify = true) => {
      generation.current++;
      const previous = currentConnection.current;
      currentConnection.current = null;
      stage.current?.removeAllListeners();
      stage.current?.leave();
      stage.current = null;
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      localStreams.current = [];
      remote.current.clear();
      setPreview(null);
      setPeers([]);
      setConnection(null);
      setStatus("idle");
      if (notify && previous)
        void apiRequest(`${root}/media/${previous.connectionId}/leave`, {
          method: "POST",
          body: { requestId: previous.requestId },
        }).catch(() => {});
      requestId.current = null;
    },
    [root],
  );
  useEffect(
    () => () => {
      stop();
    },
    [stop],
  );
  useEffect(() => {
    if (!participationId) stop();
  }, [participationId, stop]);

  const refreshDevices = useCallback(async () => {
    if (navigator.mediaDevices?.enumerateDevices)
      setDevices(await navigator.mediaDevices.enumerateDevices());
  }, []);
  useEffect(() => {
    void refreshDevices().catch(() => {});
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () =>
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        refreshDevices,
      );
  }, [refreshDevices]);

  async function checkDevices(audioId: string, videoId: string) {
    if (locked.current || stage.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const ticket = generation.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("UNSUPPORTED_BROWSER");
      const next = await navigator.mediaDevices.getUserMedia({
        audio: settings.current.micEnabled
          ? audioId
            ? { deviceId: { exact: audioId } }
            : true
          : false,
        video: settings.current.cameraEnabled
          ? {
              ...(videoId ? { deviceId: { exact: videoId } } : {}),
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : false,
      });
      if (ticket !== generation.current) {
        next.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = next;
      setPreview(next);
      await refreshDevices();
    } catch (error) {
      if (ticket === generation.current) setError(deviceError(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function join() {
    if (!participationId || locked.current || stage.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setStatus("connecting");
    const ticket = generation.current;
    let issued: JoinClassMediaResponse | null = null;
    try {
      const sdk = await import("amazon-ivs-web-broadcast");
      clientId.current ??= crypto.randomUUID();
      requestId.current ??= crypto.randomUUID();
      issued = await apiRequest<JoinClassMediaResponse>(`${root}/join`, {
        method: "POST",
        body: {
          participationId,
          clientId: clientId.current,
          requestId: requestId.current,
        },
      });
      if (ticket !== generation.current) {
        void apiRequest(`${root}/media/${issued.connectionId}/leave`, {
          method: "POST",
          body: { requestId: issued.requestId },
        }).catch(() => {});
        return;
      }
      currentConnection.current = issued;
      setConnection(issued);
      if (!stream.current) {
        setMic(false);
        setCamera(false);
        settings.current = { micEnabled: false, cameraEnabled: false };
      }
      localStreams.current = (stream.current?.getTracks() ?? [])
        .filter((t) => t.readyState === "live")
        .map((t) => new sdk.LocalStageStream(t));
      for (const item of localStreams.current)
        item.setMuted(
          item.mediaStreamTrack.kind === "audio"
            ? !settings.current.micEnabled
            : !settings.current.cameraEnabled,
        );
      const next = new sdk.Stage(issued.participantToken, {
        stageStreamsToPublish: () => localStreams.current,
        shouldPublishParticipant: () => localStreams.current.length > 0,
        shouldSubscribeToParticipant: () => sdk.SubscribeType.AUDIO_VIDEO,
      });
      stage.current = next;
      const publishPeers = () => {
        if (ticket === generation.current)
          setPeers([...remote.current.values()]);
      };
      const updatePeer = (
        person: StageParticipantInfo,
        items: StageStream[],
        remove = false,
      ) => {
        if (person.isLocal || ticket !== generation.current) return;
        const previous = remote.current.get(person.id);
        const tracks = new Map(
          previous?.stream.getTracks().map((t) => [t.id, t]) ?? [],
        );
        for (const item of items) {
          if (remove) tracks.delete(item.mediaStreamTrack.id);
          else tracks.set(item.mediaStreamTrack.id, item.mediaStreamTrack);
        }
        const media = new MediaStream([...tracks.values()]);
        remote.current.set(person.id, {
          id: person.id,
          name:
            typeof person.attributes.fullName === "string"
              ? person.attributes.fullName
              : "Thành viên",
          stream: media,
          micEnabled: !person.audioMuted,
          cameraEnabled:
            !person.videoStopped && media.getVideoTracks().length > 0,
        });
        publishPeers();
      };
      next.on(sdk.StageEvents.STAGE_CONNECTION_STATE_CHANGED, (state) => {
        if (ticket === generation.current)
          setStatus(
            state === sdk.StageConnectionState.CONNECTED
              ? "connected"
              : state === sdk.StageConnectionState.CONNECTING
                ? "connecting"
                : "reconnecting",
          );
      });
      next.on(
        sdk.StageEvents.STAGE_PARTICIPANT_STREAMS_ADDED,
        (person, streams) => updatePeer(person, streams),
      );
      next.on(
        sdk.StageEvents.STAGE_PARTICIPANT_STREAMS_REMOVED,
        (person, streams) => updatePeer(person, streams, true),
      );
      next.on(sdk.StageEvents.STAGE_STREAM_MUTE_CHANGED, (person, item) =>
        updatePeer(person, [item]),
      );
      next.on(sdk.StageEvents.STAGE_PARTICIPANT_LEFT, (person) => {
        remote.current.delete(person.id);
        publishPeers();
      });
      next.on(sdk.StageEvents.ERROR, () => {
        if (ticket !== generation.current) return;
        setError(
          "Kết nối media gặp sự cố. Kiểm tra mạng hoặc thử kết nối lại; phòng có thể đã đạt giới hạn người phát.",
        );
      });
      next.on(sdk.StageEvents.STAGE_LEFT, (reason) => {
        if (ticket !== generation.current) return;
        stop();
        setStatus("closed");
        setError(
          reason === sdk.StageLeftReason.PARTICIPANT_DISCONNECTED
            ? "Quyền kết nối video đã bị thu hồi. Hãy kiểm tra lại trạng thái tham gia."
            : "Kết nối video đã đóng. Bạn có thể thử kết nối lại nếu lượt tham gia còn hiệu lực.",
        );
      });
      await next.join();
    } catch (error) {
      if (ticket !== generation.current) return;
      const apiError = asApiError(error);
      if (
        ["MEDIA_REQUEST_EXPIRED", "STALE_MEDIA_REQUEST"].includes(apiError.code)
      )
        requestId.current = null;
      if (issued) stop();
      else setStatus("idle");
      setError(
        apiError.code === "UNKNOWN_ERROR"
          ? "Không thể kết nối video. Kiểm tra trình duyệt, mạng rồi thử lại."
          : apiError.message,
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!connection || !participationId) return;
    let stopped = false,
      sending = false;
    const ping = async () => {
      if (sending || stopped) return;
      sending = true;
      try {
        await apiRequest(`${root}/media/${connection.connectionId}/heartbeat`, {
          method: "POST",
          body: {
            participationId,
            requestId: connection.requestId,
            clientId: clientId.current,
            connected: currentStatus.current === "connected",
            ...settings.current,
          },
        });
      } catch (error) {
        if (
          !stopped &&
          currentConnection.current?.requestId === connection.requestId &&
          [401, 403, 404, 409].includes(asApiError(error).status)
        ) {
          stop();
          setError(
            "Quyền kết nối video đã hết. Hãy kiểm tra lại lượt tham gia.",
          );
        }
      } finally {
        sending = false;
      }
    };
    void ping();
    const timer = setInterval(() => void ping(), 10000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [connection, participationId, root, stop]);

  async function toggle(kind: "audio" | "video") {
    if (locked.current) return;
    const enabled = kind === "audio" ? !micEnabled : !cameraEnabled;
    if (
      enabled &&
      stage.current &&
      !stream.current
        ?.getTracks()
        .some((t) => t.kind === kind && t.readyState === "live")
    ) {
      const ticket = generation.current;
      locked.current = true;
      setBusy(true);
      setError("");
      try {
        const captured = await navigator.mediaDevices.getUserMedia({
          audio: kind === "audio",
          video:
            kind === "video"
              ? { width: { ideal: 1280 }, height: { ideal: 720 } }
              : false,
        });
        if (ticket !== generation.current) {
          captured.getTracks().forEach((t) => t.stop());
          return;
        }
        const sdk = await import("amazon-ivs-web-broadcast");
        if (ticket !== generation.current) {
          captured.getTracks().forEach((t) => t.stop());
          return;
        }
        const combined = new MediaStream([
          ...(stream.current?.getTracks() ?? []),
          ...captured.getTracks(),
        ]);
        stream.current = combined;
        setPreview(combined);
        localStreams.current.push(
          ...captured.getTracks().map((t) => new sdk.LocalStageStream(t)),
        );
        stage.current?.refreshStrategy();
      } catch (error) {
        if (ticket === generation.current) setError(deviceError(error));
        return;
      } finally {
        locked.current = false;
        setBusy(false);
      }
    }
    if (kind === "audio") setMic(enabled);
    else setCamera(enabled);
    for (const item of localStreams.current)
      if (item.mediaStreamTrack.kind === kind) item.setMuted(!enabled);
    for (const track of stream.current?.getTracks() ?? [])
      if (track.kind === kind) track.enabled = enabled;
  }
  return {
    status,
    error,
    devices,
    preview,
    peers,
    micEnabled,
    cameraEnabled,
    busy,
    checkDevices,
    join,
    stop,
    toggle,
    connected: !!connection,
  };
}
