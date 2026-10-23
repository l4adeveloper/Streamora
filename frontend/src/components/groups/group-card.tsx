"use client";

import Link from "next/link";
import { Crown, ArrowRight, ShieldCheck, Calendar } from "lucide-react";
import type { Group } from "@streamora/contracts";
import { useAuth } from "@/components/auth/auth-provider";

interface GroupCardProps {
  group: Group;
  onEdit?: (group: Group) => void;
  onDelete?: (group: Group) => void;
}

export function GroupCard({ group, onEdit, onDelete }: GroupCardProps) {
  const { user } = useAuth();
  const isOwner = user?.id === group.ownerId;
  const isAdmin = user?.globalRole === "ADMIN";
  const canManage = isOwner || isAdmin;

  // Initials for avatar
  const initials = group.name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase() || "GR";

  const formattedDate = new Intl.DateTimeFormat("vi-VN", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).format(new Date(group.createdAt));

  return (
    <div className="group-card">
      <div>
        <div className="group-card-top">
          <div className="group-avatar" aria-hidden="true">
            {initials}
          </div>
          <div className="group-card-info">
            <h3 className="group-card-title">
              <Link href={`/groups/${group.id}`}>{group.name}</Link>
            </h3>
            <div className="group-card-meta-top">
              {isOwner ? (
                <span className="group-role-badge owner">
                  <Crown size={12} /> Chủ nhóm
                </span>
              ) : isAdmin ? (
                <span className="group-role-badge">
                  <ShieldCheck size={12} /> Quản trị viên
                </span>
              ) : (
                <span className="group-role-badge">Thành viên</span>
              )}
            </div>
          </div>
        </div>

        <p className="group-card-desc">
          {group.description || "Chưa có mô tả cho nhóm học tập này."}
        </p>
      </div>

      <div>
        <div className="group-card-meta">
          <span className="group-card-date" style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <Calendar size={12} /> {formattedDate}
          </span>
          {canManage && (
            <div style={{ display: "flex", gap: "8px" }}>
              {onEdit && (
                <button
                  type="button"
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--accent)",
                    fontSize: "var(--type-secondary)",
                    lineHeight: "var(--line-secondary)",
                    minHeight: "32px",
                    cursor: "pointer",
                    padding: 0,
                  }}
                  onClick={() => onEdit(group)}
                >
                  Sửa
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--danger)",
                    fontSize: "var(--type-secondary)",
                    lineHeight: "var(--line-secondary)",
                    minHeight: "32px",
                    cursor: "pointer",
                    padding: 0,
                  }}
                  onClick={() => onDelete(group)}
                >
                  Xóa
                </button>
              )}
            </div>
          )}
        </div>

        <div className="group-card-actions">
          <Link
            href={`/groups/${group.id}`}
            className="button secondary compact"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
          >
            Chi tiết nhóm <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  );
}
