import { Controller, Get, Module } from "@nestjs/common";
import { CommunitiesModule } from "./communities/communities.module";
import { RoomsModule } from "./rooms/rooms.module";
import { FilesModule } from "./files/files.module";

@Controller("health")
class HealthController {
  @Get() health() {
    return {
      status: "ok",
      service: "streamora-api",
      mode: "development-scaffold",
    };
  }
}
@Module({
  imports: [CommunitiesModule, RoomsModule, FilesModule],
  controllers: [HealthController],
})
export class AppModule {}
