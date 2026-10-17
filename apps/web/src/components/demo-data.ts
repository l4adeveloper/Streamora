export type View = "live" | "meet" | "files" | "chat" | "room";
export type ChatMessage = {
  name: string;
  initials: string;
  color: string;
  text: string;
  time: string;
  host?: boolean;
};
export type LibraryFile = {
  name: string;
  kind: string;
  size: string;
  date: string;
};
export const initialMessages: ChatMessage[] = [
  {
    name: "Minh Anh",
    initials: "MA",
    color: "pink",
    text: "Mọi người đã nghe rõ chưa ạ? 👋",
    time: "14:02",
  },
  {
    name: "Nguyễn Hoàng",
    initials: "NH",
    color: "violet",
    text: "Hôm nay mình sẽ cùng tìm hiểu về kiến trúc hệ thống phân tán nhé!",
    time: "14:03",
    host: true,
  },
  {
    name: "Tuấn Phạm",
    initials: "TP",
    color: "blue",
    text: "Em vừa vào muộn, có xem lại phần đầu được không thầy?",
    time: "14:18",
  },
  {
    name: "Nguyễn Hoàng",
    initials: "NH",
    color: "violet",
    text: "Được em nhé. Kéo thanh thời gian về trước là xem được, buổi học vẫn tiếp tục bình thường ✨",
    time: "14:19",
    host: true,
  },
  {
    name: "Linh Nguyễn",
    initials: "LN",
    color: "green",
    text: "Tính năng này tiện quá, không sợ bỏ lỡ bài nữa 🙌",
    time: "14:20",
  },
];
export const initialFiles: LibraryFile[] = [
  {
    name: "Buổi 04 — Kiến trúc hệ thống phân tán",
    kind: "Bản ghi",
    size: "428 MB",
    date: "Hôm qua",
  },
  {
    name: "Slide — Hệ thống phân tán.pdf",
    kind: "Tài liệu",
    size: "12,4 MB",
    date: "Hôm nay",
  },
  {
    name: "Bài tập tuần 05.pdf",
    kind: "Tài liệu",
    size: "2,8 MB",
    date: "16 thg 10",
  },
  {
    name: "Tài nguyên học tập.zip",
    kind: "Tài liệu",
    size: "86 MB",
    date: "15 thg 10",
  },
];
export const membersInitial = [
  "Nguyễn Hoàng",
  "Minh Anh",
  "Tuấn Phạm",
  "Linh Nguyễn",
  "Đức Trần",
  "Hà My",
];
export const time = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
export const portrait =
  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=160&h=160&fit=crop&crop=faces";
