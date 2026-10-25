"use client";

import { useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  CircleCheck,
  LockKeyhole,
  Mail,
  UserRound,
} from "lucide-react";
import type { RegisterResponse } from "@streamora/contracts";
import { asAuthError, authRequest } from "@/lib/auth/api";
import {
  nameError,
  validateCredentials,
  type FieldErrors,
} from "@/lib/auth/validation";
import { useAuth } from "./auth-provider";
import { AuthFrame } from "./auth-ui";
import { safeReturnTo } from "@/lib/auth/return-to";
import { FormField } from "@/components/common/form-field";
import {
  InlineNotice,
  LoadingState,
  SubmitButton,
} from "@/components/common/feedback";

export type AuthMode = "login" | "register";

function loginDestination() {
  return safeReturnTo(new URLSearchParams(window.location.search).get("next"));
}

function AuthModeAction({
  mode,
  onModeChange,
  children,
  className,
  active,
}: {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  children: ReactNode;
  className?: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-pressed={active}
      onClick={() => onModeChange(mode)}
    >
      {children}
    </button>
  );
}

export function AuthForm({
  mode,
  embedded = false,
  onModeChange,
}: {
  mode: AuthMode;
  embedded?: boolean;
  onModeChange?: (mode: AuthMode) => void;
}) {
  const Frame = embedded ? Fragment : AuthFrame;
  const [localMode, setLocalMode] = useState(mode);
  const activeMode = onModeChange ? mode : localMode;
  const registering = activeMode === "register";
  const router = useRouter();
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [registered, setRegistered] = useState(false);
  const busy = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  useEffect(() => setLocalMode(mode), [mode]);
  useEffect(() => {
    if (
      !embedded &&
      (window.location.pathname === "/login" ||
        window.location.pathname === "/register")
    )
      window.history.replaceState(null, "", `/auth${window.location.search}`);
  }, [embedded]);
  useEffect(() => {
    if (!embedded)
      document.title = `${registering ? "Đăng ký" : "Đăng nhập"} — Streamora`;
  }, [embedded, registering]);
  useEffect(() => {
    if (auth.phase === "authenticated") router.replace(loginDestination());
  }, [auth.phase, router]);
  function changeMode(nextMode: AuthMode) {
    if (nextMode === activeMode) return;
    setErrors({});
    setMessage("");
    setRegistered(false);
    if (onModeChange) {
      onModeChange(nextMode);
      return;
    }
    setLocalMode(nextMode);
  }
  function edit(field: keyof FieldErrors, value: string) {
    ({ email: setEmail, password: setPassword, fullName: setFullName })[field](
      value,
    );
    setErrors((current) => ({ ...current, [field]: undefined }));
    setMessage("");
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || auth.phase === "checking") return;
    const invalid = validateCredentials(email, password, registering);
    if (registering) invalid.fullName = nameError(fullName);
    setErrors(invalid);
    setMessage("");
    if (Object.values(invalid).some(Boolean)) {
      requestAnimationFrame(() =>
        form.current
          ?.querySelector<HTMLInputElement>('[aria-invalid="true"]')
          ?.focus(),
      );
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      const credentials = { email: email.trim().toLowerCase(), password };
      if (registering) {
        await authRequest<RegisterResponse>("/auth/register", {
          body: { ...credentials, fullName: fullName.trim() },
        });
        setPassword("");
        setRegistered(true);
      } else {
        await auth.login(credentials);
        setPassword("");
        router.replace(loginDestination());
      }
    } catch (error) {
      const failure = asAuthError(error);
      setErrors(failure.fields);
      setMessage(failure.message);
      requestAnimationFrame(() => alert.current?.focus());
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  if (auth.phase === "authenticated")
    return (
      <Frame>
        <LoadingState message="Đang mở không gian học tập…" />
      </Frame>
    );
  if (registered)
    return (
      <Frame>
        <div className="auth-form-content auth-registration-success">
          <span className="auth-success-mark">
            <CircleCheck size={30} />
          </span>
          <span className="eyebrow">SẴN SÀNG KẾT NỐI</span>
          <h1>Tạo tài khoản thành công!</h1>
          <p>
            Tài khoản của bạn đã sẵn sàng. Đăng nhập để vào không gian học tập
            và kết nối với cộng đồng.
          </p>
          <AuthModeAction
            mode="login"
            onModeChange={changeMode}
            className="button primary auth-submit"
          >
            Đăng nhập ngay <ArrowRight size={17} />
          </AuthModeAction>
        </div>
      </Frame>
    );
  return (
    <Frame>
      <div className="auth-form-content">
        <span className="auth-section-label">
          <span /> TÀI KHOẢN STREAMORA
        </span>
        <h1>{registering ? "Bắt đầu từ đây." : "Chào mừng trở lại."}</h1>
        <p className="auth-intro">
          {registering
            ? "Tạo tài khoản để bắt đầu hành trình cùng cộng đồng."
            : "Đăng nhập để tiếp tục hành trình của bạn."}
        </p>
        <div className="auth-tabs" aria-label="Tài khoản">
          <AuthModeAction
            mode="login"
            onModeChange={changeMode}
            className={!registering ? "active" : ""}
            active={!registering}
          >
            Đăng nhập
          </AuthModeAction>
          <AuthModeAction
            mode="register"
            onModeChange={changeMode}
            className={registering ? "active" : ""}
            active={registering}
          >
            Tạo tài khoản
          </AuthModeAction>
        </div>
        {auth.notice && !message && (
          <InlineNotice tone={auth.phase === "error" ? "error" : "info"}>
            {auth.notice}
          </InlineNotice>
        )}
        {message && (
          <InlineNotice tone="error" ref={alert} tabIndex={-1}>
            {message}
          </InlineNotice>
        )}
        <form
          className="ui-form"
          onSubmit={submit}
          noValidate
          ref={form}
          aria-busy={pending}
        >
          <fieldset disabled={pending || auth.phase === "checking"}>
            {registering && (
              <FormField
                id="register-name"
                name="fullName"
                label="Họ và tên"
                autoComplete="name"
                placeholder="Nguyễn Minh Anh"
                icon={<UserRound size={18} />}
                value={fullName}
                onChange={(event) => edit("fullName", event.target.value)}
                error={errors.fullName}
                required
              />
            )}
            <FormField
              id={`${activeMode}-email`}
              name="email"
              label="Email"
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="ban@example.com"
              icon={<Mail size={18} />}
              value={email}
              onChange={(event) => edit("email", event.target.value)}
              error={errors.email}
              required
            />
            <FormField
              id={`${activeMode}-password`}
              name="password"
              label="Mật khẩu"
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              placeholder={
                registering ? "Tạo mật khẩu của bạn" : "Nhập mật khẩu"
              }
              icon={<LockKeyhole size={18} />}
              value={password}
              onChange={(event) => edit("password", event.target.value)}
              error={errors.password}
              hint={registering ? "Sử dụng từ 12 đến 128 ký tự." : undefined}
              required
            />
            <SubmitButton
              className="auth-submit"
              pending={pending || auth.phase === "checking"}
              pendingLabel={
                auth.phase === "checking"
                  ? "Đang kiểm tra phiên…"
                  : registering
                    ? "Đang tạo tài khoản…"
                    : "Đang đăng nhập…"
              }
            >
              {registering ? "Tạo tài khoản" : "Đăng nhập"}
              <ArrowRight size={17} />
            </SubmitButton>
          </fieldset>
        </form>
        <p className="auth-switch">
          {registering ? "Đã có tài khoản?" : "Chưa có tài khoản?"}{" "}
          <AuthModeAction
            mode={registering ? "login" : "register"}
            onModeChange={changeMode}
          >
            {registering ? "Đăng nhập" : "Đăng ký ngay"}
            <ArrowRight size={13} />
          </AuthModeAction>
        </p>
      </div>
    </Frame>
  );
}
