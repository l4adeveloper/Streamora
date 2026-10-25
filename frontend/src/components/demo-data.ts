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
