import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { loadEnvironmentFile, readEnvironment } from "./config/environment";
import { ConfigurationModule } from "./config/configuration.module";
import { DatabaseModule } from "./database/database.module";
import { VideoProcessingCoreModule } from "./modules/video-processing/video-processing-core.module";
import { VideoWorker } from "./modules/video-processing/video-worker";
async function main() {
  loadEnvironmentFile();
  const config = readEnvironment();
  class WorkerModule {}
  Module({
    imports: [
      ConfigurationModule.forRoot(config),
      DatabaseModule.forRoot(config.databaseUrl),
      VideoProcessingCoreModule,
    ],
  })(WorkerModule);
  const app = await NestFactory.createApplicationContext(WorkerModule);
  try {
    await app.get(VideoWorker).start();
  } catch (error) {
    await app.close();
    throw error;
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close();
    });
}
void main().catch(() => {
  console.error(
    "Không thể chạy video worker. Kiểm tra cấu hình, database và ffmpeg/ffprobe.",
  );
  process.exitCode = 1;
});
