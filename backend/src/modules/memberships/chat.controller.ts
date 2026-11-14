import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { IsIn, IsOptional, IsString, IsUUID, Length } from "class-validator";
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
  @IsOptional() @IsUUID() around?: string;
  @IsOptional() @IsIn(["before", "after"]) direction?: "before" | "after";
}
class SearchQuery extends PaginationQueryDto {
  @IsString() @Length(1, 100) q!: string;
}
class ThreadTitleDto {
  @IsString() @Length(1, 120) title!: string;
}
class MarkReadDto {
  @IsString() @Length(1, 100) channel!: string;
  @IsUUID() messageId!: string;
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
    if (query.around)
      return this.chat.historyAround(
        groupId,
        query.channel,
        query.around,
        query.limit,
      );
    if (query.direction === "after") {
      if (!query.cursor)
        throw new ApiError(400, "VALIDATION_ERROR", "Thiếu vị trí tin nhắn.");
      return this.chat.historyAfter(
        groupId,
        query.channel,
        query.cursor,
        query.limit,
      );
    }
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
  @Get("read-state")
  async readState(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", new UUIDParamPipe()) groupId: string,
  ) {
    await this.access.require(auth.user.id, groupId);
    return this.chat.readState(groupId, auth.user.id);
  }
  @Post("read")
  async markRead(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", new UUIDParamPipe()) groupId: string,
    @Body() body: MarkReadDto,
  ) {
    await this.access.require(auth.user.id, groupId);
    await this.chat.requireThread(groupId, body.channel);
    return this.chat.markRead(
      groupId,
      auth.user.id,
      body.channel,
      body.messageId,
    );
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
    @Body() body: ThreadTitleDto,
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
  @Patch("threads/:threadId")
  async rename(
    @CurrentAuth() auth: AuthenticatedIdentity,
    @Param("groupId", new UUIDParamPipe()) groupId: string,
    @Param("threadId", new UUIDParamPipe()) threadId: string,
    @Body() body: ThreadTitleDto,
  ) {
    const permissions = await this.access.require(auth.user.id, groupId);
    const thread = await this.chat.getThread(groupId, threadId);
    if (thread.createdById !== auth.user.id && !permissions.canManageMembers)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Bạn không có quyền đổi tên chủ đề này.",
      );
    const title = body.title.trim();
    if (!title)
      throw new ApiError(400, "VALIDATION_ERROR", "Vui lòng nhập chủ đề.");
    return { thread: await this.chat.renameThread(thread, title) };
  }
}
