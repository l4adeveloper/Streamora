import { RequireSession } from "@/components/auth/require-session";
import { MeetingEntry } from "@/components/class-sessions/meeting-entry";
export const metadata = { title: "Buổi học — Streamora" };
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <RequireSession preserveDestination>
      <MeetingEntry key={id} sessionId={id} />
    </RequireSession>
  );
}
