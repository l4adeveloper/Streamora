import { redirect } from "next/navigation";
export const metadata = { title: "Meeting trong Workspace — Streamora" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ groupId?: string; create?: string }>;
}) {
  const query = await searchParams;
  const params = new URLSearchParams();
  if (typeof query.groupId === "string") params.set("groupId", query.groupId);
  if (query.create === "1") params.set("create", "1");
  redirect(`/workspace${params.size ? `?${params}` : ""}`);
}
