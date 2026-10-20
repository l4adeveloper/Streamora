import { DynamicModule, Global, Module } from "@nestjs/common";
import { DATABASE_URL, PrismaService } from "./prisma.service";

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(databaseUrl: string): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DATABASE_URL, useValue: databaseUrl },
        PrismaService,
      ],
      exports: [PrismaService],
    };
  }
}
