import Link from "next/link";
import { ArrowLeft, Waves } from "lucide-react";
export default function NotFound() {
  return (
    <main className="not-found">
      <Waves size={48} />
      <span>404</span>
      <h1>Không gian này chưa tồn tại.</h1>
      <p>Đường dẫn có thể đã thay đổi. Hãy quay lại để tiếp tục kết nối.</p>
      <Link href="/workspace" className="button primary">
        <ArrowLeft size={17} /> Về không gian học tập
      </Link>
    </main>
  );
}
