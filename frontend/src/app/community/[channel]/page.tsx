import { Workspace } from "@/components/streamora";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ channel: string }>;
  searchParams: Promise<{ messageId?: string; threadId?: string }>;
}) {
  const { channel } = await params;
  const { messageId, threadId } = await searchParams;
  let name = channel;
  try {
    name = decodeURIComponent(channel);
  } catch {
    /* Keep literal percent characters. */
  }
  return (
    <Workspace
      view="chat"
      channel={name}
      targetMessageId={messageId}
      targetThreadId={threadId}
    />
  );
}
