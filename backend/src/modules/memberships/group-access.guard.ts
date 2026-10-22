import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { isUUID } from "class-validator";
import type { GroupPermission } from "@streamora/contracts";
import type { AuthenticatedRequest } from "../../common/auth/auth.types";
import { AccessTokenGuard } from "../../common/auth/access-token.guard";
import { ApiError } from "../../common/api-error";
import { GroupAccessService } from "./group-access.service";

type AccessRule = {
  permission?: GroupPermission;
  source: "group" | "room";
  param: string;
};
const GROUP_ACCESS = Symbol("GROUP_ACCESS");
export const RequireGroupAccess = (
  permission?: GroupPermission,
  source: AccessRule["source"] = "group",
  param = "groupId",
) =>
  applyDecorators(
    SetMetadata(GROUP_ACCESS, { permission, source, param }),
    UseGuards(AccessTokenGuard, GroupAccessGuard),
  );

@Injectable()
export class GroupAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: GroupAccessService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const rule = this.reflector.getAllAndOverride<AccessRule>(GROUP_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const id = request.params[rule.param];
    if (typeof id !== "string" || !isUUID(id))
      throw new ApiError(400, "VALIDATION_ERROR", "ID không hợp lệ.");
    if (!request.auth)
      throw new ApiError(401, "UNAUTHENTICATED", "Bạn cần đăng nhập.");
    if (rule.source === "room")
      await this.access.requireRoom(request.auth.user.id, id, rule.permission);
    else await this.access.require(request.auth.user.id, id, rule.permission);
    return true;
  }
}
