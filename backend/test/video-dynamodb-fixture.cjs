const { randomUUID } = require("node:crypto");
const {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const {
  DynamoVideoJobs,
} = require("../dist/modules/video-processing/dynamodb-video-jobs");
const { locationId } = require("../dist/modules/files/storage-target");

async function createVideoDynamoFixture() {
  const endpoint =
    process.env.VIDEO_TEST_DYNAMODB_ENDPOINT || "http://127.0.0.1:8000";
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("Tests only allow loopback DynamoDB, never AWS.");
  const admin = new DynamoDBClient({
    endpoint,
    region: "ap-northeast-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 },
  });
  const tableName = "streamora_video_test_" + randomUUID().replaceAll("-", "");
  const video = {
    mode: "aws",
    workerEnabled: false,
    tableName,
    region: "ap-northeast-1",
    accountId: "123456789012",
    outputBucket: "video-output-test",
    maxQuality: 1080,
    optionalQualities: [],
    roleArn: "arn:aws:iam::123456789012:role/video",
    queueArn: "arn:aws:mediaconvert:ap-northeast-1:123456789012:queues/video",
  };
  const target = {
    driver: "s3",
    bucket: "video-source-test",
    region: video.region,
  };
  const client = DynamoDBDocumentClient.from(admin, {
    marshallOptions: { removeUndefinedValues: true },
  });
  let created = false;
  try {
    await admin.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          { AttributeName: "work", AttributeType: "S" },
          { AttributeName: "dueAt", AttributeType: "N" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "work-due",
            KeySchema: [
              { AttributeName: "work", KeyType: "HASH" },
              { AttributeName: "dueAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      }),
    );
    created = true;
    const store = new DynamoVideoJobs(video, target.bucket, client);
    return {
      store,
      client,
      video,
      target,
      source: {
        kind: "FILE",
        key: "groups/g/source.mp4",
        storageLocationId: locationId(target),
      },
      cleanup: async () => {
        try {
          if (created && /^streamora_video_test_[a-f0-9]{32}$/.test(tableName))
            await admin.send(new DeleteTableCommand({ TableName: tableName }));
        } finally {
          admin.destroy();
        }
      },
    };
  } catch (error) {
    admin.destroy();
    throw error;
  }
}
function videoJob(fileId = randomUUID(), changes = {}) {
  const now = new Date();
  return {
    id: randomUUID(),
    fileId,
    mode: "TRANSCODE",
    encoder: "mediaconvert",
    state: "QUEUED",
    policy: null,
    providerJobId: null,
    attemptNo: 0,
    leaseOwner: null,
    leaseUntil: null,
    nextRunAt: now,
    lastDispatchAt: null,
    deliveryCount: 0,
    errorCount: 0,
    progressPercent: null,
    errorCode: null,
    output: null,
    retryKeyHash: null,
    retryActor: null,
    submittedAt: null,
    createdAt: now,
    updatedAt: now,
    ...changes,
  };
}
module.exports = { createVideoDynamoFixture, videoJob };
