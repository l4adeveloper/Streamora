import type { Response } from "express";
import type { DeliveryCookie } from "./video-delivery";
export function applyPlaybackCookies<
  T extends { deliveryCookies?: DeliveryCookie[] },
>(result: T, response: Response, cloud: boolean) {
  const { deliveryCookies, ...body } = result;
  for (const cookie of deliveryCookies ?? []) {
    if (!!cookie.domain !== cloud) continue;
    response.cookie(cookie.name, cookie.value, {
      httpOnly: true,
      secure: cookie.secure,
      sameSite: cloud ? "none" : "lax",
      path: cookie.path,
      ...(cookie.domain ? { domain: cookie.domain } : {}),
      maxAge: 60000,
    });
  }
  return body;
}
