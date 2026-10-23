"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  Copy,
  LogIn,
  LogOut,
  Play,
  Square,
  Users,
  UserRoundCheck,
} from "lucide-react";
import type {
  ClassAdmissionResponse,
  ClassParticipationClosed,
  ClassSession,
  MeetPreview,
} from "@streamora/contracts";
import { PageShell } from "@/components/shell/page-shell";
import {
  EmptyState,
  InlineNotice,
  LoadingState,
  RequestError,
} from "@/components/common/feedback";
import { useToast } from "@/components/common/toast-provider";
import { ApiError, asApiError } from "@/lib/api";
import * as api from "@/lib/class-sessions/api";
import { displayTime } from "@/lib/class-sessions/display";
import { useCursorList } from "@/lib/class-sessions/use-cursor-list";
import { useClassRealtime } from "@/lib/class-sessions/use-class-realtime";
import { SessionStatus } from "./session-card";
import { SessionForm } from "./session-form";
import "./sessions.css";

interface RoomData {
  id: string;
  admission: ClassAdmissionResponse;
  session: ClassSession | null;
  preview: MeetPreview | null;
}
const closedMessages = {
  LEFT: "Bạn đã rời phòng. Muốn tham gia lại, hãy thực hiện một lượt vào mới.",
  DISCONNECTED:
    "Lượt tham gia đã hết hạn do mất kết nối. Hãy xin vào lại nếu muốn tiếp tục.",
  SESSION_ENDED: "Buổi học đã kết thúc. Lượt tham gia của bạn đã được đóng.",
  ACCESS_REVOKED: "Quyền tham gia của bạn đã bị thu hồi.",
};

export function SessionRoom({
  sessionId,
  meetCode,
}: {
  sessionId?: string;
  meetCode?: string;
}) {
  const { notify } = useToast();
  const [id, setId] = useState<string | null>(sessionId ?? null);
  const [data, setData] = useState<RoomData | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [pending, setPending] = useState("");
  const [revision, setRevision] = useState(0),
    [editing, setEditing] = useState(false);
  const [confirmation, setConfirmation] = useState<"end" | "cancel" | null>(
    null,
  );
  const [closedId, setClosedId] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [shareLink, setShareLink] = useState("");
  const sequence = useRef(0),
    busy = useRef(false),
    scheduledRefresh = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    );
  const intent = useRef<{ signature: string; key: string } | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const preview = meetCode ? (await api.previewMeet(meetCode)).meet : null;
      const resolved = preview?.id ?? sessionId!;
      const admission = await api.getAdmission(resolved);
      const session =
        !meetCode ||
        admission.permissions.canManage ||
        (admission.participation &&
          !admission.participation.leftAt &&
          admission.permissions.canViewParticipants)
          ? (await api.getClassSession(resolved)).session
          : null;
      if (request !== sequence.current) return;
      setId(resolved);
      setData({ id: resolved, preview, admission, session });
      setError(null);
      setRevision((x) => x + 1);
    } catch (error) {
      if (request !== sequence.current) return;
      setError(error);
      setData(null);
      setConfirmation(null);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [meetCode, sessionId]);
  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 15000);
    return () => {
      sequence.current++;
      clearInterval(poll);
      clearTimeout(scheduledRefresh.current);
    };
  }, [refresh]);
  const changed = useCallback(
    (kind: string) => {
      if (["access.changed", "access-revoked"].includes(kind)) {
        sequence.current++;
        setConfirmation(null);
        setData(null);
        if (kind === "access-revoked")
          setError(
            new ApiError(
              403,
              "FORBIDDEN",
              "Bạn không còn quyền truy cập buổi học này.",
            ),
          );
      }
      clearTimeout(scheduledRefresh.current);
      scheduledRefresh.current = setTimeout(() => void refresh(), 100);
    },
    [refresh],
  );
  const closed = useCallback((event: ClassParticipationClosed) => {
    if (dataRef.current?.admission.participation?.id !== event.participationId)
      return;
    setClosedId(event.participationId);
    setNotice(closedMessages[event.reason]);
  }, []);
  const session = data?.session,
    preview = data?.preview,
    admission = data?.admission;
  const status = session?.status ?? preview?.status;
  const visit = admission?.participation;
  const active =
    !!visit &&
    !visit.leftAt &&
    visit.id !== closedId &&
    status === "LIVE" &&
    !!admission?.permissions.canViewParticipants;
  const connection = useClassRealtime(
    id,
    active ? visit.id : null,
    changed,
    closed,
  );
  const manage = !!admission?.permissions.canManage;
  useEffect(() => {
    setShareLink(
      window.location.origin +
        (meetCode ? `/meet/${meetCode}` : `/sessions/${sessionId}`),
    );
  }, [meetCode, sessionId]);
  useEffect(() => {
    if (confirmation) confirmButton.current?.focus();
  }, [confirmation]);

  function key(action: string) {
    // Retain the same key while retrying an uncertain outcome. A new server state
    // (resolved request/closed visit) gives a later explicit intent a fresh key.
    const signature = `${id}:${action}:${admission?.request?.id}:${admission?.request?.status}:${visit?.id}:${visit?.leftAt}`;
    if (intent.current?.signature !== signature)
      intent.current = { signature, key: crypto.randomUUID() };
    return intent.current.key;
  }
  async function run(
    name: string,
    work: () => Promise<unknown>,
    message?: string,
  ) {
    if (busy.current) return;
    busy.current = true;
    setPending(name);
    setActionError(null);
    setNotice("");
    try {
      await work();
      if (message) notify(message, { tone: "success" });
      setConfirmation(null);
    } catch (error) {
      setActionError(error);
    } finally {
      await refresh();
      busy.current = false;
      setPending("");
    }
  }
  const disabled = !!pending || !!error || !data;
  const title = session?.title ?? preview?.title ?? "Buổi học";
  const currentRequest = admission?.request;
  return (
    <PageShell
      title={title}
      eyebrow={
        session?.kind === "GROUP" ? "BUỔI HỌC CỦA NHÓM" : "KHÔNG GIAN BUỔI HỌC"
      }
      breadcrumb={title}
    >
      <div className="class-page">
        <div className="class-toolbar">
          <Link
            href={
              session?.groupId ? `/groups/${session.groupId}/sessions` : "/meet"
            }
            className="button secondary"
          >
            {session?.groupId ? "Lịch học của nhóm" : "Danh sách cuộc họp"}
          </Link>
          <button
            type="button"
            className="button secondary"
            onClick={() => void refresh()}
            disabled={!!pending}
          >
            Làm mới
          </button>
        </div>
        {loading && <LoadingState message="Đang tải buổi học…" />}
        {!!error && (
          <RequestError error={error} onRetry={() => void refresh()} />
        )}
        {!!actionError && (
          <InlineNotice tone="error">
            {asApiError(actionError).message}
          </InlineNotice>
        )}
        {notice && <InlineNotice>{notice}</InlineNotice>}
        {data && status && (
          <>
            <section className="class-panel class-room-header">
              <div className="class-toolbar">
                <SessionStatus status={status} />
                <span className="class-connection" role="status">
                  {connection === "connected"
                    ? "Đang cập nhật trực tiếp"
                    : connection === "connecting"
                      ? "Đang kết nối…"
                      : connection === "expired"
                        ? "Lượt kết nối đã hết hạn"
                        : "Đang khôi phục kết nối…"}
                </span>
              </div>
              {session?.description && (
                <p className="class-description">{session.description}</p>
              )}
              {preview && (
                <p>
                  Chủ phòng: <strong>{preview.host.fullName}</strong>
                </p>
              )}
              {session && (
                <div className="class-session-times">
                  <p className="class-row">
                    <CalendarDays size={17} aria-hidden="true" />
                    Dự kiến: {displayTime(session.scheduledAt)}
                  </p>
                  {session.startedAt && (
                    <p>Bắt đầu: {displayTime(session.startedAt)}</p>
                  )}
                  {session.endedAt && (
                    <p>Kết thúc: {displayTime(session.endedAt)}</p>
                  )}
                </div>
              )}
              <div className="class-share">
                <label htmlFor="class-share-link">Liên kết tham gia</label>
                <div className="class-row">
                  <input
                    id="class-share-link"
                    readOnly
                    value={shareLink}
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      if (!navigator.clipboard) {
                        notify("Chọn và sao chép liên kết trong ô bên cạnh.");
                        return;
                      }
                      void navigator.clipboard
                        .writeText(shareLink)
                        .then(() =>
                          notify("Đã sao chép liên kết.", { tone: "success" }),
                        )
                        .catch(() =>
                          notify("Chọn và sao chép liên kết trong ô bên cạnh."),
                        );
                    }}
                  >
                    <Copy size={16} />
                    Sao chép
                  </button>
                </div>
              </div>
            </section>
            {connection !== "connected" && active && (
              <InlineNotice>
                Kết nối đang được khôi phục. Bạn có tối đa 30 giây để kết nối
                lại trước khi lượt tham gia hết hạn.
              </InlineNotice>
            )}
            <section
              className="class-panel"
              aria-labelledby="class-admission-title"
            >
              <h2 id="class-admission-title">Tham gia buổi học</h2>
              {status === "SCHEDULED" && (
                <p>
                  Buổi học chưa bắt đầu. Bạn có thể xin vào khi người quản lý mở
                  buổi học.
                </p>
              )}
              {status === "ENDED" && (
                <p>
                  Buổi học đã kết thúc. Các yêu cầu và lượt tham gia đã được
                  đóng.
                </p>
              )}
              {status === "CANCELLED" && (
                <p>Buổi học đã được hủy. Không thể tham gia buổi học này.</p>
              )}
              {status === "LIVE" && (
                <>
                  {active ? (
                    <div className="class-admission-active">
                      <Users size={24} aria-hidden="true" />
                      <div>
                        <strong>Bạn đang ở trong phòng</strong>
                        <p className="class-muted">
                          Lượt tham gia được dùng chung trên các tab của bạn.
                          Rời phòng sẽ đóng lượt trên mọi tab.
                        </p>
                      </div>
                      <button
                        className="button secondary"
                        disabled={disabled}
                        onClick={() =>
                          void run(
                            "leave",
                            () => api.leaveClass(data.id, visit.id),
                            "Đã rời phòng.",
                          )
                        }
                      >
                        <LogOut size={16} />
                        {pending === "leave" ? "Đang rời…" : "Rời phòng"}
                      </button>
                    </div>
                  ) : (
                    <>
                      {!manage && currentRequest?.status === "PENDING" && (
                        <div className="class-admission-waiting" role="status">
                          <strong>Đang chờ người quản lý duyệt</strong>
                          <p>
                            Bạn sẽ nhận được kết quả tại đây. Được chấp nhận
                            chưa tính là đã vào phòng.
                          </p>
                          <button
                            className="button secondary"
                            disabled={disabled}
                            onClick={() =>
                              void run("cancel-request", () =>
                                api.cancelClassJoin(data.id, currentRequest.id),
                              )
                            }
                          >
                            Hủy yêu cầu
                          </button>
                        </div>
                      )}
                      {!manage &&
                        currentRequest?.status === "ACCEPTED" &&
                        admission?.permissions.canEnter && (
                          <p className="class-success" role="status">
                            Yêu cầu đã được chấp nhận. Bấm vào phòng để bắt đầu
                            tham gia.
                          </p>
                        )}
                      {!manage && currentRequest?.status === "REJECTED" && (
                        <p role="status">
                          Yêu cầu đã bị từ chối. Bạn có thể chủ động xin vào
                          lại.
                        </p>
                      )}
                      {!manage && currentRequest?.status === "CANCELLED" && (
                        <p>Bạn đã hủy yêu cầu tham gia.</p>
                      )}
                      {!manage &&
                        ["EXPIRED", "REVOKED"].includes(
                          currentRequest?.status ?? "",
                        ) && (
                          <p>
                            Quyền vào trước đó đã hết hiệu lực. Bạn cần được
                            duyệt lại.
                          </p>
                        )}
                      {manage && (
                        <p>
                          Bạn có quyền quản lý và được vào trực tiếp. Bắt đầu
                          buổi học không tự ghi nhận bạn vào phòng.
                        </p>
                      )}
                      {admission?.permissions.canRequestJoin && (
                        <button
                          className="button primary"
                          disabled={disabled}
                          onClick={() =>
                            void run("request", () =>
                              api.requestClassJoin(data.id, key("request")),
                            )
                          }
                        >
                          <UserRoundCheck size={17} />
                          {pending === "request"
                            ? "Đang gửi…"
                            : currentRequest
                              ? "Xin vào lại"
                              : "Xin vào phòng"}
                        </button>
                      )}
                      {admission?.permissions.canEnter && (
                        <button
                          className="button primary"
                          disabled={disabled}
                          onClick={() =>
                            void run("enter", () =>
                              api.enterClass(data.id, key("enter")),
                            )
                          }
                        >
                          <LogIn size={17} />
                          {pending === "enter" ? "Đang vào…" : "Vào phòng"}
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </section>
            {manage && (
              <section
                className="class-panel"
                aria-labelledby="class-manager-title"
              >
                <h2 id="class-manager-title">Quản lý buổi học</h2>
                <div className="class-actions">
                  {status === "SCHEDULED" && (
                    <>
                      <button
                        className="button primary"
                        disabled={disabled}
                        onClick={() =>
                          void run(
                            "start",
                            () =>
                              api.changeClassStatus(
                                data.id,
                                "start",
                                key("start"),
                              ),
                            "Đã bắt đầu buổi học.",
                          )
                        }
                      >
                        <Play size={16} />
                        {pending === "start"
                          ? "Đang bắt đầu…"
                          : "Bắt đầu buổi học"}
                      </button>
                      <button
                        className="button secondary"
                        disabled={disabled}
                        onClick={() => setEditing(!editing)}
                      >
                        {editing ? "Đóng chỉnh sửa" : "Chỉnh sửa lịch"}
                      </button>
                      <button
                        className="button danger"
                        disabled={disabled}
                        onClick={() => setConfirmation("cancel")}
                      >
                        Hủy buổi học
                      </button>
                    </>
                  )}
                  {status === "LIVE" && (
                    <button
                      className="button danger"
                      disabled={disabled}
                      onClick={() => setConfirmation("end")}
                    >
                      <Square size={16} />
                      Kết thúc buổi học
                    </button>
                  )}
                  {["ENDED", "CANCELLED"].includes(status) && (
                    <p>
                      Trạng thái đã được chốt; muốn tổ chức lại, hãy tạo buổi
                      học mới.
                    </p>
                  )}
                </div>
                {confirmation && (
                  <div
                    className="class-confirm"
                    role="alertdialog"
                    aria-labelledby="class-confirm-title"
                    aria-describedby="class-confirm-description"
                  >
                    <h3 id="class-confirm-title">
                      {confirmation === "end"
                        ? "Kết thúc buổi học này?"
                        : "Hủy lịch học này?"}
                    </h3>
                    <p id="class-confirm-description">
                      {confirmation === "end"
                        ? "Các lượt tham gia và yêu cầu đang chờ sẽ được đóng. Buổi học không thể mở lại."
                        : "Lịch sẽ chuyển sang đã hủy và không thể bắt đầu."}
                    </p>
                    <div className="class-actions">
                      <button
                        ref={confirmButton}
                        className="button danger"
                        disabled={disabled}
                        onClick={() =>
                          void run(
                            confirmation,
                            () =>
                              api.changeClassStatus(
                                data.id,
                                confirmation,
                                key(confirmation),
                              ),
                            confirmation === "end"
                              ? "Đã kết thúc buổi học."
                              : "Đã hủy lịch học.",
                          )
                        }
                      >
                        {pending
                          ? "Đang xử lý…"
                          : confirmation === "end"
                            ? "Xác nhận kết thúc"
                            : "Xác nhận hủy"}
                      </button>
                      <button
                        className="button secondary"
                        disabled={!!pending}
                        onClick={() => setConfirmation(null)}
                      >
                        Quay lại
                      </button>
                    </div>
                  </div>
                )}
                {editing && status === "SCHEDULED" && session && (
                  <SessionForm
                    key={session.updatedAt}
                    initial={session}
                    group={session.kind === "GROUP"}
                    label="Lưu thay đổi"
                    onSave={async (body) => {
                      if (busy.current) return;
                      busy.current = true;
                      setPending("edit");
                      try {
                        await api.updateClassSession(data.id, body);
                        setEditing(false);
                        notify("Đã cập nhật lịch học.", { tone: "success" });
                      } finally {
                        await refresh();
                        busy.current = false;
                        setPending("");
                      }
                    }}
                  />
                )}
              </section>
            )}
            <div className="class-grid">
              {manage && (
                <JoinQueue
                  sessionId={data.id}
                  revision={revision}
                  pending={!!pending}
                  decide={(requestId, decision) =>
                    run("decide", () =>
                      api.decideClassJoin(data.id, requestId, decision),
                    )
                  }
                />
              )}
              {admission?.permissions.canViewParticipants && (
                <Participants sessionId={data.id} revision={revision} />
              )}
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}

function JoinQueue({
  sessionId,
  revision,
  pending,
  decide,
}: {
  sessionId: string;
  revision: number;
  pending: boolean;
  decide: (id: string, decision: "ACCEPT" | "REJECT") => Promise<void>;
}) {
  const loader = useCallback(
    (cursor?: string) => api.listClassQueue(sessionId, cursor),
    [sessionId],
  );
  const list = useCursorList(loader, revision);
  return (
    <section className="class-panel" aria-labelledby="class-queue-title">
      <h2 id="class-queue-title">Hàng chờ duyệt</h2>
      <p className="class-muted">
        Chỉ người quản lý xem và quyết định các yêu cầu này.
      </p>
      {!!list.error && (
        <RequestError error={list.error} onRetry={list.refresh} />
      )}
      <ul className="class-people">
        {list.items.map((request) => (
          <li key={request.id}>
            <div>
              <strong>{request.user.fullName}</strong>
              <span>Xin vào lúc {displayTime(request.requestedAt)}</span>
            </div>
            <div className="class-actions">
              <button
                className="button primary compact"
                disabled={pending}
                aria-label={`Chấp nhận ${request.user.fullName}`}
                onClick={() => void decide(request.id, "ACCEPT")}
              >
                Chấp nhận
              </button>
              <button
                className="button secondary compact"
                disabled={pending}
                aria-label={`Từ chối ${request.user.fullName}`}
                onClick={() => void decide(request.id, "REJECT")}
              >
                Từ chối
              </button>
            </div>
          </li>
        ))}
      </ul>
      {list.loading && <LoadingState message="Đang tải hàng chờ…" />}
      {!list.loading && !list.error && !list.items.length && (
        <EmptyState
          title="Không có yêu cầu đang chờ"
          description="Yêu cầu mới sẽ tự cập nhật tại đây."
        />
      )}
      {list.cursor && (
        <button
          className="button secondary"
          disabled={list.loading}
          onClick={() => void list.more()}
        >
          Xem thêm yêu cầu
        </button>
      )}
    </section>
  );
}
function Participants({
  sessionId,
  revision,
}: {
  sessionId: string;
  revision: number;
}) {
  const loader = useCallback(
    (cursor?: string) => api.listClassParticipants(sessionId, cursor),
    [sessionId],
  );
  const list = useCursorList(loader, revision);
  return (
    <section className="class-panel" aria-labelledby="class-participants-title">
      <h2 id="class-participants-title">Người trong phòng</h2>
      <p className="class-muted">
        Mỗi người được tính một lần, kể cả khi mở nhiều tab.
      </p>
      {!!list.error && (
        <RequestError error={list.error} onRetry={list.refresh} />
      )}
      <ul className="class-people">
        {list.items.map((visit) => (
          <li key={visit.id}>
            <span className="class-person-avatar" aria-hidden="true">
              {visit.user.fullName.trim().slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{visit.user.fullName}</strong>
              <span>Vào lúc {displayTime(visit.joinedAt)}</span>
            </div>
          </li>
        ))}
      </ul>
      {list.loading && <LoadingState message="Đang tải người tham gia…" />}
      {!list.loading && !list.error && !list.items.length && (
        <EmptyState
          title="Chưa có người trong phòng"
          description="Được duyệt chưa tính là đã tham gia; người dùng cần bấm vào phòng."
        />
      )}
      {list.cursor && (
        <button
          className="button secondary"
          disabled={list.loading}
          onClick={() => void list.more()}
        >
          Xem thêm người tham gia
        </button>
      )}
    </section>
  );
}
