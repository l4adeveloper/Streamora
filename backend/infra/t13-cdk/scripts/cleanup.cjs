// Only exact T13 names, never S3/secrets or resources owned by CloudFormation.
async function cleanup(
  c,
  aws,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  log = console.log,
) {
  const name = c.namePrefix;
  const missing = [
    "ResourceNotFoundException",
    "ResourceNotFound",
    "NotFoundException",
    "NoSuchEntity",
    "QueueDoesNotExist",
    "AWS.SimpleQueueService.NonExistentQueue",
  ];
  function manual(id) {
    let result;
    try {
      result = aws(["cloudformation", "describe-stack-resources", "--physical-resource-id", id]);
    } catch (error) {
      if (!/\(ValidationError\).*does not exist/.test(error.message)) throw error;
      return true;
    }
    const detached = result.StackResources?.every((r) =>
      ["DELETE_COMPLETE", "DELETE_SKIPPED"].includes(r.ResourceStatus),
    );
    if (result.StackResources?.length && !detached) {
      log(`Giữ tài nguyên thuộc CloudFormation: ${id}`);
      return false;
    }
    return true;
  }
  function remove(args) {
    log(`Dọn: ${args[0]} ${args[1]} ${args[3]}`);
    aws(args);
  }

  const mediaQueue = aws(["mediaconvert", "get-queue", "--name", name], missing);
  const manualMediaQueue = mediaQueue && manual(mediaQueue.Queue.Arn) && manual(name);
  if (
    manualMediaQueue &&
    (mediaQueue.Queue.ProgressingJobsCount || mediaQueue.Queue.SubmittedJobsCount)
  )
    throw new Error("MediaConvert còn job đang chạy/chờ. Đợi xử lý xong rồi setup lại.");

  for (const suffix of ["maintenance", "completion"]) {
    const rule = `${name}-${suffix}`;
    if (!aws(["events", "describe-rule", "--name", rule], missing) || !manual(rule)) continue;
    aws(["events", "disable-rule", "--name", rule]);
    const ids = (aws(["events", "list-targets-by-rule", "--rule", rule]).Targets || []).map(
      (t) => t.Id,
    );
    if (
      ids.length &&
      aws(["events", "remove-targets", "--rule", rule, "--ids", ...ids]).FailedEntryCount
    )
      throw new Error(`Không gỡ được target: ${rule}`);
    remove(["events", "delete-rule", "--name", rule]);
  }
  const functionName = `${name}-pipeline`;
  const functionArn = `arn:aws:lambda:${c.region}:${c.account}:function:${functionName}`;
  for (const suffix of ["dispatch", "completion"]) {
    const queueArn = `arn:aws:sqs:${c.region}:${c.account}:${name}-${suffix}`;
    // Query by queue so orphan mappings are found even after the function was deleted.
    const mappings =
      aws(["lambda", "list-event-source-mappings", "--event-source-arn", queueArn])
        .EventSourceMappings || [];
    for (const mapping of mappings) {
      if (
        mapping.FunctionArn !== functionArn ||
        mapping.EventSourceArn !== queueArn ||
        !manual(mapping.UUID)
      )
        continue;
      if (mapping.State !== "Deleting") {
        log(`Dọn SQS trigger: ${mapping.UUID}`);
        aws(["lambda", "delete-event-source-mapping", "--uuid", mapping.UUID], missing);
      }
      let removed = false;
      for (let i = 0; i < 120; i++) {
        const remaining =
          aws(["lambda", "list-event-source-mappings", "--event-source-arn", queueArn])
            .EventSourceMappings || [];
        if (!remaining.some((item) => item.UUID === mapping.UUID)) {
          removed = true;
          break;
        }
        await sleep(5000);
      }
      if (!removed)
        throw new Error(`SQS trigger ${mapping.UUID} chưa xóa xong; chạy setup lại sau.`);
    }
  }
  if (
    aws(["lambda", "get-function", "--function-name", functionName], missing) &&
    manual(functionName)
  )
    remove(["lambda", "delete-function", "--function-name", functionName]);

  let queueDeletedAt = 0;
  for (const suffix of ["dispatch", "completion", "dispatch-dlq", "completion-dlq"]) {
    const queue = aws(["sqs", "get-queue-url", "--queue-name", `${name}-${suffix}`], missing);
    if (queue && manual(queue.QueueUrl)) {
      remove(["sqs", "delete-queue", "--queue-url", queue.QueueUrl]);
      queueDeletedAt = Date.now();
    }
  }
  if (manualMediaQueue) remove(["mediaconvert", "delete-queue", "--name", name]);

  const comments = [`${name} private HLS`];
  if (name === "streamora-video") comments.push("streamora-video-tokyo");
  for (const d of aws(["cloudfront", "list-distributions"]).DistributionList?.Items || []) {
    if (!comments.includes(d.Comment) || !manual(d.Id)) continue;
    let value = aws(["cloudfront", "get-distribution-config", "--id", d.Id]);
    if (value.DistributionConfig.Enabled) {
      value.DistributionConfig.Enabled = false;
      aws([
        "cloudfront",
        "update-distribution",
        "--id",
        d.Id,
        "--if-match",
        value.ETag,
        "--distribution-config",
        JSON.stringify(value.DistributionConfig),
      ]);
    }
    log(`Đợi CloudFront ${d.Id} tắt trước khi xóa...`);
    let deployed = false;
    for (let i = 0; i < 120; i++) {
      if (
        aws(["cloudfront", "get-distribution", "--id", d.Id]).Distribution.Status === "Deployed"
      ) {
        deployed = true;
        break;
      }
      await sleep(15000);
    }
    if (!deployed) throw new Error(`CloudFront ${d.Id} chưa tắt xong. Chạy setup lại sau.`);
    value = aws(["cloudfront", "get-distribution-config", "--id", d.Id]);
    remove(["cloudfront", "delete-distribution", "--id", d.Id, "--if-match", value.ETag]);
  }
  // Delete dependants first: distribution -> key group -> public key/OAC/policy.
  const cfResources = [
    [
      "key-group",
      "key-groups",
      "KeyGroupList",
      (i) => [i.KeyGroup.Id, i.KeyGroup.KeyGroupConfig.Name],
      name,
    ],
    ["public-key", "public-keys", "PublicKeyList", (i) => [i.Id, i.Name], name],
    [
      "origin-access-control",
      "origin-access-controls",
      "OriginAccessControlList",
      (i) => [i.Id, i.Name],
      `${name}-oac`,
    ],
    [
      "response-headers-policy",
      "response-headers-policies",
      "ResponseHeadersPolicyList",
      (i) => [i.ResponseHeadersPolicy.Id, i.ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name],
      `${name}-cors`,
    ],
  ];
  for (const [type, plural, list, fields, expected] of cfResources) {
    const args = ["cloudfront", `list-${plural}`];
    if (type === "response-headers-policy") args.push("--type", "custom");
    for (const item of aws(args)[list]?.Items || []) {
      const [id, resourceName] = fields(item);
      if (resourceName !== expected || !manual(id)) continue;
      const { ETag } = aws(["cloudfront", `get-${type}`, "--id", id]);
      remove(["cloudfront", `delete-${type}`, "--id", id, "--if-match", ETag]);
    }
  }
  const roles = [`${name}-lambda`, `${name}-mediaconvert`];
  if (name === "streamora-video") roles.push("streamora-mediaconvert");
  for (const role of roles) {
    if (!aws(["iam", "get-role", "--role-name", role], missing) || !manual(role)) continue;
    if (
      aws(["iam", "list-instance-profiles-for-role", "--role-name", role]).InstanceProfiles?.length
    )
      throw new Error(`Role ${role} đang gắn EC2; dừng để không xóa nhầm.`);
    for (const p of aws(["iam", "list-attached-role-policies", "--role-name", role])
      .AttachedPolicies || [])
      aws(["iam", "detach-role-policy", "--role-name", role, "--policy-arn", p.PolicyArn]);
    for (const p of aws(["iam", "list-role-policies", "--role-name", role]).PolicyNames || [])
      aws(["iam", "delete-role-policy", "--role-name", role, "--policy-name", p]);
    remove(["iam", "delete-role", "--role-name", role]);
  }
  const group = `/aws/lambda/${functionName}`;
  const groups =
    aws(["logs", "describe-log-groups", "--log-group-name-prefix", group]).logGroups || [];
  if (groups.some((g) => g.logGroupName === group) && manual(group))
    remove(["logs", "delete-log-group", "--log-group-name", group]);
  if (queueDeletedAt && Date.now() - queueDeletedAt < 65000) {
    log("Đợi SQS cho phép tạo lại queue cùng tên...");
    while (Date.now() - queueDeletedAt < 65000)
      await sleep(Math.min(5000, 65000 - (Date.now() - queueDeletedAt)));
  }
}
module.exports = { cleanup };
