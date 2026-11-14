import { Injectable } from "@nestjs/common";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type {
  CursorPage,
  GroupChatMessage,
  GroupChatThread,
  GroupChatReadState,
} from "@streamora/contracts";
import { ApiError } from "../../common/api-error";

export const normalizeChatSearch = (text: string) =>
  text.normalize("NFC").toLocaleLowerCase("vi");
type Stored = GroupChatMessage & {
  pk: string;
  sk: string;
  revision: number;
  deletedAt?: string;
};
const invalid = () =>
  new ApiError(400, "VALIDATION_ERROR", "Dữ liệu trò chuyện không hợp lệ.");

@Injectable()
export class ChatStore {
  readonly table = process.env.CHAT_DYNAMODB_TABLE || "streamora-chat";
  readonly client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: process.env.CHAT_DYNAMODB_REGION || "ap-southeast-1",
      endpoint:
        process.env.CHAT_DYNAMODB_ENDPOINT ||
        (process.env.NODE_ENV === "production"
          ? undefined
          : "http://127.0.0.1:8000"),
      ...(process.env.NODE_ENV !== "production" &&
      !process.env.AWS_ACCESS_KEY_ID
        ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
        : {}),
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );

  private pk(groupId: string) {
    return `GROUP#${groupId}`;
  }
  private cursor(scope: string, key?: Record<string, any>) {
    return key
      ? Buffer.from(JSON.stringify({ scope, key })).toString("base64url")
      : null;
  }
  private decode(scope: string, cursor?: string) {
    if (!cursor) return undefined;
    try {
      if (cursor.length > 2048) throw invalid();
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (
        value.scope !== scope ||
        typeof value.key?.pk !== "string" ||
        typeof value.key?.sk !== "string"
      )
        throw invalid();
      return value.key as { pk: string; sk: string };
    } catch {
      throw invalid();
    }
  }
  private async query(
    groupId: string,
    prefix: string,
    limit: number,
    cursor?: string,
    scope = prefix,
  ) {
    const key = this.decode(`${groupId}:${scope}`, cursor);
    if (key && (key.pk !== this.pk(groupId) || !key.sk.startsWith(prefix)))
      throw invalid();
    return this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": this.pk(groupId),
          ":prefix": prefix,
        },
        ScanIndexForward: false,
        ConsistentRead: true,
        Limit: limit,
        ExclusiveStartKey: key,
      }),
    );
  }
  publicMessage(row: Record<string, any>): GroupChatMessage {
    const { pk, sk, revision, deletedAt, ...message } = row;
    return message as GroupChatMessage;
  }
  async history(
    groupId: string,
    channel: string,
    cursor?: string,
    limit = 20,
  ): Promise<CursorPage<GroupChatMessage>> {
    const result = await this.query(groupId, `M#${channel}#`, limit, cursor);
    return {
      items: (result.Items ?? [])
        .filter((x: any) => !x.deletedAt)
        .map((x: any) => this.publicMessage(x))
        .reverse(),
      nextCursor: this.cursor(
        `${groupId}:M#${channel}#`,
        result.LastEvaluatedKey,
      ),
    };
  }
  async get(groupId: string, id: string): Promise<Stored | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk(groupId), sk: `ID#${id}` },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;
    const row = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk(groupId), sk: result.Item.target },
        ConsistentRead: true,
      }),
    );
    return row.Item && !row.Item.deletedAt ? (row.Item as Stored) : null;
  }
  async historyAfter(
    groupId: string,
    channel: string,
    cursor: string,
    limit = 20,
  ) {
    const prefix = `M#${channel}#`;
    const key = this.decode(`${groupId}:after:${prefix}`, cursor);
    if (!key || key.pk !== this.pk(groupId) || !key.sk.startsWith(prefix))
      throw invalid();
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": key.pk,
          ":start": key.sk,
          ":end": `${prefix}~`,
        },
        ExclusiveStartKey: key,
        ScanIndexForward: true,
        ConsistentRead: true,
        Limit: limit,
      }),
    );
    return {
      items: (result.Items ?? [])
        .filter((row) => !row.deletedAt)
        .map((row) => this.publicMessage(row)),
      nextCursor: this.cursor(
        `${groupId}:after:${prefix}`,
        result.LastEvaluatedKey,
      ),
    };
  }
  async historyAround(
    groupId: string,
    channel: string,
    id: string,
    limit = 20,
  ) {
    const target = await this.get(groupId, id);
    if (!target || target.channel !== channel)
      throw new ApiError(404, "NOT_FOUND", "Không tìm thấy tin nhắn.");
    const prefix = `M#${channel}#`;
    const key = { pk: target.pk, sk: target.sk };
    const [older, newer] = await Promise.all([
      this.history(
        groupId,
        channel,
        this.cursor(`${groupId}:${prefix}`, key)!,
        limit,
      ),
      this.historyAfter(
        groupId,
        channel,
        this.cursor(`${groupId}:after:${prefix}`, key)!,
        limit,
      ),
    ]);
    return {
      items: [...older.items, this.publicMessage(target), ...newer.items],
      nextCursor: older.nextCursor,
      newerCursor: newer.nextCursor,
    };
  }
  private event(groupId: string, event: string, payload: unknown) {
    const id = randomUUID();
    return {
      Put: {
        TableName: this.table,
        Item: {
          pk: this.pk(groupId),
          sk: `E#${new Date().toISOString()}#${id}`,
          id,
          event,
          payload,
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        },
      },
    };
  }
  async save(message: GroupChatMessage) {
    const pk = this.pk(message.groupId);
    const sk = `M#${message.channel}#${message.createdAt}#${message.id}`;
    const tokenKey = message.clientId
      ? `CLIENT#${message.channel}#${message.senderId}#${message.clientId}`
      : `ID#${message.id}`;
    const existing = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk, sk: tokenKey },
        ConsistentRead: true,
      }),
    );
    if (existing.Item) {
      const saved = await this.get(message.groupId, existing.Item.id);
      if (
        !saved ||
        saved.text !== message.text ||
        saved.replyToId !== message.replyToId
      )
        throw new ApiError(
          409,
          "CONFLICT",
          "Mã gửi lại đã được dùng cho nội dung khác.",
        );
      return this.publicMessage(saved);
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { ...message, pk, sk, revision: 0 },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: {
                  pk,
                  sk: `ID#${message.id}`,
                  target: sk,
                  id: message.id,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            ...(message.clientId
              ? [
                  {
                    Put: {
                      TableName: this.table,
                      Item: { pk, sk: tokenKey, target: sk, id: message.id },
                      ConditionExpression: "attribute_not_exists(pk)",
                    },
                  },
                ]
              : []),
            this.event(message.groupId, "chat:message", message),
          ],
        }),
      );
    } catch (error) {
      if ((error as Error).name === "TransactionCanceledException") {
        const retry = await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: { pk, sk: tokenKey },
            ConsistentRead: true,
          }),
        );
        if (retry.Item) {
          const saved = await this.get(message.groupId, retry.Item.id);
          if (
            saved &&
            saved.text === message.text &&
            saved.replyToId === message.replyToId
          )
            return this.publicMessage(saved);
          throw new ApiError(
            409,
            "CONFLICT",
            "Mã gửi lại đã được dùng cho nội dung khác.",
          );
        }
      }
      throw error;
    }
    return message;
  }
  async change(row: Stored, text?: string) {
    const next = {
      ...row,
      revision: row.revision + 1,
      ...(text === undefined
        ? { deletedAt: new Date().toISOString() }
        : { text, editedAt: new Date().toISOString() }),
    };
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: next,
              ConditionExpression: "revision = :revision",
              ExpressionAttributeValues: { ":revision": row.revision },
            },
          },
          this.event(
            row.groupId,
            text === undefined
              ? "chat:message.deleted"
              : "chat:message.updated",
            text === undefined
              ? { id: row.id, groupId: row.groupId, channel: row.channel }
              : this.publicMessage(next),
          ),
        ],
      }),
    );
  }
  async search(
    groupId: string,
    q: string,
    cursor?: string,
    limit = 20,
  ): Promise<CursorPage<GroupChatMessage>> {
    const scope = `search:${normalizeChatSearch(q)}`;
    // Bounded Query on this group's partition, never a table-wide Scan. Continue even on empty pages.
    const result = await this.query(groupId, "M#", 100, cursor, scope);
    const matches = (result.Items ?? []).filter(
      (x: any) =>
        !x.deletedAt &&
        normalizeChatSearch(x.text).includes(normalizeChatSearch(q)),
    );
    const items = matches.slice(0, limit);
    const key =
      matches.length > limit
        ? items[items.length - 1]
        : result.LastEvaluatedKey;
    return {
      items: items.map((x: any) => this.publicMessage(x)),
      nextCursor: this.cursor(
        `${groupId}:${scope}`,
        key ? { pk: key.pk, sk: key.sk } : undefined,
      ),
    };
  }
  async threads(
    groupId: string,
    cursor?: string,
    limit = 20,
  ): Promise<CursorPage<GroupChatThread>> {
    const [messages, rows] = await Promise.all([
      this.messageMetadata(groupId),
      this.allRows(groupId, "T#"),
    ]);
    const activity = this.threadActivity(messages);
    const scope = `${groupId}:threads:activity`;
    const after = this.decode(scope, cursor);
    if (after && after.pk !== this.pk(groupId)) throw invalid();
    const sorted = rows
      .map(
        ({ pk, sk, ...thread }) =>
          ({
            ...thread,
            lastMessageAt: activity[`thread:${thread.id}`] ?? thread.createdAt,
          }) as GroupChatThread & { lastMessageAt: string },
      )
      .sort(
        (a, b) =>
          b.lastMessageAt.localeCompare(a.lastMessageAt) ||
          b.id.localeCompare(a.id),
      );
    const position = (thread: (typeof sorted)[number]) =>
      `${thread.lastMessageAt}#${thread.id}`;
    const remaining = after
      ? sorted.filter((thread) => position(thread) < after.sk)
      : sorted;
    const items = remaining.slice(0, limit);
    return {
      items,
      nextCursor:
        remaining.length > limit
          ? this.cursor(scope, {
              pk: this.pk(groupId),
              sk: position(items[items.length - 1]),
            })
          : null,
    };
  }
  private async allRows(
    groupId: string,
    prefix: string,
    projection?: string,
    names?: Record<string, string>,
  ) {
    const items: Record<string, any>[] = [];
    let key: Record<string, any> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": this.pk(groupId),
            ":prefix": prefix,
          },
          ConsistentRead: true,
          ExclusiveStartKey: key,
          ProjectionExpression: projection,
          ExpressionAttributeNames: names,
        }),
      );
      items.push(...(result.Items ?? []));
      key = result.LastEvaluatedKey;
    } while (key);
    return items;
  }
  private messageMetadata(groupId: string) {
    return this.allRows(
      groupId,
      "M#",
      "#id, #channel, #sender, #created, #deleted",
      {
        "#id": "id",
        "#channel": "channel",
        "#sender": "senderId",
        "#created": "createdAt",
        "#deleted": "deletedAt",
      },
    );
  }
  private threadActivity(messages: Record<string, any>[]) {
    const activity: Record<string, string> = Object.create(null);
    for (const message of messages) {
      if (
        !message.deletedAt &&
        message.channel.startsWith("thread:") &&
        (!activity[message.channel] ||
          activity[message.channel] < message.createdAt)
      )
        activity[message.channel] = message.createdAt;
    }
    return activity;
  }
  async readState(
    groupId: string,
    userId: string,
  ): Promise<GroupChatReadState> {
    const [messages, markers] = await Promise.all([
      this.messageMetadata(groupId),
      this.allRows(groupId, `READ#${userId}#`),
    ]);
    const positions = new Map(
      markers.map((marker) => [marker.channel, marker.position]),
    );
    const unread: Record<string, number> = Object.create(null);
    for (const message of messages) {
      if (message.deletedAt || message.senderId === userId) continue;
      if (
        `${message.createdAt}#${message.id}` >
        (positions.get(message.channel) ?? "")
      )
        unread[message.channel] = (unread[message.channel] ?? 0) + 1;
    }
    return { unread, threadActivity: this.threadActivity(messages) };
  }
  async markRead(
    groupId: string,
    userId: string,
    channel: string,
    messageId: string,
  ) {
    const message = await this.get(groupId, messageId);
    if (!message || message.channel !== channel)
      throw new ApiError(404, "NOT_FOUND", "Không tìm thấy tin nhắn.");
    const position = `${message.createdAt}#${message.id}`;
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk: this.pk(groupId),
            sk: `READ#${userId}#${channel}`,
            channel,
            position,
          },
          ConditionExpression:
            "attribute_not_exists(#position) OR #position < :position",
          ExpressionAttributeNames: { "#position": "position" },
          ExpressionAttributeValues: { ":position": position },
        }),
      );
    } catch (error) {
      if ((error as Error).name !== "ConditionalCheckFailedException")
        throw error;
    }
    return { ok: true };
  }
  async createThread(groupId: string, createdById: string, title: string) {
    const thread: GroupChatThread = {
      id: randomUUID(),
      groupId,
      title,
      createdById,
      createdAt: new Date().toISOString(),
    };
    const pk = this.pk(groupId),
      sk = `T#${thread.createdAt}#${thread.id}`;
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.table, Item: { ...thread, pk, sk } } },
          {
            Put: {
              TableName: this.table,
              Item: { pk, sk: `THREAD#${thread.id}`, ...thread },
            },
          },
          this.event(groupId, "chat:thread.created", thread),
        ],
      }),
    );
    return thread;
  }
  async requireThread(groupId: string, channel: string) {
    if (!channel.startsWith("thread:")) return;
    const result = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk(groupId), sk: `THREAD#${channel.slice(7)}` },
        ConsistentRead: true,
      }),
    );
    if (!result.Item)
      throw new ApiError(404, "NOT_FOUND", "Không tìm thấy chủ đề hỏi đáp.");
  }
  async renameThread(thread: GroupChatThread, title: string) {
    if (!title.trim() || title.length > 120) throw invalid();
    const renamed = { ...thread, title: title.trim() };
    const pk = this.pk(thread.groupId);
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          ...[`T#${thread.createdAt}#${thread.id}`, `THREAD#${thread.id}`].map(
            (sk) => ({
              Put: {
                TableName: this.table,
                Item: { ...renamed, pk, sk },
                ConditionExpression: "attribute_exists(pk)",
              },
            }),
          ),
          this.event(thread.groupId, "chat:thread.updated", renamed),
        ],
      }),
    );
    return renamed;
  }
  async getThread(groupId: string, id: string): Promise<GroupChatThread> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk(groupId), sk: `THREAD#${id}` },
        ConsistentRead: true,
      }),
    );
    if (!result.Item)
      throw new ApiError(404, "NOT_FOUND", "Không tìm thấy chủ đề hỏi đáp.");
    const { pk, sk, ...thread } = result.Item;
    return thread as GroupChatThread;
  }
  onModuleDestroy() {
    this.client.destroy();
  }
  async events(groupId: string, since: string) {
    let key: Record<string, any> | undefined;
    const items: Record<string, any>[] = [];
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          ConsistentRead: true,
          KeyConditionExpression: "pk = :pk AND sk BETWEEN :start AND :end",
          ExpressionAttributeValues: {
            ":pk": this.pk(groupId),
            ":start": `E#${since}`,
            ":end": "E#~",
          },
          ExclusiveStartKey: key,
        }),
      );
      items.push(...(result.Items ?? []));
      key = result.LastEvaluatedKey;
    } while (key);
    return items;
  }
}
