"use client";

import { useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";

type FormFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  icon?: ReactNode;
};

export function FormField({
  id,
  label,
  error,
  hint,
  icon,
  type,
  className,
  ...props
}: FormFieldProps) {
  const [visible, setVisible] = useState(false);
  const password = type === "password";
  const describedBy =
    [props["aria-describedby"], hint && `${id}-hint`, error && `${id}-error`]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <div
        className={`form-input-wrap ${icon ? "with-icon" : ""} ${password ? "with-toggle" : ""} ${error ? "has-error" : ""}`}
      >
        {icon && (
          <span className="form-field-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <input
          {...props}
          id={id}
          className={className}
          type={password && visible ? "text" : type}
          aria-invalid={error ? true : props["aria-invalid"]}
          aria-describedby={describedBy}
        />
        {password && (
          <button
            type="button"
            className="form-password-toggle"
            aria-label={visible ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
            aria-pressed={visible}
            disabled={props.disabled}
            onClick={() => setVisible(!visible)}
          >
            {visible ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        )}
      </div>
      {hint && (
        <span className="form-field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="form-field-error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}
