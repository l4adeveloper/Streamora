"use client";
import Link from "next/link";
import { ErrorState } from "@/components/common/feedback";
import { PageShell } from "@/components/shell/page-shell";

export default function ErrorPage({
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <PageShell title="Nội dung đang bị gián đoạn">
      <ErrorState
        description="Có lỗi khi mở trang. Vui lòng thử lại hoặc quay về không gian học tập."
        onRetry={retry}
      >
        <Link href="/workspace" className="button secondary">
          Về không gian học tập
        </Link>
      </ErrorState>
    </PageShell>
  );
}
