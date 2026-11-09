import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { loadEnvironmentFile, readEnvironment } from "./config/environment";
import { ConfigurationModule } from "./config/configuration.module";
import { DatabaseModule } from "./database/database.module";
import { IvsEventsModule } from "./modules/class-media/ivs-events.module";
async function main() {
  loadEnvironmentFile();
  const config = readEnvironment();
  if (!config.ivs?.enabled || !config.ivs.eventsQueueUrl)
    throw new Error("IVS_WORKER_NOT_CONFIGURED");
  config.ivs.workerEnabled = true;
  class WorkerModule {}
  Module({
    imports: [
      ConfigurationModule.forRoot(config),
      DatabaseModule.forRoot(config.databaseUrl),
      IvsEventsModule,
    ],
  })(WorkerModule);
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // The queue polling interval is unref'ed for test contexts. Keep this worker alive.
  const keepAlive = setInterval(() => {}, 60000);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      clearInterval(keepAlive);
      void app.close();
    });
}
void main().catch(() => {
  console.error(
    "Không thể khởi động worker IVS. Kiểm tra env, database và AWS.",
  );
  process.exitCode = 1;
});
