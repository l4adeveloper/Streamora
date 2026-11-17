import type { Metadata } from "next";
import { RequireSession } from "@/components/auth/require-session";
import { RecordingPage } from "@/components/recordings/recording-page";

export const metadata: Metadata = { title: "Xem bản ghi — Streamora" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequireSession><RecordingPage recordingId={id} /></RequireSession>;
}
