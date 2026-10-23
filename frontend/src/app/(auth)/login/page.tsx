import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form";
export const metadata: Metadata = { title: "Đăng nhập — Streamora" };
export default function LoginPage() {
  return <AuthForm mode="login" />;
}
