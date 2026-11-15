const { resolve } = require("node:path");
const {
  Stack,
  Duration,
  RemovalPolicy,
  CfnOutput,
  aws_s3: s3,
  aws_sqs: sqs,
  aws_iam: iam,
  aws_lambda: lambda,
  aws_lambda_event_sources: sources,
  aws_events: events,
  aws_events_targets: targets,
  aws_mediaconvert: mediaconvert,
  aws_secretsmanager: secrets,
  aws_cloudfront: cf,
  aws_cloudfront_origins: origins,
  aws_logs: logs,
  aws_ec2: ec2,
} = require("aws-cdk-lib");

class VideoStack extends Stack {
  constructor(scope, id, props) {
    const { config: c, lambdaCode, ...stackProps } = props;
    super(scope, id, stackProps);
    const name = c.namePrefix;
    const source = s3.Bucket.fromBucketName(this, "SourceBucket", c.sourceBucketName);
    const output = c.existingOutputBucket
      ? s3.Bucket.fromBucketName(this, "OutputBucket", c.outputBucketName)
      : new s3.Bucket(this, "OutputBucket", {
          bucketName: c.outputBucketName,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          removalPolicy: RemovalPolicy.RETAIN,
          autoDeleteObjects: false,
        });
    const getSecret = (kind) => {
      const arn = c[`${kind}SecretArn`];
      if (arn) return secrets.Secret.fromSecretCompleteArn(this, `${kind}Secret`, arn);
      // Empty containers only. Secret values never enter synthesis or CloudFormation.
      const resource = new secrets.CfnSecret(this, `${kind}SecretResource`, {
        name: c[`${kind}SecretName`],
        description: `Streamora T13 ${kind}`,
      });
      resource.applyRemovalPolicy(RemovalPolicy.RETAIN);
      return secrets.Secret.fromSecretCompleteArn(this, `${kind}Secret`, resource.ref);
    };
    const databaseSecret = getSecret("database");
    const signingSecret = getSecret("signing");

    const queues = {};
    for (const kind of ["dispatch", "completion"]) {
      const dlq = new sqs.Queue(this, `${kind}Dlq`, {
        queueName: `${name}-${kind}-dlq`,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        visibilityTimeout: Duration.seconds(1800),
        retentionPeriod: Duration.days(14),
        receiveMessageWaitTime: Duration.seconds(20),
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const queue = new sqs.Queue(this, `${kind}Queue`, {
        queueName: `${name}-${kind}`,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        visibilityTimeout: Duration.seconds(1800),
        retentionPeriod: Duration.days(4),
        receiveMessageWaitTime: Duration.seconds(20),
        deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
        removalPolicy: RemovalPolicy.RETAIN,
      });
      // Only its corresponding queue can redrive to this DLQ.
      dlq.node.defaultChild.redriveAllowPolicy = {
        redrivePermission: "byQueue",
        // Deterministic ARN avoids Queue -> DLQ -> Queue CloudFormation dependency cycles.
        sourceQueueArns: [this.formatArn({ service: "sqs", resource: `${name}-${kind}` })],
      };
      queues[kind] = queue;
      new CfnOutput(this, `${kind}DlqUrl`, { value: dlq.queueUrl });
    }

    const mediaRole = new iam.Role(this, "MediaConvertRole", {
      roleName: `${name}-mediaconvert`,
      assumedBy: new iam.ServicePrincipal("mediaconvert.amazonaws.com"),
    });
    mediaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [source.arnForObjects("*")],
      }),
    );
    mediaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [output.arnForObjects("*")],
      }),
    );
    mediaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket", "s3:GetBucketLocation"],
        resources: [source.bucketArn, output.bucketArn],
      }),
    );
    const mediaQueue = new mediaconvert.CfnQueue(this, "MediaConvertQueue", {
      name,
      pricingPlan: "ON_DEMAND",
      status: "ACTIVE",
      description: "Streamora T13 VOD",
    });

    let network = {};
    if (c.vpc) {
      const vpc = ec2.Vpc.fromVpcAttributes(this, "ExistingVpc", {
        vpcId: c.vpc.vpcId,
        availabilityZones: c.vpc.availabilityZones,
        privateSubnetIds: c.vpc.privateSubnetIds,
      });
      network = {
        vpc,
        vpcSubnets: { subnets: vpc.privateSubnets },
        securityGroups: c.vpc.securityGroupIds.map((sg, i) =>
          ec2.SecurityGroup.fromSecurityGroupId(this, `LambdaSg${i}`, sg, {
            mutable: false,
          }),
        ),
      };
    }
    const logGroup = new logs.LogGroup(this, "LambdaLogs", {
      logGroupName: `/aws/lambda/${name}-pipeline`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const worker = new lambda.Function(this, "Pipeline", {
      functionName: `${name}-pipeline`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      handler: "index.handler",
      code:
        lambdaCode || lambda.Code.fromAsset(resolve(__dirname, "../../../dist/video-lambda.zip")),
      memorySize: 512,
      timeout: Duration.seconds(300),
      ephemeralStorageSize: require("aws-cdk-lib").Size.mebibytes(512),
      logGroup,
      environment: {
        NODE_ENV: "production",
        FILES_S3_REGION: this.region,
        FILES_S3_BUCKET: source.bucketName,
        VIDEO_MODE: "aws",
        VIDEO_WORKER_ENABLED: "false",
        VIDEO_AWS_ACCOUNT_ID: this.account,
        VIDEO_MAX_QUALITY: String(c.maxQuality),
        VIDEO_OPTIONAL_QUALITIES: c.optionalQualities.join(","),
        VIDEO_OUTPUT_BUCKET: output.bucketName,
        VIDEO_MEDIACONVERT_ROLE_ARN: mediaRole.roleArn,
        VIDEO_MEDIACONVERT_QUEUE_ARN: mediaQueue.attrArn,
        VIDEO_DISPATCH_QUEUE_URL: queues.dispatch.queueUrl,
        VIDEO_COMPLETION_QUEUE_URL: queues.completion.queueUrl,
        VIDEO_DATABASE_SECRET_ARN: databaseSecret.secretArn,
      },
      ...network,
    });
    databaseSecret.grantRead(worker);
    queues.dispatch.grantSendMessages(worker);
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "mediaconvert:Probe",
          "mediaconvert:CreateJob",
          "mediaconvert:GetJob",
          "mediaconvert:ListJobs",
        ],
        resources: ["*"],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [mediaRole.roleArn],
        conditions: {
          StringEquals: { "iam:PassedToService": "mediaconvert.amazonaws.com" },
        },
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [source.arnForObjects("*"), output.arnForObjects("*")],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [source.bucketArn, output.bucketArn],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:DeleteObject"],
        resources: [output.arnForObjects("groups/*/videos/*")],
      }),
    );
    for (const queue of Object.values(queues)) {
      worker.addEventSource(
        new sources.SqsEventSource(queue, {
          batchSize: 1,
          maxBatchingWindow: Duration.seconds(0),
          reportBatchItemFailures: true,
          maxConcurrency: 2,
          enabled: c.pipelineEnabled,
        }),
      );
    }
    const completion = new events.Rule(this, "CompletionRule", {
      ruleName: `${name}-completion`,
      enabled: c.pipelineEnabled,
      eventPattern: {
        source: ["aws.mediaconvert"],
        account: [this.account],
        region: [this.region],
        detailType: ["MediaConvert Job State Change"],
        detail: {
          status: ["COMPLETE", "ERROR", "CANCELED", "STATUS_UPDATE"],
          userMetadata: { project: ["streamora"] },
        },
      },
    });
    completion.addTarget(new targets.SqsQueue(queues.completion));
    new events.Rule(this, "MaintenanceRule", {
      ruleName: `${name}-maintenance`,
      enabled: c.pipelineEnabled,
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [
        new targets.LambdaFunction(worker, {
          event: events.RuleTargetInput.fromObject({ action: "maintenance" }),
          maxEventAge: Duration.hours(1),
          retryAttempts: 2,
        }),
      ],
    });

    const publicKey = new cf.PublicKey(this, "ViewerPublicKey", {
      publicKeyName: name,
      encodedKey: c.publicKey,
    });
    const keyGroup = new cf.KeyGroup(this, "ViewerKeyGroup", {
      keyGroupName: name,
      items: [publicKey],
    });
    const cors = new cf.ResponseHeadersPolicy(this, "Cors", {
      responseHeadersPolicyName: `${name}-cors`,
      corsBehavior: {
        accessControlAllowCredentials: true,
        accessControlAllowOrigins: [c.webOrigin],
        accessControlAllowMethods: ["GET", "HEAD", "OPTIONS", "POST"],
        accessControlAllowHeaders: ["Authorization", "Content-Type", "Range"],
        accessControlExposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
        originOverride: true,
      },
    });
    const distribution = new cf.Distribution(this, "Distribution", {
      comment: `${name} private HLS`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(output),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cf.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
        trustedKeyGroups: [keyGroup],
        responseHeadersPolicy: cors,
      },
      additionalBehaviors: {
        "/api/v1/files/*/media-grant": {
          origin: new origins.HttpOrigin(c.apiOriginDomain, {
            protocolPolicy: cf.OriginProtocolPolicy.HTTPS_ONLY,
            originSslProtocols: [cf.OriginSslPolicy.TLS_V1_2],
          }),
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cf.AllowedMethods.ALLOW_ALL,
          cachePolicy: cf.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: cors,
        },
      },
    });
    const runtimePolicy = new iam.ManagedPolicy(this, "ApiRuntimePolicy", {
      description: "T13 API: read CloudFront signing secret only",
      statements: [
        new iam.PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [signingSecret.secretArn],
        }),
      ],
      roles: c.apiRuntimeRoleName
        ? [iam.Role.fromRoleName(this, "ApiRole", c.apiRuntimeRoleName)]
        : undefined,
      users: c.apiRuntimeUserName
        ? [iam.User.fromUserName(this, "ApiUser", c.apiRuntimeUserName)]
        : undefined,
    });
    if (c.existingOutputBucket) {
      // Keep objects in the dedicated T13 output bucket; update its access policy only.
      new s3.CfnBucketPolicy(this, "OutputAccess", {
        bucket: output.bucketName,
        policyDocument: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["s3:GetObject"],
              resources: [output.arnForObjects("*")],
              principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
              conditions: {
                StringEquals: {
                  "AWS:SourceArn": this.formatArn({
                    service: "cloudfront",
                    region: "",
                    resource: "distribution",
                    resourceName: distribution.distributionId,
                  }),
                },
              },
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.DENY,
              actions: ["s3:*"],
              resources: [output.bucketArn, output.arnForObjects("*")],
              principals: [new iam.AnyPrincipal()],
              conditions: { Bool: { "aws:SecureTransport": "false" } },
            }),
          ],
        }).toJSON(),
      });
    }
    for (const [key, value] of Object.entries({
      Account: this.account,
      Region: this.region,
      SourceBucket: source.bucketName,
      OutputBucket: output.bucketName,
      LambdaName: worker.functionName,
      DispatchQueueUrl: queues.dispatch.queueUrl,
      CompletionQueueUrl: queues.completion.queueUrl,
      DatabaseSecretArn: databaseSecret.secretArn,
      SigningSecretArn: signingSecret.secretArn,
      CloudFrontPublicKeyId: publicKey.publicKeyId,
      CloudFrontDistributionId: distribution.distributionId,
      MediaDomain: distribution.distributionDomainName,
      ApiRuntimePolicyArn: runtimePolicy.managedPolicyArn,
      WebOrigin: c.webOrigin,
      PipelineEnabled: String(c.pipelineEnabled),
    })) {
      const result = new CfnOutput(this, `${key}Output`, { value });
      result.overrideLogicalId(key);
    }
  }
}
module.exports = { VideoStack };
