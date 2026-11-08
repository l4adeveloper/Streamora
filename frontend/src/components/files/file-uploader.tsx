"use client";
import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Pause,
  Play,
  Upload,
  X,
} from "lucide-react";
import { asApiError } from "@/lib/api";
import { abortUpload, createPartLimiter, uploadFile } from "@/lib/files/upload";
import { uploadStore, type UploadFileHandle } from "@/lib/files/upload-store";
import { useAuth } from "@/components/auth/auth-provider";

type Status =
  | "saving"
  | "queued"
  | "uploading"
  | "paused"
  | "finishing"
  | "done"
  | "error"
  | "cancelled";
type Job = {
  id: string;
  file: File;
  status: Status;
  percent: number;
  message?: string;
  resumeId?: string;
  needsFile?: boolean;
  fileHandle?: UploadFileHandle;
  pendingId?: string;
  queuedAt?: number;
};
type Runtime = {
  controller: AbortController;
  uploadId?: string;
  complete?: () => Promise<unknown>;
  cancelling?: boolean;
  paused?: boolean;
  percent: number;
  checkpointAt: number;
  running: boolean;
  release: () => void;
};
const PAUSED_MESSAGE = "Đã tạm dừng. Các phần đã lưu được giữ nguyên.";
function pendingEntry(job: Job, userId: string, groupId: string) {
  return {
    upload: {
      uploadId: job.pendingId ?? job.id,
      pending: true,
      queuedAt: job.queuedAt,
      userId,
      groupId,
      filename: job.file.name,
      size: job.file.size,
      fingerprint: "",
      percent: job.percent,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
    source: job.fileHandle ? { handle: job.fileHandle } : { file: job.file },
  };
}

export function FileUploader({
  groupId,
  onUploaded,
}: {
  groupId: string;
  onUploaded: () => void;
}) {
  const { user } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const queue = useRef<Job[]>([]);
  const active = useRef(0);
  const preparing = useRef(new Set<string>());
  const reserved = useRef(new Set<string>());
  const creating = useRef(new Set<string>());
  const quotaRetryAt = useRef(0);
  const quotaBackoff = useRef(1000);
  const quotaTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const cancelled = useRef(new Set<string>());
  const runtimes = useRef(new Map<string, Runtime>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const limit = useRef(createPartLimiter(5));
  const uploaded = useRef(onUploaded);
  uploaded.current = onUploaded;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queue.current = [];
      clearTimeout(quotaTimer.current);
      timers.current.forEach(clearTimeout);
      for (const runtime of runtimes.current.values()) {
        runtime.paused = true;
        runtime.controller.abort();
      }
    };
  }, []);
  useEffect(() => {
    let current = true;
    if (user)
      void uploadStore
        .list(user.id, groupId)
        .then(async (rows) => {
          const restored = await Promise.all(
            rows.map(async (row): Promise<Job> => {
              const source = await uploadStore.source(
                row.uploadId,
                user.id,
                groupId,
              );
              return {
                id: row.uploadId,
                resumeId: row.pending ? undefined : row.uploadId,
                pendingId: row.pending ? row.uploadId : undefined,
                queuedAt: row.queuedAt,
                file: source?.file ?? new File([], row.filename),
                fileHandle: source?.handle,
                needsFile: !source?.file && !source?.handle,
                percent: row.percent ?? 0,
                status: "paused",
                message:
                  Date.parse(row.expiresAt) <= Date.now()
                    ? "Phiên đã hết hạn. Hãy hủy rồi tải lại."
                    : source?.file || source?.handle
                      ? row.pending
                        ? "Chưa bắt đầu tải. Bấm tiếp tục để đưa vào hàng đợi."
                        : PAUSED_MESSAGE
                      : "Chọn lại đúng file để tiếp tục tải lên.",
              };
            }),
          );
          if (!current) return;
          for (const row of rows)
            if (!row.pending) reserved.current.add(row.uploadId);
          setJobs((jobs) => [
            ...jobs,
            ...restored.filter(
              (row) =>
                !jobs.some(
                  (job) =>
                    job.id === row.id ||
                    (!!row.resumeId && job.resumeId === row.resumeId),
                ),
            ),
          ]);
        })
        .catch(() => {
          if (current)
            setStorageError(
              "Không mở được bộ nhớ tải lên. Hãy cho phép IndexedDB trong trình duyệt.",
            );
        });
    return () => {
      current = false;
    };
  }, [groupId, user?.id]);
  const [storageError, setStorageError] = useState("");
  function update(id: string, patch: Partial<Job>) {
    if (alive.current)
      setJobs((current) =>
        current.map((job) => (job.id === id ? { ...job, ...patch } : job)),
      );
  }
  function dismiss(id: string) {
    const job = jobs.find((item) => item.id === id);
    if (job?.pendingId) {
      cancelled.current.add(id);
      queue.current = queue.current.filter((item) => item.id !== id);
      void uploadStore.remove(job.pendingId).catch(() => {});
    }
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    runtimes.current.delete(id);
    if (alive.current)
      setJobs((current) => current.filter((job) => job.id !== id));
  }
  function autoDismiss(id: string) {
    if (!alive.current) return;
    const previous = timers.current.get(id);
    if (previous) clearTimeout(previous);
    timers.current.set(
      id,
      setTimeout(() => dismiss(id), 5000),
    );
  }
  async function complete(job: Job, runtime: Runtime) {
    update(job.id, { status: "finishing", percent: 99, message: undefined });
    try {
      await runtime.complete!();
      if (runtime.uploadId) reserved.current.delete(runtime.uploadId);
      quotaFreed();
      runtime.uploadId = undefined;
      runtime.complete = undefined;
      update(job.id, {
        status: "done",
        percent: 100,
        message: "Đã lưu vào thư viện.",
      });
      if (alive.current) uploaded.current();
      autoDismiss(job.id);
    } catch (cause) {
      update(job.id, {
        status: "error",
        message: `${asApiError(cause).message} Có thể thử hoàn tất lại.`,
      });
    }
  }
  async function run(job: Job, release: () => void) {
    const runtime: Runtime = {
      controller: new AbortController(),
      uploadId: job.resumeId,
      percent: job.percent,
      checkpointAt: 0,
      running: true,
      release,
    };
    runtimes.current.set(job.id, runtime);
    update(job.id, {
      status: "uploading",
      message: job.resumeId ? "Đang đối chiếu các phần đã tải…" : undefined,
      percent: job.resumeId ? job.percent : 0,
    });
    try {
      const result = await uploadFile(job.file, groupId, {
        signal: runtime.controller.signal,
        runPart: limit.current,
        resumeId: job.resumeId,
        fileHandle: job.fileHandle,
        pendingId: job.pendingId,
        queuedAt: job.queuedAt,
        onSession: (session) => {
          runtime.uploadId = session.uploadId;
          reserved.current.add(session.uploadId);
          creating.current.delete(job.id);
          job.resumeId = session.uploadId;
          job.pendingId = undefined;
          update(job.id, { resumeId: session.uploadId, pendingId: undefined });
        },
        onProgress: (percent) => {
          if (
            !alive.current ||
            runtime.controller.signal.aborted ||
            runtimes.current.get(job.id) !== runtime
          )
            return;
          runtime.percent = Math.max(runtime.percent, percent);
          if (runtime.uploadId && Date.now() - runtime.checkpointAt > 1000) {
            runtime.checkpointAt = Date.now();
            void uploadStore
              .checkpoint(runtime.uploadId, runtime.percent)
              .catch(() => {});
          }
          setJobs((current) =>
            current.map((item) => {
              if (item.id !== job.id || item.status !== "uploading")
                return item;
              return {
                ...item,
                // Preserve the displayed transfer position while an interrupted part catches up.
                percent: Math.max(item.percent, percent),
                message:
                  percent < item.percent
                    ? "Đang gửi lại phần bị ngắt…"
                    : undefined,
              };
            }),
          );
        },
      });
      if (runtime.controller.signal.aborted)
        throw new DOMException("Đã hủy", "AbortError");
      runtime.complete = result.complete;
      await complete(job, runtime);
    } catch (cause) {
      // A rapid resume may already have installed a new runtime for this file.
      if (runtimes.current.get(job.id) !== runtime) return;
      if (runtime.paused) {
        update(job.id, {
          status: "paused",
          message: PAUSED_MESSAGE,
        });
        return;
      }
      if (runtime.controller.signal.aborted) {
        try {
          if (runtime.uploadId) await abortUpload(runtime.uploadId);
          if (runtime.uploadId) reserved.current.delete(runtime.uploadId);
          if (runtime.uploadId) quotaFreed();
          if (job.pendingId) await uploadStore.remove(job.pendingId);
          runtime.uploadId = undefined;
          update(job.id, { status: "cancelled", message: "Đã hủy tải lên." });
          autoDismiss(job.id);
          pump(); // The cancelled server session has now released its quota.
        } catch (error) {
          runtime.cancelling = false;
          update(job.id, {
            status: "error",
            message: `${asApiError(error).message} Hãy thử hủy lại.`,
          });
        }
      } else if (
        !job.resumeId &&
        asApiError(cause).code === "UPLOAD_QUOTA_EXCEEDED"
      ) {
        if (!queue.current.some((item) => item.id === job.id))
          queue.current.push(job);
        update(job.id, {
          status: "queued",
          message: "Đang chờ lượt trống từ máy chủ…",
        });
        waitForQuota();
      } else
        update(job.id, {
          status: "error",
          message: asApiError(cause).message,
          ...(asApiError(cause).code === "UPLOAD_FILE_MISMATCH"
            ? { needsFile: true }
            : {}),
        });
    } finally {
      runtime.running = false;
      if (creating.current.delete(job.id)) pump();
    }
  }
  function quotaFreed() {
    quotaRetryAt.current = 0;
    quotaBackoff.current = 1000;
    clearTimeout(quotaTimer.current);
    quotaTimer.current = undefined;
  }
  function waitForQuota() {
    if (quotaTimer.current) return;
    const delay = quotaBackoff.current;
    quotaRetryAt.current = Date.now() + delay;
    quotaBackoff.current = Math.min(10000, delay * 2);
    quotaTimer.current = setTimeout(() => {
      quotaTimer.current = undefined;
      pump();
    }, delay);
  }
  function pump() {
    while (alive.current && active.current < 4 && queue.current.length) {
      // Paused server sessions still reserve quota. Resume them before creating another one.
      const index = queue.current.findIndex(
        (job) =>
          !!job.resumeId ||
          (reserved.current.size + creating.current.size < 4 &&
            Date.now() >= quotaRetryAt.current),
      );
      if (index < 0) return;
      const [job] = queue.current.splice(index, 1);
      // Reserve the slot BEFORE hashing or POST /uploads, not after its response arrives.
      if (!job.resumeId) creating.current.add(job.id);
      active.current++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active.current--;
        pump();
      };
      void run(job, release).finally(release);
    }
  }
  async function enqueue(
    files: FileList | File[] | null,
    handles?: (UploadFileHandle | undefined)[],
  ) {
    if (!files?.length || !user) return;
    const added: Job[] = Array.from(files).map((file, index) => {
      const id = crypto.randomUUID();
      return {
        id,
        pendingId: id,
        queuedAt: Date.now() + index,
        file,
        fileHandle: handles?.[index],
        status: "saving",
        percent: 0,
        message: "Đang lưu hàng đợi…",
      };
    });
    setJobs((current) => [...current, ...added]);
    try {
      await uploadStore.stage(
        added.map((job) => pendingEntry(job, user.id, groupId)),
      );
    } catch {
      for (const job of added)
        if (!cancelled.current.has(job.id))
          update(job.id, {
            status: "error",
            message:
              "Không thể lưu hàng đợi. Hãy kiểm tra dung lượng trống hoặc quyền lưu trữ của trình duyệt.",
          });
      return;
    }
    for (const job of added)
      if (cancelled.current.has(job.id)) {
        await uploadStore.remove(job.id).catch(() => {});
      }
    if (!alive.current) return;
    const ready = added.filter((job) => !cancelled.current.has(job.id));
    for (const job of ready) {
      job.status = "queued";
      job.message = undefined;
      update(job.id, { status: "queued", message: undefined });
      queue.current.push(job);
    }
    for (const job of added) cancelled.current.delete(job.id);
    pump();
  }
  async function pickFiles() {
    const choose = (
      window as Window & {
        showOpenFilePicker?: (options: {
          multiple: boolean;
        }) => Promise<UploadFileHandle[]>;
      }
    ).showOpenFilePicker;
    if (!choose) {
      picker.current?.click();
      return;
    }
    try {
      const handles = await choose.call(window, { multiple: true });
      enqueue(
        await Promise.all(handles.map((handle) => handle.getFile())),
        handles,
      );
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        setStorageError(
          "Không đọc được file. Hãy kiểm tra quyền truy cập rồi thử lại.",
        );
    }
  }
  async function resume(job: Job) {
    const runtime = runtimes.current.get(job.id);
    if (
      preparing.current.has(job.id) ||
      queue.current.some((item) => item.id === job.id) ||
      (runtime?.running && !runtime.controller.signal.aborted)
    )
      return;
    preparing.current.add(job.id);
    try {
      let file = job.file;
      if (job.fileHandle && !job.file.size) {
        try {
          // Invoke directly from the click so the browser can ask for read permission if needed.
          const permission = await job.fileHandle.requestPermission({
            mode: "read",
          });
          if (!preparing.current.has(job.id)) return;
          if (permission !== "granted") {
            update(job.id, {
              status: "error",
              message: "Cần cho phép đọc file để tiếp tục tải lên.",
            });
            return;
          }
          file = await job.fileHandle.getFile();
        } catch {
          if (!preparing.current.has(job.id)) return;
          update(job.id, {
            status: "error",
            needsFile: true,
            fileHandle: undefined,
            message: "File đã di chuyển hoặc không thể đọc. Hãy chọn lại file.",
          });
          return;
        }
      }
      if (!alive.current || !preparing.current.has(job.id)) return;
      if (job.pendingId && user)
        await uploadStore.stage([
          pendingEntry({ ...job, file }, user.id, groupId),
        ]);
      if (!alive.current || !preparing.current.has(job.id)) return;
      update(job.id, { file, status: "queued", message: undefined });
      queue.current.push({ ...job, file, status: "queued" });
      pump();
    } catch {
      if (preparing.current.has(job.id))
        update(job.id, {
          status: "error",
          message:
            "Không thể lưu hàng đợi. Hãy kiểm tra dung lượng trống hoặc quyền lưu trữ của trình duyệt.",
        });
    } finally {
      preparing.current.delete(job.id);
    }
  }
  async function cancel(job: Job) {
    preparing.current.delete(job.id);
    cancelled.current.add(job.id);
    const runtime = runtimes.current.get(job.id);
    if (
      !runtime ||
      (!runtime.running && (job.status === "queued" || job.status === "saving"))
    ) {
      runtime?.controller.abort();
      runtime?.release?.();
      runtimes.current.delete(job.id);
      queue.current = queue.current.filter((item) => item.id !== job.id);
      const serverId = runtime?.uploadId ?? job.resumeId;
      if (serverId) {
        try {
          await abortUpload(serverId);
          reserved.current.delete(serverId);
          quotaFreed();
        } catch (cause) {
          update(job.id, { message: asApiError(cause).message });
          return;
        }
      }
      if (job.pendingId)
        await uploadStore.remove(job.pendingId).catch(() => {});
      queue.current = queue.current.filter((item) => item.id !== job.id);
      update(job.id, { status: "cancelled", message: "Đã hủy tải lên." });
      autoDismiss(job.id);
      pump();
      return;
    }
    if (runtime.cancelling) return;
    runtime.cancelling = true;
    runtime.paused = false;
    runtime.controller.abort();
    runtime.release?.();
    if (job.status === "error" || job.status === "paused") {
      try {
        if (runtime.uploadId) await abortUpload(runtime.uploadId);
        if (runtime.uploadId) reserved.current.delete(runtime.uploadId);
        if (runtime.uploadId) quotaFreed();
        if (job.pendingId) await uploadStore.remove(job.pendingId);
        runtime.uploadId = undefined;
        runtime.complete = undefined;
        update(job.id, { status: "cancelled", message: "Đã hủy tải lên." });
        autoDismiss(job.id);
        pump();
      } catch (cause) {
        update(job.id, { message: asApiError(cause).message });
      } finally {
        runtime.cancelling = false;
      }
    }
  }
  const working = jobs.filter((job) =>
    ["saving", "queued", "uploading", "finishing"].includes(job.status),
  ).length;
  return (
    <>
      <section
        className="file-uploader"
        aria-label="Tải tài liệu lên"
        onDragOver={(event) => event.preventDefault()}
        onDrop={async (event) => {
          event.preventDefault();
          const files = Array.from(event.dataTransfer.files);
          const items = Array.from(event.dataTransfer.items).filter(
            (item) => item.kind === "file",
          );
          const handles = await Promise.all(
            items.map(async (item) => {
              try {
                const handle = await (
                  item as DataTransferItem & {
                    getAsFileSystemHandle?: () => Promise<FileSystemHandle>;
                  }
                ).getAsFileSystemHandle?.();
                return handle?.kind === "file"
                  ? (handle as UploadFileHandle)
                  : undefined;
              } catch {
                return undefined;
              }
            }),
          );
          enqueue(files, handles);
        }}
      >
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            enqueue(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="button secondary compact"
          onClick={() => void pickFiles()}
        >
          <Upload size={16} /> Chọn file tải lên
        </button>
        <span> hoặc kéo thả nhiều file vào đây (tối đa 2 GB mỗi file).</span>
      </section>
      {storageError && <p role="alert">{storageError}</p>}
      {jobs.length > 0 && (
        <aside className="upload-popover" aria-label="Trạng thái tải lên">
          <div className="upload-popover-heading">
            <Upload size={18} />
            <strong>
              {working ? `Đang tải ${working} file` : "Kết quả tải lên"}
            </strong>
            <small>
              {jobs.filter((job) => job.status === "done").length}/{jobs.length}{" "}
              hoàn tất
            </small>
          </div>
          {jobs.filter((job) => job.status === "paused" && !job.needsFile)
            .length > 1 && (
            <div className="upload-popover-actions">
              <button
                type="button"
                className="button secondary compact"
                onClick={() =>
                  void Promise.all(
                    jobs
                      .filter(
                        (job) => job.status === "paused" && !job.needsFile,
                      )
                      .map(resume),
                  )
                }
              >
                <Play size={16} /> Tiếp tục tất cả
              </button>
            </div>
          )}
          <div className="upload-popover-list">
            {jobs.map((job) => {
              const runtime = runtimes.current.get(job.id);
              const terminal =
                job.status === "done" || job.status === "cancelled";
              return (
                <div key={job.id} className={`upload-job ${job.status}`}>
                  <div className="upload-job-heading">
                    {job.status === "done" ? (
                      <CheckCircle2 size={20} />
                    ) : job.status === "error" ? (
                      <CircleAlert size={20} />
                    ) : terminal ? (
                      <X size={20} />
                    ) : job.status === "paused" ? (
                      <Pause size={20} />
                    ) : (
                      <LoaderCircle size={20} className="upload-spinner" />
                    )}
                    <b title={job.file.name}>{job.file.name}</b>
                    {terminal ||
                    (job.status === "error" && !runtime?.uploadId) ? (
                      <button
                        type="button"
                        aria-label={`Đóng trạng thái ${job.file.name}`}
                        onClick={() => dismiss(job.id)}
                      >
                        <X size={16} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Hủy tải lên ${job.file.name}`}
                        disabled={job.status === "finishing"}
                        onClick={() => void cancel(job)}
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                  <div className="upload-job-progress">
                    <progress
                      max={100}
                      value={job.percent}
                      aria-label={`Tiến độ ${job.file.name}`}
                    />
                    <span className="upload-job-percent">{job.percent}%</span>
                    {job.status === "uploading" && (
                      <button
                        type="button"
                        className="upload-job-control"
                        aria-label={`Tạm dừng tải lên ${job.file.name}`}
                        title="Tạm dừng"
                        disabled={!runtime?.uploadId}
                        onClick={() => {
                          if (!runtime) return;
                          runtime.paused = true;
                          runtime.controller.abort();
                          runtime.release?.();
                          void uploadStore
                            .checkpoint(runtime.uploadId!, job.percent)
                            .catch(() => {});
                          update(job.id, {
                            status: "paused",
                            message: PAUSED_MESSAGE,
                          });
                        }}
                      >
                        <Pause size={16} />
                      </button>
                    )}
                    {job.status === "paused" && !job.needsFile && (
                      <button
                        type="button"
                        className="upload-job-control"
                        aria-label={`Tiếp tục tải lên ${job.file.name}`}
                        title="Tiếp tục tải lên"
                        onClick={() => resume(job)}
                      >
                        <Play size={16} />
                      </button>
                    )}
                  </div>
                  <p role="status">
                    {job.message ??
                      (job.status === "queued"
                        ? "Đang chờ…"
                        : job.status === "finishing"
                          ? "Đang xác minh…"
                          : "Đang tải lên…")}
                  </p>
                  {job.status === "error" && runtime?.complete && (
                    <button
                      type="button"
                      className="button secondary compact"
                      onClick={() => void complete(job, runtime)}
                    >
                      Thử hoàn tất lại
                    </button>
                  )}
                  {["paused", "error"].includes(job.status) &&
                    !runtime?.complete &&
                    (job.needsFile || job.status === "error") &&
                    (job.needsFile ? (
                      <label className="button secondary compact">
                        Chọn file để tiếp tục
                        <input
                          type="file"
                          hidden
                          aria-label={`Chọn lại ${job.file.name}`}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (!file) return;
                            const next: Job = {
                              ...job,
                              file,
                              needsFile: false,
                              status: "queued",
                            };
                            update(job.id, next);
                            void resume(next);
                          }}
                        />
                      </label>
                    ) : (
                      <button
                        type="button"
                        className="button secondary compact"
                        onClick={() => resume(job)}
                      >
                        Tiếp tục tải lên
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        </aside>
      )}
    </>
  );
}
