"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  ChevronRight,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Avatar } from "@/components/ui";
import { asAuthError } from "@/lib/auth/api";
import { nameError } from "@/lib/auth/validation";
import { useAuth } from "./auth-provider";
import { FormField } from "@/components/common/form-field";
import { InlineNotice, SubmitButton } from "@/components/common/feedback";
import { useToast } from "@/components/common/toast-provider";
import { PageShell } from "@/components/shell/page-shell";

export function AccountPage() {
  const auth = useAuth();
  const { notify } = useToast();
  const router = useRouter();
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<"save" | "logout" | null>(null);
  const busy = useRef(false);
  const input = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (auth.user) setName(auth.user.fullName);
  }, [auth.user?.id, auth.user?.fullName]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const invalid = nameError(name);
    setFieldError(invalid);
    setMessage("");
    if (invalid) {
      input.current?.querySelector("input")?.focus();
      return;
    }
    busy.current = true;
    setPending("save");
    try {
      await auth.updateProfile({ fullName: name.trim() });
      notify("Đã cập nhật họ và tên.", { tone: "success" });
    } catch (error) {
      const failure = asAuthError(error);
      setFieldError(failure.fields.fullName);
      setMessage(failure.message);
    } finally {
      busy.current = false;
      setPending(null);
    }
  }
  async function logout() {
    if (busy.current) return;
    busy.current = true;
    setPending("logout");
    setMessage("");
    try {
      await auth.logout();
      router.replace("/auth");
    } catch (error) {
      setMessage(asAuthError(error).message);
    } finally {
      busy.current = false;
      setPending(null);
    }
  }
  const user = auth.user;
  const initials =
    user?.fullName
      .trim()
      .split(/\s+/)
      .slice(-2)
      .map((part) => Array.from(part)[0])
      .join("")
      .toUpperCase() ?? "";
  return (
    <PageShell
      title="Tài khoản của bạn"
      description="Một vài thông tin để mọi người biết đến bạn hơn."
      eyebrow="KHÔNG GIAN CỦA BẠN"
      breadcrumb="Tài khoản"
    >
      {user && (
        <>
          <div className="account-grid">
            <aside className="account-summary">
              <Avatar initials={initials} />
              <h2>{user.fullName}</h2>
              <p>{user.email}</p>
              <span className="account-role">
                <span className="status-dot" />
                {user.globalRole === "ADMIN"
                  ? "Quản trị viên"
                  : "Thành viên Streamora"}
              </span>
              <div className="account-summary-rule" />
              <span className="account-nav-item">
                <UserRound size={17} /> Hồ sơ cá nhân <ChevronRight size={15} />
              </span>
            </aside>
            <div className="account-details">
              <section className="account-card">
                <div className="account-card-heading">
                  <span className="account-card-icon">
                    <UserRound size={21} />
                  </span>
                  <div>
                    <h2>Thông tin cá nhân</h2>
                    <p>Cập nhật cách tên bạn hiển thị trong cộng đồng.</p>
                  </div>
                </div>
                {message && <InlineNotice tone="error">{message}</InlineNotice>}
                <form
                  className="ui-form"
                  onSubmit={save}
                  noValidate
                  aria-busy={pending === "save"}
                >
                  <fieldset disabled={Boolean(pending)}>
                    <div ref={input}>
                      <FormField
                        id="account-name"
                        name="fullName"
                        label="Họ và tên"
                        autoComplete="name"
                        icon={<UserRound size={18} />}
                        value={name}
                        error={fieldError}
                        hint="Từ 1 đến 100 ký tự."
                        required
                        onChange={(event) => {
                          setName(event.target.value);
                          setFieldError(undefined);
                          setMessage("");
                        }}
                      />
                    </div>
                    <FormField
                      id="account-email"
                      label="Email"
                      type="email"
                      icon={<Mail size={18} />}
                      value={user.email}
                      readOnly
                      hint="Email được liên kết với tài khoản của bạn."
                    />
                    <div className="account-save">
                      <span>Thông tin chỉ được lưu khi bạn xác nhận.</span>
                      <SubmitButton
                        pending={pending === "save"}
                        pendingLabel="Đang lưu…"
                        disabled={name.trim() === user.fullName}
                      >
                        <Check size={16} /> Lưu thay đổi
                      </SubmitButton>
                    </div>
                  </fieldset>
                </form>
              </section>
              <section className="account-card account-session">
                <span className="account-card-icon">
                  <LockKeyhole size={21} />
                </span>
                <div>
                  <h2>Phiên đăng nhập</h2>
                  <p>Đăng xuất khỏi phiên hiện tại khi bạn dùng xong.</p>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  onClick={logout}
                  disabled={Boolean(pending)}
                >
                  {pending === "logout" ? (
                    <LoaderCircle size={16} className="ui-spinner" />
                  ) : (
                    <LogOut size={16} />
                  )}
                  {pending === "logout" ? "Đang đăng xuất…" : "Đăng xuất"}
                </button>
              </section>
            </div>
          </div>
          <p className="account-footnote">
            <ShieldCheck size={14} /> Mọi kết nối đều bắt đầu từ bạn.
          </p>
        </>
      )}
    </PageShell>
  );
}
