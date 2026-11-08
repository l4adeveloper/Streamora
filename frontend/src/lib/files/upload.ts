import "client-only";
import type { LibraryFile } from "@streamora/contracts";
import { apiRequest } from "@/lib/api";

export type UploadSession = {
  uploadId: string;
  partSize: number;
  totalParts: number;
  expiresAt: string;
};
type Part = { partNumber: number; etag: string };
// Shared across files so the whole queue sends at most five PUTs at once.
export function createPartLimiter(limit = 5) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (work: () => Promise<void>) => {
    await new Promise<void>((resolve) => {
      const enter = () => {
        active++;
        resolve();
      };
      if (active < limit) enter();
      else waiting.push(enter);
    });
    try {
      await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
export function abortUpload(id: string) {
  return apiRequest<void>(`/uploads/${id}`, { method: "DELETE" });
}
export function completeUpload(id: string, parts: Part[]) {
  return apiRequest<{ file: LibraryFile }>(`/uploads/${id}/complete`, {
    method: "POST",
    idempotencyKey: id,
    body: { parts },
  });
}

// Sign five URLs together so control-API latency cannot serialize the part PUTs.
export async function uploadFile(
  file: File,
  groupId: string,
  options: {
    signal: AbortSignal;
    onSession: (session: UploadSession) => void;
    onProgress: (percent: number) => void;
    source?: "DOCUMENT" | "LOCAL_RECORDING";
    sessionId?: string;
    runPart?: (work: () => Promise<void>) => Promise<void>;
  },
) {
  const checkCancelled = () => {
    if (options.signal.aborted) throw new DOMException("Đã hủy", "AbortError");
  };
  checkCancelled();
  const session = await apiRequest<UploadSession>("/uploads", {
    method: "POST",
    body: {
      groupId,
      filename: file.name,
      size: file.size,
      mimeType: file.type.split(";")[0] || "application/octet-stream",
      fingerprint: `${file.size}:${file.lastModified}:${file.name}`.slice(
        0,
        200,
      ),
      source: options.source ?? "DOCUMENT",
      sessionId: options.sessionId,
    },
  });
  options.onSession(session);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener("abort", cancel);
  if (options.signal.aborted) controller.abort();
  const parts: Part[] = [];
  const progress = new Map<number, number>();
  const report = () =>
    options.onProgress(
      Math.min(
        99,
        Math.floor(
          ([...progress.values()].reduce((a, b) => a + b, 0) / file.size) * 100,
        ),
      ),
    );
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
    for (let first = 1; first <= session.totalParts; first += 5) {
      checkCancelled();
      const partNumbers = Array.from(
        { length: Math.min(5, session.totalParts - first + 1) },
        (_, index) => first + index,
      );
      const signed = await apiRequest<{
        parts: { partNumber: number; url: string; expiresAt: string }[];
      }>(`/uploads/${session.uploadId}/parts/sign`, {
        method: "POST",
        body: { partNumbers },
      });
      const workers = signed.parts.map((part) =>
        (options.runPart ?? (async (work) => work()))(async () => {
          checkCancelled();
          let url = part.url;
          if (Date.parse(part.expiresAt) <= Date.now() + 3000) {
            const refreshed = await apiRequest<{ parts: { url: string }[] }>(
              `/uploads/${session.uploadId}/parts/sign`,
              { method: "POST", body: { partNumbers: [part.partNumber] } },
            );
            url = refreshed.parts[0].url;
          }
          await sendPart(part.partNumber, url);
        }).catch((error) => {
          controller.abort();
          throw error;
        }),
      );
      const results = await Promise.allSettled(workers);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
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
