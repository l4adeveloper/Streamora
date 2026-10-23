import { Workspace } from "@/components/streamora";
export default async function Page({
  params,
}: {
  params: Promise<{ channel: string }>;
}) {
  const { channel } = await params;
  let name = channel;
  try {
    name = decodeURIComponent(channel);
  } catch {
    /* Keep literal percent characters. */
  }
  return <Workspace view="chat" channel={name} />;
}
