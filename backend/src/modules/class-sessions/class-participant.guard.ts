import {
  Injectable,
  CanActivate,
  ExecutionContext,
  SetMetadata,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ClassSessionParticipantContext } from "@streamora/contracts";
import { AccessTokenGuard } from "../../common/auth/access-token.guard";
import type { AuthenticatedRequest } from "../../common/auth/auth.types";
import { ApiError } from "../../common/api-error";
import { ClassParticipantService } from "./class-participant.service";

interface ParticipationRule {
  manage: boolean;
  sessionParam: string;
  participationParam: string;
}
interface ParticipantRequest extends AuthenticatedRequest {
  classParticipant?: ClassSessionParticipantContext;
}
const CLASS_PARTICIPATION = Symbol("CLASS_PARTICIPATION");

export const RequireClassParticipation = (
  options: Partial<ParticipationRule> = {},
) =>
  applyDecorators(
    SetMetadata(CLASS_PARTICIPATION, {
      manage: false,
      sessionParam: "sessionId",
      participationParam: "participationId",
      ...options,
    }),
    UseGuards(AccessTokenGuard, ClassParticipantGuard),
  );

@Injectable()
export class ClassParticipantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly participants: ClassParticipantService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ParticipantRequest>();
    if (!request.auth)
      throw new ApiError(401, "UNAUTHENTICATED", "Bạn cần đăng nhập.");
    const rule = this.reflector.getAllAndOverride<ParticipationRule>(
      CLASS_PARTICIPATION,
      [context.getHandler(), context.getClass()],
    );
    if (!rule)
      throw new ApiError(
        403,
        "ADMISSION_REQUIRED",
        "Chưa thiết lập kiểm tra lượt tham gia.",
      );
    request.classParticipant = await this.participants.require(
      { userId: request.auth.user.id, authSessionId: request.auth.sessionId },
      request.params[rule.sessionParam] as string,
      request.params[rule.participationParam] as string,
      rule.manage,
    );
    return true;
  }
}
export const CurrentClassParticipant = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const participant = context
      .switchToHttp()
      .getRequest<ParticipantRequest>().classParticipant;
    if (!participant)
      throw new ApiError(
        403,
        "ADMISSION_REQUIRED",
        "Chưa xác minh lượt tham gia.",
      );
    return participant;
  },
);
