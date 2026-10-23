"use client";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import type { ClassSession } from "@streamora/contracts";
import { PageShell } from "@/components/shell/page-shell";
import { FormField } from "@/components/common/form-field";
import {
  EmptyState,
  InlineNotice,
  LoadingState,
  RequestError,
} from "@/components/common/feedback";
import {
  createMeet,
  changeClassStatus,
  listClassSessions,
} from "@/lib/class-sessions/api";
import { useCursorList } from "@/lib/class-sessions/use-cursor-list";
import { meetCodeInput, sessionHref } from "@/lib/class-sessions/display";
import { SessionCard } from "./session-card";
import { SessionForm } from "./session-form";
import "./sessions.css";

export function MeetHub() {
  const router = useRouter();
  const [code, setCode] = useState(""),
    [codeError, setCodeError] = useState("");
  const [created, setCreated] = useState<ClassSession | null>(null);
  const saved = useRef<ClassSession | null>(null),
    startKey = useRef<string | null>(null);
  const [revision, setRevision] = useState(0);
  const loader = useCallback(
    (cursor?: string) => listClassSessions(null, cursor),
    [],
  );
  const list = useCursorList(loader, revision);
  useEffect(() => {
    const refresh = () => setRevision((x) => x + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  function join(event: FormEvent) {
    event.preventDefault();
    const result = meetCodeInput(code, window.location.origin);
    if (!result) {
      setCodeError(
        "Nhập mã 12 ký tự hoặc liên kết Meet của Streamora trên trang này.",
      );
      return;
    }
    setCodeError("");
    router.push(`/meet/${result}`);
  }
  return (
    <PageShell
      title="Gặp nhau, bắt đầu học"
      description="Tạo cuộc họp độc lập hoặc mở liên kết được chia sẻ. Chủ phòng sẽ duyệt người xin vào."
      eyebrow="MEET"
      breadcrumb="Cuộc họp"
    >
      <div className="class-page">
        <div className="class-grid class-hub-grid">
          <section className="class-panel">
            <h2>Tạo cuộc họp</h2>
            <p className="class-muted">
              Bạn quản lý cuộc họp mình tạo và có thể bắt đầu ngay.
            </p>
            {created && (
              <InlineNotice>
                Cuộc họp đã được tạo. Nếu bước bắt đầu chưa thành công, bấm tiếp
                tục hoặc{" "}
                <Link href={sessionHref(created)}>mở cuộc họp đã tạo</Link>.
              </InlineNotice>
            )}
            <SessionForm
              label={created ? "Tiếp tục mở cuộc họp" : "Tạo và bắt đầu"}
              locked={!!created}
              onSave={async (body, key) => {
                if (!saved.current) {
                  const { session } = await createMeet(
                    {
                      title: body.title,
                      description: body.description ?? undefined,
                      ...(body.scheduledAt
                        ? { scheduledAt: body.scheduledAt }
                        : {}),
                    },
                    key,
                  );
                  saved.current = session;
                  setCreated(session);
                  setRevision((x) => x + 1);
                }
                startKey.current ??= crypto.randomUUID();
                await changeClassStatus(
                  saved.current.id,
                  "start",
                  startKey.current,
                );
                router.push(sessionHref(saved.current));
              }}
            />
          </section>
          <section className="class-panel">
            <h2>Tham gia cuộc họp</h2>
            <p className="class-muted">
              Dán mã hoặc liên kết được chủ phòng chia sẻ.
            </p>
            <form className="ui-form" onSubmit={join} noValidate>
              <FormField
                id="meet-code"
                label="Mã hoặc liên kết cuộc họp"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setCodeError("");
                }}
                error={codeError}
                required
              />
              <button className="button primary" type="submit">
                Mở cuộc họp
              </button>
            </form>
            <div className="class-hub-note">
              <h3>Học cùng nhóm của bạn</h3>
              <p>
                Lịch học trong nhóm được quản lý riêng, cùng quyền thành viên
                của nhóm đó.
              </p>
              <Link href="/groups" className="button secondary">
                Đến nhóm học tập
              </Link>
            </div>
          </section>
        </div>
        <h2>Cuộc họp do bạn tạo</h2>
        {!!list.error && (
          <RequestError error={list.error} onRetry={list.refresh} />
        )}
        <div className="class-grid">
          {list.items.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
        {list.loading && <LoadingState message="Đang tải cuộc họp…" />}
        {!list.loading && !list.error && !list.items.length && (
          <EmptyState
            title="Chưa có cuộc họp"
            description="Cuộc họp bạn tạo sẽ được lưu ở đây để mở lại và xem trạng thái."
          />
        )}
        {list.cursor && (
          <button
            type="button"
            className="button secondary"
            disabled={list.loading}
            onClick={() => void list.more()}
          >
            Xem thêm cuộc họp
          </button>
        )}
      </div>
    </PageShell>
  );
}
