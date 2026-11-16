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
    if (!asset)
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
      publishedJobId: asset.publishedJobId,
      replicas: replicas.map((row) => ({
        ...row,
        current: row.jobId === asset.publishedJobId,
      })),
    };
  }
}
