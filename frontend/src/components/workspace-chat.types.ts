export type ChatMessage = {
  id?: string;
  clientId?: string | null;
  senderId?: string;
  name: string;
  initials: string;
  color: string;
  text: string;
  time: string;
  createdAt?: string;
  replyToId?: string | null;
  meetingId?: string | null;
  editedAt?: string | null;
  host?: boolean;
  pending?: boolean;
};
