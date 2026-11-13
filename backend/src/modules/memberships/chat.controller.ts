import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { IsOptional, IsString, Length } from "class-validator";
import { ApiError } from "../../common/api-error";
import {
  CurrentAuth,
  RequireAuth,
  UUIDParamPipe,
  PaginationQueryDto,
} from "../../common";
import type { AuthenticatedIdentity } from "../../common";
import { GroupAccessService } from "./group-access.service";
import { ChatStore } from "./chat-store";

class HistoryQuery extends PaginationQueryDto {
  @IsOptional() @IsString() @Length(1, 100) channel = "trò-chuyện-chung";
}
class SearchQuery extends PaginationQueryDto {
  @IsString() @Length(1, 100) q!: string;
}
class CreateThreadDto {
  @IsString() @Length(1, 120) title!: string;
}

@Controller("groups/:groupId/chat")
@RequireAuth()
export class ChatController {
  constructor(
    private readonly access: GroupAccessService,
    private readonly chat: ChatStore,
  ) {}
  @Get("messages")
  async history(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", new UUIDParamPipe()) groupId: string,
    @Query() query: HistoryQuery,
  ) {
    await this.access.require(auth.user.id, groupId);
    await this.chat.requireThread(groupId, query.channel);
    return this.chat.history(groupId, query.channel, query.cursor, query.limit);
  }
  @Get("search")
  async search(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", new UUIDParamPipe()) groupId: string,
    @Query() query: SearchQuery,
  ) {
    await this.access.require(auth.user.id, groupId);
    return this.chat.search(groupId, query.q, query.cursor, query.limit);
  }
  @Get("threads")
  async threads(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", new UUIDParamPipe()) groupId: string,
    @Query() query: PaginationQueryDto,
  ) {
    await this.access.require(auth.user.id, groupId);
    return this.chat.threads(groupId, query.cursor, query.limit);
  }
  @Post("threads")
  async create(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", new UUIDParamPipe()) groupId: string,
    @Body() body: CreateThreadDto,
  ) {
    await this.access.require(auth.user.id, groupId);
    if (!body.title.trim())
      throw new ApiError(400, "VALIDATION_ERROR", "Vui lòng nhập chủ đề.");
    return {
      thread: await this.chat.createThread(
        groupId,
        auth.user.id,
        body.title.trim(),
      ),
    };
  }
  @Get("threads/:threadId")
  async thread(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", new UUIDParamPipe()) groupId: string,
    @Param("threadId", new UUIDParamPipe()) threadId: string,
  ) {
    await this.access.require(auth.user.id, groupId);
    return { thread: await this.chat.getThread(groupId, threadId) };
  }
}
