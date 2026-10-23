"use client";

import Link from "next/link";
import { UserRound } from "lucide-react";
import { Avatar } from "@/components/ui";
import { useAuth } from "@/components/auth/auth-provider";
import { usePathname } from "next/navigation";

export function SessionIdentity() {
  const { user, phase } = useAuth();
  const initials =
    user?.fullName
      .trim()
      .split(/\s+/)
      .slice(-2)
      .map((part) => Array.from(part)[0])
      .join("")
      .toUpperCase() || "KH";
  return (
    <>
      <Avatar initials={initials} small />
      <div className="session-identity">
        <b>{user?.fullName ?? "Khách"}</b>
        <small>
          {user && <span className="status-dot" />}{" "}
          {phase === "checking"
            ? "Đang kiểm tra phiên"
            : phase === "error"
              ? "Chưa thể kiểm tra phiên"
              : user
                ? "Đã đăng nhập"
                : "Bản trải nghiệm"}
        </small>
      </div>
    </>
  );
}

export function AccountLink({
  variant = "text",
}: {
  variant?: "text" | "button" | "avatar";
}) {
  const { user, phase } = useAuth();
  const path = usePathname();
  if (variant === "avatar")
    return (
      <Link
        className="profile-avatar"
        href="/account"
        title="Tài khoản của bạn"
        aria-label="Tài khoản của bạn"
      >
        <UserRound size={21} />
        {user && <span />}
      </Link>
    );
  if (phase === "checking")
    return (
      <span className="account-link-pending" role="status">
        Đang kiểm tra phiên…
      </span>
    );
  const href = user
    ? "/account"
    : variant === "button"
      ? "/register"
      : "/login";
  return (
    <Link
      className={variant === "button" ? "button secondary" : undefined}
      aria-current={path === href ? "page" : undefined}
      href={href}
    >
      {user
        ? variant === "button"
          ? "Mở tài khoản"
          : "Tài khoản"
        : variant === "button"
          ? "Tạo tài khoản"
          : "Đăng nhập"}
    </Link>
  );
}
