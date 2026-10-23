"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Brand } from "@/components/ui";
import { AccountLink } from "./account-link";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  const path = usePathname();
  return (
    <header className="site-header">
      <Brand />
      <nav aria-label="Điều hướng chính">
        <Link
          href="/meet"
          aria-current={path.startsWith("/meet") ? "page" : undefined}
        >
          Cuộc họp
        </Link>
        <Link
          href="/groups"
          aria-current={path.startsWith("/groups") ? "page" : undefined}
        >
          Nhóm học tập
        </Link>
        <Link
          href="/workspace"
          aria-current={path === "/workspace" ? "page" : undefined}
        >
          Không gian học tập
        </Link>
        <AccountLink />
        <ThemeToggle />
      </nav>
    </header>
  );
}

export function PageShell({
  title,
  description,
  eyebrow,
  breadcrumb,
  children,
}: {
  title?: string;
  description?: string;
  eyebrow?: string;
  breadcrumb?: string;
  children: ReactNode;
}) {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="page-shell-main">
        {breadcrumb && (
          <nav className="page-breadcrumb" aria-label="Đường dẫn">
            <Link href="/">Streamora</Link>
            <ChevronRight size={14} aria-hidden="true" />
            <span aria-current="page">{breadcrumb}</span>
          </nav>
        )}
        {title && (
          <div className="page-heading">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h1>{title}</h1>
            {description && <p>{description}</p>}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
