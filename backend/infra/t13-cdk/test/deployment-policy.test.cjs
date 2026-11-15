const { test } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../deployment-policy.json");

function matches(pattern, value) {
  return new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  ).test(value);
}
function allows(action, resource, context = {}) {
  return policy.Statement.some(
    (s) =>
      s.Effect === "Allow" &&
      [s.Action].flat().some((p) => matches(p, action)) &&
      [s.Resource].flat().some((p) => matches(p, resource)) &&
      Object.entries({ ...s.Condition?.StringEquals, ...s.Condition?.ArnEquals }).every(
        ([key, value]) => context[key] === value,
      ),
  );
}

test("deployment policy fixes ListStackResources for T13 and fits the managed-policy limit", () => {
  assert.ok(JSON.stringify(policy).length <= 6144);
  for (const stack of ["StreamoraT13", "CDKToolkit"]) {
    const arn = `arn:aws:cloudformation:ap-northeast-1:586481704097:stack/${stack}/example`;
    assert.ok(allows("cloudformation:ListStackResources", arn));
    assert.ok(allows("cloudformation:CreateStack", arn));
  }
  assert.equal(
    allows(
      "cloudformation:DeleteStack",
      "arn:aws:cloudformation:ap-northeast-1:586481704097:stack/Other/example",
    ),
    false,
  );
});

test("mapping cleanup permissions allow only the T13 function", () => {
  const mappingArn =
    "arn:aws:lambda:ap-northeast-1:586481704097:event-source-mapping:c6741112-ba29-4fcf-8f56-07753353f8dd";
  const context = {
    "lambda:FunctionArn":
      "arn:aws:lambda:ap-northeast-1:586481704097:function:streamora-video-pipeline",
  };
  assert.ok(allows("lambda:ListEventSourceMappings", "*"));
  assert.equal(allows("lambda:GetEventSourceMapping", "*"), false);
  assert.equal(allows("lambda:GetEventSourceMapping", mappingArn), false);
  for (const action of ["lambda:DeleteEventSourceMapping"]) {
    assert.ok(allows(action, mappingArn, context));
    assert.equal(
      allows(action, mappingArn, {
        "lambda:FunctionArn": "arn:aws:lambda:ap-northeast-1:586481704097:function:other",
      }),
      false,
    );
    assert.equal(allows(action, mappingArn), false);
  }
});

test("deployment policy preserves source/data restrictions and limits PassRole to CloudFormation", () => {
  assert.equal(allows("s3:DeleteBucket", "arn:aws:s3:::streamora-file-storage"), false);
  assert.equal(allows("s3:DeleteObject", "arn:aws:s3:::streamora-file-storage/video.mp4"), false);
  assert.ok(allows("s3:GetBucketLocation", "arn:aws:s3:::streamora-file-storage"));
  const secret =
    "arn:aws:secretsmanager:ap-northeast-1:586481704097:secret:streamora/video-database-AbCd12";
  assert.ok(allows("secretsmanager:PutSecretValue", secret));
  assert.equal(allows("secretsmanager:DeleteSecret", secret), false);
  const role =
    "arn:aws:iam::586481704097:role/cdk-hnb659fds-cfn-exec-role-586481704097-ap-northeast-1";
  assert.ok(
    allows("iam:PassRole", role, { "iam:PassedToService": "cloudformation.amazonaws.com" }),
  );
  assert.equal(
    allows("iam:PassRole", role, { "iam:PassedToService": "lambda.amazonaws.com" }),
    false,
  );
  assert.equal(allows("sts:AssumeRole", "arn:aws:iam::586481704097:role/OtherRole"), false);
});
