"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { X, Users } from "lucide-react";
import { FormField } from "@/components/common/form-field";
import { InlineNotice, SubmitButton } from "@/components/common/feedback";
import { asApiError } from "@/lib/api";
import { GROUP_CONSTRAINTS } from "@streamora/contracts";
import type { Group } from "@streamora/contracts";

interface GroupFormDialogProps {
  mode: "create" | "edit";
  initialGroup?: Group;
  onClose: () => void;
  onSubmit: (
    data: { name: string; description: string },
    idempotencyKey: string,
  ) => Promise<void>;
}

export function GroupFormDialog({
  mode,
  initialGroup,
  onClose,
  onSubmit,
}: GroupFormDialogProps) {
  const [name, setName] = useState(initialGroup?.name ?? "");
  const [description, setDescription] = useState(
    initialGroup?.description ?? "",
  );
  const [nameError, setNameError] = useState<string>();
  const [errorNotice, setErrorNotice] = useState<string>();
  const [pending, setPending] = useState(false);
  const nameInputRef = useRef<HTMLDivElement>(null);
  const createRequest = useRef<{ body: string; key: string } | null>(null);

  // Focus trap and escape key
  useEffect(() => {
    nameInputRef.current?.querySelector("input")?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function validate(): boolean {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Vui lòng nhập tên nhóm học tập.");
      return false;
    }
    if (trimmed.length > GROUP_CONSTRAINTS.nameMaxLength) {
      setNameError(
        `Tên nhóm không được vượt quá ${GROUP_CONSTRAINTS.nameMaxLength} ký tự.`,
      );
      return false;
    }
    if (description.length > GROUP_CONSTRAINTS.descriptionMaxLength) {
      setErrorNotice(
        `Mô tả không được vượt quá ${GROUP_CONSTRAINTS.descriptionMaxLength} ký tự.`,
      );
      return false;
    }
    setNameError(undefined);
    setErrorNotice(undefined);
    return true;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validate() || pending) return;

    setPending(true);
    setErrorNotice(undefined);

    try {
      const data = {
        name: name.trim(),
        description: description.trim(),
      };
      const body = JSON.stringify(data);
      if (!createRequest.current || createRequest.current.body !== body) {
        createRequest.current = { body, key: crypto.randomUUID() };
      }
      await onSubmit(data, createRequest.current.key);
      onClose();
    } catch (err) {
      const apiErr = asApiError(err);
      if (apiErr.fields.name) setNameError(apiErr.fields.name);
      else setErrorNotice(apiErr.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-dialog-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <h2 id="group-dialog-title">
            {mode === "create"
              ? "Tạo nhóm học tập mới"
              : "Chỉnh sửa nhóm học tập"}
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

        <form onSubmit={handleSubmit} noValidate>
          <div ref={nameInputRef}>
            <FormField
              id="group-name"
              label="Tên nhóm học tập"
              required
              placeholder="VD: Điện toán đám mây K69"
              icon={<Users size={18} />}
              value={name}
              error={nameError}
              hint={`Từ ${GROUP_CONSTRAINTS.nameMinLength} đến ${GROUP_CONSTRAINTS.nameMaxLength} ký tự.`}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(undefined);
              }}
            />
          </div>

          <div className="form-field">
            <label htmlFor="group-description">Mô tả nhóm (tuỳ chọn)</label>
            <div className="form-input-wrap">
              <input
                id="group-description"
                placeholder="VD: Nhóm học tập, thảo luận đồ án và buổi học trực tiếp"
                value={description}
                maxLength={GROUP_CONSTRAINTS.descriptionMaxLength}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <span className="form-field-hint">
              Tối đa {GROUP_CONSTRAINTS.descriptionMaxLength} ký tự.
            </span>
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
            <SubmitButton
              pending={pending}
              pendingLabel={mode === "create" ? "Đang tạo…" : "Đang lưu…"}
            >
              {mode === "create" ? "Tạo nhóm" : "Lưu thay đổi"}
            </SubmitButton>
          </div>
        </form>
      </div>
    </div>
  );
}
