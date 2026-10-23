import { RequireSession } from "@/components/auth/require-session";
import { MeetHub } from "@/components/class-sessions/meet-hub";
export const metadata = { title: "Cuộc họp — Streamora" };
export default function Page() {
  return (
    <RequireSession preserveDestination>
      <MeetHub />
    </RequireSession>
  );
}
