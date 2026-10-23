"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  CircleCheck,
  LockKeyhole,
  Users,
  Waves,
} from "lucide-react";
import { SiteHeader } from "@/components/shell/page-shell";

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <SiteHeader />
      <main className="auth-main">
        <aside className="auth-story" aria-label="Không gian Streamora">
          <span className="eyebrow">
            <span className="status-dot" /> CÙNG NHAU, TIẾN XA HƠN
          </span>
          <h2>
            Không gian chung.
            <br />
            <span>Hành trình của bạn.</span>
          </h2>
          <p>
            Một nơi để gặp gỡ, chia sẻ ý tưởng và cùng nhau học thêm điều mới
            mỗi ngày.
          </p>
          <div className="auth-illustration" aria-hidden="true">
            <div className="auth-orbit orbit-one" />
            <div className="auth-orbit orbit-two" />
            <div className="auth-wave">
              <Waves size={58} strokeWidth={1.4} />
            </div>
            <div className="auth-float auth-float-top">
              <span className="auth-float-icon">
                <Users size={20} />
              </span>
              <div>
                <strong>Kết nối từ đây</strong>
                <small>Mỗi hành trình bắt đầu cùng nhau</small>
              </div>
            </div>
            <div className="auth-float auth-float-bottom">
              <CircleCheck size={20} />
              <span>Một tài khoản. Không gian của bạn.</span>
            </div>
          </div>
          <span className="auth-story-footer">
            <LockKeyhole size={14} /> Kết nối theo cách của bạn.
          </span>
        </aside>
        <section className="auth-panel">{children}</section>
      </main>
      <footer className="auth-footer">
        <Link href="/">
          <ArrowLeft size={13} /> Về trang chủ
        </Link>
        <span>© 2026 Streamora</span>
      </footer>
    </div>
  );
}
