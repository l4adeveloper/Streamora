import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { randomUUID } from "node:crypto";

// Local-only event scaffold. Add authentication, authorization, rate limits,
// PostgreSQL persistence and a Redis adapter before production use.
@WebSocketGateway({
  cors: { origin: process.env.WEB_ORIGIN || "http://127.0.0.1:3000" },
  maxHttpBufferSize: 16384,
})
export class RealtimeGateway {
  @WebSocketServer() server!: Server;
  @SubscribeMessage("channel:join")
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      !("channelId" in body) ||
      typeof body.channelId !== "string" ||
      !/^[a-z0-9-]{1,80}$/.test(body.channelId)
    )
      throw new WsException("Kênh không hợp lệ.");
    await client.join(`channel:${body.channelId}`);
    return {
      event: "channel:joined",
      data: { channelId: body.channelId, demo: true },
    };
  }
  @SubscribeMessage("chat:send")
  send(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      !("channelId" in body) ||
      !("text" in body) ||
      typeof body.channelId !== "string" ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > 4000
    )
      throw new WsException("Tin nhắn không hợp lệ.");
    if (!client.rooms.has(`channel:${body.channelId}`))
      throw new WsException("Hãy tham gia kênh trước.");
    const message = {
      id: randomUUID(),
      channelId: body.channelId,
      senderId: client.id,
      text: body.text.trim(),
      createdAt: new Date().toISOString(),
      demo: true,
    };
    this.server.to(`channel:${body.channelId}`).emit("chat:message", message);
    return { ok: true, id: message.id };
  }
}
