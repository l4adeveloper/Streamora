"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useAuth } from "@/components/auth/auth-provider";

type Tone = "info" | "success" | "error";
type Toast = { id: number; message: string; tone: Tone; owner: string | null };
type ToastContextValue = {
  notify(message: string, options?: { tone?: Tone }): void;
  dismiss(id: number): void;
};
const ToastContext = createContext<ToastContextValue | null>(null);

function ToastItem({
  toast,
  dismiss,
}: {
  toast: Toast;
  dismiss(id: number): void;
}) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || toast.tone === "error") return;
    const timer = setTimeout(() => dismiss(toast.id), 5000);
    return () => clearTimeout(timer);
  }, [paused, toast.id, toast.tone, dismiss]);
  const Icon =
    toast.tone === "error"
      ? TriangleAlert
      : toast.tone === "success"
        ? CircleCheck
        : Info;
  return (
    <div
      className={`app-toast ${toast.tone}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setPaused(false);
      }}
    >
      <Icon size={18} aria-hidden="true" />
      <span role={toast.tone === "error" ? "alert" : "status"}>
        {toast.message}
      </span>
      <button
        type="button"
        aria-label="Đóng thông báo"
        onClick={() => dismiss(toast.id)}
      >
        <X size={16} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const owner = user?.id ?? null;
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sequence = useRef(0);
  const dismiss = useCallback(
    (id: number) =>
      setToasts((current) => current.filter((item) => item.id !== id)),
    [],
  );
  useEffect(() => {
    setToasts([]);
  }, [owner]);
  const notify = useCallback(
    (message: string, options?: { tone?: Tone }) => {
      if (currentOwner.current !== owner) return;
      const toast = {
        id: ++sequence.current,
        message,
        tone: options?.tone ?? "info",
        owner,
      };
      setToasts((current) =>
        [...current.filter((item) => item.owner === owner), toast].slice(-3),
      );
    },
    [owner],
  );
  return (
    <ToastContext.Provider value={{ notify, dismiss }}>
      {children}
      <div
        className="toast-stack"
        role="region"
        aria-label="Thông báo"
        tabIndex={-1}
      >
        {toasts
          .filter((toast) => toast.owner === owner)
          .map((toast) => (
            <ToastItem key={toast.id} toast={toast} dismiss={dismiss} />
          ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast requires ToastProvider");
  return value;
}
