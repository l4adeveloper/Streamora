const assert = require("node:assert/strict");
const { test } = require("node:test");
require("reflect-metadata");
const {
  PrismaService,
  DatabaseConnectionError,
} = require("../dist/database/prisma.service");

const PRIVATE = "postgresql://private-user:private-password@private-host/app";

test("database startup reports raw and Prisma adapter TLS errors without leaking driver details", () => {
  for (const failure of [
    { code: "DEPTH_ZERO_SELF_SIGNED_CERT", message: PRIVATE },
    { code: "SELF_SIGNED_CERT_IN_CHAIN", message: PRIVATE },
    {
      code: "P2010",
      message: PRIVATE,
      meta: {
        driverAdapterError: {
          cause: { kind: "TlsConnectionError", reason: PRIVATE },
        },
      },
    },
  ]) {
    const error = new DatabaseConnectionError(failure);
    assert.match(error.message, /SSL.*PostgreSQL/);
    assert.match(error.message, /sslrootcert/);
    assert.ok(!error.stack.includes(PRIVATE));
    assert.ok(!JSON.stringify(error).includes(PRIVATE));
    assert.equal(error.cause, undefined);
  }
});

test("other connection errors retain a safe generic database message", () => {
  for (const failure of [null, undefined, PRIVATE, { message: PRIVATE }]) {
    const error = new DatabaseConnectionError(failure);
    assert.match(error.message, /Không thể kết nối PostgreSQL/);
    assert.ok(!error.stack.includes(PRIVATE));
  }
});

test("failed database round trip closes the pool and preserves the safe TLS diagnosis", async () => {
  const prisma = new PrismaService(
    "postgresql://unused:unused@127.0.0.1:1/unused",
  );
  let disconnected = false;
  prisma.$connect = async () => {};
  prisma.$queryRaw = async () => {
    throw { code: "DEPTH_ZERO_SELF_SIGNED_CERT", message: PRIVATE };
  };
  prisma.$disconnect = async () => {
    disconnected = true;
  };
  await assert.rejects(prisma.onModuleInit(), (error) => {
    assert.ok(error instanceof DatabaseConnectionError);
    assert.match(error.message, /sslrootcert/);
    assert.ok(!error.message.includes(PRIVATE));
    return true;
  });
  assert.equal(disconnected, true);
});
