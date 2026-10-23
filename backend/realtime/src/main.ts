import "reflect-metadata";
// Reuse the authenticated gateway and durable permission events from the API.
// Never run the previous anonymous channel/chat scaffold alongside real groups.
const { createApplication } = require("../../dist/app");
const {
  loadEnvironmentFile,
  readEnvironment,
} = require("../../dist/config/environment");
async function bootstrap() {
  loadEnvironmentFile();
  const app = await createApplication(readEnvironment());
  await app.listen(Number(process.env.REALTIME_PORT || 4001), "127.0.0.1");
}
void bootstrap();
