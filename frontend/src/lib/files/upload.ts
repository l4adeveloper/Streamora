import "client-only";
import type { LibraryFile } from "@streamora/contracts";
import { apiRequest, ApiError } from "@/lib/api";
import { authSession } from "@/lib/auth/session";
import {
  fingerprintFile,
  uploadStore,
  type UploadFileHandle,
} from "./upload-store";

export type UploadSession = {
  uploadId: string;
  partSize: number;
  totalParts: number;
  expiresAt: string;
};
type Part = { partNumber: number; etag: string };
export type UploadState = UploadSession & {
  status: string;
  filename: string;
  size: number;
  fingerprint: string;
  uploadedParts: (Part & { size: number })[];
  fileId?: string;
  groupId: string;
  objectReady?: boolean;
};
export async function getUpload(id: string) {
  try {
    return await apiRequest<UploadState>(`/uploads/${id}`, { method: "GET" });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      error.code === "NOT_FOUND"
    )
      throw new ApiError(
        404,
        "UPLOAD_RESUME_UNAVAILABLE",
        "API đang chạy chưa hỗ trợ tiếp tục tải lên. Hãy khởi động lại API bằng phiên bản mới.",
      );
    throw error;
  }
}

async function retry<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await work();
    } catch (error) {
      signal.throwIfAborted();
      if (
        attempt >= 4 ||
        (error instanceof ApiError &&
          ![0, 408, 429, 500, 502, 503, 504].includes(error.status))
      )
        throw error;
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(
          () => {
            signal.removeEventListener("abort", stop);
            resolve();
          },
          Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250,
        );
        signal.addEventListener("abort", stop, { once: true });
      });
    }
  }
}
type PartRunner = (
  work: () => Promise<void>,
  fileId?: string,
  signal?: AbortSignal,
) => Promise<void>;

// Share PUT slots fairly between ready files, using every free slot even for a single file.
export function createPartLimiter(limit = 5): PartRunner {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("Upload concurrency must be a positive integer");
  type Ticket = { enter: () => void };
  const ungrouped = Symbol("ungrouped");
  type Key = string | typeof ungrouped;
  const waiting = new Map<Key, Ticket[]>();
  const running = new Map<Key, number>();
  let active = 0;
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      while (active < limit && waiting.size) {
        // Prefer files with fewer active PUTs; rotate equal candidates in insertion order.
        const key = [...waiting.keys()].reduce((best, candidate) =>
          (running.get(candidate) ?? 0) < (running.get(best) ?? 0)
            ? candidate
            : best,
        );
        const tickets = waiting.get(key)!;
        const ticket = tickets.shift()!;
        waiting.delete(key);
        if (tickets.length) waiting.set(key, tickets);
        active++;
        running.set(key, (running.get(key) ?? 0) + 1);
        ticket.enter();
      }
    });
  }
  return async (work, fileId, signal) => {
    signal?.throwIfAborted();
    const key = fileId ?? ungrouped;
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        const tickets = waiting.get(key);
        const index = tickets?.indexOf(ticket) ?? -1;
        if (index >= 0) {
          tickets!.splice(index, 1);
          if (!tickets!.length) waiting.delete(key);
        }
        reject(signal!.reason);
      };
      const ticket: Ticket = {
        enter: () => {
          signal?.removeEventListener("abort", stop);
          resolve();
        },
      };
      const tickets = waiting.get(key) ?? [];
      tickets.push(ticket);
      waiting.set(key, tickets);
      signal?.addEventListener("abort", stop, { once: true });
      schedule();
    });
    try {
      signal?.throwIfAborted();
      await work();
    } finally {
      active--;
      const count = running.get(key)! - 1;
      if (count) running.set(key, count);
      else running.delete(key);
      const tickets = waiting.get(key);
      if (tickets) {
        waiting.delete(key);
        waiting.set(key, tickets);
      }
      schedule();
    }
  };
}
export async function abortUpload(id: string) {
  await apiRequest<void>(`/uploads/${id}`, { method: "DELETE" });
  await uploadStore.remove(id).catch(() => {});
}
export async function completeUpload(id: string, parts: Part[]) {
  const result = await apiRequest<{ file: LibraryFile }>(
    `/uploads/${id}/complete`,
    {
      method: "POST",
      idempotencyKey: id,
      body: { parts },
    },
  );
  // A stale local record is reconciled with terminal server state on the next resume.
  await uploadStore.remove(id).catch(() => {});
  return result;
}

// Sign five URLs together so control-API latency cannot serialize the part PUTs.
export async function uploadFile(
  file: File,
  groupId: string,
  options: {
    signal: AbortSignal;
    folderPath?: string;
    onSession: (session: UploadSession) => void;
    onProgress: (percent: number) => void;
    source?: "DOCUMENT" | "LOCAL_RECORDING";
    sessionId?: string;
    runPart?: PartRunner;
    resumeId?: string;
    fileHandle?: UploadFileHandle;
    pendingId?: string;
    queuedAt?: number;
  },
) {
  const userId = authSession.getSnapshot().user?.id;
  const checkCancelled = () => {
    if (options.signal.aborted) throw new DOMException("Đã hủy", "AbortError");
    if (authSession.getSnapshot().user?.id !== userId)
      throw new ApiError(
        409,
        "SESSION_CHANGED",
        "Tài khoản đã thay đổi. Hãy đăng nhập lại để tiếp tục.",
      );
  };
  checkCancelled();
  if (!userId) throw new Error("Vui lòng đăng nhập để tải lên.");
  // Overlap local verification and the read-only status request on resume.
  const preparation = new AbortController();
  const stopPreparation = () => preparation.abort();
  options.signal.addEventListener("abort", stopPreparation, { once: true });
  let fingerprint: string;
  let previous: UploadState | undefined;
  try {
    [fingerprint, previous] = await Promise.all([
      fingerprintFile(file, preparation.signal),
      options.resumeId
        ? retry(() => getUpload(options.resumeId!), preparation.signal)
        : Promise.resolve(undefined),
    ]);
  } catch (error) {
    preparation.abort();
    throw error;
  } finally {
    options.signal.removeEventListener("abort", stopPreparation);
  }
  checkCancelled();
  if (previous) {
    if (
      previous.groupId !== groupId ||
      previous.size !== file.size ||
      previous.fingerprint !== fingerprint ||
      previous.filename !== file.name
    )
      throw new ApiError(
        409,
        "UPLOAD_FILE_MISMATCH",
        "File không khớp phiên tải lên. Hãy chọn lại đúng file ban đầu.",
      );
    if (previous.status === "COMPLETED") {
      await uploadStore.remove(previous.uploadId);
      return { session: previous, parts: [], complete: async () => ({}) };
    }
    if (previous.status !== "ACTIVE")
      throw new ApiError(
        409,
        "UPLOAD_NOT_ACTIVE",
        "Phiên đã hủy hoặc đang xử lý. Hãy kiểm tra và thử lại.",
      );
    if (previous.objectReady)
      return {
        session: previous,
        parts: [],
        complete: () => completeUpload(previous.uploadId, []),
      };
  }
  const session =
    previous ??
    (await apiRequest<UploadSession>("/uploads", {
      method: "POST",
      body: {
        groupId,
        filename: file.name,
        folderPath: options.folderPath ?? "",
        size: file.size,
        mimeType: file.type.split(";")[0] || "application/octet-stream",
        fingerprint,
        source: options.source ?? "DOCUMENT",
        sessionId: options.sessionId,
      },
    }));
  try {
    await uploadStore.save(
      {
        uploadId: session.uploadId,
        userId,
        groupId,
        filename: file.name,
        folderPath: options.folderPath ?? "",
        size: file.size,
        fingerprint,
        expiresAt: session.expiresAt,
        queuedAt: options.queuedAt,
      },
      options.fileHandle ? { handle: options.fileHandle } : { file },
      options.pendingId,
    );
  } catch {
    if (!previous) await abortUpload(session.uploadId).catch(() => {});
    throw new ApiError(
      507,
      "UPLOAD_LOCAL_STORAGE_UNAVAILABLE",
      "Không thể lưu file để tiếp tục sau reload. Hãy kiểm tra dung lượng trống hoặc quyền lưu trữ của trình duyệt.",
    );
  }
  options.onSession(session);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener("abort", cancel);
  if (options.signal.aborted) controller.abort();
  const parts: Part[] = (previous?.uploadedParts ?? [])
    .filter(
      (part) =>
        part.partNumber >= 1 &&
        part.partNumber <= session.totalParts &&
        part.size ===
          Math.min(
            session.partSize,
            file.size - (part.partNumber - 1) * session.partSize,
          ),
    )
    // ListParts includes size for reconciliation; CompleteUploadDto accepts only these fields.
    .map(({ partNumber, etag }) => ({ partNumber, etag }));
  const progress = new Map<number, number>();
  for (const part of parts)
    progress.set(
      part.partNumber,
      Math.min(
        session.partSize,
        file.size - (part.partNumber - 1) * session.partSize,
      ),
    );
  const report = () =>
    options.onProgress(
      Math.min(
        99,
        Math.floor(
          ([...progress.values()].reduce((a, b) => a + b, 0) / file.size) * 100,
        ),
      ),
    );
  // Restore confirmed progress before signing or sending another part.
  report();
  async function sendPart(partNumber: number, url: string) {
    if (controller.signal.aborted)
      throw new DOMException("Đã hủy", "AbortError");
    const chunk = file.slice(
      (partNumber - 1) * session.partSize,
      partNumber * session.partSize,
    );
    const etag = await new Promise<string>((resolve, reject) => {
      const request = new XMLHttpRequest();
      const stop = () => request.abort();
      const cleanup = () =>
        controller.signal.removeEventListener("abort", stop);
      request.open("PUT", url);
      request.timeout = 120000;
      request.upload.onprogress = (event) => {
        progress.set(partNumber, event.loaded);
        report();
      };
      request.onload = () => {
        cleanup();
        const etag = request.getResponseHeader("ETag");
        if (request.status === 200 && etag) resolve(etag);
        else
          reject(
            new Error(
              "Không tải được phần dữ liệu. Kiểm tra kết nối và CORS lưu trữ.",
            ),
          );
      };
      request.onerror = request.ontimeout = () => {
        cleanup();
        reject(new Error("Kết nối tải lên bị gián đoạn."));
      };
      request.onabort = () => {
        cleanup();
        reject(new DOMException("Đã hủy", "AbortError"));
      };
      controller.signal.addEventListener("abort", stop, { once: true });
      request.send(chunk);
    });
    progress.set(partNumber, chunk.size);
    report();
    parts.push({ partNumber, etag });
  }
  try {
    const completed = new Set(parts.map((part) => part.partNumber));
    const missing = Array.from(
      { length: session.totalParts },
      (_, i) => i + 1,
    ).filter((n) => !completed.has(n));
    type SignedPart = { partNumber: number; url: string; expiresAt: string };
    // Capture speculative failures immediately; report them only if that batch is needed.
    type SignedBatch = { parts: SignedPart[] } | { error: unknown };
    const signatures = new Map<number, Promise<SignedBatch>>();
    const signBatch = (batch: number) => {
      let signing = signatures.get(batch);
      if (!signing) {
        signing = retry(
          () =>
            apiRequest<{ parts: SignedPart[] }>(
              `/uploads/${session.uploadId}/parts/sign`,
              {
                method: "POST",
                body: { partNumbers: missing.slice(batch * 5, batch * 5 + 5) },
              },
            ),
          controller.signal,
        ).catch((error): SignedBatch => ({ error }));
        signatures.set(batch, signing);
      }
      return signing;
    };
    const runPart = options.runPart ?? (async (work) => work());
    let next = 0;
    let failed = false;
    let failure: unknown;
    const worker = async () => {
      for (;;) {
        checkCancelled();
        const index = next++;
        if (index >= missing.length) return;
        const batch = Math.floor(index / 5);
        const signed = await signBatch(batch);
        if ("error" in signed) throw signed.error;
        checkCancelled();
        // One batch ahead: overlap URL signing with the current batch's data transfer.
        if ((batch + 1) * 5 < missing.length) void signBatch(batch + 1);
        let part = signed.parts[index % 5];
        const refresh = async () => {
          const refreshed = await apiRequest<{ parts: SignedPart[] }>(
            `/uploads/${session.uploadId}/parts/sign`,
            { method: "POST", body: { partNumbers: [part.partNumber] } },
          );
          part = refreshed.parts[0];
        };
        let attempt = 0;
        await retry(async () => {
          checkCancelled();
          if (attempt++ > 0 || Date.parse(part.expiresAt) <= Date.now() + 3000)
            await refresh();
          // Retry delay and normal URL refresh happen outside the shared PUT slot.
          await runPart(
            async () => {
              checkCancelled();
              // A signed URL may expire while this file waits behind other files.
              if (Date.parse(part.expiresAt) <= Date.now() + 3000)
                await refresh();
              checkCancelled();
              await sendPart(part.partNumber, part.url);
            },
            session.uploadId,
            controller.signal,
          );
        }, controller.signal);
      }
    };
    await Promise.allSettled(
      Array.from({ length: Math.min(5, missing.length) }, () =>
        worker().catch((error) => {
          if (!failed) {
            failed = true;
            failure = error;
          }
          controller.abort();
          throw error;
        }),
      ),
    );
    if (failed) throw failure;
    checkCancelled();
    // Keep the completion payload for a retry if only the response was lost.
    return {
      session,
      parts,
      complete: () => completeUpload(session.uploadId, parts),
    };
  } finally {
    options.signal.removeEventListener("abort", cancel);
  }
}
