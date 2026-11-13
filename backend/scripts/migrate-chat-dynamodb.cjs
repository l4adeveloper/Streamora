require("reflect-metadata");
const { loadEnvironmentFile } = require("../dist/config/environment");
loadEnvironmentFile();
const { PrismaClient } = require("../dist/generated/prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { ChatStore } = require("../dist/modules/memberships/chat-store");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
async function main() {
  const write = process.argv.includes("--write");
  const chat = new ChatStore();
  let cursor,
    count = 0;
  try {
    while (true) {
      const rows = await db.groupChatMessage.findMany({
        where: { deletedAt: null },
        orderBy: { id: "asc" },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) break;
      for (const row of rows) {
        if (write && !(await chat.get(row.groupId, row.id)))
          await chat.save({
            ...row,
            createdAt: row.createdAt.toISOString(),
            editedAt: row.editedAt?.toISOString() ?? null,
            clientId: null,
            deletedAt: undefined,
          });
        count++;
      }
      cursor = rows.at(-1).id;
    }
    console.log(
      `${write ? "Copied/verified" : "Dry run: eligible"} ${count} messages. PostgreSQL remains unchanged.`,
    );
  } finally {
    await db.$disconnect();
    chat.client.destroy();
  }
}
main().catch((error) => {
  console.error("Migration failed:", error.name);
  process.exitCode = 1;
});
