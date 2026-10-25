import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../../common/api-error";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { PrismaService } from "../../database/prisma.service";
import { PUBLIC_USER_SELECT, type PublicUser } from "../users/user.types";
import { UsersService } from "../users/users.service";
import { AccessTokenService } from "./access-token.service";
import { PasswordService } from "./password.service";
import { SessionStore } from "./session-store.service";
import { AUTH_POLICY } from "../../config/auth-policy";
import { openRefreshToken, sealRefreshToken } from "./refresh-recovery";
import type { LoginRequest, RegisterRequest } from "@streamora/contracts";

type Failure = { error: { status: number; code: string; message: string } };
interface SessionGrant {
  user: PublicUser;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}
const failure = (status: number, code: string, message: string): Failure => ({
  error: { status, code, message },
});
const refreshExpired = () =>
  failure(
    401,
    "REFRESH_EXPIRED",
    "Phiên đăng nhập đã hết hạn hoặc không hợp lệ.",
  );
const userDisabled = () =>
  failure(403, "USER_DISABLED", "Tài khoản đã bị khóa.");
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionStore,
    @Inject(APP_CONFIG) private readonly config: EnvironmentConfig,
  ) {}

  async register(dto: RegisterRequest) {
    const passwordHash = await this.passwords.hash(dto.password);
    return this.users.create(dto.email, dto.fullName, passwordHash);
  }

  private unwrap(result: SessionGrant | Failure) {
    if ("error" in result) {
      throw new ApiError(
        result.error.status,
        result.error.code,
        result.error.message,
      );
    }
    return result;
  }

  private grant(
    user: PublicUser,
    sessionId: string,
    expiresAt: Date,
    now: Date,
    refreshToken: string,
  ): SessionGrant {
    const expiresIn = Math.min(
      this.config.auth.accessTokenTtlSeconds,
      Math.floor((expiresAt.getTime() - now.getTime()) / 1000),
    );
    return {
      user,
      accessToken: this.tokens.issue(user.id, sessionId, expiresIn, now),
      expiresIn,
      refreshToken,
      refreshExpiresAt: expiresAt,
    };
  }

  async login(dto: LoginRequest) {
    const existing = await this.users.findForLogin(dto.email);
    if (
      !(await this.passwords.verify(existing?.passwordHash, dto.password)) ||
      !existing
    ) {
      throw new ApiError(
        401,
        "INVALID_CREDENTIALS",
        "Email hoặc mật khẩu không đúng.",
      );
    }
    const result = await this.sessions.withUserLock<SessionGrant | Failure>(
      existing.id,
      async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: existing.id },
          select: { ...PUBLIC_USER_SELECT, disabledAt: true },
        });
        if (!user)
          return failure(
            401,
            "INVALID_CREDENTIALS",
            "Email hoặc mật khẩu không đúng.",
          );
        const now = await this.sessions.now(tx);
        if (user.disabledAt) {
          await this.sessions.revokeDisabledUser(tx, user.id, now);
          return userDisabled();
        }
        const expiresAt = new Date(
          now.getTime() + this.config.auth.refreshTokenTtlSeconds * 1000,
        );
        const refreshToken = randomBytes(32).toString("base64url");
        const session = await tx.authSession.create({
          data: {
            userId: user.id,
            createdAt: now,
            expiresAt,
            lastUsedAt: now,
            refreshTokens: {
              create: {
                tokenHash: tokenHash(refreshToken),
                generation: 0,
                createdAt: now,
                expiresAt,
              },
            },
          },
        });
        const { disabledAt: _disabledAt, ...publicUser } = user;
        return this.grant(publicUser, session.id, expiresAt, now, refreshToken);
      },
    );
    return this.unwrap(result);
  }

  private validRefreshToken(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  }

  async refresh(cookie: unknown) {
    if (!this.validRefreshToken(cookie)) return this.unwrap(refreshExpired());
    const hash = tokenHash(cookie);
    const known = await this.prisma.authRefreshToken.findUnique({
      where: { tokenHash: hash },
      select: { session: { select: { userId: true } } },
    });
    if (!known) return this.unwrap(refreshExpired());
    const result = await this.sessions.withUserLock<SessionGrant | Failure>(
      known.session.userId,
      async (tx) => {
        const previous = await tx.authRefreshToken.findUnique({
          where: { tokenHash: hash },
          include: {
            session: {
              include: {
                user: { select: { ...PUBLIC_USER_SELECT, disabledAt: true } },
              },
            },
          },
        });
        if (!previous) return refreshExpired();
        const { session } = previous;
        const now = await this.sessions.now(tx);
        if (session.user.disabledAt) {
          await this.sessions.revokeDisabledUser(tx, session.userId, now);
          return userDisabled();
        }
        if (
          session.revokedAt ||
          session.expiresAt.getTime() - now.getTime() < 1000 ||
          previous.expiresAt <= now
        )
          return refreshExpired();
        if (previous.consumedAt) {
          // A reload may discard Set-Cookie after the rotation has committed.
          // Recover the current generation, including when another tab has since
          // rotated it. The presented token's original consumption time bounds
          // recovery: retries never extend its window or create another branch.
          const age = now.getTime() - previous.consumedAt.getTime();
          if (
            age >= 0 &&
            age < AUTH_POLICY.refreshRecoveryWindowMs &&
            session.refreshRecoveryToken &&
            session.refreshRecoveryUntil &&
            session.refreshRecoveryUntil > now
          ) {
            const recovered = openRefreshToken(
              session.refreshRecoveryToken,
              this.config.auth.accessTokenSecret,
              session.id,
            );
            if (recovered && this.validRefreshToken(recovered)) {
              const current = await tx.authRefreshToken.findUnique({
                where: { tokenHash: tokenHash(recovered) },
              });
              if (
                current &&
                current.sessionId === session.id &&
                current.generation > previous.generation &&
                !current.consumedAt &&
                current.expiresAt > now
              ) {
                const { disabledAt: _disabledAt, ...user } = session.user;
                return this.grant(
                  user,
                  session.id,
                  session.expiresAt,
                  now,
                  recovered,
                );
              }
            }
          }
          await tx.authSession.update({
            where: { id: session.id },
            data: {
              revokedAt: now,
              revocationReason: "REFRESH_REUSED",
              refreshRecoveryToken: null,
              refreshRecoveryUntil: null,
            },
          });
          // Return the failure so the transaction COMMITS the revocation before throwing.
          return failure(
            401,
            "REFRESH_REUSED",
            "Token cũ đã được sử dụng lại. Vui lòng đăng nhập lại.",
          );
        }
        const consumed = await tx.authRefreshToken.updateMany({
          where: { id: previous.id, consumedAt: null },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) {
          await tx.authSession.update({
            where: { id: session.id },
            data: {
              revokedAt: now,
              revocationReason: "REFRESH_REUSED",
              refreshRecoveryToken: null,
              refreshRecoveryUntil: null,
            },
          });
          return failure(
            401,
            "REFRESH_REUSED",
            "Token cũ đã được sử dụng lại. Vui lòng đăng nhập lại.",
          );
        }
        const refreshToken = randomBytes(32).toString("base64url");
        await tx.authRefreshToken.create({
          data: {
            sessionId: session.id,
            tokenHash: tokenHash(refreshToken),
            generation: previous.generation + 1,
            createdAt: now,
            expiresAt: session.expiresAt,
          },
        });
        await tx.authSession.update({
          where: { id: session.id },
          data: {
            lastUsedAt: now,
            refreshRecoveryToken: sealRefreshToken(
              refreshToken,
              this.config.auth.accessTokenSecret,
              session.id,
            ),
            refreshRecoveryUntil: new Date(
              Math.min(
                now.getTime() + AUTH_POLICY.refreshRecoveryWindowMs,
                session.expiresAt.getTime(),
              ),
            ),
          },
        });
        const { disabledAt: _disabledAt, ...user } = session.user;
        return this.grant(
          user,
          session.id,
          session.expiresAt,
          now,
          refreshToken,
        );
      },
    );
    return this.unwrap(result);
  }

  async logout(cookie: unknown) {
    if (!this.validRefreshToken(cookie)) return;
    const known = await this.prisma.authRefreshToken.findUnique({
      where: { tokenHash: tokenHash(cookie) },
      select: { sessionId: true, session: { select: { userId: true } } },
    });
    if (!known) return;
    await this.sessions.withUserLock(known.session.userId, async (tx) => {
      const now = await this.sessions.now(tx);
      await tx.authSession.updateMany({
        where: { id: known.sessionId, revokedAt: null },
        data: {
          revokedAt: now,
          revocationReason: "LOGOUT",
          refreshRecoveryToken: null,
          refreshRecoveryUntil: null,
        },
      });
    });
  }
}
