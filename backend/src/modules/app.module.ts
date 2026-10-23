import { Controller, DynamicModule, Get, Module } from "@nestjs/common";
import { CommunitiesModule } from "./communities/communities.module";
import { RoomsModule } from "./rooms/rooms.module";
import { FilesModule } from "./files/files.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { GroupsModule } from "./groups/groups.module";
import { MembershipsModule } from "./memberships/memberships.module";
import { ClassSessionsModule } from "./class-sessions/class-sessions.module";
import { DatabaseModule } from "../database/database.module";
import { ConfigurationModule } from "../config/configuration.module";
import type { EnvironmentConfig } from "../config/environment";

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
  imports: [
    AuthModule,
    UsersModule,
    GroupsModule,
    MembershipsModule,
    ClassSessionsModule,
    CommunitiesModule,
    RoomsModule,
    FilesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {
  static forRoot(config: EnvironmentConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigurationModule.forRoot(config),
        DatabaseModule.forRoot(config.databaseUrl),
      ],
    };
  }
}
