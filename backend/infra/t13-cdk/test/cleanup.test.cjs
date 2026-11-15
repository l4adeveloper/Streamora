const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cleanup } = require("../scripts/cleanup.cjs");
const config = require("../t13.config.example.json");
const functionArn = "arn:aws:lambda:ap-northeast-1:586481704097:function:streamora-video-pipeline";

function fixture({ managed = false, active = false, denied = false } = {}) {
  const calls = [];
  const writes = [];
  let polls = 0;
  const aws = (args) => {
    calls.push(args);
    const [service, action] = args;
    if (/^(delete|disable|update|remove|detach)-/.test(action)) {
      writes.push(args);
      return {};
    }
    if (service === "cloudformation") {
      if (denied) throw new Error("(AccessDenied) cloudformation");
      if (managed) return { StackResources: [{ StackName: "ExistingStack" }] };
      throw new Error("(ValidationError) Stack for resource does not exist");
    }
    if (action === "get-queue")
      return {
        Queue: {
          Arn: "arn:aws:mediaconvert:ap-northeast-1:586481704097:queues/streamora-video",
          ProgressingJobsCount: active ? 1 : 0,
        },
      };
    if (action === "list-event-source-mappings") return { EventSourceMappings: [] };
    if (action === "describe-rule" || action === "get-function" || action === "get-role") return {};
    if (action === "list-targets-by-rule") return { Targets: [{ Id: "target" }] };
    if (action === "get-queue-url")
      return { QueueUrl: `https://sqs.ap-northeast-1.amazonaws.com/586481704097/${args[3]}` };
    if (action === "list-distributions")
      return {
        DistributionList: {
          Items: [
            { Id: "OLD", Comment: "streamora-video-tokyo" },
            { Id: "OTHER", Comment: "another app" },
          ],
        },
      };
    if (action === "get-distribution-config")
      return { ETag: "etag", DistributionConfig: { Enabled: polls === 0 } };
    if (action === "get-distribution")
      return { Distribution: { Status: ++polls === 1 ? "InProgress" : "Deployed" } };
    if (action === "list-key-groups")
      return {
        KeyGroupList: {
          Items: [{ KeyGroup: { Id: "GROUP", KeyGroupConfig: { Name: "streamora-video" } } }],
        },
      };
    if (action === "list-public-keys")
      return {
        PublicKeyList: {
          Items: [
            { Id: "KEY", Name: "streamora-video" },
            { Id: "OTHERKEY", Name: "other" },
          ],
        },
      };
    if (action === "list-origin-access-controls")
      return { OriginAccessControlList: { Items: [{ Id: "OAC", Name: "streamora-video-oac" }] } };
    if (action === "list-response-headers-policies")
      return {
        ResponseHeadersPolicyList: {
          Items: [
            {
              ResponseHeadersPolicy: {
                Id: "CORS",
                ResponseHeadersPolicyConfig: { Name: "streamora-video-cors" },
              },
            },
          ],
        },
      };
    if (service === "cloudfront" && action.startsWith("get-")) return { ETag: "etag" };
    if (action === "list-instance-profiles-for-role") return { InstanceProfiles: [] };
    if (action === "list-attached-role-policies")
      return { AttachedPolicies: [{ PolicyArn: "arn:policy" }] };
    if (action === "list-role-policies") return { PolicyNames: ["inline"] };
    if (action === "describe-log-groups")
      return { logGroups: [{ logGroupName: "/aws/lambda/streamora-video-pipeline" }] };
    throw new Error(`Unexpected AWS call: ${args.join(" ")}`);
  };
  return { aws, calls, writes };
}

test("cleanup deletes only exact manual T13 services in dependency order and waits before recreating SQS", async (t) => {
  const f = fixture();
  let now = 100000;
  const pauses = [];
  t.mock.method(Date, "now", () => now);
  await cleanup(
    config,
    f.aws,
    async (ms) => {
      pauses.push(ms);
      now += ms;
    },
    () => {},
  );
  const actions = f.writes.map((a) => a[1]);
  assert.equal(f.writes.filter((a) => a[1] === "delete-queue" && a[0] === "sqs").length, 4);
  assert.ok(actions.indexOf("remove-targets") < actions.indexOf("delete-rule"));
  assert.ok(actions.indexOf("update-distribution") < actions.indexOf("delete-distribution"));
  assert.ok(actions.indexOf("delete-distribution") < actions.indexOf("delete-key-group"));
  assert.ok(actions.indexOf("delete-key-group") < actions.indexOf("delete-public-key"));
  assert.ok(!f.writes.some((a) => a.some((value) => value === "OTHER" || value === "OTHERKEY")));
  assert.ok(!f.calls.some((a) => ["s3", "s3api", "secretsmanager"].includes(a[0])));
  assert.ok(!actions.includes("delete-stack"));
  assert.ok(pauses.reduce((a, b) => a + b, 0) >= 65000);
});

test("cleanup keeps all CloudFormation resources, including another stack", async () => {
  const f = fixture({ managed: true });
  await cleanup(
    config,
    f.aws,
    async () => assert.fail("No wait needed"),
    () => {},
  );
  assert.deepEqual(f.writes, []);
});

test("cleanup stops on denied ownership checks rather than treating them as missing resources", async () => {
  const f = fixture({ denied: true });
  await assert.rejects(
    cleanup(
      config,
      f.aws,
      async () => {},
      () => {},
    ),
    /AccessDenied/,
  );
  assert.deepEqual(f.writes, []);
});

test("cleanup refuses active MediaConvert jobs before deleting services", async () => {
  const f = fixture({ active: true });
  await assert.rejects(
    cleanup(
      config,
      f.aws,
      async () => {},
      () => {},
    ),
    /còn job/,
  );
  assert.deepEqual(f.writes, []);
});

test("cleanup removes retained service remnants after rollback without touching S3 or secrets", async (t) => {
  const f = fixture();
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const aws = (args) =>
    args[0] === "cloudformation"
      ? {
          StackResources: [
            { ResourceStatus: "DELETE_SKIPPED" },
            { ResourceStatus: "DELETE_COMPLETE" },
          ],
        }
      : f.aws(args);
  await cleanup(
    config,
    aws,
    async (ms) => {
      now += ms;
    },
    () => {},
  );
  assert.ok(f.writes.some((a) => a[0] === "sqs" && a[1] === "delete-queue"));
  assert.ok(f.writes.some((a) => a[0] === "logs" && a[1] === "delete-log-group"));
  assert.ok(!f.calls.some((a) => ["s3", "s3api", "secretsmanager"].includes(a[0])));
});

test("cleanup deletes exact orphan SQS mappings and waits until gone before deleting the function", async (t) => {
  const f = fixture();
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const polls = new Map();
  const aws = (args, missing) => {
    if (args[1] === "list-event-source-mappings") {
      const queue = args[3];
      assert.equal(args[2], "--event-source-arn"); // Works even if the old function no longer exists.
      const count = (polls.get(queue) || 0) + 1;
      polls.set(queue, count);
      return {
        EventSourceMappings: [
          ...(count < 3
            ? [
                {
                  UUID: queue.endsWith("dispatch") ? "dispatch-id" : "completion-id",
                  FunctionArn: functionArn,
                  EventSourceArn: queue,
                  State: count === 1 ? "Enabled" : "Deleting",
                },
              ]
            : []),
          { UUID: "other-function", FunctionArn: functionArn + "-other", EventSourceArn: queue },
          { UUID: "other-queue", FunctionArn: functionArn, EventSourceArn: queue + "-other" },
        ],
      };
    }
    if (args[1] === "get-event-source-mapping")
      assert.fail("Polling must not require GetEventSourceMapping permission");
    return f.aws(args, missing);
  };
  await cleanup(
    config,
    aws,
    async (ms) => {
      now += ms;
    },
    () => {},
  );
  assert.deepEqual(
    f.writes.filter((a) => a[1] === "delete-event-source-mapping").map((a) => a[3]),
    ["dispatch-id", "completion-id"],
  );
  assert.deepEqual([...polls.values()], [3, 3]);
  const actions = f.writes.map((a) => a[1]);
  assert.ok(
    actions.lastIndexOf("delete-event-source-mapping") < actions.indexOf("delete-function"),
  );
});

test("cleanup keeps SQS mappings owned by an active CloudFormation stack", async () => {
  const f = fixture({ managed: true });
  const aws = (args, missing) =>
    args[1] === "list-event-source-mappings"
      ? {
          EventSourceMappings: [
            {
              UUID: "managed-mapping",
              FunctionArn: functionArn,
              EventSourceArn: args[3],
              State: "Enabled",
            },
          ],
        }
      : f.aws(args, missing);
  await cleanup(
    config,
    aws,
    async () => assert.fail("No wait needed"),
    () => {},
  );
  assert.deepEqual(f.writes, []);
});

test("cleanup waits for an already-deleting orphan mapping even when the function is absent", async () => {
  const f = fixture({ managed: true });
  let polls = 0;
  const pauses = [];
  const aws = (args, missing) => {
    if (args[1] === "list-event-source-mappings") {
      if (args[3].endsWith("dispatch")) polls++;
      return {
        EventSourceMappings:
          args[3].endsWith("dispatch") && polls < 3
            ? [
                {
                  UUID: "orphan",
                  FunctionArn: functionArn,
                  EventSourceArn: args[3],
                  State: "Deleting",
                },
              ]
            : [],
      };
    }
    if (args[0] === "cloudformation" && args[3] === "orphan")
      throw new Error("(ValidationError) Stack does not exist");
    if (args[1] === "get-event-source-mapping")
      assert.fail("Polling must not require GetEventSourceMapping permission");
    if (args[1] === "get-function") return null;
    return f.aws(args, missing);
  };
  await cleanup(
    config,
    aws,
    async (ms) => pauses.push(ms),
    () => {},
  );
  assert.equal(polls, 3);
  assert.deepEqual(pauses, [5000]);
  assert.deepEqual(f.writes, []);
});

test("cleanup stops when deletion of an orphan mapping has not completed", async () => {
  const f = fixture({ managed: true });
  const aws = (args, missing) => {
    if (args[1] === "list-event-source-mappings")
      return {
        EventSourceMappings: [
          { UUID: "orphan", FunctionArn: functionArn, EventSourceArn: args[3], State: "Deleting" },
        ],
      };
    if (args[0] === "cloudformation" && args[3] === "orphan")
      throw new Error("(ValidationError) Stack does not exist");
    return f.aws(args, missing);
  };
  await assert.rejects(
    cleanup(
      config,
      aws,
      async () => {},
      () => {},
    ),
    /chưa xóa xong/,
  );
  assert.deepEqual(f.writes, []);
});

test("cleanup is a no-op when manual services are already absent", async () => {
  const aws = ([service, action]) => {
    if (
      ["get-queue", "get-queue-url", "get-function", "get-role", "describe-rule"].includes(action)
    )
      return null;
    if (action.startsWith("list-") || action === "describe-log-groups") return {};
    assert.fail(`Unexpected call: ${service} ${action}`);
  };
  await cleanup(
    config,
    aws,
    async () => assert.fail("No wait needed"),
    () => {},
  );
});
