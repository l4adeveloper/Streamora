"use client";

import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { asApiError } from "@/lib/api";

export function LoadingState({
  message = "Đang tải dữ liệu…",
}: {
  message?: string;
}) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle size={24} className="ui-spinner" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

export function InlineNotice({
  tone = "info",
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  tone?: "info" | "success" | "error";
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      {...props}
      className={`inline-notice ${tone} ${className}`}
      role={tone === "error" ? "alert" : "status"}
    />
  );
}

export function SubmitButton({
  pending = false,
  pendingLabel = "Đang xử lý…",
  children,
  disabled,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  pending?: boolean;
  pendingLabel?: string;
}) {
  return (
    <button
      {...props}
      type={props.type ?? "submit"}
      className={`button primary ${className}`}
      disabled={disabled || pending}
      aria-busy={pending}
    >
      {pending ? (
        <>
          <LoaderCircle size={17} className="ui-spinner" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="content-state">
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </section>
  );
}

export function ErrorState({
  title = "Chưa thể tải nội dung",
  description,
  onRetry,
  children,
}: {
  title?: string;
  description: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="content-state">
      <h2>{title}</h2>
      <p role="alert">{description}</p>
      <div className="content-state-actions">
        {onRetry && (
          <button type="button" className="button primary" onClick={onRetry}>
            Thử lại
          </button>
        )}
        {children}
      </div>
    </section>
  );
}

export function RequestError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const failure = asApiError(error);
  return (
    <ErrorState
      title={failure.status === 403 ? "Bạn chưa có quyền truy cập" : undefined}
      description={failure.message}
      onRetry={
        failure.status === 401 || failure.status === 403 ? undefined : onRetry
      }
    >
      {failure.status === 401 && (
        <Link href="/login" className="button secondary">
          Đăng nhập
        </Link>
      )}
    </ErrorState>
  );
}
