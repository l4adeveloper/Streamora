import "client-only";
export const folderChangeEvent = "streamora:folder-force-changed";
export const folderChangeChannel = "streamora-folder-force-changed";
export type FolderChange = { groupId: string; folderPath: string };
export function announceFolderChange(change: FolderChange) {
  window.dispatchEvent(new CustomEvent(folderChangeEvent, { detail: change }));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(folderChangeChannel);
    channel.postMessage(change);
    channel.close();
  }
}
