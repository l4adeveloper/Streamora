"use client";

import { useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { PageShell } from "@/components/shell/page-shell";
import { apiRequest, asApiError } from "@/lib/api";
import styles from "./replica-operations.module.css";

interface ReplicaStatus {
  assetId: string;
  publishedJobId: string | null;
  replicas: {
    id: string;
    jobId: string;
    destinationBucket: string;
    status: string;
    attempts: number;
    objectCount: number;
    lastSyncedAt: string | null;
    errorCode: string | null;
    updatedAt: string;
    current: boolean;
  }[];
}

export function ReplicaOperationsPage() {
  const { user } = useAuth();
  const [assetId, setAssetId] = useState("");
  const [result, setResult] = useState<ReplicaStatus>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  async function load(id: string) {
    const request = ++sequence.current;
    if (user?.globalRole !== "ADMIN") return;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      )
    ) {
      setError("Nhập UUID của file video cần kiểm tra.");
      setLoading(false);
      setResult(undefined);
      return;
    }
    setLoading(true);
    setError("");
    setResult(undefined);
    try {
      const value = await apiRequest<ReplicaStatus>(
        `/internal/assets/${id}/replicas`,
        { method: "GET" },
      );
      if (request === sequence.current) setResult(value);
    } catch (cause) {
      if (request === sequence.current) setError(asApiError(cause).message);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void load(assetId.trim());
  }
  return (
    <PageShell
      title="Vận hành video"
      description="Trạng thái sao chép theo phiên bản video. Chỉ quản trị viên được truy cập."
    >
      {user?.globalRole !== "ADMIN" ? (
        <p role="alert">Bạn không có quyền truy cập trang vận hành.</p>
      ) : (
        <section className={styles.panel}>
          <form onSubmit={submit} className={styles.form}>
            <label htmlFor="replica-asset-id">ID file video</label>
            <input
              id="replica-asset-id"
              value={assetId}
              onChange={(event) => setAssetId(event.target.value)}
              placeholder="UUID của file video"
              required
            />
            <button className="button primary" disabled={loading}>
              {loading ? "Đang kiểm tra…" : "Xem trạng thái"}
            </button>
          </form>
          {error && <p role="alert">{error}</p>}
          {result && (
            <div aria-live="polite">
              <p>
                File: <code>{result.assetId}</code>
              </p>
              <p>
                Phiên bản đang công bố:{" "}
                <code>{result.publishedJobId ?? "Chưa có"}</code>
              </p>
              {!result.replicas.length && (
                <p>
                  Chưa có replica. Kiểm tra cấu hình worker và trạng thái xử lý
                  video.
                </p>
              )}
              <div className={styles.list}>
                {result.replicas.map((replica) => (
                  <article className={styles.card} key={replica.id}>
                    <h2>
                      {replica.status} ·{" "}
                      {replica.current ? "Phiên bản hiện tại" : "Phiên bản cũ"}
                    </h2>
                    <dl>
                      <dt>Bucket</dt>
                      <dd>{replica.destinationBucket}</dd>
                      <dt>Job</dt>
                      <dd>{replica.jobId}</dd>
                      <dt>Số object</dt>
                      <dd>{replica.objectCount}</dd>
                      <dt>Số lần thử</dt>
                      <dd>{replica.attempts}</dd>
                      <dt>Đồng bộ thành công</dt>
                      <dd>
                        {replica.lastSyncedAt
                          ? new Date(replica.lastSyncedAt).toLocaleString(
                              "vi-VN",
                            )
                          : "Chưa hoàn tất"}
                      </dd>
                      <dt>Cập nhật</dt>
                      <dd>
                        {new Date(replica.updatedAt).toLocaleString("vi-VN")}
                      </dd>
                      {replica.errorCode && (
                        <>
                          <dt>Mã lỗi</dt>
                          <dd>{replica.errorCode}</dd>
                        </>
                      )}
                    </dl>
                  </article>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </PageShell>
  );
}
