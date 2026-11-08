"use client";
import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Upload,
  X,
} from "lucide-react";
import { asApiError } from "@/lib/api";
import { abortUpload, createPartLimiter, uploadFile } from "@/lib/files/upload";

type Status =
  "queued" | "uploading" | "finishing" | "done" | "error" | "cancelled";
type Job = {
  id: string;
  file: File;
  status: Status;
  percent: number;
  message?: string;
};
type Runtime = {
  controller: AbortController;
  uploadId?: string;
  complete?: () => Promise<unknown>;
  cancelling?: boolean;
};

export function FileUploader({
  groupId,
  onUploaded,
}: {
  groupId: string;
  onUploaded: () => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const queue = useRef<Job[]>([]);
  const active = useRef(0);
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
      timers.current.forEach(clearTimeout);
      for (const runtime of runtimes.current.values()) {
        runtime.controller.abort();
        if (runtime.uploadId)
          void abortUpload(runtime.uploadId).catch(() => {});
      }
    };
  }, []);
  function update(id: string, patch: Partial<Job>) {
    if (alive.current)
      setJobs((current) =>
        current.map((job) => (job.id === id ? { ...job, ...patch } : job)),
      );
  }
  function dismiss(id: string) {
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
  async function run(job: Job) {
    const runtime: Runtime = { controller: new AbortController() };
    runtimes.current.set(job.id, runtime);
    update(job.id, { status: "uploading", message: undefined, percent: 0 });
    try {
      const result = await uploadFile(job.file, groupId, {
        signal: runtime.controller.signal,
        runPart: limit.current,
        onSession: (session) => {
          runtime.uploadId = session.uploadId;
        },
        onProgress: (percent) => update(job.id, { percent }),
      });
      if (runtime.controller.signal.aborted)
        throw new DOMException("Đã hủy", "AbortError");
      runtime.complete = result.complete;
      await complete(job, runtime);
    } catch (cause) {
      if (runtime.controller.signal.aborted) {
        try {
          if (runtime.uploadId) await abortUpload(runtime.uploadId);
          runtime.uploadId = undefined;
          update(job.id, { status: "cancelled", message: "Đã hủy tải lên." });
          autoDismiss(job.id);
        } catch (error) {
          runtime.cancelling = false;
          update(job.id, {
            status: "error",
            message: `${asApiError(error).message} Hãy thử hủy lại.`,
          });
        }
      } else
        update(job.id, { status: "error", message: asApiError(cause).message });
    }
  }
  function pump() {
    while (alive.current && active.current < 4 && queue.current.length) {
      const job = queue.current.shift()!;
      active.current++;
      void run(job).finally(() => {
        active.current--;
        pump();
      });
    }
  }
  function enqueue(files: FileList | File[] | null) {
    if (!files?.length) return;
    const added: Job[] = Array.from(files).map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: "queued",
      percent: 0,
    }));
    setJobs((current) => [...current, ...added]);
    queue.current.push(...added);
    pump();
  }
  async function cancel(job: Job) {
    const runtime = runtimes.current.get(job.id);
    if (!runtime) {
      queue.current = queue.current.filter((item) => item.id !== job.id);
      update(job.id, { status: "cancelled", message: "Đã hủy tải lên." });
      autoDismiss(job.id);
      return;
    }
    if (runtime.cancelling) return;
    runtime.cancelling = true;
    runtime.controller.abort();
    if (job.status === "error") {
      try {
        if (runtime.uploadId) await abortUpload(runtime.uploadId);
        runtime.uploadId = undefined;
        runtime.complete = undefined;
        update(job.id, { status: "cancelled", message: "Đã hủy tải lên." });
        autoDismiss(job.id);
      } catch (cause) {
        update(job.id, { message: asApiError(cause).message });
      } finally {
        runtime.cancelling = false;
      }
    }
  }
  const working = jobs.filter((job) =>
    ["queued", "uploading", "finishing"].includes(job.status),
  ).length;
  return (
    <>
      <section
        className="file-uploader"
        aria-label="Tải tài liệu lên"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          enqueue(event.dataTransfer.files);
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
          onClick={() => picker.current?.click()}
        >
          <Upload size={16} /> Chọn file tải lên
        </button>
        <span> hoặc kéo thả nhiều file vào đây (tối đa 2 GB mỗi file).</span>
      </section>
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
                  <progress
                    max={100}
                    value={job.percent}
                    aria-label={`Tiến độ ${job.file.name}`}
                  />
                  <p role="status">
                    {job.message ??
                      (job.status === "queued"
                        ? "Đang chờ…"
                        : job.status === "finishing"
                          ? "Đang xác minh…"
                          : `${job.percent}%`)}
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
                </div>
              );
            })}
          </div>
        </aside>
      )}
    </>
  );
}
