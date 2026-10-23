"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CircleHelp, LayoutGrid, X } from "lucide-react";
import { Avatar, Brand, IconButton } from "./ui";

export type SavedMeeting = { id: string; name: string; createdAt: number };
export const MEETINGS_KEY = "streamora-meetings";

export function readMeetings(): SavedMeeting[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(MEETINGS_KEY) || "[]",
    );
    return Array.isArray(stored)
      ? stored.filter(
          (meeting): meeting is SavedMeeting =>
            meeting &&
            typeof meeting.id === "string" &&
            typeof meeting.name === "string" &&
            typeof meeting.createdAt === "number",
        )
      : [];
  } catch {
    return [];
  }
}

export function rememberMeeting(meeting: SavedMeeting) {
  try {
    const next = [
      meeting,
      ...readMeetings().filter((item) => item.id !== meeting.id),
    ].slice(0, 5);
    localStorage.setItem(MEETINGS_KEY, JSON.stringify(next));
  } catch {
    /* The meeting remains usable if local storage is unavailable. */
  }
}

export function MeetingHeader({ onHelp }: { onHelp: () => void }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <header className="meet-header">
      <div className="meet-header-brand">
        <Brand />
        <span className="meet-header-divider" />
        <Link href="/meet" className="meet-product-name">
          Cuộc họp
        </Link>
      </div>
      <nav aria-label="Điều hướng cuộc họp">
        <time className="meet-clock" suppressHydrationWarning>
          {now
            ? `${now.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" })} · ${now.toLocaleDateString("vi-VN", { weekday: "short", day: "numeric", month: "long", timeZone: "Asia/Ho_Chi_Minh" })}`
            : ""}
        </time>
        <IconButton label="Hướng dẫn cuộc họp" onClick={onHelp}>
          <CircleHelp size={21} />
        </IconButton>
        <Link
          className="meet-workspace-link"
          href="/workspace"
          title="Mở không gian học tập"
        >
          <LayoutGrid size={18} />
          <span>Không gian học tập</span>
          <ArrowUpRight size={13} />
        </Link>
        <span title="Bảo Anh" className="meet-user">
          <Avatar initials="BA" small />
        </span>
      </nav>
    </header>
  );
}

export function MeetingDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, [tabindex="0"]',
        ) || [],
      ).filter((element) => !element.hasAttribute("disabled"));
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const controls = focusable();
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialog}
        className="modal meet-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meet-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <IconButton label="Đóng hộp thoại" onClick={onClose}>
          <X size={20} />
        </IconButton>
        <h2 id="meet-dialog-title">{title}</h2>
        {children}
      </section>
    </div>
  );
}

export function MeetingHelp({ onClose }: { onClose: () => void }) {
  return (
    <MeetingDialog title="Gặp nhau chỉ với một liên kết." onClose={onClose}>
      <p>
        Chọn “Cuộc họp mới” để bắt đầu ngay hoặc lấy liên kết dùng sau. Người
        được mời có thể nhập mã hoặc dán liên kết để vào phòng chờ.
      </p>
      <p>
        Bạn có thể kiểm tra camera và micro trước khi tham gia. Các thiết bị chỉ
        bật sau khi bạn cho phép.
      </p>
      <div className="meet-demo-note">
        Bản trải nghiệm: camera, micro và màn hình hoạt động trên thiết bị của
        bạn. Chưa kết nối cuộc gọi giữa nhiều người.
      </div>
      <button className="button primary" onClick={onClose}>
        Đã hiểu
      </button>
    </MeetingDialog>
  );
}
