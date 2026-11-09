// Only bounded codes: never log connection URLs, credentials, signed URLs or driver messages.
export function safeErrorCode(error: unknown): string {
  const value = error as {
    code?: unknown;
    cause?: { code?: unknown };
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
  } | null;
  if (error instanceof Error && /query read timeout/i.test(error.message))
    return "DATABASE_QUERY_TIMEOUT";
  for (const code of [
    value?.meta?.driverAdapterError?.cause?.originalCode,
    value?.meta?.code,
    value?.cause?.code,
    value?.code,
  ]) {
    if (typeof code === "string" && /^[A-Z0-9_]{2,48}$/.test(code)) return code;
  }
  if (
    error instanceof Error &&
    /timeout exceeded when trying to connect|connection terminated due to connection timeout/i.test(
      error.message,
    )
  )
    return "CONNECTION_TIMEOUT";
  return "UNKNOWN";
}
