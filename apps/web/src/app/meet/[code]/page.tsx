import { RequireSession } from "@/components/auth/require-session";
import { SessionRoom } from "@/components/class-sessions/session-room";
export const metadata = { title: "Tham gia cuộc họp — Streamora" };
export default async function Page({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return (
    <RequireSession preserveDestination>
      <SessionRoom key={code} meetCode={code} />
    </RequireSession>
  );
}
