"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import { InlineNotice } from "@/components/common/feedback";
import { asApiError } from "@/lib/api";
import type { Group } from "@streamora/contracts";

interface DeleteGroupDialogProps {
  group: Group;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function DeleteGroupDialog({
  group,
  onClose,
  onConfirm,
}: DeleteGroupDialogProps) {
  const [pending, setPending] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string>();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleDelete() {
    if (pending) return;
    setPending(true);
    setErrorNotice(undefined);

    try {
      await onConfirm();
      onClose();
    } catch (err) {
      const apiErr = asApiError(err);
      setErrorNotice(apiErr.message);
      setPending(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-group-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <h2
            id="delete-group-title"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              color: "var(--danger)",
            }}
          >
            <AlertTriangle size={20} /> Xóa nhóm học tập
          </h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Đóng cửa sổ"
          >
            <X size={18} />
          </button>
        </div>

        {errorNotice && <InlineNotice tone="error">{errorNotice}</InlineNotice>}

        <p
          style={{
            color: "var(--text)",
            fontSize: "var(--type-body)",
            lineHeight: "var(--line-body)",
            margin: "0 0 16px",
          }}
        >
          Bạn có chắc chắn muốn xóa nhóm <strong>{group.name}</strong> không?
        </p>

        <div
          style={{
            background: "var(--danger-soft)",
            border: "1px solid var(--danger-border)",
            borderRadius: "8px",
            padding: "12px 16px",
            fontSize: "var(--type-secondary)",
            color: "var(--danger)",
            lineHeight: "var(--line-secondary)",
            marginBottom: "20px",
          }}
        >
          Nhóm sẽ được xóa mềm và ngừng xuất hiện trong danh sách hoạt động.
          Thao tác này giữ lại thông tin nhóm trong hệ thống.
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={pending}
          >
            Hủy bỏ
          </button>
          <button
            type="button"
            className="button danger"
            onClick={handleDelete}
            disabled={pending}
          >
            {pending ? (
              <>
                <LoaderCircle size={16} className="ui-spinner" />
                Đang xóa…
              </>
            ) : (
              "Xác nhận xóa"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
