"use client";
import { useRef, useState, type FormEvent } from "react";
import type {
  ClassSession,
  UpdateClassSessionRequest,
} from "@streamora/contracts";
import { FormField } from "@/components/common/form-field";
import { InlineNotice, SubmitButton } from "@/components/common/feedback";
import { asApiError } from "@/lib/api";
import { localDateInput, utcDateInput } from "@/lib/class-sessions/display";

export function SessionForm({
  group = false,
  initial,
  label,
  onSave,
  locked = false,
}: {
  group?: boolean;
  initial?: ClassSession;
  label: string;
  locked?: boolean;
  onSave: (
    body: UpdateClassSessionRequest & { title: string },
    key: string,
  ) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [scheduledAt, setSchedule] = useState(
    localDateInput(initial?.scheduledAt ?? null),
  );
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false),
    form = useRef<HTMLFormElement>(null);
  const intent = useRef<{ body: string; key: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    const invalid: Record<string, string> = {};
    if (!title.trim() || title.trim().length > 100)
      invalid.title = "Nhập tên từ 1 đến 100 ký tự.";
    if (description.length > 2000)
      invalid.description = "Mô tả tối đa 2000 ký tự.";
    const utc = scheduledAt ? utcDateInput(scheduledAt) : null;
    if ((group && !scheduledAt) || (scheduledAt && !utc))
      invalid.scheduledAt = "Chọn ngày và giờ hợp lệ.";
    setFields(invalid);
    setError("");
    if (Object.keys(invalid).length) {
      requestAnimationFrame(() =>
        form.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus(),
      );
      return;
    }
    busy.current = true;
    setPending(true);
    const body = {
      title: title.trim(),
      description: description.trim() || (initial ? null : undefined),
      scheduledAt: utc ?? (initial ? null : undefined),
    };
    const signature = JSON.stringify(body);
    if (!intent.current || intent.current.body !== signature)
      intent.current = { body: signature, key: crypto.randomUUID() };
    try {
      await onSave(body, intent.current.key);
    } catch (error) {
      const failure = asApiError(error);
      setFields(failure.fields);
      setError(failure.message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <form
      ref={form}
      className="ui-form class-session-form"
      onSubmit={submit}
      noValidate
      aria-busy={pending}
    >
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <fieldset disabled={pending}>
        <FormField
          id="class-title"
          label={group ? "Tên buổi học" : "Tên cuộc họp"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={100}
          error={fields.title}
          disabled={locked}
        />
        <div className="form-field">
          <label htmlFor="class-description">Mô tả (tùy chọn)</label>
          <textarea
            id="class-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={3}
            disabled={locked}
            aria-invalid={!!fields.description}
            aria-describedby={
              fields.description ? "class-description-error" : undefined
            }
          />
          {fields.description && (
            <span className="form-field-error" id="class-description-error">
              {fields.description}
            </span>
          )}
        </div>
        <FormField
          id="class-scheduled"
          type="datetime-local"
          label={group ? "Thời gian dự kiến" : "Thời gian dự kiến (tùy chọn)"}
          value={scheduledAt}
          onChange={(e) => setSchedule(e.target.value)}
          required={group}
          disabled={locked}
          error={fields.scheduledAt}
          hint="Theo giờ trên thiết bị của bạn. Buổi học chỉ mở khi người quản lý bấm bắt đầu."
        />
        <SubmitButton pending={pending} pendingLabel="Đang lưu…">
          {label}
        </SubmitButton>
      </fieldset>
    </form>
  );
}
