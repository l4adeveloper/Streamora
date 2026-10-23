import { RequireSession } from "@/components/auth/require-session";
import { GroupSchedule } from "@/components/class-sessions/group-schedule";
export const metadata = { title: "Lịch học của nhóm — Streamora" };
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <RequireSession preserveDestination>
      <GroupSchedule key={id} groupId={id} />
    </RequireSession>
  );
}
