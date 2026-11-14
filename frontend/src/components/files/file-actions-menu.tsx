"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MoreVertical } from "lucide-react";

export function FileActionsMenu({
  label,
  disabled = false,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const menu = popup.current;
    if (!menu) return;
    if (!open || disabled) {
      if (menu.matches(":popover-open")) menu.hidePopover();
      return;
    }
    if (!menu.matches(":popover-open")) menu.showPopover();
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const top =
        anchor.bottom + 6 + menu.offsetHeight <= window.innerHeight - 8
          ? anchor.bottom + 6
          : anchor.top - menu.offsetHeight - 6;
      menu.style.top = `${Math.max(8, top)}px`;
      menu.style.left = `${Math.max(8, Math.min(anchor.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
    };
    position();
    const items = menu.querySelectorAll<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    );
    (focusLast.current ? items[items.length - 1] : items[0])?.focus({
      preventScroll: true,
    });
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, disabled]);

  return (
    <span className="library-action-menu">
      <button
        ref={trigger}
        type="button"
        className="library-action-trigger"
        aria-label={label}
        title="Thao tác khác"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        popoverTarget={id}
        disabled={disabled}
        onClick={() => {
          focusLast.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          focusLast.current = event.key === "ArrowUp";
          setOpen(true);
        }}
      >
        <MoreVertical size={20} />
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        className="library-action-dropdown"
        onToggle={(event) =>
          setOpen((event.nativeEvent as ToggleEvent).newState === "open")
        }
        onClick={(event) => {
          if (
            !(event.target as HTMLElement).closest(
              'button[role="menuitem"]:not(:disabled)',
            )
          )
            return;
          setOpen(false);
          popup.current?.hidePopover();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
          } else if (
            ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          ) {
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                'button[role="menuitem"]:not(:disabled)',
              ),
            );
            const current = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                    items.length;
            items[next]?.focus({ preventScroll: true });
          }
        }}
      >
        {children}
      </div>
    </span>
  );
}
