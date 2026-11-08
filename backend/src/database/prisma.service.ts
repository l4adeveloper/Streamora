import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { safeErrorCode } from "../common/safe-error-code";

export const DATABASE_URL = Symbol("DATABASE_URL");

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(@Inject(DATABASE_URL) databaseUrl: string) {
    super({
      adapter: new PrismaPg(
        {
          connectionString: databaseUrl,
          max: 10,
          connectionTimeoutMillis: 5000,
          // Bound both server work and stalled network reads; a pool-acquire timeout alone is insufficient.
          statement_timeout: 12000,
          query_timeout: 15000,
          idle_in_transaction_session_timeout: 30000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10000,
          idleTimeoutMillis: 30000,
          maxLifetimeSeconds: 300,
        },
        {
          onPoolError: (error) =>
            console.warn(
              JSON.stringify({
                event: "database_pool_error",
                code: safeErrorCode(error),
              }),
            ),
          onConnectionError: (error) =>
            console.warn(
              JSON.stringify({
                event: "database_connection_error",
                code: safeErrorCode(error),
              }),
            ),
        },
      ),
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
