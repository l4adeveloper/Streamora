import {
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { IsString, Length } from "class-validator";
import { randomUUID } from "node:crypto";

class CreateRoomDto {
  @IsString() @Length(1, 100) name!: string;
}
@Controller("rooms")
class RoomsController {
  // Development store. Replace with PostgreSQL and authenticated, community-scoped access.
  private readonly rooms = new Map<
    string,
    { id: string; name: string; createdAt: string }
  >();
  @Post() create(@Body() dto: CreateRoomDto) {
    const room = {
      id: randomUUID(),
      name: dto.name,
      createdAt: new Date().toISOString(),
    };
    this.rooms.set(room.id, room);
    return { data: room, demo: true };
  }
  @Get(":id") find(@Param("id") id: string) {
    const room = this.rooms.get(id);
    if (!room) throw new NotFoundException("Không tìm thấy phòng học.");
    return { data: room, demo: true };
  }
  // LiveKit tokens intentionally have no public endpoint until authentication and room permissions exist.
}
@Module({ controllers: [RoomsController] })
export class RoomsModule {}
