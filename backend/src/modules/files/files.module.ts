import { Controller, Get, Module, Query } from "@nestjs/common";
import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentAuth, RequireAuth } from "../../common";
import type { AuthenticatedIdentity } from "../../common";
import { MembershipsModule } from "../memberships/memberships.module";
import { GroupAccessService } from "../memberships/group-access.service";

class FileListQueryDto {
  @IsUUID() groupId!: string;
  @IsOptional() @IsString() @MaxLength(254) q?: string;
}

@Controller("files")
class FilesController {
  constructor(private readonly access: GroupAccessService) {}
  @Get()
  @RequireAuth()
  async list(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Query() query: FileListQueryDto,
  ) {
    await this.access.require(auth.user.id, query.groupId, "canViewRecordings");
    const files = [
      {
        id: "slide-05",
        name: "Slide — Hệ thống phân tán.pdf",
        kind: "document",
        size: 13002342,
      },
      {
        id: "record-04",
        name: "Buổi 04 — Kiến trúc hệ thống phân tán",
        kind: "recording",
        size: 448790528,
      },
    ];
    return {
      data: files.filter((file) =>
        file.name
          .toLocaleLowerCase("vi")
          .includes((query.q ?? "").toLocaleLowerCase("vi")),
      ),
      demo: true,
    };
  }
}
@Module({ imports: [MembershipsModule], controllers: [FilesController] })
export class FilesModule {}
