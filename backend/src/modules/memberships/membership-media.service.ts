import { Injectable } from "@nestjs/common";
import { RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { PrismaService } from "../../database/prisma.service";
import { GroupAccessService } from "./group-access.service";
import { ApiError } from "../../common/api-error";

@Injectable()
export class MembershipMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccessService,
  ) {}

  // No client-provided room/group mapping is trusted.
  async synchronize(groupId: string, userId: string) {
    const rooms = await this.prisma.groupRoom.findMany({
      where: { groupId },
      select: { roomName: true },
    });
    if (!rooms.length) return;
    const url = process.env.LIVEKIT_URL;
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    // Leave the durable event pending until media configuration is available.
    if (!url || !key || !secret) throw new Error("MEDIA_NOT_CONFIGURED");
    const livekit = new RoomServiceClient(
      url.replace(/^ws/, "http"),
      key,
      secret,
      { requestTimeout: 3, failover: false },
    );
    for (const { roomName } of rooms) {
      // Serialize media synchronization with membership mutations and other
      // workers. A slow older update must not restore permissions after removal.
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM groups WHERE id = ${groupId}::uuid FOR UPDATE`;
          let role: string | null = null;
          try {
            role = (await this.access.require(userId, groupId, undefined, tx))
              .role;
          } catch (error) {
            if (!(
              error instanceof ApiError &&
              [403, 404].includes(error.getStatus())
            ))
              throw error;
          }
          try {
            if (!role) await livekit.removeParticipant(roomName, userId);
            else
              await livekit.updateParticipant(roomName, userId, {
                metadata: JSON.stringify({ groupId, role }),
                // Viewer mic/camera remain allowed. Screen share belongs to HOST/OWNER
                // until T06 introduces an explicit viewer-share policy.
                permission: {
                  canSubscribe: true,
                  canPublish: true,
                  canPublishData: true,
                  canPublishSources:
                    role === "VIEWER"
                      ? [TrackSource.CAMERA, TrackSource.MICROPHONE]
                      : [
                          TrackSource.CAMERA,
                          TrackSource.MICROPHONE,
                          TrackSource.SCREEN_SHARE,
                          TrackSource.SCREEN_SHARE_AUDIO,
                        ],
                  canUpdateMetadata: false,
                  hidden: false,
                  recorder: false,
                },
              });
          } catch (error) {
            if (!(
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "not_found"
            ))
              throw error;
          }
        },
        { timeout: 8000 },
      );
    }
  }
}
