import "reflect-metadata";
import { createApplication } from "./app";
import {
  ConfigurationError,
  loadEnvironmentFile,
  readEnvironment,
} from "./config/environment";
import {
  deployMigrations,
  MigrationDeployError,
} from "./database/deploy-migrations";

async function bootstrap() {
  loadEnvironmentFile();
  const config = readEnvironment();
  await deployMigrations(config);
  const app = await createApplication(config);
  await app.listen(config.port, config.host);
}
void bootstrap().catch((error: unknown) => {
  // Never print configuration values, connection strings or signing keys.
  console.error(
    error instanceof ConfigurationError || error instanceof MigrationDeployError
      ? error.message
      : "Không thể khởi động API. Kiểm tra cấu hình backend/.env và cổng API.",
  );
  process.exitCode = 1;
});
