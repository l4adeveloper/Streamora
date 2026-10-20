import { Injectable, OnModuleInit } from "@nestjs/common";
import * as argon2 from "argon2";
import { randomBytes } from "node:crypto";

@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash!: string;

  async onModuleInit() {
    this.dummyHash = await this.hash(randomBytes(32).toString("base64url"));
  }

  hash(password: string) {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32,
      salt: randomBytes(16),
    });
  }

  async verify(hash: string | undefined, password: string) {
    try {
      const matches = await argon2.verify(hash ?? this.dummyHash, password);
      return hash !== undefined && matches;
    } catch {
      return false;
    }
  }
}
