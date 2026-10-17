import type { Metadata } from "next";
import "./globals.css";
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
      <body>{children}</body>
    </html>
  );
}
