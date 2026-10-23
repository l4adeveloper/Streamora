import type { Metadata } from "next";
import { MeetingHome } from "@/components/meeting-home";

export const metadata: Metadata = {
  title: "Cuộc họp — Streamora",
  description: "Tạo cuộc họp mới hoặc tham gia bằng mã và liên kết.",
};

export default function Page() {
  return <MeetingHome />;
}
