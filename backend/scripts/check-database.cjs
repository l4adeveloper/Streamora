const {
  loadEnvironmentFile,
  readEnvironment,
} = require("../dist/config/environment");
const { PrismaService } = require("../dist/database/prisma.service");

async function main() {
  loadEnvironmentFile();
  const config = readEnvironment();
  const prisma = new PrismaService(config.databaseUrl);
  try {
    await prisma.onModuleInit();
    // Only schema availability is reported; no user/session data or credentials.
    await prisma.user.count();
    await prisma.authSession.count();
    await prisma.authRefreshToken.count();
    console.log(
      "PostgreSQL: kết nối thành công; users/auth_sessions/auth_refresh_tokens sẵn sàng.",
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch(() => {
  console.error(
    "Database chưa sẵn sàng. Kiểm tra Docker, backend/.env và chạy npm run db:migrate.",
  );
  process.exitCode = 1;
});
