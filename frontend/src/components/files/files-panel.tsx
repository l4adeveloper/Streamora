"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Eye,
  FileText,
  Folder,
  ImageIcon,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Video,
  X,
} from "lucide-react";
import type { GroupPermissions, LibraryFile } from "@streamora/contracts";
import { asApiError } from "@/lib/api";
import {
  deleteFile,
  deleteFolder,
  renameFolder,
  downloadFolder,
  getFile,
  getFileDownload,
  getFilePreview,
  listFiles,
  renameFile,
} from "@/lib/files/api";
import { announceFolderChange } from "@/lib/files/folder-events";
import { useToast } from "../common/toast-provider";
import { LoadingState, RequestError } from "../common/feedback";
import "./files.css";
import { FileUploader } from "./file-uploader";
import { VideoPreview } from "./video-preview";

const sources = {
  DOCUMENT: "Tài liệu tải lên",
  LOCAL_RECORDING: "Bản ghi buổi học",
  CLOUD_RECORDING: "Bản ghi cloud",
};
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const videoTypes = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const previewLabel = (file: LibraryFile) =>
  videoTypes.has(file.mimeType)
    ? "Xem trước video"
    : imageTypes.has(file.mimeType)
      ? "Xem trước ảnh"
      : "Xem trước PDF";
const canPreview = (file: LibraryFile) =>
  file.mimeType === "application/pdf" ||
  imageTypes.has(file.mimeType) ||
  videoTypes.has(file.mimeType);
function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  const unit = Math.min(3, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** unit).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} ${["B", "KB", "MB", "GB"][unit]}`;
}
export function FilesPanel({
  groupId,
  userId,
  permissions,
  filter,
  onFilterChange,
}: {
  groupId: string;
  userId: string;
  permissions: GroupPermissions;
  filter: string;
  onFilterChange: (filter: string) => void;
}) {
  const { notify } = useToast();
  const [query, setQuery] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [items, setItems] = useState<LibraryFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [folderAction, setFolderAction] = useState<{
    path: string;
    name: string;
    action: "rename" | "delete";
  } | null>(null);
  const folderDialog = useRef<HTMLDialogElement>(null);
  const [folderName, setFolderName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [selected, setSelected] = useState<LibraryFile | null>(null);
  const [action, setAction] = useState<
    "detail" | "rename" | "delete" | "preview"
  >("detail");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [preview, setPreview] = useState<{
    url?: string;
    loading: boolean;
    error?: string;
  }>({ loading: false });
  const [previewRevision, setPreviewRevision] = useState(0);
  const sequence = useRef(0);
  const alive = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const type =
    filter === "Tài liệu"
      ? "document"
      : filter === "Bản ghi"
        ? "video"
        : undefined;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  const load = useCallback(async () => {
    const version = ++sequence.current;
    setLoading(true);
    setError(null);
    setMore(false);
    try {
      const response = await listFiles(groupId, {
        folderPath,
        q: query.trim(),
        type,
        limit: 20,
      });
      if (version !== sequence.current) return;
      setItems(response.items);
      setFolders(response.folders ?? []);
      setCursor(response.nextCursor);
    } catch (cause) {
      if (version === sequence.current) {
        setItems([]);
        setError(cause);
      }
    } finally {
      if (version === sequence.current) setLoading(false);
    }
  }, [groupId, folderPath, query, type]);
  useEffect(() => {
    sequence.current++;
    setLoading(true);
    const timer = setTimeout(() => void load(), 300);
    return () => {
      clearTimeout(timer);
      sequence.current++;
    };
  }, [load]);
  useEffect(() => {
    if (selected && !dialog.current?.open) dialog.current?.showModal();
    if (!selected && dialog.current?.open) dialog.current.close();
  }, [selected]);
  useEffect(() => {
    if (
      action !== "preview" ||
      !selected ||
      videoTypes.has(selected.mimeType)
    ) {
      setPreview({ loading: false });
      return;
    }
    let current = true;
    setPreview({ loading: true });
    void getFilePreview(selected.id)
      .then((result) => {
        if (current) setPreview({ url: result.url, loading: true });
      })
      .catch((error) => {
        if (current)
          setPreview({ loading: false, error: asApiError(error).message });
      });
    return () => {
      current = false;
    };
  }, [action, selected?.id, previewRevision]);
  useEffect(() => {
    if (folderAction && !folderDialog.current?.open)
      folderDialog.current?.showModal();
    if (!folderAction && folderDialog.current?.open)
      folderDialog.current.close();
  }, [folderAction]);
  async function folderDownload(path: string, name: string) {
    setBusy(true);
    try {
      const blob = await downloadFolder(groupId, path);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name + ".zip";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) {
      notify(asApiError(cause).message, { tone: "error" });
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function submitFolder(force = false) {
    if (!folderAction || busy) return;
    setBusy(true);
    setActionError("");
    try {
      if (folderAction.action === "rename")
        await renameFolder(
          groupId,
          folderAction.path,
          folderName.trim(),
          force,
        );
      else await deleteFolder(groupId, folderAction.path, force);
      if (force)
        announceFolderChange({ groupId, folderPath: folderAction.path });
      setFolderAction(null);
      setFolderBusy(false);
      notify("Đã cập nhật thư mục.", { tone: "success" });
      void load();
    } catch (cause) {
      setFolderBusy(asApiError(cause).code === "FOLDER_BUSY");
      setActionError(asApiError(cause).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const canManage = (file: LibraryFile) =>
    file.createdBy === userId || permissions.canHost;
  async function loadMore() {
    if (!cursor || more || loading) return;
    const version = sequence.current;
    setMore(true);
    try {
      const response = await listFiles(groupId, {
        folderPath,
        q: query.trim(),
        type,
        limit: 20,
        cursor,
      });
      if (version !== sequence.current) return;
      setItems((current) => [...current, ...response.items]);
      setCursor(response.nextCursor);
    } catch (cause) {
      if (version === sequence.current)
        notify(asApiError(cause).message, { tone: "error" });
    } finally {
      if (version === sequence.current) setMore(false);
    }
  }
  async function open(file: LibraryFile, nextAction: typeof action) {
    setActionError("");
    setBusy(true);
    try {
      const response = await getFile(file.id);
      if (!alive.current) return;
      setSelected(response.file);
      setName(response.file.name);
      setAction(nextAction);
    } catch (cause) {
      if (alive.current) notify(asApiError(cause).message, { tone: "error" });
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function download(file: LibraryFile) {
    setBusy(true);
    setActionError("");
    try {
      const response = await getFileDownload(file.id);
      if (!alive.current) return;
      // Browser navigation honors S3 attachment disposition; no signed URL is persisted.
      const link = document.createElement("a");
      link.href = response.url;
      link.rel = "noreferrer";
      link.referrerPolicy = "no-referrer";
      document.body.append(link);
      link.click();
      link.remove();
    } catch (cause) {
      if (alive.current) notify(asApiError(cause).message, { tone: "error" });
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function submit() {
    if (!selected || busy) return;
    setBusy(true);
    setActionError("");
    try {
      if (action === "delete") await deleteFile(selected.id);
      else if (action === "rename") await renameFile(selected.id, name.trim());
      else return;
      if (!alive.current) return;
      notify(
        action === "delete"
          ? "Đã xóa vĩnh viễn tài liệu."
          : "Đã đổi tên tài liệu.",
        { tone: "success" },
      );
      setSelected(null);
      void load();
    } catch (cause) {
      if (alive.current) setActionError(asApiError(cause).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const visibleFolders = query.trim() || type === "video" ? [] : folders;
  const hasRows = items.length > 0 || visibleFolders.length > 0;
  return (
    <div className="files-page">
      {permissions.canUpload && (
        <FileUploader
          key={`${groupId}:${userId}`}
          groupId={groupId}
          folderPath={folderPath}
          onUploaded={() => void load()}
        />
      )}
      <div className="library-toolbar">
        <button
          type="button"
          className="button secondary compact"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={16} /> Làm mới
        </button>
      </div>
      <nav className="folder-breadcrumb" aria-label="Đường dẫn thư mục">
        <button type="button" onClick={() => setFolderPath("")}>
          Thư viện
        </button>
        {folderPath
          .split("/")
          .filter(Boolean)
          .map((part, index, parts) => (
            <span key={parts.slice(0, index + 1).join("/")}>
              {" "}
              /{" "}
              <button
                type="button"
                onClick={() =>
                  setFolderPath(parts.slice(0, index + 1).join("/"))
                }
              >
                {part}
              </button>
            </span>
          ))}
      </nav>
      <div className="file-controls">
        <div className="file-filters">
          {["Tất cả", "Tài liệu", "Bản ghi"].map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={filter === item}
              className={filter === item ? "selected" : ""}
              onClick={() => onFilterChange(item)}
            >
              {item === "Bản ghi" ? "Video và bản ghi" : item}
            </button>
          ))}
        </div>
        <div className="input-icon">
          <Search size={16} />
          <input
            aria-label="Tìm tên tài liệu"
            placeholder="Tìm tên tài liệu…"
            maxLength={255}
            value={query}
            onChange={(event) => {
              sequence.current++;
              setLoading(true);
              setQuery(event.target.value);
            }}
          />
        </div>
      </div>
      {error ? (
        <RequestError error={error} onRetry={() => void load()} />
      ) : loading ? (
        <LoadingState message="Đang tải thư viện…" />
      ) : (
        <>
          <div className="file-table" aria-label="Tài liệu trong nhóm">
            {hasRows && (
              <div className="file-table-heading">
                <span>Tên tài liệu</span>
                <span>Dung lượng</span>
                <span>Được thêm</span>
                <span>Thao tác</span>
              </div>
            )}
            {visibleFolders.map((folder) => (
              <div className="file-row library-file-row" key={folder}>
                <button
                  type="button"
                  className="library-file-name"
                  onClick={() =>
                    setFolderPath(
                      [folderPath, folder].filter(Boolean).join("/"),
                    )
                  }
                >
                  <span className="file-symbol">
                    <Folder size={22} />
                  </span>
                  <span>
                    <b>{folder}</b>
                    <small>Thư mục</small>
                  </span>
                </button>
                <span>—</span>
                <span>—</span>
                <span className="library-actions">
                  <button
                    type="button"
                    title="Tải thư mục (.zip)"
                    aria-label={`Tải xuống thư mục ${folder}`}
                    disabled={busy}
                    onClick={() =>
                      void folderDownload(
                        [folderPath, folder].filter(Boolean).join("/"),
                        folder,
                      )
                    }
                  >
                    <Download size={16} />
                  </button>
                  {(["rename", "delete"] as const).map((action) => (
                    <button
                      type="button"
                      key={action}
                      title={
                        action === "rename" ? "Đổi tên thư mục" : "Xóa thư mục"
                      }
                      aria-label={`${action === "rename" ? "Đổi tên" : "Xóa"} thư mục ${folder}`}
                      disabled={busy}
                      onClick={() => {
                        setActionError("");
                        setFolderName(folder);
                        setFolderBusy(false);
                        setFolderAction({
                          path: [folderPath, folder].filter(Boolean).join("/"),
                          name: folder,
                          action,
                        });
                      }}
                    >
                      {action === "rename" ? (
                        <Pencil size={16} />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </button>
                  ))}
                </span>
              </div>
            ))}
            {items.map((file) => (
              <div className="file-row library-file-row" key={file.id}>
                <button
                  type="button"
                  className="library-file-name"
                  onClick={() => void open(file, "detail")}
                  disabled={busy}
                >
                  <span
                    className={`file-symbol ${file.mimeType.startsWith("video/") ? "video-symbol" : ""}`}
                  >
                    {file.mimeType.startsWith("video/") ? (
                      <Video size={22} />
                    ) : imageTypes.has(file.mimeType) ? (
                      <ImageIcon size={22} />
                    ) : (
                      <FileText size={22} />
                    )}
                  </span>
                  <span>
                    <b>{file.name}</b>
                    <small>
                      {sources[file.source]} ·{" "}
                      {file.status === "AVAILABLE"
                        ? "Sẵn sàng"
                        : "Đang chuẩn bị"}
                      {query.trim() && file.folderPath
                        ? ` · ${file.folderPath}`
                        : ""}
                    </small>
                  </span>
                </button>
                <span>{sizeLabel(file.size)}</span>
                <span>
                  {new Date(file.createdAt).toLocaleDateString("vi-VN")}
                </span>
                <span className="library-actions">
                  {canPreview(file) && (
                    <button
                      type="button"
                      title={previewLabel(file)}
                      aria-label={`Xem trước ${file.name}`}
                      disabled={busy || file.status !== "AVAILABLE"}
                      onClick={() => void open(file, "preview")}
                    >
                      <Eye size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    title="Tải xuống"
                    aria-label={`Tải xuống ${file.name}`}
                    disabled={busy || file.status !== "AVAILABLE"}
                    onClick={() => void download(file)}
                  >
                    <Download size={16} />
                  </button>
                  {canManage(file) && (
                    <>
                      <button
                        type="button"
                        title="Đổi tên"
                        aria-label={`Đổi tên ${file.name}`}
                        disabled={busy}
                        onClick={() => void open(file, "rename")}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        title="Xóa tài liệu"
                        aria-label={`Xóa ${file.name}`}
                        disabled={busy}
                        onClick={() => void open(file, "delete")}
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                </span>
              </div>
            ))}
            {!hasRows && (
              <div className="empty-state">
                <Search size={30} />
                <h3>
                  {query || type
                    ? "Chưa tìm thấy tài liệu"
                    : "Thư viện chưa có tài liệu"}
                </h3>
                <p>
                  {query || type
                    ? "Thử tên hoặc bộ lọc khác."
                    : "Tài liệu và bản ghi được thêm vào nhóm sẽ xuất hiện tại đây."}
                </p>
              </div>
            )}
          </div>
          {cursor && (
            <button
              type="button"
              className="button secondary library-more"
              disabled={more}
              onClick={() => void loadMore()}
            >
              {more ? "Đang tải…" : "Xem thêm"}
            </button>
          )}
        </>
      )}
      <dialog
        ref={folderDialog}
        className="library-dialog"
        aria-labelledby="folder-dialog-title"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setFolderAction(null);
        }}
        onClose={() => setFolderAction(null)}
      >
        {folderAction && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitFolder();
            }}
          >
            <div className="library-dialog-heading">
              <h3 id="folder-dialog-title">
                {folderAction.action === "rename"
                  ? "Đổi tên thư mục"
                  : "Xóa vĩnh viễn thư mục?"}
              </h3>
              <button
                type="button"
                disabled={busy}
                aria-label="Đóng"
                onClick={() => setFolderAction(null)}
              >
                <X size={18} />
              </button>
            </div>
            {folderAction.action === "rename" ? (
              <label>
                Tên thư mục
                <input
                  autoFocus
                  required
                  maxLength={255}
                  pattern="[^/\\\\]+"
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                />
              </label>
            ) : (
              <p>
                Thư mục “{folderAction.name}” cùng toàn bộ file và thư mục con
                sẽ bị xóa vĩnh viễn, không thể khôi phục.
              </p>
            )}
            {actionError && (
              <p role="alert" className="library-error">
                {actionError}
              </p>
            )}
            {folderBusy && (
              <p className="folder-force-warning">
                Buộc thực hiện sẽ hủy mọi file đang tải lên hoặc đang chờ trong
                thư mục này và các thư mục con. Tiến độ tải lên sẽ không được
                giữ lại.
              </p>
            )}
            <div className="library-dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setFolderAction(null)}
              >
                Đóng
              </button>
              <button
                type={folderBusy ? "button" : "submit"}
                onClick={folderBusy ? () => void submitFolder(true) : undefined}
                className={
                  folderBusy
                    ? "button primary folder-force-button"
                    : "button primary"
                }
                disabled={
                  busy ||
                  (folderAction.action === "rename" && !folderName.trim())
                }
              >
                {busy
                  ? "Đang xử lý…"
                  : folderBusy
                    ? `Hủy tải lên và ${folderAction.action === "rename" ? "đổi tên" : "xóa thư mục"}`
                    : folderAction.action === "rename"
                      ? "Lưu tên"
                      : "Xóa vĩnh viễn"}
              </button>
            </div>
          </form>
        )}
      </dialog>
      <dialog
        ref={dialog}
        className={`library-dialog ${action === "preview" ? "library-preview-dialog" : ""}`}
        aria-labelledby="library-dialog-title"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setSelected(null);
        }}
        onClose={() => setSelected(null)}
      >
        {selected && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="library-dialog-heading">
              <div className="library-dialog-title-group">
                <h3 id="library-dialog-title">
                  {action === "rename"
                    ? "Đổi tên tài liệu"
                    : action === "delete"
                      ? "Xóa vĩnh viễn tài liệu?"
                      : action === "preview"
                        ? previewLabel(selected)
                        : "Chi tiết tài liệu"}
                </h3>
                {action === "preview" && (
                  <p className="library-preview-filename" title={selected.name}>
                    {selected.name}
                  </p>
                )}
              </div>
              <div className="library-preview-tools">
                {action === "preview" && (
                  <>
                    <button
                      type="button"
                      title="Tải lại bản xem trước"
                      aria-label="Tải lại bản xem trước"
                      onClick={() => setPreviewRevision((value) => value + 1)}
                    >
                      <RefreshCw size={18} />
                    </button>
                    <button
                      type="button"
                      className="preview-download"
                      aria-label="Tải xuống"
                      title="Tải xuống"
                      disabled={busy || selected.status !== "AVAILABLE"}
                      onClick={() => void download(selected)}
                    >
                      <Download size={18} />
                      <span>Tải xuống</span>
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="preview-close"
                  title="Đóng"
                  aria-label="Đóng"
                  disabled={busy}
                  onClick={() => setSelected(null)}
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            {action === "rename" ? (
              <label>
                Tên tài liệu
                <input
                  autoFocus
                  required
                  minLength={1}
                  maxLength={255}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            ) : action !== "preview" ? (
              <p className="library-detail-name">{selected.name}</p>
            ) : null}
            {action === "delete" && (
              <p>
                Tài liệu sẽ bị xóa vĩnh viễn và không thể khôi phục. Bạn có chắc
                chắn muốn xóa tài liệu này không?
              </p>
            )}
            {action === "detail" && (
              <dl>
                <dt>Nguồn</dt>
                <dd>{sources[selected.source]}</dd>
                <dt>Dung lượng</dt>
                <dd>{sizeLabel(selected.size)}</dd>
                <dt>Định dạng</dt>
                <dd>{selected.mimeType}</dd>
                <dt>Trạng thái</dt>
                <dd>
                  {selected.status === "AVAILABLE"
                    ? "Sẵn sàng"
                    : "Đang chuẩn bị"}
                </dd>
                <dt>Ngày thêm</dt>
                <dd>{new Date(selected.createdAt).toLocaleString("vi-VN")}</dd>
              </dl>
            )}
            {action === "preview" &&
              (videoTypes.has(selected.mimeType) ? (
                <VideoPreview
                  key={`${selected.id}:${previewRevision}`}
                  fileId={selected.id}
                  name={selected.name}
                />
              ) : (
                <div className="library-preview-body">
                  {preview.loading && (
                    <LoadingState
                      message={
                        imageTypes.has(selected.mimeType)
                          ? "Đang mở ảnh…"
                          : "Đang mở PDF…"
                      }
                    />
                  )}
                  {preview.error && (
                    <p role="alert" className="library-error">
                      {preview.error}
                    </p>
                  )}
                  {preview.url &&
                    (imageTypes.has(selected.mimeType) ? (
                      <img
                        key={preview.url}
                        className="library-preview-image"
                        src={preview.url}
                        alt={`Xem trước ảnh: ${selected.name}`}
                        referrerPolicy="no-referrer"
                        onLoad={() =>
                          setPreview((current) => ({
                            ...current,
                            loading: false,
                          }))
                        }
                        onError={() =>
                          setPreview({
                            loading: false,
                            error:
                              "Chưa mở được ảnh. Hãy thử tải lại hoặc tải file xuống.",
                          })
                        }
                      />
                    ) : (
                      <iframe
                        key={preview.url}
                        src={preview.url}
                        title={`Xem trước PDF: ${selected.name}`}
                        referrerPolicy="no-referrer"
                        onLoad={() =>
                          setPreview((current) => ({
                            ...current,
                            loading: false,
                          }))
                        }
                        onError={() =>
                          setPreview({
                            loading: false,
                            error:
                              "Chưa mở được PDF. Hãy thử tải lại hoặc tải file xuống.",
                          })
                        }
                      />
                    ))}
                </div>
              ))}
            {actionError && (
              <p role="alert" className="library-error">
                {actionError}
              </p>
            )}
            {action !== "preview" && (
              <div className="library-dialog-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setSelected(null)}
                >
                  Đóng
                </button>
                {action === "detail" && canPreview(selected) && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy || selected.status !== "AVAILABLE"}
                    onClick={() => setAction("preview")}
                  >
                    <Eye size={16} /> {previewLabel(selected)}
                  </button>
                )}
                {action === "detail" ? (
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || selected.status !== "AVAILABLE"}
                    onClick={() => void download(selected)}
                  >
                    Tải xuống
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="button primary"
                    disabled={busy || (action === "rename" && !name.trim())}
                  >
                    {busy
                      ? "Đang xử lý…"
                      : action === "delete"
                        ? "Xóa vĩnh viễn"
                        : "Lưu tên"}
                  </button>
                )}
              </div>
            )}
          </form>
        )}
      </dialog>
    </div>
  );
}
