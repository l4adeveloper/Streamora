"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { SiteHeader } from "@/components/shell/page-shell";

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <SiteHeader />
      <main className="auth-main">
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
