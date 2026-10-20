"use client";
// Copied into the isolated test build only.
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { FormField } from "@/components/common/form-field";
import {
  InlineNotice,
  LoadingState,
  RequestError,
  SubmitButton,
} from "@/components/common/feedback";
import { useToast } from "@/components/common/toast-provider";
import { PageShell } from "@/components/shell/page-shell";
import { apiRequest, asApiError } from "@/lib/api";

export default function ShellProbe() {
  const { notify } = useToast();
  const count = useRef(0);
  const busy = useRef(false);
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [readPending, setReadPending] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFieldError(undefined);
    try {
      await apiRequest("/users/me", {
        method: "PATCH",
        body: { fullName: name },
      });
      notify("Đã lưu biểu mẫu.", { tone: "success" });
    } catch (reason) {
      setFieldError(asApiError(reason).fields.title);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function read() {
    setReadPending(true);
    setError(undefined);
    try {
      await apiRequest("/users/me");
    } catch (reason) {
      setError(reason);
    } finally {
      setReadPending(false);
    }
  }
  return (
    <PageShell title="Giao diện dùng chung" breadcrumb="Kiểm thử">
      <InlineNotice>Thông tin thử nghiệm.</InlineNotice>
      <form className="ui-form" noValidate onSubmit={save} aria-busy={pending}>
        <fieldset disabled={pending}>
          <FormField
            id="probe-title"
            label="Tiêu đề"
            hint="Nhập tiêu đề của bạn."
            error={fieldError}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <SubmitButton pending={pending} pendingLabel="Đang gửi biểu mẫu…">
            Ghi biểu mẫu
          </SubmitButton>
        </fieldset>
      </form>
      <button
        onClick={() =>
          notify(`Thông báo ${++count.current}`, { tone: "success" })
        }
      >
        Thêm thông báo
      </button>
      <button onClick={() => notify("Lỗi cần xem lại.", { tone: "error" })}>
        Thông báo lỗi
      </button>
      <button onClick={read} disabled={readPending}>
        Đọc tài nguyên
      </button>
      {readPending && <LoadingState />}
      {error !== undefined && <RequestError error={error} onRetry={read} />}
      <Link href="/">Về trang chủ thử nghiệm</Link>
    </PageShell>
  );
}
