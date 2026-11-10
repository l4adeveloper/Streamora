import { RequireSession } from "@/components/auth/require-session";
import { Workspace } from "@/components/workspace";
export const metadata = { title: "Meeting trong Workspace — Streamora" };
export default function Page() {
  return (
    <RequireSession preserveDestination>
      <Workspace view="meetings" />
    </RequireSession>
  );
}
