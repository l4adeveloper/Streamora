"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Brand } from "./ui";
import { ThemeToggle } from "./shell/theme-toggle";
import { StudyBanner } from "./study-banner";
import "./entry-page.css";

export function Landing() {
  return (
    <main className="entry-page">
      <div className="entry-backdrop" aria-hidden="true">
        <StudyBanner />
      </div>
      <header className="entry-header">
        <Brand />
        <ThemeToggle />
      </header>
      <div className="entry-content">
        <section className="entry-story" aria-label="Cộng đồng Streamora">
          <p className="entry-kicker">Nơi những ý tưởng gặp nhau</p>
          <h1>
            Đi xa hơn.
            <br /> <span>Cùng nhau.</span>
          </h1>
          <p className="entry-description">
            Một câu hỏi hay. Một góc nhìn mới.
            <br /> Một hành trình học tập có nhau.
          </p>
          <Link href="/auth" className="button entry-start">
            <span className="entry-start-label">Bắt đầu</span>
            <ArrowUpRight size={21} aria-hidden="true" />
          </Link>
        </section>
      </div>
      <footer className="entry-footer">
        <span>Cùng học. Cùng tiến xa.</span>
        <span>© 2026 Streamora</span>
      </footer>
    </main>
  );
}
