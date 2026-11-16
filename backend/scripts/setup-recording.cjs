// Run once with the backend's existing AWS credentials; never prints credentials.
const {
  IVSRealTimeClient,
  ListStorageConfigurationsCommand,
  CreateStorageConfigurationCommand,
  ListEncoderConfigurationsCommand,
  CreateEncoderConfigurationCommand,
} = require("@aws-sdk/client-ivs-realtime");
const {
  loadEnvironmentFile,
  readEnvironment,
} = require("../dist/config/environment");

async function main() {
  loadEnvironmentFile();
  const config = readEnvironment();
  if (
    !config.ivs?.enabled ||
    config.files?.driver !== "s3" ||
    !config.files.bucket ||
    config.files.region !== config.ivs.region
  )
    throw new Error(
      "Đặt IVS_ENABLED=true, FILES_STORAGE_DRIVER=s3 và dùng bucket cùng region với AWS_REGION.",
    );
  const client = new IVSRealTimeClient({
    region: config.ivs.region,
    credentials: config.ivs.credentials,
  });
  async function find(Command, field, predicate) {
    let nextToken;
    do {
      const page = await client.send(
        new Command({ nextToken, maxResults: 100 }),
      );
      const found = page[field]?.find(predicate);
      if (found) return found;
      nextToken = page.nextToken;
    } while (nextToken);
  }
  try {
    const name = "streamora-recording-1080p-v1";
    let storage = await find(
      ListStorageConfigurationsCommand,
      "storageConfigurations",
      (item) => item.s3?.bucketName === config.files.bucket,
    );
    if (!storage)
      storage = (
        await client.send(
          new CreateStorageConfigurationCommand({
            name: "streamora-recordings",
            s3: { bucketName: config.files.bucket },
          }),
        )
      ).storageConfiguration;
    let encoder = await find(
      ListEncoderConfigurationsCommand,
      "encoderConfigurations",
      (item) => item.name === name,
    );
    if (!encoder)
      encoder = (
        await client.send(
          new CreateEncoderConfigurationCommand({
            name,
            video: {
              width: 1920,
              height: 1080,
              framerate: 30,
              bitrate: 4000000,
            },
          }),
        )
      ).encoderConfiguration;
    console.log("Thêm hai dòng sau vào backend/.env rồi khởi động lại API:");
    console.log("IVS_RECORDING_STORAGE_ARN=" + storage.arn);
    console.log("IVS_RECORDING_ENCODER_ARN=" + encoder.arn);
  } finally {
    client.destroy();
  }
}
main().catch((error) => {
  console.error(
    "Không thiết lập được ghi hình: " +
      (error.name === "Error" ? error.message : error.name),
  );
  process.exitCode = 1;
});
