"use client";
import Link from "next/link";

import { Waves } from "lucide-react";

export function Brand({
  small = false,
  href = "/",
  label = "Streamora, trang chủ",
}: {
  small?: boolean;
  href?: string;
  label?: string;
}) {
  return (
    <Link
      href={href}
      className={`brand ${small ? "brand-small" : ""}`}
      aria-label={label}
    >
      <span className="brand-mark">
        <Waves size={25} strokeWidth={2} />
      </span>
      {!small && (
        <>
          streamora<span className="brand-dot">.</span>
        </>
      )}
    </Link>
  );
}
export function Avatar({
  initials,
  color = "violet",
  small = false,
}: {
  initials: string;
  color?: string;
  small?: boolean;
}) {
  return (
    <span className={`avatar ${color} ${small ? "avatar-small" : ""}`}>
      {initials}
    </span>
  );
}
export function IconButton({
  children,
  label,
  onClick,
  active = false,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`icon-button ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
