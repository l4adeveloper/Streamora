import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type {
  RegisterResponse,
  LoginResponse,
  RefreshResponse,
  LogoutResponse,
} from "@streamora/contracts";
import { ApiError } from "../../common/api-error";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { AuthOriginGuard, AuthRateLimitGuard } from "./auth.guards";
import { LoginDto, RegisterDto } from "./auth.dto";
import { AuthService } from "./auth.service";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  ApiAuthOrigin,
  ApiErrors,
  ApiSuccess,
} from "../../documentation/api-decorators";
import {
  AccessTokenResponseDto,
  LoginResponseDto,
  UserResponseDto,
} from "../../documentation/api-models";

@Controller("auth")
@ApiTags("Auth")
@ApiAuthOrigin()
@UseGuards(AuthOriginGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}

  private setRefreshCookie(response: Response, token: string, expiresAt: Date) {
    const { name, ...options } = this.config.auth.cookie;
    response.cookie(name, token, {
      ...options,
      maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
    });
  }

  private clearRefreshCookie(response: Response) {
    const { name, ...options } = this.config.auth.cookie;
    response.clearCookie(name, options);
  }

  private cookie(request: Request): unknown {
    return (request.cookies as Record<string, unknown> | undefined)?.[
      this.config.auth.cookie.name
    ];
  }

  private requireEmptyBody(body: unknown) {
    if (
      body !== undefined &&
      (body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length > 0)
    ) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Yêu cầu này không nhận dữ liệu trong body.",
      );
    }
  }

  @Post("register")
  @ApiOperation({
    summary: "T01-01 — Tạo tài khoản",
    description:
      "Không tự đăng nhập và không cấp refresh cookie. User mới có globalRole=USER.",
    security: [],
  })
  @ApiSuccess(201, UserResponseDto)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [403, "ORIGIN_NOT_ALLOWED"],
    [409, "EMAIL_EXISTS"],
    [429, "RATE_LIMITED"],
  )
  @UseGuards(AuthRateLimitGuard)
  async register(@Body() dto: RegisterDto): Promise<RegisterResponse> {
    return { user: await this.auth.register(dto) };
  }

  @Post("login")
  @ApiOperation({
    summary: "T01-02 — Đăng nhập",
    description:
      "Kiểm tra mật khẩu bằng Argon2id; cấp access JWT và refresh cookie HttpOnly. Không trả refresh token trong JSON.",
    security: [],
  })
  @ApiSuccess(200, LoginResponseDto, true)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "INVALID_CREDENTIALS"],
    [403, "USER_DISABLED", "ORIGIN_NOT_ALLOWED"],
    [429, "RATE_LIMITED"],
  )
  @HttpCode(200)
  @UseGuards(AuthRateLimitGuard)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const grant = await this.auth.login(dto);
    this.setRefreshCookie(response, grant.refreshToken, grant.refreshExpiresAt);
    return {
      accessToken: grant.accessToken,
      expiresIn: grant.expiresIn,
      user: grant.user,
    };
  }

  @Post("refresh")
  @ApiOperation({
    summary: "T01-03 — Xoay refresh token",
    description:
      "Không gửi body. Xoay cookie; gửi lại token vừa dùng trong 10 giây được phục hồi cookie hiện tại, không tạo nhánh token mới và không gia hạn cửa sổ phục hồi. Reuse ngoài cửa sổ thu hồi cả family. Không kéo dài hạn tuyệt đối của phiên. Lỗi 401/403 từ dịch vụ phiên xóa cookie; Origin sai không thay đổi cookie.",
    security: [{ refreshCookie: [] }],
  })
  @ApiSuccess(200, AccessTokenResponseDto, true)
  @ApiErrors(
    [400, "VALIDATION_ERROR"],
    [401, "REFRESH_EXPIRED", "REFRESH_REUSED"],
    [403, "USER_DISABLED", "ORIGIN_NOT_ALLOWED"],
  )
  @HttpCode(200)
  async refresh(
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RefreshResponse> {
    this.requireEmptyBody(body);
    try {
      const grant = await this.auth.refresh(this.cookie(request));
      this.setRefreshCookie(
        response,
        grant.refreshToken,
        grant.refreshExpiresAt,
      );
      return { accessToken: grant.accessToken, expiresIn: grant.expiresIn };
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.getStatus()))
        this.clearRefreshCookie(response);
      throw error;
    }
  }

  @Post("logout")
  @ApiOperation({
    summary: "T01-04 — Đăng xuất",
    description:
      "Không gửi body. Thu hồi session hiện tại và xóa cookie. Bearer của session bị từ chối ngay. Cookie thiếu/sai/đã thu hồi vẫn trả 204; không ảnh hưởng session khác.",
    security: [{}, { refreshCookie: [] }],
  })
  @ApiSuccess(204, undefined, true)
  @ApiErrors([400, "VALIDATION_ERROR"], [403, "ORIGIN_NOT_ALLOWED"])
  @HttpCode(204)
  async logout(
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LogoutResponse> {
    this.requireEmptyBody(body);
    await this.auth.logout(this.cookie(request));
    this.clearRefreshCookie(response);
  }
}
