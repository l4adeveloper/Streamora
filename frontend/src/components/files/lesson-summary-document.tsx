"use client";
import type { ReactNode } from "react";

// Render the small Markdown subset used by summaries without accepting HTML,
// scripts or arbitrary generated links.
export function LessonSummaryDocument({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const inline = (value: string) =>
    value
      .split(/(\*\*[^*]+\*\*)/g)
      .map((part, index) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={index}>{part.slice(2, -2)}</strong>
        ) : (
          part
        ),
      );
  const flush = () => {
    if (paragraph.length) {
      blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "))}</p>);
      paragraph = [];
    }
    if (list.length) {
      blocks.push(
        <ul key={blocks.length}>
          {list.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const item = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
    if (heading) {
      flush();
      blocks.push(<h4 key={blocks.length}>{inline(heading[1])}</h4>);
    } else if (/^\s*---+\s*$/.test(line)) {
      flush();
      blocks.push(<hr key={blocks.length} />);
    } else if (item) {
      if (paragraph.length) flush();
      list.push(item[1]);
    } else {
      if (list.length) flush();
      paragraph.push(line);
    }
  }
  flush();
  return <article className="lesson-summary-content">{blocks}</article>;
}
