import type { Metadata } from "next";
import { RequireSession } from "@/components/auth/require-session";
import { ReplicaOperationsPage } from "@/components/recordings/replica-operations-page";

export const metadata: Metadata = { title: "Vận hành video — Streamora" };
export default function Page() {
  return (
    <RequireSession>
      <ReplicaOperationsPage />
    </RequireSession>
  );
}
