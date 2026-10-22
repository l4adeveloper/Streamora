"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Users,
  Video,
  Folder,
  Settings2,
  Trash2,
  ShieldCheck,
  Calendar,
  Clock,
  Crown,
  ChevronLeft,
} from "lucide-react";
import { PageShell } from "@/components/shell/page-shell";
import { LoadingState, RequestError } from "@/components/common/feedback";
import { useToast } from "@/components/common/toast-provider";
import { useAuth } from "@/components/auth/auth-provider";
import { GroupFormDialog } from "./group-form-dialog";
import { DeleteGroupDialog } from "./delete-group-dialog";
import { getGroup, updateGroup, deleteGroup } from "@/lib/groups/api";
import type { Group } from "@streamora/contracts";
import "./groups.css";

export function GroupDetailPage({ groupId }: { groupId: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const { notify } = useToast();

  const [group, setGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getGroup(groupId);
      setGroup(res.group);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const isOwner = user?.id === group?.ownerId;
  const isAdmin = user?.globalRole === "ADMIN";
  const canManage = isOwner || isAdmin;

  const handleUpdate = async (data: { name: string; description?: string }) => {
    if (!group) return;
    const res = await updateGroup(group.id, data);
    setGroup(res.group);
    notify(`Đã cập nhật thông tin nhóm "${res.group.name}".`, {
      tone: "success",
    });
  };

  const handleDelete = async () => {
    if (!group) return;
    await deleteGroup(group.id);
    notify(`Đã xóa nhóm "${group.name}".`, { tone: "info" });
    router.replace("/groups");
  };

  if (loading) {
    return (
      <PageShell
        title="Đang tải thông tin nhóm…"
        eyebrow="CHI TIẾT NHÓM"
        breadcrumb="Nhóm học tập"
      >
        <LoadingState message="Đang tải dữ liệu nhóm học tập…" />
      </PageShell>
    );
  }

  if (error || !group) {
    return (
      <PageShell
        title="Không thể mở nhóm học tập"
        eyebrow="CHI TIẾT NHÓM"
        breadcrumb="Nhóm học tập"
      >
        <div style={{ marginBottom: "20px" }}>
          <Link
            href="/groups"
            className="button secondary compact"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <ChevronLeft size={16} /> Quay lại danh sách nhóm
          </Link>
        </div>
        <RequestError error={error} onRetry={fetchDetail} />
      </PageShell>
    );
  }

  const initials =
    group.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "GR";

  const createdDate = new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(group.createdAt));

  const updatedDate = new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(group.updatedAt));

  return (
    <PageShell
      title={group.name}
      description={
        group.description ?? "Không gian cộng tác, học tập và tài liệu chung."
      }
      eyebrow="CHI TIẾT NHÓM"
      breadcrumb={group.name}
    >
      <div className="groups-page-container">
        <div style={{ marginBottom: "20px" }}>
          <Link
            href="/groups"
            className="button secondary compact"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <ChevronLeft size={16} /> Danh sách nhóm
          </Link>
        </div>

        <section className="group-detail-header">
          <div className="group-detail-profile">
            <div className="group-detail-avatar" aria-hidden="true">
              {initials}
            </div>
            <div className="group-detail-info">
              <h1>{group.name}</h1>
              <p>
                {group.description || "Chưa có mô tả chi tiết cho nhóm này."}
              </p>
              <div className="group-detail-tags">
                {isOwner ? (
                  <span className="group-role-badge owner">
                    <Crown size={12} /> Bạn là chủ nhóm (OWNER)
                  </span>
                ) : isAdmin ? (
                  <span className="group-role-badge">
                    <ShieldCheck size={12} /> Quản trị viên hệ thống (ADMIN)
                  </span>
                ) : (
                  <span className="group-role-badge">Thành viên nhóm</span>
                )}
                <span>
                  <Calendar
                    size={12}
                    style={{ display: "inline", verticalAlign: "-2px" }}
                  />{" "}
                  Tạo lúc: {createdDate}
                </span>
                <span>
                  <Clock
                    size={12}
                    style={{ display: "inline", verticalAlign: "-2px" }}
                  />{" "}
                  Cập nhật: {updatedDate}
                </span>
              </div>
            </div>
          </div>

          <div className="group-detail-controls">
            {canManage && (
              <>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setShowEditDialog(true)}
                  title="Chỉnh sửa thông tin nhóm"
                >
                  <Settings2 size={16} /> Chỉnh sửa
                </button>
                <button
                  type="button"
                  className="button danger"
                  onClick={() => setShowDeleteDialog(true)}
                  title="Xóa mềm nhóm"
                >
                  <Trash2 size={16} /> Xóa nhóm
                </button>
              </>
            )}
          </div>
        </section>

        <h2
          style={{
            fontSize: "var(--type-section)",
            lineHeight: "var(--line-section)",
            fontWeight: "600",
            color: "var(--text)",
            margin: "32px 0 16px",
          }}
        >
          Không gian tính năng
        </h2>

        <div className="group-sections-grid">
          <div className="group-section-box">
            <div className="group-section-icon">
              <Video size={20} />
            </div>
            <div>
              <h3>Buổi học & Phòng trực tiếp</h3>
              <p>Lớp học trực tiếp của nhóm sẽ được bổ sung sau.</p>
            </div>
            <span className="badge">Sắp có</span>
          </div>

          <div className="group-section-box">
            <div className="group-section-icon">
              <Users size={20} />
            </div>
            <div>
              <h3>Thành viên & Phân quyền</h3>
              <p>Xem danh sách, tìm kiếm và quản lý vai trò thành viên.</p>
              <Link
                className="button secondary compact"
                href={`/workspace?groupId=${group.id}&tab=members`}
              >
                Quản lý thành viên
              </Link>
            </div>
            <span className="badge">T03</span>
          </div>

          <div className="group-section-box">
            <div className="group-section-icon">
              <Folder size={20} />
            </div>
            <div>
              <h3>Tài liệu & Bản ghi</h3>
              <p>
                Thư viện tài liệu và bản ghi riêng của nhóm sẽ được bổ sung sau.
              </p>
            </div>
            <span className="badge">Sắp có</span>
          </div>
        </div>
      </div>

      {showEditDialog && (
        <GroupFormDialog
          mode="edit"
          initialGroup={group}
          onClose={() => setShowEditDialog(false)}
          onSubmit={handleUpdate}
        />
      )}

      {showDeleteDialog && (
        <DeleteGroupDialog
          group={group}
          onClose={() => setShowDeleteDialog(false)}
          onConfirm={handleDelete}
        />
      )}
    </PageShell>
  );
}
