"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Plus } from "lucide-react";
import type { ClassSessionStatus } from "@streamora/contracts";
import { PageShell } from "@/components/shell/page-shell";
import {
  EmptyState,
  LoadingState,
  RequestError,
} from "@/components/common/feedback";
import { useGroupPermissions } from "@/lib/memberships/use-group-permissions";
import { useCursorList } from "@/lib/class-sessions/use-cursor-list";
import {
  createGroupSession,
  listClassSessions,
} from "@/lib/class-sessions/api";
import { statusLabels } from "@/lib/class-sessions/display";
import { SessionCard } from "./session-card";
import { SessionForm } from "./session-form";
import { getGroup } from "@/lib/groups/api";
import "./sessions.css";

export function GroupSchedule({ groupId }: { groupId: string }) {
  const router = useRouter();
  const access = useGroupPermissions(groupId);
  const [filter, setFilter] = useState<ClassSessionStatus | "">("");
  const [creating, setCreating] = useState(false),
    [name, setName] = useState("");
  const loader = useCallback(
    (cursor?: string) =>
      listClassSessions(groupId, cursor, filter || undefined),
    [groupId, filter],
  );
  const list = useCursorList(loader, access.revision);
  useEffect(() => {
    let current = true;
    void getGroup(groupId)
      .then(({ group }) => {
        if (current) setName(group.name);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [groupId]);
  return (
    <PageShell
      title={name ? `Lịch học · ${name}` : "Lịch học của nhóm"}
      description="Xem lịch dự kiến và tham gia các buổi học của nhóm."
      eyebrow="BUỔI HỌC"
      breadcrumb="Lịch học"
    >
      <div className="class-page">
        <div className="class-toolbar">
          <Link href={`/groups/${groupId}`} className="button secondary">
            Quay lại nhóm
          </Link>
          {access.permissions?.canHost && (
            <button
              type="button"
              className="button primary"
              onClick={() => setCreating(!creating)}
            >
              <Plus size={16} />
              {creating ? "Đóng biểu mẫu" : "Lên lịch buổi học"}
            </button>
          )}
        </div>
        {creating && access.permissions?.canHost && (
          <section className="class-panel">
            <h2>Lên lịch buổi học</h2>
            <SessionForm
              group
              label="Tạo lịch học"
              onSave={async (body, key) => {
                const { session } = await createGroupSession(
                  groupId,
                  {
                    title: body.title,
                    description: body.description ?? undefined,
                    scheduledAt: body.scheduledAt!,
                  },
                  key,
                );
                router.push(`/sessions/${session.id}`);
              }}
            />
          </section>
        )}
        <div className="class-toolbar">
          <h2 className="class-row">
            <CalendarDays size={20} />
            Các buổi học
          </h2>
          <div className="class-filter">
            <label htmlFor="class-status-filter">Trạng thái</label>
            <select
              id="class-status-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
            >
              <option value="">Tất cả</option>
              {Object.entries(statusLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {access.error ? (
          <RequestError
            error={access.error}
            onRetry={() => void access.refresh()}
          />
        ) : list.error ? (
          <RequestError error={list.error} onRetry={list.refresh} />
        ) : null}
        {!access.error && (
          <div className="class-grid">
            {list.items.map((session) => (
              <SessionCard key={session.id} session={session} />
            ))}
          </div>
        )}
        {list.loading && <LoadingState message="Đang tải lịch học…" />}
        {!list.loading &&
          !list.error &&
          !access.error &&
          list.items.length === 0 && (
            <EmptyState
              title="Chưa có buổi học"
              description="Lịch phù hợp với trạng thái đã chọn sẽ hiển thị ở đây."
            />
          )}
        {list.cursor && !access.error && (
          <button
            className="button secondary"
            disabled={list.loading}
            onClick={() => void list.more()}
          >
            Xem thêm buổi học
          </button>
        )}
      </div>
    </PageShell>
  );
}
