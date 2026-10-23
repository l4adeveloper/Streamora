import type { Metadata } from "next";
import { RequireSession } from "@/components/auth/require-session";
import { GroupDetailPage } from "@/components/groups/group-detail-page";

export const metadata: Metadata = {
  title: "Chi tiết nhóm học tập — Streamora",
  description: "Xem chi tiết nhóm học tập, lịch học và tài liệu trao đổi.",
};

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <RequireSession>
      <GroupDetailPage groupId={id} />
    </RequireSession>
  );
}
