"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Keyboard,
  Link2,
  Mic,
  MicOff,
  Plus,
  ShieldCheck,
  Sparkles,
  Video,
  Waves,
} from "lucide-react";
import { Avatar } from "./ui";
import {
  MeetingDialog,
  MeetingHeader,
  MeetingHelp,
  readMeetings,
  rememberMeeting,
  type SavedMeeting,
} from "./meeting-shared";

const tips = [
  {
    title: "Một liên kết. Mọi người cùng có mặt.",
    text: "Tạo cuộc họp, chia sẻ liên kết và bắt đầu câu chuyện của bạn. Đơn giản vậy thôi.",
  },
  {
    title: "Sẵn sàng trước khi nói lời chào.",
    text: "Kiểm tra camera, micro và chọn cách bạn xuất hiện trước khi tham gia cuộc họp.",
  },
  {
    title: "Không gian dành cho mọi ý tưởng.",
    text: "Một buổi học nhóm, một cuộc trao đổi nhanh hay ý tưởng cho dự án tiếp theo — cùng bắt đầu nhé.",
  },
];

export function MeetingHome() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
  const [tip, setTip] = useState(0);
  const [saved, setSaved] = useState<SavedMeeting[]>([]);
  const [created, setCreated] = useState<SavedMeeting | null>(null);
  const [copied, setCopied] = useState(false);
  const inviteInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSaved(readMeetings());
  }, []);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(false);
        menuRef.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);

  function create(start: boolean) {
    const random = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const id = `${random.slice(0, 3)}-${random.slice(3, 7)}-${random.slice(7)}`;
    const meeting = { id, name: "Cuộc họp của Bảo Anh", createdAt: Date.now() };
    rememberMeeting(meeting);
    setSaved(readMeetings());
    setMenu(false);
    if (start) router.push(`/meet/${id}?start=1`);
    else {
      setCopied(false);
      setCreated(meeting);
    }
  }

  function join(event: React.FormEvent) {
    event.preventDefault();
    const value = code.trim();
    let id = value;
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (
          url.origin !== location.origin ||
          !/^\/(meet|rooms)\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
        ) {
          setError("Hãy dùng liên kết cuộc họp Streamora hoặc nhập mã phòng.");
          return;
        }
        id = url.pathname.split("/").filter(Boolean).pop() || "";
      } catch {
        setError("Liên kết chưa đúng. Bạn thử kiểm tra lại nhé.");
        return;
      }
    }
    if (!/^[a-zA-Z0-9_-]{3,80}$/.test(id)) {
      setError("Mã cuộc họp cần 3–80 ký tự, gồm chữ, số hoặc dấu gạch ngang.");
      return;
    }
    router.push(`/meet/${encodeURIComponent(id)}`);
  }

  const invite =
    created && typeof location !== "undefined"
      ? `${location.origin}/meet/${created.id}`
      : "";
  async function copy() {
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
    } catch {
      inviteInput.current?.focus();
      inviteInput.current?.select();
      setCopied(false);
    }
  }

  return (
    <div className="meet-standalone">
      <MeetingHeader onHelp={() => setHelp(true)} />
      <main className="meet-home-main">
        <section className="meet-home-copy">
          <div className="meet-eyebrow">
            <span /> KẾT NỐI, THEO CÁCH CỦA BẠN
          </div>
          <h1>
            Gặp nhau dễ hơn.
            <br />
            <span>Cùng nhau đi xa hơn.</span>
          </h1>
          <p className="meet-intro">
            Cuộc họp video cho những điều đáng chia sẻ.
            <br />
            Từ một lời chào đến ý tưởng lớn tiếp theo.
          </p>
          <div className="meet-start-actions">
            <div className="meet-create-menu" ref={menuRef}>
              <button
                type="button"
                className="button primary meet-new-button"
                aria-expanded={menu}
                aria-controls="new-meeting-options"
                onClick={() => setMenu(!menu)}
              >
                <Video size={21} /> Cuộc họp mới <ChevronDown size={15} />
              </button>
              {menu && (
                <div id="new-meeting-options" className="meet-dropdown">
                  <button onClick={() => create(false)}>
                    <Link2 size={19} />
                    <span>
                      <b>Tạo cuộc họp để dùng sau</b>
                      <small>Lấy liên kết và chia sẻ với mọi người</small>
                    </span>
                  </button>
                  <button onClick={() => create(true)}>
                    <Plus size={20} />
                    <span>
                      <b>Bắt đầu cuộc họp ngay</b>
                      <small>Mở phòng họp của bạn</small>
                    </span>
                  </button>
                </div>
              )}
            </div>
            <form onSubmit={join} className="meet-join-form">
              <div className={`meet-code-input ${error ? "invalid" : ""}`}>
                <Keyboard size={20} />
                <input
                  aria-label="Nhập mã hoặc liên kết cuộc họp"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "meet-code-error" : undefined}
                  placeholder="Nhập mã hoặc liên kết"
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value);
                    setError("");
                  }}
                />
              </div>
              <button
                type="submit"
                className="meet-join-button"
                disabled={!code.trim()}
              >
                Tham gia <ArrowRight size={16} />
              </button>
            </form>
          </div>
          {error && (
            <p id="meet-code-error" className="meet-form-error" role="alert">
              {error}
            </p>
          )}
          <div className="meet-home-divider" />
          <div className="meet-help-line">
            <ShieldCheck size={17} />
            <span>Không gian riêng cho những cuộc trò chuyện của bạn.</span>
          </div>
          <button className="meet-learn-link" onClick={() => setHelp(true)}>
            Tìm hiểu cách sử dụng Streamora <ArrowRight size={14} />
          </button>
          {saved.length > 0 && (
            <div className="meet-recent">
              <div className="meet-recent-heading">
                <Clock3 size={15} />
                <h2>Cuộc họp gần đây</h2>
                <span>Trên thiết bị này</span>
              </div>
              {saved.slice(0, 2).map((meeting) => (
                <Link key={meeting.id} href={`/meet/${meeting.id}`}>
                  <span className="meet-recent-icon">
                    <Video size={18} />
                  </span>
                  <span>
                    <b>{meeting.name}</b>
                    <small>{meeting.id}</small>
                  </span>
                  <ArrowRight size={17} />
                </Link>
              ))}
            </div>
          )}
        </section>
        <section className="meet-home-visual" aria-label="Giới thiệu cuộc họp">
          <div className="meet-illustration" aria-hidden="true">
            <div className="meet-illustration-ring ring-outer" />
            <div className="meet-illustration-ring ring-inner" />
            <span className="meet-orbit-star star-a">✦</span>
            <span className="meet-orbit-star star-b">✧</span>
            <span className="meet-orbit-dot" />
            <div className="meet-art-grid">
              <div className="meet-art-person art-person-one">
                <Avatar initials="MA" color="pink" />
                <span>
                  Minh Anh <Mic size={12} />
                </span>
                <i />
              </div>
              <div className="meet-art-person art-person-two">
                <Avatar initials="TP" color="blue" />
                <span>
                  Tuấn Phạm <MicOff size={12} />
                </span>
              </div>
              <div className="meet-art-person art-person-three">
                <Avatar initials="LN" color="green" />
                <span>
                  Linh Nguyễn <MicOff size={12} />
                </span>
              </div>
              <div className="meet-art-person art-person-four">
                <Avatar initials="BA" />
                <span>
                  Bạn <Mic size={12} />
                </span>
              </div>
            </div>
            <div className="meet-art-logo">
              <Waves size={24} />
            </div>
            <div className="meet-art-invite">
              <span>
                <Link2 size={18} />
              </span>
              <div>
                <b>Gửi liên kết. Bắt đầu kết nối.</b>
                <small>Không cần một không gian phức tạp.</small>
              </div>
              <Check size={17} />
            </div>
          </div>
          <div className="meet-tips">
            <button
              aria-label="Mẹo trước"
              onClick={() => setTip((tip + tips.length - 1) % tips.length)}
            >
              <ChevronLeft size={22} />
            </button>
            <div aria-live="polite">
              <h2>{tips[tip].title}</h2>
              <p>{tips[tip].text}</p>
              <div className="meet-tip-dots">
                {tips.map((item, index) => (
                  <button
                    key={item.title}
                    className={tip === index ? "selected" : ""}
                    aria-label={`Xem mẹo ${index + 1}`}
                    aria-pressed={tip === index}
                    onClick={() => setTip(index)}
                  />
                ))}
              </div>
            </div>
            <button
              aria-label="Mẹo tiếp theo"
              onClick={() => setTip((tip + 1) % tips.length)}
            >
              <ChevronRight size={22} />
            </button>
          </div>
        </section>
      </main>
      <footer className="meet-home-footer">
        <span>
          <Sparkles size={14} /> Mỗi cuộc gặp, một khởi đầu.
        </span>
        <small>Bản trải nghiệm giao diện · Kết nối theo nhịp của bạn</small>
      </footer>
      {help && <MeetingHelp onClose={() => setHelp(false)} />}
      {created && (
        <MeetingDialog
          title="Cuộc họp của bạn đã sẵn sàng."
          onClose={() => setCreated(null)}
        >
          <div className="meet-link-icon">
            <Link2 size={26} />
          </div>
          <p>
            Chia sẻ liên kết này với những người bạn muốn gặp. Bạn có thể quay
            lại cuộc họp từ danh sách gần đây trên thiết bị này.
          </p>
          <div className="meet-copy-field">
            <input
              ref={inviteInput}
              aria-label="Liên kết cuộc họp"
              readOnly
              value={invite}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button aria-label="Sao chép liên kết cuộc họp" onClick={copy}>
              {copied ? <Check size={19} /> : <Copy size={19} />}
            </button>
          </div>
          <span className="meet-copy-status" role="status">
            {copied
              ? "Đã sao chép liên kết."
              : "Sao chép liên kết hoặc chọn và sao chép thủ công."}
          </span>
          <Link className="button primary" href={`/meet/${created.id}`}>
            Vào phòng chờ <ArrowRight size={16} />
          </Link>
        </MeetingDialog>
      )}
    </div>
  );
}
