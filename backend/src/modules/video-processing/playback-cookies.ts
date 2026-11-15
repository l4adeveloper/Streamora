import type { Response } from "express";
import type { DeliveryCookie } from "./video-delivery";
export function applyPlaybackCookies<
  T extends { deliveryCookies?: DeliveryCookie[] },
>(result: T, response: Response) {
  const { deliveryCookies, ...body } = result;
  for (const cookie of deliveryCookies ?? []) {
    response.cookie(cookie.name, cookie.value, {
      httpOnly: true,
      secure: cookie.secure,
      sameSite: "lax",
      path: cookie.path,
      maxAge: 60000,
    });
  }
  return body;
}
