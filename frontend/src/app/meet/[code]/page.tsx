import { RequireSession } from "@/components/auth/require-session";
import { MeetingEntry } from "@/components/class-sessions/meeting-entry";
export const metadata = { title: "Tham gia cuộc họp — Streamora" };
export default async function Page({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return (
    <RequireSession preserveDestination>
      <MeetingEntry key={code} code={code} />
    </RequireSession>
  );
}
