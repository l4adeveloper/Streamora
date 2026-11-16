"use client";
import { useEffect, useRef, useState } from "react";
import type { FolderItem, LessonSummaryResponse } from "@streamora/contracts";
import { apiRequest, asApiError } from "@/lib/api";
import { LessonMaterialPicker } from "./lesson-material-picker";
import { LessonSummaryDocument } from "./lesson-summary-document";

const errorText: Record<string, string> = {
  AI_DEPLOYMENT_ERROR:
    "Không gọi được deployment Azure OpenAI. Kiểm tra endpoint, API key, tên deployment và khả năng đọc PDF/ảnh của model.",
  AI_RATE_LIMITED: "Azure đang giới hạn lượt gọi. Hệ thống sẽ thử lại.",
  AI_TEMPORARY_FAILURE: "Dịch vụ AI tạm thời chưa phản hồi. Hãy thử lại.",
  AI_INVALID_OUTPUT: "Kết quả AI chưa hợp lệ. Hãy thử lại.",
  SUMMARY_SOURCES_CHANGED:
    "Tài liệu đã thay đổi trong lúc xử lý. Bấm tạo lại để dùng nguồn mới nhất.",
  SUMMARY_TOO_LARGE:
    "Tài liệu quá lớn cho một lần tóm tắt. Giảm bớt tài liệu rồi thử lại.",
  SUMMARY_ACCESS_REVOKED:
    "Người yêu cầu đã mất quyền quản lý buổi học. Host hiện tại có thể tạo lại tóm tắt.",
};
export function LessonFolderPanel({
  folder,
  canManage,
  onClose,
  onChanged,
}: {
  folder: FolderItem;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<LessonSummaryResponse>();
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const dirty = useRef(false);
  const jobId = useRef<string | null>(null);
  const seenReady = useRef<string | null>(null);
  const change = useRef(onChanged);
  change.current = onChanged;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await apiRequest<LessonSummaryResponse>(
          `/folders/${folder.id}/summary${jobId.current ? `?summaryId=${jobId.current}` : ""}`,
          { method: "GET" },
        );
        if (!live) return;
        setData(result);
        if (!dirty.current && result.summary)
          setPrompt(result.summary.customPrompt);
        if (["PENDING", "PROCESSING"].includes(result.summary?.status ?? ""))
          timer = setTimeout(() => void load(), 3000);
        if (
          result.summary?.status === "READY" &&
          seenReady.current !== result.summary.id
        ) {
          seenReady.current = result.summary.id;
          change.current();
        }
      } catch (cause) {
        if (live) setError(asApiError(cause).message);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [folder.id, revision]);
  const processing = ["PENDING", "PROCESSING"].includes(
    data?.summary?.status ?? "",
  );
  return (
    <dialog
      ref={dialog}
      className="library-dialog lesson-folder-dialog"
      aria-labelledby="lesson-folder-title"
      onCancel={onClose}
    >
      <header className="library-dialog-heading">
        <div>
          <small>Folder buổi học</small>
          <h2 id="lesson-folder-title">{folder.name}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng folder buổi học"
        >
          ×
        </button>
      </header>
      {error && (
        <p role="alert" className="library-error">
          {error}
        </p>
      )}
      {canManage && (
        <details className="lesson-folder-materials">
          <summary>Thêm tài liệu có sẵn vào folder</summary>
          <LessonMaterialPicker
            groupId={folder.groupId}
            excludeFolderId={folder.id}
            selected={selected}
            onChange={setSelected}
            disabled={busy}
          />
          <button
            type="button"
            className="button secondary"
            disabled={!selected.length || busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await apiRequest(`/folders/${folder.id}/materials`, {
                  method: "POST",
                  body: { fileIds: selected },
                });
                setSelected([]);
                change.current();
              } catch (cause) {
                setError(asApiError(cause).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Thêm {selected.length || ""} tài liệu
          </button>
        </details>
      )}
      <section className="lesson-folder-summary">
        <h3>Tóm tắt buổi học</h3>
        {!data && !error && <p>Đang tải…</p>}
        {data && canManage && (
          <>
            <details>
              <summary>Prompt cơ sở</summary>
              <pre className="lesson-base-prompt">{data.basePrompt}</pre>
            </details>
            <label htmlFor="lesson-extra-prompt">
              Yêu cầu bổ sung (tùy chọn)
            </label>
            <textarea
              id="lesson-extra-prompt"
              rows={4}
              maxLength={4000}
              value={prompt}
              disabled={busy || processing}
              placeholder="Ví dụ: tập trung phần kiến trúc hệ thống; liệt kê bài tập và nội dung cần ôn."
              onChange={(event) => {
                dirty.current = true;
                setPrompt(event.target.value);
              }}
            />
            <p className="class-muted">
              AI tổng hợp bản ghi và tài liệu trong folder. Kết quả được lưu
              thành file Markdown ngay tại đây. Tài liệu chờ công bố sẽ khiến
              bản tóm tắt cũng ở trạng thái chờ.
            </p>
            {!data.configured && (
              <p>Cần cấu hình deployment Azure OpenAI trước khi tạo tóm tắt.</p>
            )}
            {data.sessionStatus !== "ENDED" && (
              <p>Chỉ tạo tóm tắt khi buổi học đã kết thúc.</p>
            )}
            <button
              type="button"
              className="button primary"
              disabled={
                busy ||
                processing ||
                !data.configured ||
                data.sessionStatus !== "ENDED"
              }
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const result = await apiRequest<LessonSummaryResponse>(
                    `/folders/${folder.id}/summary`,
                    { method: "POST", body: { customPrompt: prompt } },
                  );
                  jobId.current = result.summary?.id ?? null;
                  setData(result);
                  setRevision((value) => value + 1);
                } catch (cause) {
                  setError(asApiError(cause).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {processing
                ? "Đang tạo tóm tắt…"
                : busy
                  ? "Đang gửi…"
                  : data.summary
                    ? "Tạo lại với yêu cầu này"
                    : "Tạo tóm tắt"}
            </button>
          </>
        )}
        {processing && (
          <p role="status">
            Đang tổng hợp nội dung. Bạn có thể đóng cửa sổ này và quay lại sau.
          </p>
        )}
        {data?.summary?.status === "FAILED" && (
          <p role="alert">
            {errorText[data.summary.errorCode ?? ""] ??
              "Chưa tạo được bản tóm tắt. Kiểm tra quyền truy cập và tài liệu rồi thử lại."}
          </p>
        )}
        {data?.summary?.status === "READY" && (
          <>
            <p>Đã lưu bản tóm tắt vào folder này.</p>
            <LessonSummaryDocument text={data.summary.content ?? ""} />
          </>
        )}
        {data && !data.summary && !canManage && (
          <p>Chưa có bản tóm tắt được công bố.</p>
        )}
      </section>
    </dialog>
  );
}
