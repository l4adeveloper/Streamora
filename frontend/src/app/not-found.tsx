import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "@/components/common/feedback";
import { PageShell } from "@/components/shell/page-shell";
export default function NotFound() {
  return (
    <PageShell title="404">
      <EmptyState
        title="Không gian này chưa tồn tại."
        description="Đường dẫn có thể đã thay đổi. Hãy quay lại để tiếp tục kết nối."
      >
        <Link href="/workspace" className="button primary">
          <ArrowLeft size={17} /> Về không gian học tập
        </Link>
      </EmptyState>
    </PageShell>
  );
}
