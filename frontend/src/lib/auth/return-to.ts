const fallback = "/workspace";
const origin = "https://streamora.invalid";
const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const returnPath = new RegExp(
  `^/(workspace(?:/meetings/${uuid})?|dashboard|files|community(?:/[^/]+)?|rooms/[^/]+|meet(?:/[a-zA-Z0-9]{12})?|sessions/${uuid}|groups/${uuid}/sessions)$`,
);

export function safeReturnTo(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const destination = new URL(value, origin);
    if (destination.origin === origin && returnPath.test(destination.pathname))
      return destination.pathname + destination.search;
  } catch {
    // Invalid URL.
  }
  return fallback;
}
