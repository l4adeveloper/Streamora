const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const { App, aws_lambda: lambda } = require("aws-cdk-lib");
const { Template, Match } = require("aws-cdk-lib/assertions");
const { validateConfig } = require("../lib/config.cjs");
const { VideoStack } = require("../lib/video-stack.cjs");
const example = require("../t13.config.example.json");
const publicKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
}).publicKey;

function synth(changes = {}) {
  const config = { ...example, ...changes, publicKey };
  validateConfig({ ...example, ...changes });
  const app = new App();
  const stack = new VideoStack(app, config.stackName, {
    env: { account: config.account, region: config.region },
    config,
    lambdaCode: lambda.Code.fromInline(
      "exports.handler = async () => ({ok:true});",
    ),
  });
  // Full synthesis also detects CloudFormation dependency cycles.
  app.synth();
  return Template.fromStack(stack);
}

test("pipeline is staged off, uses packaged-handler settings and bounded SQS retries", () => {
  const t = synth();
  t.resourceCountIs("AWS::Lambda::Function", 1);
  t.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs22.x",
    Handler: "index.handler",
    Timeout: 300,
    MemorySize: 512,
    Environment: {
      Variables: Match.objectLike({
        VIDEO_MODE: "aws",
        VIDEO_WORKER_ENABLED: "false",
        VIDEO_MAX_QUALITY: "1080",
      }),
    },
  });
  const fn = Object.values(t.findResources("AWS::Lambda::Function"))[0];
  assert.equal(fn.Properties.ReservedConcurrentExecutions, undefined);
  t.resourceCountIs("AWS::SQS::Queue", 4);
  t.resourceCountIs("AWS::Lambda::EventSourceMapping", 2);
  for (const mapping of Object.values(
    t.findResources("AWS::Lambda::EventSourceMapping"),
  )) {
    assert.equal(mapping.Properties.Enabled, false);
    assert.equal(mapping.Properties.BatchSize, 1);
    assert.deepEqual(mapping.Properties.FunctionResponseTypes, [
      "ReportBatchItemFailures",
    ]);
    assert.equal(mapping.Properties.ScalingConfig.MaximumConcurrency, 2);
  }
  for (const queue of Object.values(t.findResources("AWS::SQS::Queue"))) {
    assert.equal(queue.Properties.VisibilityTimeout, 1800);
    assert.equal(queue.Properties.SqsManagedSseEnabled, true);
    assert.equal(queue.DeletionPolicy, "Retain");
    if (queue.Properties.RedrivePolicy)
      assert.equal(queue.Properties.RedrivePolicy.maxReceiveCount, 5);
    else assert.equal(queue.Properties.MessageRetentionPeriod, 1209600);
  }
  t.hasResourceProperties("AWS::Events::Rule", {
    ScheduleExpression: "rate(1 minute)",
    State: "DISABLED",
    Targets: [
      Match.objectLike({
        Input: '{"action":"maintenance"}',
        RetryPolicy: {
          MaximumEventAgeInSeconds: 3600,
          MaximumRetryAttempts: 2,
        },
      }),
    ],
  });
  t.hasResourceProperties("AWS::Events::Rule", {
    State: "DISABLED",
    EventPattern: Match.objectLike({
      source: ["aws.mediaconvert"],
      account: [example.account],
      region: [example.region],
      detail: {
        status: ["COMPLETE", "ERROR", "CANCELED", "STATUS_UPDATE"],
        userMetadata: { project: ["streamora"] },
      },
    }),
  });
});

test("CloudFront restricts HLS while forwarding uncached authenticated grants over TLS", () => {
  const t = synth();
  t.resourceCountIs("AWS::S3::Bucket", 1); // Existing source bucket is imported.
  t.hasResourceProperties("AWS::S3::Bucket", {
    BucketName: example.outputBucketName,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
  });
  const bucket = Object.values(t.findResources("AWS::S3::Bucket"))[0];
  assert.equal(bucket.DeletionPolicy, "Retain");
  assert.equal(bucket.Properties.LifecycleConfiguration, undefined);
  t.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  t.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: Match.objectLike({
      DefaultCacheBehavior: Match.objectLike({
        ViewerProtocolPolicy: "https-only",
        TrustedKeyGroups: Match.anyValue(),
      }),
      CacheBehaviors: [
        Match.objectLike({
          PathPattern: "/api/v1/files/*/media-grant",
          CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
          ViewerProtocolPolicy: "https-only",
        }),
      ],
    }),
  });
  const distribution = Object.values(
    t.findResources("AWS::CloudFront::Distribution"),
  )[0].Properties.DistributionConfig;
  assert.equal(distribution.CacheBehaviors[0].TrustedKeyGroups, undefined);
  assert.equal(
    distribution.Origins.find((o) => o.CustomOriginConfig)?.CustomOriginConfig
      .OriginProtocolPolicy,
    "https-only",
  );
  t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
    ResponseHeadersPolicyConfig: Match.objectLike({
      CorsConfig: Match.objectLike({
        AccessControlAllowCredentials: true,
        AccessControlAllowOrigins: { Items: [example.webOrigin] },
      }),
    }),
  });
  t.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: "cloudfront.amazonaws.com" },
          Condition: Match.objectLike({ StringEquals: Match.anyValue() }),
        }),
      ]),
    },
  });
});

test("secrets stay empty and only the API can read the signing secret", () => {
  const t = synth();
  t.resourceCountIs("AWS::SecretsManager::Secret", 2);
  for (const secret of Object.values(
    t.findResources("AWS::SecretsManager::Secret"),
  )) {
    assert.equal(secret.Properties.SecretString, undefined);
    assert.equal(secret.Properties.GenerateSecretString, undefined);
    assert.equal(secret.DeletionPolicy, "Retain");
  }
  const lambdaEnv = Object.values(t.findResources("AWS::Lambda::Function"))[0]
    .Properties.Environment.Variables;
  assert.equal(lambdaEnv.VIDEO_SIGNING_SECRET_ARN, undefined);
  assert.equal(lambdaEnv.DATABASE_URL, undefined);
  const policies = Object.values(t.findResources("AWS::IAM::Policy")).flatMap(
    (p) => p.Properties.PolicyDocument.Statement,
  );
  const readSecrets = policies.filter((s) =>
    [s.Action].flat().includes("secretsmanager:GetSecretValue"),
  );
  assert.equal(readSecrets.length, 1);
  assert.ok(JSON.stringify(readSecrets).includes("databaseSecretResource"));
  assert.ok(!JSON.stringify(readSecrets).includes("signingSecretResource"));
  const passRole = policies.find((s) => s.Action === "iam:PassRole");
  assert.deepEqual(passRole.Condition, {
    StringEquals: { "iam:PassedToService": "mediaconvert.amazonaws.com" },
  });
});

test("activation, imported secrets, API role and an existing VPC synthesize without new network resources", () => {
  const t = synth({
    pipelineEnabled: true,
    apiRuntimeRoleName: "streamora-api",
    databaseSecretArn: `arn:aws:secretsmanager:${example.region}:${example.account}:secret:existing-db-AbCd12`,
    signingSecretArn: `arn:aws:secretsmanager:${example.region}:${example.account}:secret:existing-signing-AbCd12`,
    vpc: {
      vpcId: "vpc-0123456789abcdef0",
      availabilityZones: ["ap-northeast-1a"],
      privateSubnetIds: ["subnet-0123456789abcdef0"],
      securityGroupIds: ["sg-0123456789abcdef0"],
    },
  });
  t.resourceCountIs("AWS::SecretsManager::Secret", 0);
  t.resourceCountIs("AWS::EC2::VPC", 0);
  t.resourceCountIs("AWS::EC2::NatGateway", 0);
  t.hasResourceProperties("AWS::Lambda::Function", {
    VpcConfig: Match.objectLike({
      SubnetIds: ["subnet-0123456789abcdef0"],
      SecurityGroupIds: ["sg-0123456789abcdef0"],
    }),
  });
  t.hasResourceProperties("AWS::IAM::ManagedPolicy", {
    Roles: ["streamora-api"],
  });
  for (const mapping of Object.values(
    t.findResources("AWS::Lambda::EventSourceMapping"),
  ))
    assert.equal(mapping.Properties.Enabled, true);
  for (const rule of Object.values(t.findResources("AWS::Events::Rule")))
    assert.equal(rule.Properties.State, "ENABLED");
});

test("config rejects typos, implicit activation and unsafe origins or mixed regions", () => {
  for (const changes of [
    { pipelineEnabled: "false" },
    { pipelineEnabled: undefined },
    { vpc: false },
    { webOrigin: "https://example.com/" },
    { webOrigin: "http://example.com" },
    { apiOriginDomain: "https://example.com" },
    { databaseUrl: "must-never-appear" },
    { maxQuality: 4320 },
    { outputBucketName: example.sourceBucketName },
    { apiRuntimeRoleName: "a", apiRuntimeUserName: "b" },
    {
      databaseSecretArn: `arn:aws:secretsmanager:us-east-1:${example.account}:secret:db-AbCd12`,
    },
  ])
    assert.throws(() => validateConfig({ ...example, ...changes }));
});

test("existing output bucket keeps its objects and gets a distribution-scoped private policy", () => {
  const t = synth({ existingOutputBucket: true });
  t.resourceCountIs("AWS::S3::Bucket", 0);
  t.resourceCountIs("AWS::S3::BucketPolicy", 1);
  const policy = Object.values(t.findResources("AWS::S3::BucketPolicy"))[0].Properties;
  assert.equal(policy.Bucket, example.outputBucketName);
  const allow = policy.PolicyDocument.Statement.find((s) => s.Effect === "Allow");
  assert.equal(allow.Principal.Service, "cloudfront.amazonaws.com");
  assert.ok(JSON.stringify(allow.Condition).includes(":distribution/"));
  assert.ok(!JSON.stringify(policy).includes(example.sourceBucketName));
});
