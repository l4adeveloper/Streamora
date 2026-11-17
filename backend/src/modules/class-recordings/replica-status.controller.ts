import { Controller, Get, Header, Param } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  CurrentAuth,
  RequireAuth,
  UUIDParamPipe,
  type AuthenticatedIdentity,
} from "../../common";
import { ApiError } from "../../common/api-error";
import { PrismaService } from "../../database/prisma.service";

@Controller("internal/assets/:assetId/replicas")
@ApiTags("Internal video operations")
@ApiBearerAuth("accessToken")
@RequireAuth()
export class ReplicaStatusController {
  constructor(private readonly db: PrismaService) {}
  @Get()
  @Header("Cache-Control", "no-store")
  async get(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("assetId", UUIDParamPipe) assetId: string,
  ) {
    if (auth.user.globalRole !== "ADMIN")
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Chỉ quản trị viên được xem trạng thái replica.",
      );
    const asset = await this.db.videoAsset.findUnique({
      where: { fileId: assetId },
      select: { publishedJobId: true },
    });
    const file = asset
      ? true
      : await this.db.libraryFile.findUnique({
          where: { id: assetId },
          select: { id: true },
        });
    if (!file)
      throw new ApiError(404, "ASSET_NOT_FOUND", "Không tìm thấy video.");
    const replicas = await this.db.videoReplica.findMany({
      where: { fileId: assetId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        jobId: true,
        destinationBucket: true,
        status: true,
        attempts: true,
        objectCount: true,
        lastSyncedAt: true,
        errorCode: true,
        updatedAt: true,
      },
    });
    return {
      assetId,
      publishedJobId: asset?.publishedJobId ?? null,
      storageReplicas: await this.db.storageReplica.findMany({
        where: { kind: "RAW", assetId },
        select: {
          id: true,
          kind: true,
          status: true,
          attempts: true,
          objectCount: true,
          errorCode: true,
          lastSyncedAt: true,
          completed: true,
        },
      }),
      replicas: replicas.map((row) => ({
        ...row,
        current: row.jobId === asset?.publishedJobId,
      })),
    };
  }

  @Get("live")
  @Header("Cache-Control", "no-store")
  async live(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("assetId", UUIDParamPipe) assetId: string,
  ) {
    if (auth.user.globalRole !== "ADMIN")
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Chỉ quản trị viên được xem trạng thái replica.",
      );
    return {
      recordingId: assetId,
      replicas: await this.db.storageReplica.findMany({
        where: { kind: "LIVE_DVR", assetId },
        select: {
          id: true,
          status: true,
          attempts: true,
          objectCount: true,
          readyThroughSeconds: true,
          errorCode: true,
          lastSyncedAt: true,
          completed: true,
        },
      }),
    };
  }
}
