import type { Metadata } from "next";
import { AuthProvider } from "@/components/auth/auth-provider";
import { ToastProvider } from "@/components/common/toast-provider";
import "./globals.css";
import "@/components/common/common.css";
export const metadata: Metadata = {
  title: "Streamora — Học cùng nhau, kết nối mọi lúc",
  description:
    "Không gian học tập, trò chuyện và cộng tác trực tiếp dành cho cộng đồng của bạn.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
