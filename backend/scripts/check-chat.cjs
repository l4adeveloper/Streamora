// Read-only diagnostic. Never print credentials or write chat data.
const { resolve } = require("node:path");
const { existsSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");

async function main() {
  try {
    process.loadEnvFile(resolve(__dirname, "../.env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const region = process.env.CHAT_DYNAMODB_REGION || "ap-southeast-1";
  const table = process.env.CHAT_DYNAMODB_TABLE || "streamora-chat";
  const endpoint =
    process.env.CHAT_DYNAMODB_ENDPOINT ||
    (process.env.NODE_ENV === "production"
      ? undefined
      : "http://127.0.0.1:8000");
  const usesLocalCredentials =
    process.env.NODE_ENV !== "production" && !process.env.AWS_ACCESS_KEY_ID;
  console.log(
    JSON.stringify(
      {
        nodeEnv: process.env.NODE_ENV || "development (default)",
        region,
        table,
        endpoint: endpoint
          ? new URL(endpoint).origin
          : "AWS regional endpoint (automatic)",
        hasAccessKey: Boolean(process.env.AWS_ACCESS_KEY_ID),
        hasSecretKey: Boolean(process.env.AWS_SECRET_ACCESS_KEY),
        hasSessionToken: Boolean(process.env.AWS_SESSION_TOKEN),
        usesLocalCredentials,
        buildHasChatStore: existsSync(
          resolve(__dirname, "../dist/modules/memberships/chat-store.js"),
        ),
      },
      null,
      2,
    ),
  );
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region,
      endpoint,
      maxAttempts: 1,
      ...(usesLocalCredentials
        ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
        : {}),
    }),
  );
  try {
    await client.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": "GROUP#__streamora_connection_check__",
          ":prefix": "M#",
        },
        ConsistentRead: true,
        Limit: 1,
      }),
      { abortSignal: AbortSignal.timeout(12000) },
    );
    console.log(
      "CHAT_READ_OK: Table, key schema and Query permission are working. No data was written.",
    );
    if (process.argv.includes("--check-write-permission")) {
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: table,
                  Item: { pk: `DIAGNOSTIC#${randomUUID()}`, sk: "NO_WRITE" },
                  // Deliberately impossible: this probe must never insert or replace an item.
                  ConditionExpression:
                    "attribute_exists(pk) AND attribute_not_exists(pk)",
                },
              },
            ],
          }),
          { abortSignal: AbortSignal.timeout(12000) },
        );
        throw new Error("UnexpectedDiagnosticResult");
      } catch (error) {
        if (
          error.name !== "TransactionCanceledException" ||
          error.CancellationReasons?.[0]?.Code !== "ConditionalCheckFailed"
        )
          throw error;
        console.log(
          "CHAT_WRITE_PERMISSION_OK: Transactional Put passed authorization and was cancelled by its deliberately false condition. No data was written.",
        );
      }
    } else {
      console.log(
        "To test transactional Put permission without writing data, add --check-write-permission.",
      );
    }
    console.log(
      "The deployed WebSocket connection and per-item IAM conditions are not covered by this probe.",
    );
  } catch (error) {
    const hints = {
      ResourceNotFoundException:
        "Check the table name, AWS account, region, and Active status.",
      AccessDeniedException:
        "Grant the denied operation (Query or transactional PutItem) on this exact table ARN to the identity actually used by the backend.",
      UnrecognizedClientException:
        "Check credentials and any expired or stale session token.",
      InvalidSignatureException:
        "Check that access key and secret belong to the same key pair, and check server time.",
      CredentialsProviderError:
        "No usable AWS credentials were found. Check the EC2 role or environment credentials.",
      ValidationException:
        "Check that partition key is pk (String) and sort key is sk (String).",
      AbortError:
        "Connection timed out. Check endpoint, DNS, and outbound HTTPS access.",
      TimeoutError:
        "Connection timed out. Check endpoint, DNS, and outbound HTTPS access.",
      ECONNREFUSED:
        "The endpoint refused the connection. For AWS chat, remove any localhost:8000 endpoint from both backend/.env and PM2 environment.",
      ENOTFOUND:
        "DNS lookup failed. Check the endpoint hostname and server DNS.",
      ETIMEDOUT:
        "Connection timed out. Check endpoint and outbound HTTPS access.",
    };
    const networkCode = error.code ?? error.cause?.code;
    const name =
      typeof networkCode === "string" && /^[A-Z0-9_]{2,48}$/.test(networkCode)
        ? networkCode
        : typeof error.name === "string" && /^[A-Za-z0-9_]+$/.test(error.name)
          ? error.name
          : "UnknownError";
    console.error(`CHAT_CHECK_FAILED: ${name}`);
    console.error(
      hints[name] ||
        "Check network access and the endpoint; compare these settings with the running backend environment.",
    );
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
}

main().catch(() => {
  console.error(
    "CHAT_CHECK_CONFIG_FAILED: Check backend/.env syntax and CHAT_DYNAMODB_ENDPOINT format.",
  );
  process.exitCode = 1;
});
