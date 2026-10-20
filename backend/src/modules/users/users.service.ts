import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { Prisma } from "../../generated/prisma/client";
import { ApiError } from "../../common/api-error";
import { PUBLIC_USER_SELECT } from "./user.types";

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(email: string, fullName: string, passwordHash: string) {
    try {
      return await this.prisma.user.create({
        data: { email, fullName, passwordHash, globalRole: "USER" },
        select: PUBLIC_USER_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ApiError(409, "EMAIL_EXISTS", "Email này đã được sử dụng.");
      }
      throw error;
    }
  }

  findForLogin(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: { ...PUBLIC_USER_SELECT, passwordHash: true },
    });
  }

  updateFullName(userId: string, fullName: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { fullName },
      select: PUBLIC_USER_SELECT,
    });
  }
}
