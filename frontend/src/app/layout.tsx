import type { Metadata } from "next";
import Script from "next/script";
import { AuthProvider } from "@/components/auth/auth-provider";
import { ToastProvider } from "@/components/common/toast-provider";
import { InteractionFeedback } from "@/components/common/interaction-feedback";
import { themeInitScript } from "@/lib/theme";
import "./globals.css";
import "@/components/common/common.css";
import "@/components/workspace-layout.css";
import "@/components/common/selects.css";
import "@/components/common/motion.css";
export const metadata: Metadata = {
  title: "Streamora — Học cùng nhau, kết nối mọi lúc",
  description:
    "Không gian học tập, trò chuyện và cộng tác trực tiếp dành cho cộng đồng của bạn.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        <link
          rel="preload"
          href="/fonts/google-sans-flex-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/google-sans-flex-vietnamese.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
        <InteractionFeedback />
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
