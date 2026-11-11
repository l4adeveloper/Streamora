import "client-only";
import { io } from "socket.io-client";
import { authSession } from "@/lib/auth/session";

export function connectClassroom() {
  const azure = process.env.NEXT_PUBLIC_AZURE_WEB_PUBSUB_URL?.trim();
  const api = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(
    /\/api\/v1\/?$/,
    "",
  );
  const endpoint = azure || process.env.NEXT_PUBLIC_REALTIME_URL || api;
  return io(`${endpoint.replace(/\/$/, "")}/classroom`, {
    ...(azure ? { path: "/clients/socketio/hubs/classroom" } : {}),
    autoConnect: false,
    transports: ["websocket"],
    auth: (callback) => {
      void authSession.getAccessToken().then(
        (accessToken) => callback({ accessToken }),
        () => callback({}),
      );
    },
  });
}
