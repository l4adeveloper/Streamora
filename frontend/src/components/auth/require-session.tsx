"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, type ReactNode } from "react";
import { useAuth } from "./auth-provider";
import { ErrorState, LoadingState } from "@/components/common/feedback";

export function RequireSession({
  children,
  preserveDestination = false,
}: {
  children: ReactNode;
  preserveDestination?: boolean;
}) {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (auth.phase === "anonymous")
      router.replace(
        preserveDestination
          ? `/auth?next=${encodeURIComponent(window.location.pathname)}`
          : "/auth",
      );
  }, [auth.phase, router, preserveDestination]);
  if (auth.phase === "checking" || auth.phase === "anonymous")
    return <LoadingState message="Đang kiểm tra phiên đăng nhập…" />;
  if (auth.phase === "error")
    return (
      <ErrorState
        title="Chưa thể tải tài khoản"
        description={auth.notice ?? "Vui lòng kiểm tra kết nối và thử lại."}
        onRetry={auth.retry}
      >
        <Link href="/auth" className="button secondary">
          Đến trang đăng nhập
        </Link>
      </ErrorState>
    );
  return <Fragment key={auth.user?.id}>{children}</Fragment>;
}
