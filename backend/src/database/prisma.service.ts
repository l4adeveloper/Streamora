import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

export const DATABASE_URL = Symbol("DATABASE_URL");

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(@Inject(DATABASE_URL) databaseUrl: string) {
    super({
      adapter: new PrismaPg({
        connectionString: databaseUrl,
        max: 10,
        connectionTimeoutMillis: 5000,
      }),
      errorFormat: "minimal",
      log: [],
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      // A real round trip verifies credentials, rather than only constructing a pool.
      await this.$queryRaw`SELECT 1`;
    } catch {
      await this.$disconnect();
      throw new Error(
        "Không thể kết nối PostgreSQL. Kiểm tra DATABASE_URL trong backend/.env và kết nối mạng tới server.",
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
