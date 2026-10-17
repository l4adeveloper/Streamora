import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Controller, Get, Module } from "@nestjs/common";
import { RealtimeGateway } from "./realtime.gateway";

@Controller("health")
class HealthController {
  @Get() health() {
    return {
      status: "ok",
      service: "streamora-realtime",
      mode: "development-scaffold",
    };
  }
}
@Module({ controllers: [HealthController], providers: [RealtimeGateway] })
class AppModule {}
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(Number(process.env.REALTIME_PORT || 4001), "127.0.0.1");
}
void bootstrap();
