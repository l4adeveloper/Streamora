const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const yaml = require("js-yaml");

const schema = new yaml.Schema([
  ...yaml.CORE_SCHEMA.tags,
  ...["Ref", "GetAtt", "Sub"].map((tag) =>
    yaml.defineScalarTag("!" + tag, {
      resolve: (value) => ({ [tag]: value }),
      identify: () => false,
    }),
  ),
]);
const template = yaml.load(
  readFileSync(
    join(__dirname, "../infra/aws/video/cloudformation-console.yaml"),
    "utf8",
  ),
  { schema },
);

test("console template needs no manual key, binds signing before serving media and has no dependency cycle", () => {
  assert.deepEqual(Object.keys(template.Parameters).sort(), [
    "ApiDomain",
    "RuntimeUserName",
    "SourceBucket",
    "WebOrigin",
  ]);
  assert.deepEqual(template.Resources.WorkerPolicy.Properties.Users, [
    { Ref: "RuntimeUserName" },
  ]);
  assert.equal(template.Resources.SigningSecret.DeletionPolicy, "Retain");
  assert.equal(template.Resources.SigningSecret.Properties.SecretString, "{}");
  assert.equal(template.Resources.Distribution.DependsOn, "SigningKeyBinding");
  assert.deepEqual(
    template.Resources.PublicKey.Properties.PublicKeyConfig.EncodedKey,
    { GetAtt: "SigningKeys.PublicKey" },
  );
  assert.deepEqual(template.Resources.SigningKeyBinding.Properties.KeyPairId, {
    Ref: "PublicKey",
  });
  assert.ok(
    !Object.values(template.Resources).some((r) =>
      /^AWS::(EC2|RDS|IVS|DynamoDB)::/.test(r.Type),
    ),
  );
  const secretSetup =
    template.Resources.SigningSetupRole.Properties.Policies[0].PolicyDocument
      .Statement[0];
  assert.deepEqual(secretSetup.Resource, { Ref: "SigningSecret" });
  assert.deepEqual(secretSetup.Action, [
    "secretsmanager:GetSecretValue",
    "secretsmanager:PutSecretValue",
  ]);
  assert.ok(
    template.Outputs.VideoEnvironment.Value.Sub.includes(
      "VIDEO_AWS_ACCOUNT_ID=${AWS::AccountId}",
    ),
  );
  assert.ok(
    !/PRIVATE KEY|AWS_SECRET_ACCESS_KEY|SecretString/.test(
      JSON.stringify(template.Outputs),
    ),
  );

  const dependencies = (value, refs = new Set()) => {
    if (!value || typeof value !== "object") return refs;
    if (value.Ref) refs.add(value.Ref);
    if (value.GetAtt) refs.add(value.GetAtt.split(".")[0]);
    if (value.Sub)
      for (const match of value.Sub.matchAll(/\$\{([\w:.-]+)\}/g))
        refs.add(match[1].split(".")[0]);
    for (const child of Object.values(value)) dependencies(child, refs);
    return refs;
  };
  for (const ref of dependencies(template))
    assert.ok(
      ref.startsWith("AWS::") ||
        ref in template.Resources ||
        ref in template.Parameters,
      ref,
    );
  const active = new Set(),
    complete = new Set();
  function visit(name) {
    if (complete.has(name)) return;
    assert.ok(!active.has(name), `CloudFormation dependency cycle at ${name}`);
    active.add(name);
    const resource = template.Resources[name];
    const refs = dependencies(resource);
    for (const explicit of [resource.DependsOn ?? []].flat())
      refs.add(explicit);
    for (const ref of refs) if (ref in template.Resources) visit(ref);
    active.delete(name);
    complete.add(name);
  }
  for (const name of Object.keys(template.Resources)) visit(name);
});

function fixture() {
  let secret = {};
  let failRead = false;
  const writes = [],
    reads = [],
    replies = [],
    logs = [];
  class GetSecretValueCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class PutSecretValueCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class SecretsManagerClient {
    async send(command) {
      if (command instanceof GetSecretValueCommand) {
        reads.push(command.input);
        if (failRead)
          throw new Error(
            "A confidential value must never appear in the response",
          );
        return { SecretString: JSON.stringify(secret) };
      }
      writes.push(command.input);
      secret = JSON.parse(command.input.SecretString);
      return {};
    }
  }
  const context = {
    exports: {},
    require(name) {
      if (name === "node:crypto") return crypto;
      assert.equal(name, "@aws-sdk/client-secrets-manager");
      return {
        SecretsManagerClient,
        GetSecretValueCommand,
        PutSecretValueCommand,
      };
    },
    console: { error: (...args) => logs.push(args) },
    AbortSignal,
    setTimeout,
    fetch: async (url, options) => {
      assert.equal(url, "https://response.example.test/signed-url");
      assert.equal(options.method, "PUT");
      replies.push(JSON.parse(options.body));
      return { ok: true };
    },
  };
  vm.runInNewContext(
    template.Resources.SigningSetup.Properties.Code.ZipFile,
    context,
  );
  const invoke = async (stage, requestType = "Create", extra = {}) => {
    await context.exports.handler({
      RequestType: requestType,
      RequestId: `${requestType}-${stage}`,
      StackId: "stack-test-id",
      LogicalResourceId:
        stage === "Generate" ? "SigningKeys" : "SigningKeyBinding",
      ResponseURL: "https://response.example.test/signed-url",
      ResourceProperties: {
        SecretArn: "test-secret-arn",
        Stage: stage,
        ...extra,
      },
    });
    return replies.at(-1);
  };
  return {
    invoke,
    writes,
    reads,
    replies,
    logs,
    get secret() {
      return secret;
    },
    failRead() {
      failRead = true;
    },
  };
}

test("console signing generates a valid key privately, reuses it on retry/update, and binds only the matching public key", async () => {
  const f = fixture();
  const generated = await f.invoke("Generate");
  assert.equal(generated.Status, "SUCCESS");
  assert.equal(f.writes.length, 1);
  assert.equal(f.secret.keyPairId, "PENDING_STACK_OUTPUT");
  assert.match(f.writes[0].ClientRequestToken, /^[a-f0-9]{64}$/);
  const privateKey = f.secret.privateKey;
  const signature = crypto.sign(
    "RSA-SHA1",
    Buffer.from("sample-policy"),
    privateKey,
  );
  assert.ok(
    crypto.verify(
      "RSA-SHA1",
      Buffer.from("sample-policy"),
      generated.Data.PublicKey,
      signature,
    ),
  );
  assert.equal(
    crypto.createPublicKey(generated.Data.PublicKey).asymmetricKeyDetails
      .modulusLength,
    2048,
  );
  const retry = await f.invoke("Generate");
  const update = await f.invoke("Generate", "Update");
  assert.equal(retry.Data.PublicKey, generated.Data.PublicKey);
  assert.equal(update.Data.PublicKey, generated.Data.PublicKey);
  assert.equal(retry.PhysicalResourceId, update.PhysicalResourceId);
  assert.equal(f.writes.length, 1);

  const binding = {
    KeyPairId: "K123EXAMPLE",
    PublicKey: generated.Data.PublicKey,
  };
  const bound = await f.invoke("Bind", "Create", binding);
  assert.equal(bound.Status, "SUCCESS");
  assert.equal(f.secret.keyPairId, binding.KeyPairId);
  assert.equal(f.secret.privateKey, privateKey);
  await f.invoke("Bind", "Update", binding);
  assert.equal(f.writes.length, 2);
  const mismatch = await f.invoke("Bind", "Update", {
    ...binding,
    PublicKey: "wrong-key",
  });
  assert.equal(mismatch.Status, "FAILED");
  assert.equal(f.writes.length, 2);
  assert.equal(JSON.stringify(f.replies).includes(privateKey), false);
  assert.equal(JSON.stringify(f.replies).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(f.logs).includes(privateKey), false);
});

test("console signing acknowledges failed setup and rollback/delete without leaking or deleting the private key", async () => {
  const f = fixture();
  f.failRead();
  const failed = await f.invoke("Generate");
  assert.equal(failed.Status, "FAILED");
  assert.equal(JSON.stringify(failed).includes("confidential"), false);
  assert.equal(f.writes.length, 0);
  const reads = f.reads.length;
  for (const stage of ["Generate", "Bind"]) {
    const deleted = await f.invoke(stage, "Delete");
    assert.equal(deleted.Status, "SUCCESS");
  }
  assert.equal(f.reads.length, reads);
  assert.equal(f.writes.length, 0);
});
