"use client";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type {
  Stage,
  StageStream,
  LocalStageStream,
  StageParticipantInfo,
  StageErrorCategory,
} from "amazon-ivs-web-broadcast";
import type {
  JoinClassMediaRequest,
  JoinClassMediaResponse,
} from "@streamora/contracts";
import { apiRequest, asApiError } from "@/lib/api";

export interface MediaPeer {
  id: string;
  userId: string;
  name: string;
  stream: MediaStream;
  micEnabled: boolean;
  cameraEnabled: boolean;
  isScreenShare: boolean;
}
interface ScreenShare {
  cancel: AbortController;
  capture?: MediaStream;
  connection?: JoinClassMediaResponse;
  stage?: Stage;
  heartbeat?: ReturnType<typeof setInterval>;
}

async function requestMediaConnection(
  root: string,
  body: JoinClassMediaRequest,
  signal: AbortSignal,
) {
  const deadline = Date.now() + 130000;
  let attempt = 0;
  while (!signal.aborted) {
    try {
      // Keep in-flight requests alive so a late token can be explicitly released.
      return await apiRequest<JoinClassMediaResponse>(`${root}/join`, {
        method: "POST",
        body,
      });
    } catch (error) {
      const failure = asApiError(error);
      const delay = Math.min(4000, 500 * 2 ** attempt++);
      if (signal.aborted) return null;
      if (
        failure.status !== 409 ||
        !["MEDIA_STARTING", "MEDIA_REVOKING"].includes(failure.code) ||
        Date.now() + delay > deadline
      )
        throw error;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
  return null;
}

function releaseMediaConnection(
  root: string,
  connection: JoinClassMediaResponse,
) {
  void apiRequest(`${root}/media/${connection.connectionId}/leave`, {
    method: "POST",
    body: { requestId: connection.requestId },
  }).catch(() => {});
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
  micLocked: boolean,
) {
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [error, setError] = useState("");
  const [stageError, setStageError] = useState<{
    category: StageErrorCategory;
    message: string;
  } | null>(null);
  const [unavailablePeers, setUnavailablePeers] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<MediaPeer[]>([]);
  const [micEnabled, setMic] = useState(!participationId),
    [cameraEnabled, setCamera] = useState(!participationId);
  const [connection, setConnection] = useState<JoinClassMediaResponse | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [screenPreview, setScreenPreview] = useState<MediaStream | null>(null);
  const [screenPending, setScreenPending] = useState(false);
  const screenShare = useRef<ScreenShare | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const stage = useRef<Stage | null>(null);
  const localStreams = useRef<LocalStageStream[]>([]);
  const remote = useRef(new Map<string, MediaPeer>());
  const clientId = useRef<string | null>(null),
    requestId = useRef<string | null>(null);
  const currentConnection = useRef<JoinClassMediaResponse | null>(null);
  const generation = useRef(0),
    locked = useRef(false);
  const joinRequest = useRef<AbortController | null>(null);
  const autoJoinedVisit = useRef<string | null>(null);
  const settings = useRef({ micEnabled, cameraEnabled });
  settings.current = { micEnabled, cameraEnabled };
  const currentStatus = useRef(status);
  currentStatus.current = status;
  const root = `/sessions/${encodeURIComponent(sessionId)}`;
  const muteRevision = useRef(0);
  const publishLocked =
    micLocked || (connection !== null && !connection.capabilities.includes("PUBLISH"));
  const applyMute = useCallback(() => {
    muteRevision.current++;
    settings.current.micEnabled = false;
    setMic(false);
    for (const item of localStreams.current)
      if (item.mediaStreamTrack.kind === "audio") item.setMuted(true);
    for (const track of stream.current?.getAudioTracks() ?? [])
      track.enabled = false;
  }, []);

  const stopScreenShare = useCallback(() => {
    const previous = screenShare.current;
    if (!previous) return;
    screenShare.current = null;
    previous.cancel.abort();
    clearInterval(previous.heartbeat);
    previous.capture?.getTracks().forEach((track) => track.stop());
    previous.stage?.removeAllListeners();
    previous.stage?.leave();
    if (previous.connection) releaseMediaConnection(root, previous.connection);
    setScreenPending(false);
    setScreenPreview(null);
  }, [root]);

  const stop = useCallback(
    (notify = true) => {
      generation.current++;
      joinRequest.current?.abort();
      stopScreenShare();
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
      setStageError(null);
      setUnavailablePeers(new Map());
      setConnection(null);
      setStatus("idle");
      if (notify && previous) releaseMediaConnection(root, previous);
      requestId.current = null;
    },
    [root, stopScreenShare],
  );
  useEffect(() => () => stop(), [participationId, stop]);
  useEffect(() => {
    if (!micLocked) return;
    applyMute();
    setCamera(false);
    settings.current.cameraEnabled = false;
    if (
      currentConnection.current?.capabilities.includes("PUBLISH") ||
      !currentConnection.current
    )
      stop();
    else stopScreenShare();
  }, [micLocked, applyMute, stop, stopScreenShare]);

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
    if (publishLocked || locked.current || stage.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const ticket = generation.current;
    const muteAtStart = muteRevision.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("UNSUPPORTED_BROWSER");
      const { micEnabled, cameraEnabled } = settings.current;
      const testBoth = !micEnabled && !cameraEnabled;
      const next = await navigator.mediaDevices.getUserMedia({
        audio:
          micEnabled || testBoth
            ? audioId
              ? {
                  deviceId: { exact: audioId },
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                }
              : {
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                }
            : false,
        video:
          cameraEnabled || testBoth
            ? {
                ...(videoId ? { deviceId: { exact: videoId } } : {}),
                width: { ideal: 1920, min: 640 },
                height: { ideal: 1080, min: 480 },
                frameRate: { ideal: 30, max: 60 },
                facingMode: "user",
                aspectRatio: { ideal: 1.7777777778 },
              }
            : false,
      });
      // Optimize hardware encoder processing for camera
      for (const track of next.getVideoTracks()) {
        if ("contentHint" in track) {
          try {
            (track as MediaStreamTrack & { contentHint?: string }).contentHint =
              "motion";
          } catch {}
        }
      }
      if (ticket !== generation.current) {
        next.getTracks().forEach((t) => t.stop());
        return;
      }
      if (muteAtStart !== muteRevision.current)
        for (const track of next.getAudioTracks()) track.enabled = false;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = next;
      setPreview(next);
      setMic(next.getAudioTracks().some((track) => track.enabled));
      setCamera(next.getVideoTracks().length > 0);
      await refreshDevices();
    } catch (error) {
      if (ticket === generation.current) setError(deviceError(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function join(listenOnly = false) {
    if (!participationId || locked.current || stage.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setStatus("connecting");
    const ticket = generation.current;
    const request = new AbortController();
    joinRequest.current = request;
    if (listenOnly) {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      setPreview(null);
      setMic(false);
      setCamera(false);
      settings.current = { micEnabled: false, cameraEnabled: false };
    }
    let issued: JoinClassMediaResponse | null = null;
    try {
      const sdk = await import("amazon-ivs-web-broadcast");
      if (request.signal.aborted) return;
      clientId.current ??= crypto.randomUUID();
      requestId.current ??= crypto.randomUUID();
      const body = {
        participationId,
        clientId: clientId.current,
        requestId: requestId.current,
      };
      issued = await requestMediaConnection(root, body, request.signal);
      if (!issued) return;
      if (ticket !== generation.current) {
        releaseMediaConnection(root, issued);
        return;
      }
      currentConnection.current = issued;
      setConnection(issued);
      const canPublish = issued.capabilities.includes("PUBLISH");
      if (!canPublish) {
        stream.current?.getTracks().forEach((track) => track.stop());
        stream.current = null;
        setPreview(null);
      }
      settings.current = {
        micEnabled:
          settings.current.micEnabled &&
          !!stream.current
            ?.getAudioTracks()
            .some((track) => track.readyState === "live" && track.enabled),
        cameraEnabled:
          settings.current.cameraEnabled &&
          !!stream.current
            ?.getVideoTracks()
            .some((track) => track.readyState === "live" && track.enabled),
      };
      setMic(settings.current.micEnabled);
      setCamera(settings.current.cameraEnabled);
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
        shouldPublishParticipant: () =>
          canPublish && localStreams.current.length > 0,
        shouldSubscribeToParticipant: (person) => {
          if (person.id === screenShare.current?.connection?.participantId)
            return sdk.SubscribeType.NONE;
          // IVS re-evaluates the subscription when the publisher changes its camera state.
          return person.videoStopped &&
            person.attributes["screen-share"] !== "true"
            ? sdk.SubscribeType.AUDIO_ONLY
            : sdk.SubscribeType.AUDIO_VIDEO;
        },
      });
      stage.current = next;
      const publishPeers = () => {
        if (ticket === generation.current)
          setPeers([...remote.current.values()]);
      };
      const updateSubscriptionNotice = (
        person: StageParticipantInfo,
        failed: boolean,
      ) => {
        if (
          ticket !== generation.current ||
          person.isLocal ||
          person.id === screenShare.current?.connection?.participantId
        )
          return;
        setUnavailablePeers((current) => {
          if (current.has(person.id) === failed) return current;
          const next = new Map(current);
          if (failed) {
            const name = person.attributes.fullName;
            next.set(person.id, typeof name === "string" ? name : "Thành viên");
          } else {
            next.delete(person.id);
          }
          return next;
        });
      };
      const updatePeer = (
        person: StageParticipantInfo,
        items: StageStream[],
        remove = false,
      ) => {
        if (
          person.isLocal ||
          ticket !== generation.current ||
          person.id === screenShare.current?.connection?.participantId
        )
          return;
        const previous = remote.current.get(person.id);
        const tracks = new Map(
          previous?.stream.getTracks().map((t) => [t.id, t]) ?? [],
        );
        for (const item of items) {
          if (remove) tracks.delete(item.mediaStreamTrack.id);
          else tracks.set(item.mediaStreamTrack.id, item.mediaStreamTrack);
        }
        const media = new MediaStream([...tracks.values()]);
        const isScreenShare = person.attributes["screen-share"] === "true";
        if (isScreenShare && !media.getVideoTracks().length) {
          remote.current.delete(person.id);
          publishPeers();
          return;
        }
        remote.current.set(person.id, {
          id: person.id,
          userId: person.userId,
          name:
            typeof person.attributes.fullName === "string"
              ? person.attributes.fullName
              : "Thành viên",
          stream: media,
          micEnabled: !person.audioMuted,
          cameraEnabled:
            !person.videoStopped && media.getVideoTracks().length > 0,
          isScreenShare,
        });
        publishPeers();
      };
      next.on(sdk.StageEvents.STAGE_CONNECTION_STATE_CHANGED, (state) => {
        if (ticket !== generation.current) return;
        setStatus(
          state === sdk.StageConnectionState.CONNECTED
            ? "connected"
            : state === sdk.StageConnectionState.CONNECTING
              ? "connecting"
              : "reconnecting",
        );
        if (state === sdk.StageConnectionState.CONNECTED)
          setStageError((current) =>
            current?.category === sdk.StageErrorCategory.JOIN_ERROR
              ? null
              : current,
          );
      });
      next.on(
        sdk.StageEvents.STAGE_PARTICIPANT_SUBSCRIBE_STATE_CHANGED,
        (person, state) =>
          updateSubscriptionNotice(
            person,
            state === sdk.StageParticipantSubscribeState.ERRORED,
          ),
      );
      next.on(
        sdk.StageEvents.STAGE_PARTICIPANT_PUBLISH_STATE_CHANGED,
        (person, state) => {
          if (
            ticket === generation.current &&
            person.isLocal &&
            state === sdk.StageParticipantPublishState.PUBLISHED
          )
            setStageError((current) =>
              current?.category === sdk.StageErrorCategory.PUBLISH_ERROR
                ? null
                : current,
            );
        },
      );
      next.on(
        sdk.StageEvents.STAGE_PARTICIPANT_STREAMS_ADDED,
        (person, streams) => {
          updatePeer(person, streams);
          if (streams.length) updateSubscriptionNotice(person, false);
        },
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
        updateSubscriptionNotice(person, false);
        publishPeers();
      });
      next.on(sdk.StageEvents.ERROR, ({ code, category }) => {
        if (
          ticket !== generation.current ||
          code === sdk.StageErrorCode.CANCELED ||
          category === sdk.StageErrorCategory.SUBSCRIBE_ERROR
        )
          return;
        setStageError({
          category,
          message:
            code === sdk.StageErrorCode.STAGE_AT_CAPACITY
              ? "Phòng đã đạt giới hạn kết nối hoặc người phát. Hãy thử lại sau."
              : category === sdk.StageErrorCategory.PUBLISH_ERROR
                ? "Không thể phát mic hoặc camera của bạn. Hãy thử bật lại thiết bị."
                : "Kết nối media gặp sự cố. Hãy kiểm tra mạng hoặc kết nối lại.",
        });
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
      joinRequest.current = null;
      locked.current = false;
      setBusy(false);
    }
  }

  const joinOnEntry = useEffectEvent(() => void join(true));

  useEffect(() => {
    if (!participationId) {
      autoJoinedVisit.current = null;
      return;
    }
    if (busy || autoJoinedVisit.current === participationId) return;
    const ticket = generation.current;
    const start = setTimeout(() => {
      if (ticket !== generation.current || locked.current) return;
      autoJoinedVisit.current = participationId;
      joinOnEntry();
    }, 0);
    return () => clearTimeout(start);
  }, [busy, participationId, root]);
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

  async function toggleScreenShare() {
    if (screenShare.current) {
      stopScreenShare();
      return;
    }
    const tabId = clientId.current;
    if (publishLocked || !participationId || !tabId || currentStatus.current !== "connected")
      return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Trình duyệt này không hỗ trợ chia sẻ màn hình.");
      return;
    }
    const share: ScreenShare = { cancel: new AbortController() };
    const { signal } = share.cancel;
    screenShare.current = share;
    setScreenPending(true);
    setError("");
    try {
      const capture = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920, max: 2560 },
          height: { ideal: 1080, max: 1440 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      if (signal.aborted) {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      share.capture = capture;
      const track = capture.getVideoTracks()[0];
      if (!track || track.readyState !== "live")
        throw new Error("No display track");
      track.addEventListener("ended", stopScreenShare, { once: true, signal });
      if ("contentHint" in track) {
        try {
          (track as MediaStreamTrack & { contentHint?: string }).contentHint =
            "detail";
        } catch {}
      }
      await track
        .applyConstraints({
          width: { max: 1920 },
          height: { max: 1080 },
          frameRate: { max: 30 },
        })
        .catch(() => {});
      if (signal.aborted) return;
      const sdk = await import("amazon-ivs-web-broadcast");
      const issued = await requestMediaConnection(
        root,
        {
          participationId,
          clientId: tabId,
          requestId: crypto.randomUUID(),
          source: "SCREEN",
        },
        signal,
      );
      if (!issued) return;
      if (signal.aborted) {
        releaseMediaConnection(root, issued);
        return;
      }
      share.connection = issued;
      const display = new sdk.LocalStageStream(track);
      const publisher = new sdk.Stage(issued.participantToken, {
        stageStreamsToPublish: () => [display],
        shouldPublishParticipant: () => true,
        shouldSubscribeToParticipant: () => sdk.SubscribeType.NONE,
      });
      share.stage = publisher;
      const onShareError = () => {
        if (signal.aborted) return;
        stopScreenShare();
        setError("Không thể tiếp tục chia sẻ màn hình. Hãy thử chia sẻ lại.");
      };
      publisher.on(sdk.StageEvents.ERROR, ({ code }) => {
        if (code !== sdk.StageErrorCode.CANCELED) onShareError();
      });
      publisher.on(sdk.StageEvents.STAGE_LEFT, onShareError);
      publisher.on(
        sdk.StageEvents.STAGE_PARTICIPANT_PUBLISH_STATE_CHANGED,
        (person, state) => {
          if (
            person.isLocal &&
            state === sdk.StageParticipantPublishState.ERRORED
          )
            onShareError();
        },
      );
      let connected = false;
      publisher.on(sdk.StageEvents.STAGE_CONNECTION_STATE_CHANGED, (state) => {
        connected = state === sdk.StageConnectionState.CONNECTED;
      });
      await publisher.join();
      if (signal.aborted) return;
      setScreenPreview(capture);
      setScreenPending(false);
      let sending = false;
      const ping = async () => {
        if (sending || signal.aborted) return;
        sending = true;
        try {
          await apiRequest(`${root}/media/${issued.connectionId}/heartbeat`, {
            method: "POST",
            body: {
              participationId,
              requestId: issued.requestId,
              clientId: tabId,
              connected,
              micEnabled: false,
              cameraEnabled: false,
            },
          });
        } catch (error) {
          if ([401, 403, 404, 409].includes(asApiError(error).status))
            onShareError();
        } finally {
          sending = false;
        }
      };
      share.heartbeat = setInterval(() => void ping(), 10000);
      void ping();
    } catch (error) {
      if (signal.aborted) return;
      stopScreenShare();
      if (error instanceof DOMException && error.name === "NotAllowedError")
        return;
      const failure = asApiError(error);
      setError(
        failure.code === "UNKNOWN_ERROR"
          ? "Không thể chia sẻ màn hình. Hãy kiểm tra quyền của trình duyệt rồi thử lại."
          : failure.message,
      );
    }
  }

  async function toggle(kind: "audio" | "video", deviceId = "") {
    if (publishLocked || locked.current) return;
    const previous = stream.current?.getTracks() ?? [];
    const activeTrack = previous.find(
      (track) => track.kind === kind && track.readyState === "live",
    );
    const enabled =
      !activeTrack ||
      !(kind === "audio"
        ? settings.current.micEnabled
        : settings.current.cameraEnabled);
    const needsCapture =
      !activeTrack ||
      (deviceId && activeTrack.getSettings().deviceId !== deviceId);
    let addedTracks = false;
    if (enabled && needsCapture) {
      const ticket = generation.current;
      const muteAtStart = muteRevision.current;
      const cancelled = () =>
        ticket !== generation.current ||
        (kind === "audio" && muteAtStart !== muteRevision.current);
      locked.current = true;
      setBusy(true);
      setError("");
      let captured: MediaStream | null = null;
      try {
        captured = await navigator.mediaDevices.getUserMedia({
          audio:
            kind === "audio"
              ? deviceId
                ? {
                    deviceId: { exact: deviceId },
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                  }
                : {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                  }
              : false,
          video:
            kind === "video"
              ? {
                  ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
                  width: { ideal: 1920, min: 640 },
                  height: { ideal: 1080, min: 480 },
                  frameRate: { ideal: 30, max: 60 },
                  facingMode: "user",
                  aspectRatio: { ideal: 1.7777777778 },
                }
              : false,
        });
        if (captured) {
          for (const track of captured.getVideoTracks()) {
            if ("contentHint" in track) {
              try {
                (track as MediaStreamTrack & { contentHint?: string }).contentHint =
                  "motion";
              } catch {}
            }
          }
        }
        if (cancelled()) {
          captured.getTracks().forEach((t) => t.stop());
          return;
        }
        const sdk = await import("amazon-ivs-web-broadcast");
        if (cancelled()) {
          captured.getTracks().forEach((t) => t.stop());
          return;
        }
        const tracks = captured.getTracks();
        const additions = tracks.map(
          (track) => new sdk.LocalStageStream(track),
        );
        const combined = new MediaStream([
          ...previous.filter(
            (track) => track.kind !== kind && track.readyState === "live",
          ),
          ...tracks,
        ]);
        previous
          .filter((track) => track.kind === kind)
          .forEach((track) => track.stop());
        stream.current = combined;
        setPreview(combined);
        localStreams.current = [
          ...localStreams.current.filter(
            ({ mediaStreamTrack }) =>
              mediaStreamTrack.kind !== kind &&
              mediaStreamTrack.readyState === "live",
          ),
          ...additions,
        ];
        addedTracks = true;
      } catch (error) {
        captured?.getTracks().forEach((track) => track.stop());
        if (ticket === generation.current) setError(deviceError(error));
        return;
      } finally {
        locked.current = false;
        setBusy(false);
      }
    }
    settings.current = {
      ...settings.current,
      [kind === "audio" ? "micEnabled" : "cameraEnabled"]: enabled,
    };
    if (kind === "audio") setMic(enabled);
    else setCamera(enabled);
    for (const item of localStreams.current)
      if (item.mediaStreamTrack.kind === kind) item.setMuted(!enabled);
    for (const track of stream.current?.getTracks() ?? [])
      if (track.kind === kind) track.enabled = enabled;
    if (addedTracks) stage.current?.refreshStrategy();
    // An explicit device click should publish into an admitted room, including
    // when the participant initially joined only to listen.
    if (enabled && participationId && !stage.current) await join();
  }
  return {
    status,
    error: error || stageError?.message || "",
    unavailablePeers: [...new Set(unavailablePeers.values())],
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
    screenPreview,
    screenPending,
    toggleScreenShare,
    applyMute,
    publishLocked,
    connected: !!connection,
  };
}
