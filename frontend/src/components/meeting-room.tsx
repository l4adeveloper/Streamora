"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Hand,
  Link2,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Send,
  Settings2,
  ShieldCheck,
  Users,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { Avatar, IconButton } from "./ui";
import {
  MeetingDialog,
  MeetingHeader,
  MeetingHelp,
  readMeetings,
  rememberMeeting,
} from "./meeting-shared";

type MediaKind = "camera" | "mic" | "screen";

export function MeetingRoom({
  id,
  autoJoin = false,
}: {
  id: string;
  autoJoin?: boolean;
}) {
  const [name, setName] = useState("Cuộc họp của bạn");
  const [joined, setJoined] = useState(autoJoin);
  const [camera, setCamera] = useState(false);
  const [mic, setMic] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [hand, setHand] = useState(false);
  const [help, setHelp] = useState(false);
  const [invite, setInvite] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"chat" | "members" | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [fps, setFps] = useState("30");
  const [settings, setSettings] = useState(false);
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const screenVideo = useRef<HTMLVideoElement>(null);
  const copyField = useRef<HTMLInputElement>(null);
  const streams = useRef<Record<MediaKind, MediaStream | null>>({
    camera: null,
    mic: null,
    screen: null,
  });
  const togglePending = useRef(new Set<MediaKind>());
  const mounted = useRef(true);

  useEffect(() => {
    const saved = readMeetings().find((meeting) => meeting.id === id);
    if (saved) setName(saved.name);
  }, [id]);
  useEffect(() => {
    mounted.current = true;
    const currentStreams = streams.current;
    return () => {
      mounted.current = false;
      Object.values(currentStreams).forEach((stream) =>
        stream?.getTracks().forEach((track) => track.stop()),
      );
    };
  }, []);
  useEffect(() => {
    if (cameraVideo.current)
      cameraVideo.current.srcObject = streams.current.camera;
  }, [camera, joined]);
  useEffect(() => {
    if (screenVideo.current)
      screenVideo.current.srcObject = streams.current.screen;
  }, [sharing]);

  async function toggle(kind: MediaKind) {
    if (togglePending.current.has(kind)) return;
    const enabled = kind === "camera" ? camera : kind === "mic" ? mic : sharing;
    const setter =
      kind === "camera" ? setCamera : kind === "mic" ? setMic : setSharing;
    if (enabled) {
      streams.current[kind]?.getTracks().forEach((track) => track.stop());
      streams.current[kind] = null;
      setter(false);
      return;
    }
    togglePending.current.add(kind);
    setError("");
    try {
      if (!navigator.mediaDevices)
        throw new Error("Thiết bị không được hỗ trợ.");
      const stream =
        kind === "screen"
          ? await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: Number(fps) },
              audio: true,
            })
          : await navigator.mediaDevices.getUserMedia(
              kind === "camera" ? { video: true } : { audio: true },
            );
      if (!mounted.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streams.current[kind] = stream;
      setter(true);
      stream.getTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          if (mounted.current) setter(false);
        }),
      );
    } catch {
      if (mounted.current)
        setError(
          "Chưa thể mở thiết bị. Hãy kiểm tra quyền camera, micro hoặc chia sẻ màn hình của trình duyệt.",
        );
    } finally {
      togglePending.current.delete(kind);
    }
  }

  function join() {
    rememberMeeting({ id, name, createdAt: Date.now() });
    setJoined(true);
  }
  const url =
    typeof location === "undefined" ? "" : `${location.origin}/meet/${id}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      copyField.current?.focus();
      copyField.current?.select();
    }
  }
  const deviceButtons = (
    <>
      <button
        type="button"
        className={`meet-device-control ${!mic ? "is-off" : ""}`}
        onClick={() => toggle("mic")}
        aria-label={mic ? "Tắt micro" : "Bật micro"}
        title={mic ? "Tắt micro" : "Bật micro"}
      >
        {mic ? <Mic size={21} /> : <MicOff size={21} />}
      </button>
      <button
        type="button"
        className={`meet-device-control ${!camera ? "is-off" : ""}`}
        onClick={() => toggle("camera")}
        aria-label={camera ? "Tắt camera" : "Bật camera"}
        title={camera ? "Tắt camera" : "Bật camera"}
      >
        {camera ? <Video size={21} /> : <VideoOff size={21} />}
      </button>
    </>
  );
  const cameraTile = (
    <div className={`meet-camera-tile ${camera ? "camera-on" : ""}`}>
      {camera ? (
        <video ref={cameraVideo} autoPlay playsInline muted />
      ) : (
        <div className="meet-camera-off">
          <Avatar initials="BA" />
          <h2>{joined ? "Bảo Anh" : "Camera đang tắt"}</h2>
          <p>
            {joined
              ? "Bạn là người đầu tiên trong phòng."
              : "Bạn có thể bật camera trước khi tham gia."}
          </p>
        </div>
      )}
      <span className="meet-camera-name">
        {joined ? "Bạn" : "Bản xem trước của bạn"}
        {hand && <Hand size={15} />}
      </span>
      <span className="meet-camera-mic">
        {mic ? <Mic size={17} /> : <MicOff size={17} />}
      </span>
      {!joined && <div className="meet-preview-controls">{deviceButtons}</div>}
    </div>
  );

  return (
    <div className={`meet-standalone ${joined ? "meet-in-call" : ""}`}>
      <MeetingHeader onHelp={() => setHelp(true)} />
      {!joined ? (
        <main className="meet-prejoin-main">
          <section className="meet-preview-column">
            <Link href="/meet" className="meet-back">
              <ArrowLeft size={16} /> Về trang cuộc họp
            </Link>
            {cameraTile}
            <p className="meet-device-hint">
              <ShieldCheck size={15} /> Thiết bị của bạn chỉ bật khi bạn cho
              phép.
            </p>
          </section>
          <section className="meet-ready-column">
            <span className="meet-eyebrow">
              <span /> KHÔNG GIAN CỦA BẠN ĐÃ SẴN SÀNG
            </span>
            <h1>Sẵn sàng tham gia?</h1>
            <h2>{name}</h2>
            <span className="meet-room-code">
              <Link2 size={14} />
              {id}
            </span>
            <p>
              Kiểm tra camera và micro.
              <br />
              Sau đó, cùng bắt đầu cuộc trò chuyện.
            </p>
            <button className="button primary meet-enter-button" onClick={join}>
              Tham gia ngay <ArrowRight size={18} />
            </button>
            <button
              className="meet-learn-link"
              onClick={() => {
                setCopied(false);
                setInvite(true);
              }}
            >
              <Link2 size={15} /> Sao chép liên kết mời
            </button>
          </section>
        </main>
      ) : (
        <>
          <main className="meet-call-main">
            <section className="meet-call-workspace">
              <div className="meet-call-heading">
                <div>
                  <span className="status-dot" />
                  <h1>{name}</h1>
                  <span className="meet-room-code">{id}</span>
                </div>
                <span>
                  <Users size={15} /> 1 người tham gia
                </span>
              </div>
              <div className={`meet-call-stage ${sharing ? "is-sharing" : ""}`}>
                {sharing && (
                  <div className="meet-screen-tile">
                    <video ref={screenVideo} autoPlay playsInline muted />
                    <span>
                      <MonitorUp size={14} /> Bạn đang chia sẻ màn hình
                    </span>
                  </div>
                )}
                {cameraTile}
                {!sharing && (
                  <div className="meet-waiting-card">
                    <span className="meet-link-icon">
                      <Link2 size={22} />
                    </span>
                    <h2>Cuộc họp đã sẵn sàng</h2>
                    <p>Gửi liên kết để mời mọi người cùng tham gia.</p>
                    <button
                      className="button secondary compact"
                      onClick={() => {
                        setCopied(false);
                        setInvite(true);
                      }}
                    >
                      <Copy size={15} /> Chia sẻ liên kết
                    </button>
                  </div>
                )}
              </div>
              <div className="meet-call-demo">
                <ShieldCheck size={13} /> Bản trải nghiệm · Camera, micro và màn
                hình chỉ hiển thị cục bộ.
              </div>
            </section>
            {panel && (
              <aside className="meet-call-panel">
                <div className="meet-call-panel-heading">
                  <h2>
                    {panel === "chat"
                      ? "Tin nhắn trong cuộc họp"
                      : "Người tham gia"}
                  </h2>
                  <IconButton
                    label="Đóng bảng cuộc họp"
                    onClick={() => setPanel(null)}
                  >
                    <X size={19} />
                  </IconButton>
                </div>
                {panel === "members" ? (
                  <div className="meet-member">
                    <Avatar initials="BA" small />
                    <div>
                      <b>Bảo Anh (Bạn)</b>
                      <small>Người tổ chức</small>
                    </div>
                    {mic ? <Mic size={17} /> : <MicOff size={17} />}
                  </div>
                ) : (
                  <>
                    <p className="meet-chat-note">
                      Tin nhắn mẫu chỉ hiển thị trên thiết bị này và trong phiên
                      hiện tại.
                    </p>
                    <div className="meet-call-messages">
                      {!messages.length && (
                        <div className="meet-chat-empty">
                          <MessageCircle size={28} />
                          <p>Gửi lời chào đầu tiên.</p>
                        </div>
                      )}
                      {messages.map((text, index) => (
                        <div key={index}>
                          <b>Bạn</b>
                          <p>{text}</p>
                        </div>
                      ))}
                    </div>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!draft.trim()) return;
                        setMessages([...messages, draft.trim()]);
                        setDraft("");
                      }}
                    >
                      <input
                        aria-label="Tin nhắn cuộc họp"
                        placeholder="Gửi lời nhắn…"
                        value={draft}
                        maxLength={4000}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                      <button
                        aria-label="Gửi tin nhắn cuộc họp"
                        disabled={!draft.trim()}
                      >
                        <Send size={17} />
                      </button>
                    </form>
                  </>
                )}
              </aside>
            )}
          </main>
          <footer className="meet-call-footer">
            <div className="meet-call-footer-info">
              <Video size={17} />
              <span>{id}</span>
            </div>
            <div className="meet-call-controls">
              {deviceButtons}
              <button
                className={`meet-device-control ${sharing ? "is-active" : ""}`}
                onClick={() => toggle("screen")}
                title={sharing ? "Dừng chia sẻ màn hình" : "Chia sẻ màn hình"}
                aria-label={
                  sharing ? "Dừng chia sẻ màn hình" : "Chia sẻ màn hình"
                }
              >
                <MonitorUp size={21} />
              </button>
              <button
                className={`meet-device-control ${hand ? "is-active" : ""}`}
                onClick={() => setHand(!hand)}
                title={hand ? "Hạ tay" : "Giơ tay"}
                aria-label={hand ? "Hạ tay" : "Giơ tay"}
              >
                <Hand size={21} />
              </button>
              <button
                className="meet-device-control"
                onClick={() => setSettings(true)}
                title="Thiết lập chia sẻ"
                aria-label="Thiết lập chia sẻ"
              >
                <Settings2 size={21} />
              </button>
              <Link
                className="meet-device-control meet-end-call"
                href="/meet"
                title="Rời cuộc họp"
                aria-label="Rời cuộc họp"
              >
                <PhoneOff size={22} />
              </Link>
            </div>
            <div className="meet-call-side-actions">
              <IconButton
                label="Người tham gia cuộc họp"
                active={panel === "members"}
                onClick={() => setPanel(panel === "members" ? null : "members")}
              >
                <Users size={22} />
              </IconButton>
              <IconButton
                label="Mở tin nhắn cuộc họp"
                active={panel === "chat"}
                onClick={() => setPanel(panel === "chat" ? null : "chat")}
              >
                <MessageCircle size={21} />
              </IconButton>
            </div>
          </footer>
        </>
      )}
      {!joined && (
        <footer className="meet-home-footer">
          <span>Bạn có thể tham gia với camera và micro đang tắt.</span>
          <small>Bản trải nghiệm · Chưa kết nối cuộc gọi nhiều người</small>
        </footer>
      )}
      {error && (
        <div className="meet-media-error" role="alert">
          <span>{error}</span>
          <IconButton
            label="Đóng thông báo thiết bị"
            onClick={() => setError("")}
          >
            <X size={17} />
          </IconButton>
        </div>
      )}
      {help && <MeetingHelp onClose={() => setHelp(false)} />}
      {invite && (
        <MeetingDialog
          title="Mời mọi người cùng tham gia."
          onClose={() => setInvite(false)}
        >
          <p>Chia sẻ liên kết cuộc họp này với bạn bè hoặc đồng nghiệp.</p>
          <div className="meet-copy-field">
            <input
              ref={copyField}
              aria-label="Liên kết cuộc họp"
              readOnly
              value={url}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button aria-label="Sao chép liên kết cuộc họp" onClick={copy}>
              {copied ? <Check size={19} /> : <Copy size={19} />}
            </button>
          </div>
          <span role="status" className="meet-copy-status">
            {copied
              ? "Đã sao chép liên kết."
              : "Liên kết mở trực tiếp phòng chờ của cuộc họp."}
          </span>
          <button className="button primary" onClick={copy}>
            <Copy size={16} />
            {copied ? "Đã sao chép" : "Sao chép liên kết"}
          </button>
        </MeetingDialog>
      )}
      {settings && (
        <MeetingDialog
          title="Thiết lập chia sẻ màn hình"
          onClose={() => setSettings(false)}
        >
          <p>Chọn tốc độ khung hình cho lần chia sẻ tiếp theo.</p>
          <label htmlFor="standalone-fps">Tốc độ khung hình</label>
          <select
            id="standalone-fps"
            value={fps}
            onChange={(event) => setFps(event.target.value)}
          >
            <option value="15">15 khung hình/giây · Tài liệu</option>
            <option value="30">30 khung hình/giây · Cân bằng</option>
            <option value="60">60 khung hình/giây · Chuyển động</option>
          </select>
          <button className="button primary" onClick={() => setSettings(false)}>
            <Check size={17} /> Xong
          </button>
        </MeetingDialog>
      )}
    </div>
  );
}
