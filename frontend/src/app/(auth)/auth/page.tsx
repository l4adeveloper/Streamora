import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form";

export const metadata: Metadata = { title: "Tài khoản — Streamora" };

export default function AuthPage() {
  return <AuthForm mode="login" />;
}
