import { Fragment } from "react";

/** Render text as React nodes, never HTML supplied by a message. */
export function ChatSearchHighlight({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const source = text.normalize("NFC");
  const needle = query.trim().normalize("NFC").toLocaleLowerCase("vi");
  if (!needle) return <>{source}</>;
  const lower = source.toLocaleLowerCase("vi");
  const parts = [];
  let start = 0;
  let match = lower.indexOf(needle);
  while (match !== -1) {
    parts.push(
      <Fragment key={start}>
        {source.slice(start, match)}
        <mark>{source.slice(match, match + needle.length)}</mark>
      </Fragment>,
    );
    start = match + needle.length;
    match = lower.indexOf(needle, start);
  }
  return (
    <>
      {parts}
      {source.slice(start)}
    </>
  );
}

export function chatSearchExcerpt(text: string, query: string) {
  const source = text.normalize("NFC");
  const position = source
    .toLocaleLowerCase("vi")
    .indexOf(query.trim().normalize("NFC").toLocaleLowerCase("vi"));
  const start = Math.max(0, position - 90);
  const end = Math.min(
    source.length,
    Math.max(start + 260, position + query.length + 90),
  );
  return `${start ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}
