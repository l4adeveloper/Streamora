import { RequireSession } from "@/components/auth/require-session";
import { SessionRoom } from "@/components/class-sessions/session-room";
export const metadata = { title: "Buổi học — Streamora" };
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <RequireSession preserveDestination>
      <SessionRoom key={id} sessionId={id} />
    </RequireSession>
  );
}
