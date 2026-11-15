import { Inject, Injectable, OnModuleInit, Optional } from "@nestjs/common";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import { ApiError } from "../../common/api-error";

export {
  configuredStorage,
  locationId,
  type StorageTarget,
} from "./storage-target";
import {
  configuredStorage,
  locationId,
  type StorageTarget,
} from "./storage-target";

@Injectable()
export class StorageLocationsService implements OnModuleInit {
  readonly target: StorageTarget;
  readonly id: string;
  private registered?: Promise<string>;
  private readonly cache = new Map<string, StorageTarget>();
  constructor(
    @Inject(APP_CONFIG) config: Pick<EnvironmentConfig, "files">,
    @Optional() private readonly db?: PrismaService,
  ) {
    this.target = configuredStorage(config);
    this.id = locationId(this.target);
    this.cache.set(this.id, this.target);
  }
  current() {
    if (!this.registered)
      this.registered = this.register().catch((error) => {
        this.registered = undefined;
        throw error;
      });
    return this.registered;
  }
  private async register() {
    if (this.db)
      await this.db.storageLocation.upsert({
        where: { id: this.id },
        create: {
          id: this.id,
          driver: this.target.driver,
          config: this.target,
        },
        update: {},
      });
    return this.id;
  }
  async onModuleInit() {
    if (!this.db || (this.target.driver === "s3" && !this.target.bucket))
      return;
    const legacyOtherDriver = await this.db.uploadSession.count({
      where: { storageLocationId: null, driver: { not: this.target.driver } },
    });
    if (legacyOtherDriver)
      throw new Error(
        "Hãy chạy bản nâng cấp với cấu hình lưu trữ cũ trước khi đổi driver, để gắn đúng vị trí các phiên upload hiện có.",
      );
    await this.current();
    // Run this upgrade with the previous storage config before switching providers.
    // NULL is legacy only; existing bindings are never reassigned on later starts.
    await this.db.libraryFile.updateMany({
      where: { storageLocationId: null },
      data: { storageLocationId: this.id },
    });
    await this.db.uploadSession.updateMany({
      where: { storageLocationId: null },
      data: { storageLocationId: this.id },
    });
    await this.db
      .$executeRaw`UPDATE file_object_deletions d SET storage_location_id = f.storage_location_id FROM files f WHERE d.file_id = f.id AND d.storage_location_id IS NULL`;
  }
  async resolve(id?: string | null): Promise<StorageTarget> {
    if (!id || id === this.id) return this.target;
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new ApiError(
        404,
        "STORAGE_LOCATION_NOT_FOUND",
        "Không tìm thấy vị trí lưu trữ.",
      );
    const cached = this.cache.get(id);
    if (cached) return cached;
    const row = await this.db?.storageLocation.findUnique({ where: { id } });
    if (!row)
      throw new ApiError(
        404,
        "STORAGE_LOCATION_NOT_FOUND",
        "Không tìm thấy vị trí lưu trữ.",
      );
    const target = row.config as StorageTarget;
    if (locationId(target) !== id || !["local", "s3"].includes(target.driver))
      throw new ApiError(
        503,
        "STORAGE_UNAVAILABLE",
        "Cấu hình lưu trữ không hợp lệ.",
      );
    this.cache.set(id, target);
    return target;
  }
}
