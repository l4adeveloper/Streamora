const { loadEnvironmentFile, readEnvironment } = require("../dist/config/environment");
const { PrismaService } = require("../dist/database/prisma.service");
const { PasswordService } = require("../dist/modules/auth/password.service");

async function seed() {
  loadEnvironmentFile();
  const config = readEnvironment();
  const prisma = new PrismaService(config.databaseUrl);
  const passwordService = new PasswordService();

  await prisma.onModuleInit();
  await passwordService.onModuleInit();

  try {
    const adminPasswordHash = await passwordService.hash("AdminPassword123!");
    const userPasswordHash = await passwordService.hash("UserPassword123!");

    // 1. Tạo hoặc cập nhật tài khoản ADMIN
    const admin = await prisma.user.upsert({
      where: { email: "admin@streamora.io" },
      update: {
        passwordHash: adminPasswordHash,
        fullName: "Quản trị viên Streamora",
        globalRole: "ADMIN",
        disabledAt: null,
      },
      create: {
        email: "admin@streamora.io",
        passwordHash: adminPasswordHash,
        fullName: "Quản trị viên Streamora",
        globalRole: "ADMIN",
      },
    });

    // 2. Tạo hoặc cập nhật tài khoản USER thông thường
    const user = await prisma.user.upsert({
      where: { email: "user@streamora.io" },
      update: {
        passwordHash: userPasswordHash,
        fullName: "Nguyễn Văn A",
        globalRole: "USER",
        disabledAt: null,
      },
      create: {
        email: "user@streamora.io",
        passwordHash: userPasswordHash,
        fullName: "Nguyễn Văn A",
        globalRole: "USER",
      },
    });

    // 3. Tạo một nhóm mẫu do User làm chủ sở hữu (nếu chưa có)
    const existingGroup = await prisma.group.findFirst({
      where: { ownerId: user.id, deletedAt: null },
    });

    if (!existingGroup) {
      await prisma.$transaction(async (tx) => {
        const group = await tx.group.create({
          data: {
            name: "Điện toán đám mây — K69 UET",
            description: "Nhóm học tập, bài giảng trực tuyến và thảo luận đồ án môn Điện toán đám mây.",
            ownerId: user.id,
          },
        });
        await tx.groupMember.create({
          data: {
            userId: user.id,
            groupId: group.id,
            role: "OWNER",
          },
        });
      });
    }

    console.log("SEEDED_SUCCESSFULLY");
    return { admin, user };
  } finally {
    await prisma.onModuleDestroy();
  }
}

if (require.main === module) {
  seed().catch((err) => {
    console.error("Lỗi khi tạo tài khoản:", err);
    process.exit(1);
  });
}

module.exports = { seed };
