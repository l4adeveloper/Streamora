import type { Metadata } from "next";
import { RequireSession } from "@/components/auth/require-session";
import { GroupsListPage } from "@/components/groups/groups-list-page";

export const metadata: Metadata = {
  title: "Nhóm học tập — Streamora",
  description: "Quản lý các nhóm học tập và lớp học trực tiếp của bạn trên Streamora.",
};

export default function Page() {
  return (
    <RequireSession>
      <GroupsListPage />
    </RequireSession>
  );
}
