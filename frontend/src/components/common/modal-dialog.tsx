"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import "./modal-dialog.css";

export function ModalDialog({
  title,
  description,
  children,
  footer,
  className = "",
  onClose,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!mounted) return;
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, [mounted]);
  if (!mounted) return null;
  return createPortal(
    <dialog
      ref={dialog}
      className={`ui-modal-dialog ${className}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button, a[href], input, select, textarea, [tabindex]",
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled") &&
            element.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="ui-modal-heading">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p id={`${id}-description`}>{description}</p>}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={`Đóng ${title.toLocaleLowerCase("vi-VN")}`}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="ui-modal-body">{children}</div>
      {footer && <footer className="ui-modal-footer">{footer}</footer>}
    </dialog>,
    document.body,
  );
}
