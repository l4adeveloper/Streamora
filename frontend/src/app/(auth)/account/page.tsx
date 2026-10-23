import type { Metadata } from "next";
import { AccountPage } from "@/components/auth/account-page";
import { RequireSession } from "@/components/auth/require-session";
export const metadata: Metadata = {
  title: "Tài khoản của bạn — Streamora",
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <RequireSession>
      <AccountPage />
    </RequireSession>
  );
}
