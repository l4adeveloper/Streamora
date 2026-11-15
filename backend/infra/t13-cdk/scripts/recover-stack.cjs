// An initial ROLLBACK_COMPLETE stack cannot be updated; remove that failed shell only.
async function recoverStack(
  stackName,
  aws,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  log = console.log,
) {
  function describe(id) {
    try {
      return aws(["cloudformation", "describe-stacks", "--stack-name", id]).Stacks[0];
    } catch (error) {
      if (/\(ValidationError\).*does not exist/.test(error.message)) return null;
      throw error;
    }
  }
  const stack = describe(stackName);
  if (stack?.StackStatus.endsWith("_IN_PROGRESS") && stack.StackStatus !== "DELETE_IN_PROGRESS")
    throw new Error(
      `Stack ${stackName} đang ${stack.StackStatus}; đợi hoàn tất rồi chạy setup lại.`,
    );
  if (!stack || !["ROLLBACK_COMPLETE", "DELETE_IN_PROGRESS"].includes(stack.StackStatus)) return;
  const id = stack.StackId;
  if (!id) throw new Error("Không xác định được StackId; chưa xóa stack.");
  if (stack.StackStatus === "ROLLBACK_COMPLETE") {
    log(`Dọn stack ${stackName} tạo thất bại; giữ các tài nguyên có Retain.`);
    if (stack.EnableTerminationProtection)
      aws([
        "cloudformation",
        "update-termination-protection",
        "--no-enable-termination-protection",
        "--stack-name",
        id,
      ]);
    aws(["cloudformation", "delete-stack", "--stack-name", id]);
  }
  for (let i = 0; i < 120; i++) {
    const current = describe(id);
    if (!current || current.StackStatus === "DELETE_COMPLETE") return;
    if (current.StackStatus !== "DELETE_IN_PROGRESS")
      throw new Error(
        `Dọn stack chưa xong: ${current.StackStatus}. Kiểm tra CloudFormation trước khi chạy lại.`,
      );
    await sleep(5000);
  }
  throw new Error("Stack đang được xóa; đợi hoàn tất rồi chạy setup lại.");
}
module.exports = { recoverStack };
