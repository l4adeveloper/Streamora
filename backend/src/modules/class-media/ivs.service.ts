import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  IVSRealTimeClient,
  CreateStageCommand,
  GetStageCommand,
  ListStagesCommand,
  CreateParticipantTokenCommand,
  DisconnectParticipantCommand,
  DeleteStageCommand,
  ListParticipantsCommand,
  ListCompositionsCommand,
} from "@aws-sdk/client-ivs-realtime";
import { APP_CONFIG } from "../../config/configuration.module";
import type { EnvironmentConfig } from "../../config/environment";
import { ApiError } from "../../common/api-error";

@Injectable()
export class IvsService implements OnModuleDestroy {
  private readonly client: IVSRealTimeClient;
  constructor(@Inject(APP_CONFIG) readonly config: EnvironmentConfig) {
    this.client = new IVSRealTimeClient({
      region: config.ivs?.region ?? "ap-northeast-1",
      credentials: config.ivs?.credentials,
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 8000 },
    });
  }
  available() {
    if (!this.config.ivs?.enabled)
      throw new ApiError(
        503,
        "MEDIA_UNAVAILABLE",
        "Phòng video chưa được cấu hình. Vui lòng thử lại sau.",
      );
  }
  async ensureStage(sessionId: string) {
    this.available();
    const name = `streamora-${this.config.nodeEnv}-${sessionId}`;
    // Recover after a crash between AWS CreateStage and the DB commit.
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListStagesCommand({ nextToken, maxResults: 100 }),
      );
      for (const stage of page.stages ?? []) {
        if (stage.name !== name || !stage.arn) continue;
        const result = await this.client.send(
          new GetStageCommand({ arn: stage.arn }),
        );
        if (result.stage?.tags?.streamoraSessionId === sessionId)
          return stage.arn;
      }
      nextToken = page.nextToken;
    } while (nextToken);
    const result = await this.client.send(
      new CreateStageCommand({
        name,
        tags: {
          streamoraSessionId: sessionId,
          environment: this.config.nodeEnv,
        },
      }),
    );
    if (!result.stage?.arn) throw new Error("IVS_INVALID_RESPONSE");
    return result.stage.arn;
  }
  async token(stageArn: string, userId: string, fullName: string) {
    const result = await this.client.send(
      new CreateParticipantTokenCommand({
        stageArn,
        userId,
        duration: 1,
        capabilities: ["PUBLISH", "SUBSCRIBE"],
        attributes: { fullName },
      }),
    );
    const value = result.participantToken;
    if (!value?.token || !value.participantId || !value.expirationTime)
      throw new Error("IVS_INVALID_RESPONSE");
    return {
      token: value.token,
      participantId: value.participantId,
      expiresAt: value.expirationTime,
    };
  }
  async disconnect(stageArn: string, participantId: string) {
    await this.client.send(
      new DisconnectParticipantCommand({
        stageArn,
        participantId,
        reason: "Streamora access ended",
      }),
    );
  }
  async presence(stageArn: string) {
    const { stage } = await this.client.send(
      new GetStageCommand({ arn: stageArn }),
    );
    const sessionId = stage?.activeSessionId;
    if (!sessionId) return { sessionId: null, connectedIds: new Set<string>() };
    const connectedIds = new Set<string>();
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListParticipantsCommand({
          stageArn,
          sessionId,
          filterByState: "CONNECTED",
          maxResults: 100,
          nextToken,
        }),
      );
      for (const item of page.participants ?? [])
        if (item.participantId) connectedIds.add(item.participantId);
      nextToken = page.nextToken;
    } while (nextToken);
    return { sessionId, connectedIds };
  }
  async close(stageArn: string) {
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListCompositionsCommand({
          filterByStageArn: stageArn,
          maxResults: 100,
          nextToken,
        }),
      );
      if (
        page.compositions?.some(
          (item) => !["STOPPED", "FAILED"].includes(item.state ?? ""),
        )
      )
        return false;
      nextToken = page.nextToken;
    } while (nextToken);
    await this.client.send(new DeleteStageCommand({ arn: stageArn }));
    return true;
  }
  onModuleDestroy() {
    this.client.destroy();
  }
}
