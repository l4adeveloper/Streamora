"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search, Users, X, RefreshCw } from "lucide-react";
import { PageShell } from "@/components/shell/page-shell";
import {
  EmptyState,
  LoadingState,
  RequestError,
} from "@/components/common/feedback";
import { useToast } from "@/components/common/toast-provider";
import { GroupCard } from "./group-card";
import { GroupFormDialog } from "./group-form-dialog";
import { DeleteGroupDialog } from "./delete-group-dialog";
import {
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
} from "@/lib/groups/api";
import type { Group } from "@streamora/contracts";
import "./groups.css";

export function GroupsListPage() {
  const { notify } = useToast();
  const [groups, setGroups] = useState<Group[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [searchDraft, setSearchDraft] = useState("");

  // Modals state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<Group | null>(null);

  // Debounced search
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const handleSearchChange = (val: string) => {
    setSearchDraft(val);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setQuery(val.trim());
    }, 350);
  };

  const fetchGroups = useCallback(async (searchQuery: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await listGroups({
        q: searchQuery || undefined,
        limit: 12,
      });
      setGroups(res.items);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGroups(query);
  }, [fetchGroups, query]);

  // Load more via cursor pagination
  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await listGroups({
        q: query || undefined,
        cursor: nextCursor,
        limit: 12,
      });
      setGroups((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      notify("Chưa thể tải thêm nhóm. Vui lòng thử lại.", { tone: "error" });
    } finally {
      setLoadingMore(false);
    }
  };

  // Actions
  const handleCreate = async (data: { name: string; description?: string }) => {
    const res = await createGroup(data);
    setGroups((prev) => [res.group, ...prev]);
    notify(`Đã tạo nhóm "${res.group.name}" thành công!`, { tone: "success" });
  };

  const handleUpdate = async (data: { name: string; description?: string }) => {
    if (!editingGroup) return;
    const res = await updateGroup(editingGroup.id, data);
    setGroups((prev) =>
      prev.map((g) => (g.id === res.group.id ? res.group : g)),
    );
    notify(`Đã cập nhật nhóm "${res.group.name}".`, { tone: "success" });
  };

  const handleDelete = async () => {
    if (!deletingGroup) return;
    await deleteGroup(deletingGroup.id);
    setGroups((prev) => prev.filter((g) => g.id !== deletingGroup.id));
    notify(`Đã xóa nhóm "${deletingGroup.name}".`, { tone: "info" });
  };

  return (
    <PageShell
      title="Nhóm học tập của bạn"
      description="Tạo và quản lý các nhóm học tập, lịch học trực tiếp và tài liệu cộng tác."
      eyebrow="KHÔNG GIAN NHÓM"
      breadcrumb="Nhóm học tập"
    >
      <div className="groups-page-container">
        <div className="groups-toolbar">
          <div className="groups-search-box">
            <Search size={16} className="groups-search-icon" aria-hidden="true" />
            <input
              type="text"
              placeholder="Tìm kiếm nhóm theo tên…"
              value={searchDraft}
              onChange={(e) => handleSearchChange(e.target.value)}
              aria-label="Tìm kiếm nhóm"
            />
            {searchDraft && (
              <button
                type="button"
                className="groups-search-clear"
                onClick={() => {
                  setSearchDraft("");
                  setQuery("");
                }}
                aria-label="Xóa từ khóa tìm kiếm"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className="groups-actions">
            <button
              type="button"
              className="button secondary compact"
              onClick={() => fetchGroups(query)}
              title="Làm mới danh sách"
            >
              <RefreshCw size={14} /> Làm mới
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => setShowCreateDialog(true)}
            >
              <Plus size={16} /> Tạo nhóm mới
            </button>
          </div>
        </div>

        {loading ? (
          <LoadingState message="Đang tải danh sách nhóm học tập…" />
        ) : error ? (
          <RequestError error={error} onRetry={() => fetchGroups(query)} />
        ) : groups.length === 0 ? (
          <EmptyState
            title={query ? "Không tìm thấy nhóm phù hợp" : "Chưa có nhóm học tập nào"}
            description={
              query
                ? `Không có nhóm nào khớp với từ khóa "${query}". Hãy thử từ khóa khác.`
                : "Bạn chưa tham gia hoặc tạo nhóm học tập nào. Hãy tạo nhóm đầu tiên để mời mọi người và bắt đầu buổi học!"
            }
          >
            {query ? (
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setSearchDraft("");
                  setQuery("");
                }}
              >
                Xóa tìm kiếm
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                onClick={() => setShowCreateDialog(true)}
              >
                <Plus size={16} /> Tạo nhóm đầu tiên
              </button>
            )}
          </EmptyState>
        ) : (
          <>
            <div className="groups-grid">
              {groups.map((group) => (
                <GroupCard
                  key={group.id}
                  group={group}
                  onEdit={(g) => setEditingGroup(g)}
                  onDelete={(g) => setDeletingGroup(g)}
                />
              ))}
            </div>

            {nextCursor && (
              <div className="pagination-footer">
                <button
                  type="button"
                  className="button secondary"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Đang tải thêm…" : "Tải thêm nhóm"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {showCreateDialog && (
        <GroupFormDialog
          mode="create"
          onClose={() => setShowCreateDialog(false)}
          onSubmit={handleCreate}
        />
      )}

      {editingGroup && (
        <GroupFormDialog
          mode="edit"
          initialGroup={editingGroup}
          onClose={() => setEditingGroup(null)}
          onSubmit={handleUpdate}
        />
      )}

      {deletingGroup && (
        <DeleteGroupDialog
          group={deletingGroup}
          onClose={() => setDeletingGroup(null)}
          onConfirm={handleDelete}
        />
      )}
    </PageShell>
  );
}
