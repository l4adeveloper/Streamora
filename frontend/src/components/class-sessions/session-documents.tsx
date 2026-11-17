"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Eye,
  FileText,
  Globe,
  ImageIcon,
  Plus,
  Trash2,
  Video,
  X,
} from "lucide-react";
import type { LibraryFile } from "@streamora/contracts";
import { asApiError } from "@/lib/api";
import {
  deleteFile,
  getFileDownload,
  getFilePreview,
  listFiles,
  publishFile,
} from "@/lib/files/api";
import { useToast } from "../common/toast-provider";
import { LoadingState } from "../common/feedback";
import { FileUploader } from "../files/file-uploader";
import "./sessions.css";

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SessionDocuments({
  sessionId,
  groupId,
  canManage,
}: {
  sessionId: string;
  groupId: string;
  canManage: boolean;
}) {
  const { notify } = useToast();
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [canDeletePermanently, setCanDeletePermanently] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showUploader, setShowUploader] = useState(false);
  const [previewFile, setPreviewFile] = useState<LibraryFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!groupId || !sessionId) return;
    try {
      setLoading(true);
      const res = await listFiles(groupId, { sessionId, limit: 50 });
      if (alive.current) {
        setFiles(res.items);
        setCanDeletePermanently(res.canDeletePermanently === true);
      }
    } catch (err) {
      if (alive.current) {
        notify(asApiError(err).message, { tone: "error" });
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [groupId, sessionId, notify]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function handleDownload(file: LibraryFile) {
    try {
      const res = await getFileDownload(file.id);
      const link = document.createElement("a");
      link.href = res.url;
      link.rel = "noreferrer";
      link.referrerPolicy = "no-referrer";
      document.body.append(link);
      link.click();
      link.remove();
    } catch (err) {
      notify(asApiError(err).message, { tone: "error" });
    }
  }

  async function handlePreview(file: LibraryFile) {
    try {
      const res = await getFilePreview(file.id);
      setPreviewUrl(res.url);
      setPreviewFile(file);
    } catch (err) {
      notify(asApiError(err).message, { tone: "error" });
    }
  }

  async function handlePublishToggle(file: LibraryFile, targetPublished: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await publishFile(file.id, targetPublished);
      notify(
        targetPublished
          ? `Đã công bố "${file.name}" cho các thành viên trong buổi học.`
          : `Đã chuyển "${file.name}" về trạng thái chờ.`,
        { tone: "success" },
      );
      void load();
    } catch (err) {
      notify(asApiError(err).message, { tone: "error" });
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function handleDelete(file: LibraryFile) {
    const question = canDeletePermanently
      ? `Bạn có chắc muốn xóa vĩnh viễn tài liệu "${file.name}"?`
      : `Chuyển "${file.name}" vào Thùng rác của nhóm?`;
    if (!confirm(question)) return;
    if (busy) return;
    setBusy(true);
    try {
      await deleteFile(file.id, canDeletePermanently);
      notify(canDeletePermanently
        ? `Đã xóa tài liệu "${file.name}".`
        : `Đang chuyển "${file.name}" vào Thùng rác.`, { tone: "success" });
      void load();
    } catch (err) {
      notify(asApiError(err).message, { tone: "error" });
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section className="class-panel session-documents-panel" aria-labelledby="session-docs-title">
      <header className="class-toolbar">
        <h3 id="session-docs-title" className="class-row">
          <FileText size={18} />
          Tài liệu buổi học ({files.length})
        </h3>
        {canManage && (
          <button
            type="button"
            className="button secondary compact"
            onClick={() => setShowUploader((prev) => !prev)}
          >
            <Plus size={15} />
            {showUploader ? "Đóng tải lên" : "Tải tài liệu lên trước"}
          </button>
        )}
      </header>

      {showUploader && canManage && (
        <div style={{ marginBottom: "16px" }}>
          <FileUploader
            groupId={groupId}
            sessionId={sessionId}
            canHost={true}
            defaultDraft={true}
            onUploaded={() => {
              void load();
            }}
          />
        </div>
      )}

      {loading && !files.length ? (
        <LoadingState message="Đang tải tài liệu buổi học…" />
      ) : files.length === 0 ? (
        <p className="class-muted" style={{ padding: "12px 0", margin: 0 }}>
          {canManage
            ? "Chưa có tài liệu nào cho buổi học này. Bạn có thể tải tài liệu lên trước ở trạng thái chờ (học viên sẽ không thấy cho đến khi bạn bấm Công bố)."
            : "Chưa có tài liệu nào được công bố cho buổi học này."}
        </p>
      ) : (
        <div className="session-docs-list">
          {files.map((file) => (
            <div key={file.id} className="session-doc-item">
              <div className="session-doc-info">
                <span className="session-doc-icon">
                  {file.mimeType.startsWith("video/") ? (
                    <Video size={18} />
                  ) : file.mimeType.startsWith("image/") ? (
                    <ImageIcon size={18} />
                  ) : (
                    <FileText size={18} />
                  )}
                </span>
                <div className="session-doc-meta">
                  <span className="session-doc-name" title={file.name}>
                    {file.name}
                  </span>
                  <span className="session-doc-sub">
                    {sizeLabel(file.size)}
                    {file.isPublished === false && (
                      <span className="file-draft-badge" title="Tài liệu đang ở trạng thái chờ, học viên không thể xem">
                        Chờ công bố
                      </span>
                    )}
                  </span>
                </div>
              </div>

              <div className="session-doc-actions">
                <button
                  type="button"
                  className="button secondary compact"
                  title="Xem trước"
                  aria-label={`Xem trước ${file.name}`}
                  onClick={() => void handlePreview(file)}
                >
                  <Eye size={15} />
                </button>
                <button
                  type="button"
                  className="button secondary compact"
                  title="Tải xuống"
                  aria-label={`Tải xuống ${file.name}`}
                  onClick={() => void handleDownload(file)}
                >
                  <Download size={15} />
                </button>
                {canManage && (
                  <>
                    {file.isPublished === false ? (
                      <button
                        type="button"
                        className="button primary compact"
                        title="Công bố cho các thành viên"
                        aria-label={`Công bố ${file.name}`}
                        disabled={busy}
                        onClick={() => void handlePublishToggle(file, true)}
                      >
                        <Globe size={15} /> Công bố
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button secondary compact"
                        title="Ẩn tài liệu (chuyển về trạng thái chờ)"
                        aria-label={`Ẩn ${file.name}`}
                        disabled={busy}
                        onClick={() => void handlePublishToggle(file, false)}
                      >
                        <Globe size={15} style={{ opacity: 0.5 }} /> Ẩn
                      </button>
                    )}
                    <button
                      type="button"
                      className="button danger compact"
                      title="Xóa tài liệu"
                      aria-label={`Xóa ${file.name}`}
                      disabled={busy}
                      onClick={() => void handleDelete(file)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {previewFile && previewUrl && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setPreviewFile(null);
            setPreviewUrl(null);
          }}
        >
          <div
            className="preview-pane-dialog"
            style={{ maxWidth: "900px", width: "95vw", height: "85vh", display: "flex", flexDirection: "column" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="preview-pane-header">
              <span className="preview-file-name">{previewFile.name}</span>
              <button
                type="button"
                className="modal-close"
                onClick={() => {
                  setPreviewFile(null);
                  setPreviewUrl(null);
                }}
              >
                <X size={20} />
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, padding: "12px", display: "flex", justifyContent: "center", alignItems: "center" }}>
              {previewFile.mimeType.startsWith("image/") ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={previewUrl}
                  alt={previewFile.name}
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                />
              ) : previewFile.mimeType === "application/pdf" ? (
                <iframe
                  src={previewUrl}
                  title={previewFile.name}
                  style={{ width: "100%", height: "100%", border: "none" }}
                />
              ) : previewFile.mimeType.startsWith("video/") ? (
                <video
                  src={previewUrl}
                  controls
                  style={{ maxWidth: "100%", maxHeight: "100%" }}
                />
              ) : (
                <p>Không hỗ trợ xem trước định dạng này.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

