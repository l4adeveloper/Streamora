import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MeetingRoom } from "@/components/meeting-room";

export const metadata: Metadata = { title: "Phòng họp — Streamora" };

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ start?: string }>;
}) {
  const { id } = await params;
  const { start } = await searchParams;
  if (!/^[a-zA-Z0-9_-]{3,80}$/.test(id)) notFound();
  return <MeetingRoom id={id} autoJoin={start === "1"} />;
}
