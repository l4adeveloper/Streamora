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

const IVS_VIDEO_CONSTRAINTS = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 30, max: 30 },
};

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
  const [renewal, setRenewal] = useState<JoinClassMediaResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [screenPreview, setScreenPreview] = useState<MediaStream | null>(null);
  const [screenPending, setScreenPending] = useState(false);
  const [screenParticipantId, setScreenParticipantId] = useState<string | null>(
    null,
  );
  const [screenNotice, setScreenNotice] = useState("");
  const screenShare = useRef<ScreenShare | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const stage = useRef<Stage | null>(null);
  const localStreams = useRef<LocalStageStream[]>([]);
  const remote = useRef(new Map<string, MediaPeer>());
  const subscriptionRetry = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const clientId = useRef<string | null>(null),
    requestId = useRef<string | null>(null);
  const currentConnection = useRef<JoinClassMediaResponse | null>(null);
  const generation = useRef(0),
    locked = useRef(false);
  const joinRequest = useRef<AbortController | null>(null);
  const autoJoinedVisit = useRef<string | null>(null);
  const optedOutVisit = useRef<string | null>(null);
  const lastRenewal = useRef<{ visit: string; time: number } | null>(null);
  const previousMicLock = useRef(micLocked);
  const settings = useRef({ micEnabled, cameraEnabled });
  settings.current = { micEnabled, cameraEnabled };
  const currentStatus = useRef(status);
  currentStatus.current = status;
  const root = `/sessions/${encodeURIComponent(sessionId)}`;
  const muteRevision = useRef(0);
  const publishLocked =
    micLocked ||
    (connection !== null && !connection.capabilities.includes("PUBLISH"));
  const setTrackMuted = useCallback((kind: "audio" | "video", muted: boolean) => {
    for (const track of stream.current?.getTracks() ?? []) {
      if (track.kind !== kind) continue;
      const local = localStreams.current.find(
        (item) => item.mediaStreamTrack === track,
      );
      if (local) local.setMuted(muted);
      else track.enabled = !muted;
    }
  }, []);
  const applyMute = useCallback(() => {
    muteRevision.current++;
    settings.current.micEnabled = false;
    setMic(false);
    setTrackMuted("audio", true);
  }, [setTrackMuted]);

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
    setScreenParticipantId(null);
    setScreenNotice("");
  }, [root]);

  const stop = useCallback(
    ({ renewToken = false } = {}) => {
      generation.current++;
      joinRequest.current?.abort();
      clearTimeout(subscriptionRetry.current);
      subscriptionRetry.current = undefined;
      if (!renewToken) stopScreenShare();
      const previous = currentConnection.current;
      currentConnection.current = null;
      stage.current?.removeAllListeners();
      stage.current?.leave();
      stage.current = null;
      if (!renewToken) {
        stream.current?.getTracks().forEach((track) => track.stop());
        stream.current = null;
        setPreview(null);
      }
      localStreams.current = [];
      remote.current.clear();
      setPeers([]);
      setStageError(null);
      setUnavailablePeers(new Map());
      setConnection(null);
      setStatus("idle");
      if (!renewToken && previous) releaseMediaConnection(root, previous);
      requestId.current = null;
    },
    [root, stopScreenShare],
  );
  useEffect(() => () => stop(), [participationId, stop]);
  useEffect(() => {
    if (previousMicLock.current === micLocked) return;
    previousMicLock.current = micLocked;
    // A stage token cannot change capabilities in place. Rejoin without
    // publishing so only an explicit device click can turn the mic back on.
    if (optedOutVisit.current !== participationId) autoJoinedVisit.current = null;
    stop();
    setMic(false);
    setCamera(false);
    settings.current = { micEnabled: false, cameraEnabled: false };
  }, [micLocked, participationId, stop]);

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
                ...IVS_VIDEO_CONSTRAINTS,
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
    optedOutVisit.current = null;
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
    let renewing = false;
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
          if (
            person.isLocal ||
            person.id === screenShare.current?.connection?.participantId
          )
            return sdk.SubscribeType.NONE;
          // IVS re-evaluates the subscription when the publisher changes its camera state.
          return person.videoStopped &&
            person.attributes["screen-share"] !== "true"
            ? sdk.SubscribeType.AUDIO_ONLY
            : sdk.SubscribeType.AUDIO_VIDEO;
        },
      });
      stage.current = next;
      const issuedConnection = issued;
      const tokenDeadline = performance.now() + issued.expiresIn * 1000;
      const renew = () => {
        if (renewing) return true;
        if (ticket !== generation.current) return false;
        const previous = lastRenewal.current;
        if (
          previous?.visit === participationId &&
          performance.now() - previous.time < 5000
        )
          return false;
        lastRenewal.current = { visit: participationId, time: performance.now() };
        renewing = true;
        setRenewal(issuedConnection);
        return true;
      };
      let stageConnected = false;
      const failedSubscriptions = new Set<string>();
      const retryAttempts = new Map<string, number>();
      const scheduleSubscriptionRetry = () => {
        if (!stageConnected || subscriptionRetry.current !== undefined) return;
        subscriptionRetry.current = setTimeout(() => {
          subscriptionRetry.current = undefined;
          if (!stageConnected || stage.current !== next) return;
          const retry = [...failedSubscriptions].filter(
            (id) => (retryAttempts.get(id) ?? 0) < 2,
          );
          if (!retry.length) return;
          for (const id of retry)
            retryAttempts.set(id, (retryAttempts.get(id) ?? 0) + 1);
          next.refreshStrategy();
        }, 1200);
      };
      const isRemotePeer = (person: StageParticipantInfo) =>
        ticket === generation.current &&
        !person.isLocal &&
        person.id !== screenShare.current?.connection?.participantId;
      const publishPeers = () => {
        if (ticket === generation.current)
          setPeers([...remote.current.values()]);
      };
      const updateSubscriptionNotice = (
        person: StageParticipantInfo,
        failed: boolean,
      ) => {
        if (!isRemotePeer(person)) return;
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
        items: StageStream[] = [],
        remove = false,
      ) => {
        if (!isRemotePeer(person)) return;
        const previous = remote.current.get(person.id);
        const before = previous?.stream.getTracks() ?? [];
        const tracks = new Map(
          before
            .filter((track) => track.readyState === "live")
            .map((track) => [track.kind, track]),
        );
        for (const { mediaStreamTrack: track } of items) {
          if (remove) {
            if (tracks.get(track.kind) === track) tracks.delete(track.kind);
          } else if (track.readyState === "live") tracks.set(track.kind, track);
        }
        const isScreenShare = person.attributes["screen-share"] === "true";
        if (!tracks.size || (isScreenShare && !tracks.has("video"))) {
          if (remote.current.delete(person.id)) publishPeers();
          return;
        }
        const media =
          previous &&
          before.length === tracks.size &&
          before.every((track) => tracks.get(track.kind) === track)
            ? previous.stream
            : new MediaStream([...tracks.values()]);
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
        stageConnected = state === sdk.StageConnectionState.CONNECTED;
        setStatus(
          stageConnected
            ? "connected"
            : state === sdk.StageConnectionState.CONNECTING
              ? "connecting"
              : "reconnecting",
        );
        if (stageConnected) {
          if (failedSubscriptions.size) scheduleSubscriptionRetry();
          setStageError((current) =>
            current?.category === sdk.StageErrorCategory.JOIN_ERROR
              ? null
              : current,
          );
        }
      });
      next.on(
        sdk.StageEvents.STAGE_PARTICIPANT_SUBSCRIBE_STATE_CHANGED,
        (person, state) => {
          if (!isRemotePeer(person)) return;
          if (state === sdk.StageParticipantSubscribeState.ERRORED) {
            if (performance.now() >= tokenDeadline && renew()) return;
            failedSubscriptions.add(person.id);
            updateSubscriptionNotice(person, true);
            scheduleSubscriptionRetry();
            return;
          }
          failedSubscriptions.delete(person.id);
          if (
            state !== sdk.StageParticipantSubscribeState.ATTEMPTING_SUBSCRIBE
          ) {
            retryAttempts.delete(person.id);
            updateSubscriptionNotice(person, false);
          }
        },
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
      // Only the stream lifecycle events can add or replace tracks.
      next.on(sdk.StageEvents.STAGE_STREAM_MUTE_CHANGED, (person) =>
        updatePeer(person),
      );
      next.on(sdk.StageEvents.STAGE_PARTICIPANT_LEFT, (person) => {
        failedSubscriptions.delete(person.id);
        retryAttempts.delete(person.id);
        remote.current.delete(person.id);
        updateSubscriptionNotice(person, false);
        publishPeers();
      });
      next.on(sdk.StageEvents.ERROR, ({ code, category }) => {
        // 1001 is the underlying StageClientError code for an expired token.
        if (
          (code === sdk.StageErrorCode.TOKEN_EXPIRED || Number(code) === 1001) &&
          renew()
        )
          return;
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
        if (renewing || ticket !== generation.current) return;
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
      // The SDK can emit TOKEN_EXPIRED and reject join in the same turn.
      if (renewing) return;
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
  const rejoinWithFreshToken = useEffectEvent(() => {
    // The new join supersedes the old connection on the server. Preserve the
    // selected devices and mute state, but never reuse the old request key.
    stop({ renewToken: true });
    void join();
  });

  useEffect(() => {
    if (!renewal || busy) return;
    setRenewal(null);
    if (participationId && currentConnection.current === renewal)
      rejoinWithFreshToken();
  }, [busy, participationId, renewal]);

  useEffect(() => {
    if (!participationId) {
      autoJoinedVisit.current = null;
      return;
    }
    if (
      busy ||
      autoJoinedVisit.current === participationId ||
      optedOutVisit.current === participationId
    )
      return;
    const ticket = generation.current;
    const start = setTimeout(() => {
      if (ticket !== generation.current || locked.current) return;
      autoJoinedVisit.current = participationId;
      joinOnEntry();
    }, 0);
    return () => clearTimeout(start);
  }, [busy, micLocked, participationId, root]);
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
      // Ask for tab/system audio too, so viewers and recordings hear the
      // shared video. Chrome only grants audio for a tab, or for the entire
      // screen on Windows/ChromeOS; a window share is always video only.
      // Open the picker on tabs and hide this meeting tab to avoid echo.
      const options: DisplayMediaStreamOptions & {
        systemAudio?: "include" | "exclude";
        selfBrowserSurface?: "include" | "exclude";
        surfaceSwitching?: "include" | "exclude";
      } = {
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          displaySurface: "browser",
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        systemAudio: "include",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
      };
      const capture = await navigator.mediaDevices.getDisplayMedia(options);
      if (signal.aborted) {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      share.capture = capture;
      setScreenNotice(
        capture.getAudioTracks().length
          ? ""
          : "Màn hình đang chia sẻ không có âm thanh. Muốn người khác nghe được tiếng, hãy chia sẻ một Tab và bật “Share tab audio” (hoặc Toàn màn hình trên Windows và bật chia sẻ âm thanh hệ thống). Chia sẻ Cửa sổ không hỗ trợ âm thanh.",
      );
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
      await track.applyConstraints(IVS_VIDEO_CONSTRAINTS);
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
      const screenAudio = capture
        .getAudioTracks()
        .filter((item) => item.readyState === "live")
        .map((item) => new sdk.LocalStageStream(item));
      const publisher = new sdk.Stage(issued.participantToken, {
        stageStreamsToPublish: () => [display, ...screenAudio],
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
      setScreenParticipantId(issued.participantId);
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
                  ...IVS_VIDEO_CONSTRAINTS,
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
    setTrackMuted(kind, !enabled);
    if (addedTracks) stage.current?.refreshStrategy();
    // An explicit device click should publish into an admitted room, including
    // when the participant initially joined only to listen.
    if (enabled && participationId && !stage.current) await join();
  }
  return {
    status,
    error: error || stageError?.message || "",
    unavailablePeers: [...new Set(unavailablePeers.values())],
    retrySubscriptions: () => stage.current?.refreshStrategy(),
    devices,
    preview,
    peers,
    micEnabled,
    cameraEnabled,
    busy,
    checkDevices,
    join,
    stop,
    disconnect: () => {
      optedOutVisit.current = participationId;
      stop();
    },
    toggle,
    screenPreview,
    screenPending,
    screenParticipantId,
    /** Set while sharing a surface the browser gave no audio for. */
    screenNotice,
    toggleScreenShare,
    /** Ends this tab's screen share, e.g. when a recording keeps someone else's. */
    endScreenShare: (notice?: string) => {
      stopScreenShare();
      if (notice) setError(notice);
    },
    applyMute,
    publishLocked,
    connected: !!connection,
  };
}
