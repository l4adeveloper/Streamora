import { Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
import { IsString, IsUUID, Length } from "class-validator";
import { randomUUID } from "node:crypto";
import { CurrentAuth, RequireAuth, UUIDParamPipe } from "../../common";
import type { AuthenticatedIdentity } from "../../common";
import { MembershipsModule } from "../memberships/memberships.module";
import { GroupAccessService } from "../memberships/group-access.service";
import { RequireGroupAccess } from "../memberships/group-access.guard";
import { PrismaService } from "../../database/prisma.service";

class CreateRoomDto {
  @IsString() @Length(1, 100) name!: string;
  @IsUUID() groupId!: string;
}
@Controller("rooms")
class RoomsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccessService,
  ) {}
  @Post()
  @RequireAuth()
  async create(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Body() dto: CreateRoomDto,
  ) {
    const id = randomUUID();
    const room = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM groups WHERE id = ${dto.groupId}::uuid FOR UPDATE`;
      await this.access.require(auth.user.id, dto.groupId, "canHost", tx);
      return tx.groupRoom.create({
        data: {
          id,
          name: dto.name,
          groupId: dto.groupId,
          roomName: `group-${dto.groupId}-${id}`,
        },
      });
    });
    return {
      data: { id: room.id, name: room.name, groupId: room.groupId },
      demo: true,
    };
  }
  @Get(":id")
  @RequireGroupAccess(undefined, "room", "id")
  async find(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("id", UUIDParamPipe) id: string,
  ) {
    const room = await this.access.requireRoom(auth.user.id, id);
    return {
      data: { id: room.id, name: room.name, groupId: room.groupId },
      demo: true,
    };
  }
  // T05 owns session lifecycle checks, bans and LiveKit token issuance.
}
@Module({ imports: [MembershipsModule], controllers: [RoomsController] })
export class RoomsModule {}
