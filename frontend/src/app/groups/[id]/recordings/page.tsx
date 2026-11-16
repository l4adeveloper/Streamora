import type { Metadata } from "next";
import { RequireSession } from "@/components/auth/require-session";
import { RecordingsPage } from "@/components/recordings/recordings-page";

export const metadata: Metadata = { title: "Bản ghi buổi học — Streamora" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequireSession><RecordingsPage groupId={id} /></RequireSession>;
}
