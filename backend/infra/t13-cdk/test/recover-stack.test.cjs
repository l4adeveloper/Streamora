const { test } = require("node:test");
const assert = require("node:assert/strict");
const { recoverStack } = require("../scripts/recover-stack.cjs");
const id = "arn:aws:cloudformation:ap-northeast-1:586481704097:stack/StreamoraT13/failed-id";

test("recovery deletes only the initial failed stack ID and waits before recreating resources", async () => {
  const calls = [],
    pauses = [];
  const states = ["ROLLBACK_COMPLETE", "DELETE_IN_PROGRESS", "DELETE_COMPLETE"];
  const aws = (args) => {
    calls.push(args);
    return args[1] === "describe-stacks"
      ? {
          Stacks: [{ StackId: id, StackStatus: states.shift(), EnableTerminationProtection: true }],
        }
      : {};
  };
  await recoverStack(
    "StreamoraT13",
    aws,
    async (ms) => pauses.push(ms),
    () => {},
  );
  assert.deepEqual(
    calls.filter((a) => a[1] !== "describe-stacks"),
    [
      [
        "cloudformation",
        "update-termination-protection",
        "--no-enable-termination-protection",
        "--stack-name",
        id,
      ],
      ["cloudformation", "delete-stack", "--stack-name", id],
    ],
  );
  assert.deepEqual(pauses, [5000]);
});

test("recovery keeps successful stacks and completed update rollbacks", async () => {
  for (const state of ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]) {
    const calls = [];
    await recoverStack("StreamoraT13", (args) => {
      calls.push(args);
      return { Stacks: [{ StackId: id, StackStatus: state }] };
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], "describe-stacks");
  }
});

test("recovery stops setup while CloudFormation is still running or rolling back", async () => {
  for (const state of [
    "CREATE_IN_PROGRESS",
    "ROLLBACK_IN_PROGRESS",
    "UPDATE_IN_PROGRESS",
    "UPDATE_ROLLBACK_IN_PROGRESS",
  ]) {
    const calls = [];
    await assert.rejects(
      recoverStack("StreamoraT13", (args) => {
        calls.push(args);
        return { Stacks: [{ StackId: id, StackStatus: state }] };
      }),
      /đợi hoàn tất/,
    );
    assert.equal(calls.length, 1);
  }
});

test("recovery handles absent stacks but does not ignore AccessDenied", async () => {
  await recoverStack("StreamoraT13", () => {
    throw new Error("(ValidationError) Stack does not exist");
  });
  await assert.rejects(
    recoverStack("StreamoraT13", () => {
      throw new Error("(AccessDenied) denied");
    }),
    /AccessDenied/,
  );
});

test("recovery resumes an existing deletion without deleting twice", async () => {
  const states = ["DELETE_IN_PROGRESS", "DELETE_COMPLETE"];
  await recoverStack("StreamoraT13", (args) => {
    assert.equal(args[1], "describe-stacks");
    return { Stacks: [{ StackId: id, StackStatus: states.shift() }] };
  });
});

test("recovery stops if stack deletion fails", async () => {
  const states = ["ROLLBACK_COMPLETE", "DELETE_FAILED"];
  await assert.rejects(
    recoverStack(
      "StreamoraT13",
      (args) =>
        args[1] === "describe-stacks"
          ? { Stacks: [{ StackId: id, StackStatus: states.shift() }] }
          : {},
      async () => {},
      () => {},
    ),
    /DELETE_FAILED/,
  );
});
