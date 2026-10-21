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
          <h2 id="delete-group-title" style={{ display: "flex", alignItems: "center", gap: "8px", color: "#f87171" }}>
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

        <p style={{ color: "#d2c8df", fontSize: "13px", lineHeight: "1.7", margin: "0 0 16px" }}>
          Bạn có chắc chắn muốn xóa nhóm <strong>{group.name}</strong> không?
        </p>

        <div
          style={{
            background: "#2a151b",
            border: "1px solid #5c202a",
            borderRadius: "8px",
            padding: "12px 14px",
            fontSize: "12px",
            color: "#fca5a5",
            lineHeight: "1.6",
            marginBottom: "20px",
          }}
        >
          Nhóm sẽ được xóa mềm và ngừng xuất hiện trong danh sách hoạt động.
          Dữ liệu và lịch sử các buổi học trước đó sẽ được lưu trữ an toàn theo chính sách hệ thống.
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
