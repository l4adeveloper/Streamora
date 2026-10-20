"use client";
// Copied into the isolated test build only. Never part of apps/web or a deployed route.
import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth/auth-provider";
import { authenticatedRequest } from "@/lib/auth/session";
import { asAuthError } from "@/lib/auth/api";
import type { UserResponse } from "@streamora/contracts";

export default function ProbePage() {
  const auth = useAuth();
  const [result, setResult] = useState("");
  const [name, setName] = useState("");
  async function many() {
    setResult("pending");
    const responses = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        authenticatedRequest<UserResponse>("/users/me"),
      ),
    );
    setResult(
      responses
        .map((response) =>
          response.status === "fulfilled"
            ? "ok"
            : asAuthError(response.reason).code,
        )
        .join(","),
    );
  }
  async function mutate() {
    setResult("pending");
    try {
      const body = { fullName: name };
      const options: { method: "PATCH" | "DELETE"; body: typeof body } = {
        method: "PATCH",
        body,
      };
      const request = authenticatedRequest("/users/me", options);
      // The shared client must retain the original payload even if its caller mutates it.
      body.fullName = "Caller mutated after dispatch";
      options.method = "DELETE";
      await request;
      setResult("saved");
    } catch (error) {
      setResult(asAuthError(error).code);
    }
  }
  return (
    <main>
      <h1>Session probe</h1>
      <p data-testid="phase">{auth.phase}</p>
      <p data-testid="user">{auth.user?.email ?? "guest"}</p>
      <button type="button" onClick={many} disabled={!auth.user}>
        Gửi 3 yêu cầu
      </button>
      <label>
        Tên thử nghiệm
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <button type="button" onClick={mutate} disabled={!auth.user}>
        Gửi cập nhật
      </button>
      <button type="button" onClick={auth.retry}>
        Làm mới phiên
      </button>
      <Link href="/account">Tài khoản</Link>
      <output data-testid="result">{result}</output>
    </main>
  );
}
