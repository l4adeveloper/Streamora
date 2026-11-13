// Explicit setup command; never creates cloud resources during API startup.
const {
  DynamoDBClient,
  CreateTableCommand,
  UpdateTimeToLiveCommand,
  DescribeTableCommand,
} = require("@aws-sdk/client-dynamodb");
const { loadEnvFile } = require("node:process");
try {
  loadEnvFile(require("node:path").resolve(__dirname, "../.env"));
} catch {}
const endpoint =
  process.env.CHAT_DYNAMODB_ENDPOINT ||
  (process.env.NODE_ENV === "production" ? undefined : "http://127.0.0.1:8000");
const client = new DynamoDBClient({
  region: process.env.CHAT_DYNAMODB_REGION || "ap-southeast-1",
  endpoint,
  ...(endpoint && !process.env.AWS_ACCESS_KEY_ID
    ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
    : {}),
});
const TableName = process.env.CHAT_DYNAMODB_TABLE || "streamora-chat";
async function main() {
  if (!endpoint && !process.argv.includes("--cloud"))
    throw new Error("Cloud setup requires --cloud explicitly.");
  try {
    await client.send(
      new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
      }),
    );
  } catch (error) {
    if (error.name !== "ResourceInUseException") throw error;
  }
  for (let i = 0; i < 60; i++) {
    const result = await client.send(new DescribeTableCommand({ TableName }));
    if (result.Table.TableStatus === "ACTIVE") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName,
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      }),
    );
  } catch (error) {
    if (error.name !== "ValidationException") throw error;
  }
  console.log("Chat table ready.");
  client.destroy();
}
main().catch((error) => {
  console.error("Chat table setup failed:", error.name);
  process.exitCode = 1;
  client.destroy();
});
