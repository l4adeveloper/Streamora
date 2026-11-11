import { isUUID } from "class-validator";
import { ApiError } from "../../common/api-error";

export function readClassSessionCursor(
  cursor: string | undefined,
  scope: string,
) {
  if (!cursor) return null;
  try {
    if (!/^[\w-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
      scope: string;
      at: string;
      id: string;
    };
    if (
      !value ||
      value.scope !== scope ||
      !isUUID(value.id) ||
      typeof value.at !== "string" ||
      new Date(value.at).toISOString() !== value.at
    )
      throw new Error();
    return { at: new Date(value.at), id: value.id };
  } catch {
    throw new ApiError(
      400,
      "INVALID_CURSOR",
      "Con trỏ phân trang không hợp lệ.",
    );
  }
}

export function classSessionCursor(scope: string, at: Date, id: string) {
  return Buffer.from(
    JSON.stringify({ scope, at: at.toISOString(), id }),
  ).toString("base64url");
}
