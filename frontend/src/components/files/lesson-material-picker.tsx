"use client";
import { useEffect, useRef, useState } from "react";
import { FileText, FolderOpen } from "lucide-react";
import type { FolderItem, LibraryFile } from "@streamora/contracts";
import { listFiles, listFolders } from "@/lib/files/api";
import { asApiError } from "@/lib/api";
import { ModalDialog } from "@/components/common/modal-dialog";
import "./lesson-folders.css";

export function LessonMaterialPicker({
  groupId,
  selected,
  onChange,
  disabled = false,
  excludeFolderId,
  autoOpen = false,
}: {
  groupId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  excludeFolderId?: string;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen && !disabled);
  const [draft, setDraft] = useState<string[]>([...selected]);
  const names = useRef(new Map<string, string>());
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [folderId, setFolderId] = useState("root");
  const [items, setItems] = useState<LibraryFile[]>([]);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    listFolders(groupId, "all")
      .then((data) => {
        if (live) setFolders(data.folders);
      })
      .catch((cause) => {
        if (live) setError(asApiError(cause).message);
      });
    return () => {
      live = false;
    };
  }, [groupId, open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    requestVersion.current += 1;
    setBusy(true);
    setLoadingMore(false);
    setCursor(null);
    setError("");
    const timer = setTimeout(() => {
      listFiles(groupId, { folderId, q: query, limit: 50 })
        .then((data) => {
          if (live) {
            setItems(data.items);
            setCursor(data.nextCursor);
            data.items.forEach((file) => names.current.set(file.id, file.name));
          }
        })
        .catch((cause) => {
          if (live) setError(asApiError(cause).message);
        })
        .finally(() => {
          if (live) setBusy(false);
        });
    }, 250);
    return () => {
      live = false;
      requestVersion.current += 1;
      clearTimeout(timer);
    };
  }, [groupId, folderId, query, open]);
  const available = items.filter(
    (file) =>
      file.status === "AVAILABLE" &&
      file.source === "DOCUMENT" &&
      (!excludeFolderId || file.folderId !== excludeFolderId),
  );
  return (
    <div className="lesson-material-selection">
      <div className="lesson-material-selection-heading">
        <FolderOpen size={20} aria-hidden="true" />
        <div>
          <b>Tài liệu buổi học</b>
          <small>
            {selected.length
              ? `Đã chọn ${selected.length} tài liệu`
              : "Chọn tài liệu có sẵn hoặc thêm sau."}
          </small>
        </div>
        <button
          type="button"
          className="button secondary compact"
          disabled={disabled}
          aria-haspopup="dialog"
          onClick={() => {
            setDraft([...selected]);
            setOpen(true);
          }}
        >
          {selected.length ? "Thay đổi tài liệu" : "Chọn tài liệu"}
        </button>
      </div>
      {selected.length > 0 && (
        <ul className="lesson-selected-files" aria-label="Tài liệu đã chọn">
          {selected.slice(0, 3).map((id) => (
            <li key={id}>
              <FileText size={14} aria-hidden="true" />
              <span>{names.current.get(id) ?? "Tài liệu đã chọn"}</span>
            </li>
          ))}
          {selected.length > 3 && <li>+{selected.length - 3} tài liệu</li>}
        </ul>
      )}
      {open && (
        <ModalDialog
          title="Chọn tài liệu cho buổi học"
          description="Chọn tối đa 50 tài liệu trong nhóm. Tài liệu sẽ được chuyển vào folder khi bạn lưu buổi học hoặc thêm tài liệu."
          className="lesson-material-dialog"
          onClose={() => setOpen(false)}
          footer={
            <>
              <span className="lesson-material-count" role="status">
                Đã chọn {draft.length}/50 tài liệu
              </span>
              <button
                type="button"
                className="button secondary"
                onClick={() => setOpen(false)}
              >
                Hủy
              </button>
              <button
                type="button"
                className="button primary"
                disabled={disabled}
                onClick={() => {
                  onChange(draft);
                  setOpen(false);
                }}
              >
                Xác nhận
              </button>
            </>
          }
        >
          <div className="lesson-material-picker">
            <div className="lesson-material-filters">
              <select
                aria-label="Thư mục chứa tài liệu"
                value={folderId}
                onChange={(event) => setFolderId(event.target.value)}
                disabled={disabled}
              >
                <option value="root">Tài liệu ở thư mục gốc</option>
                {folders
                  .filter((f) => f.id !== excludeFolderId)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
              <input
                aria-label="Tìm tài liệu để thêm"
                placeholder="Tìm tên tài liệu…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                disabled={disabled}
                type="search"
              />
            </div>
            {error && <p role="alert">{error}</p>}
            <div className="lesson-material-list" aria-busy={busy}>
              {busy ? (
                <p>Đang tải tài liệu…</p>
              ) : (
                available.map((file) => (
                  <label key={file.id} className="lesson-material-item">
                    <input
                      type="checkbox"
                      aria-label={file.name}
                      checked={draft.includes(file.id)}
                      disabled={
                        disabled ||
                        (draft.length >= 50 && !draft.includes(file.id))
                      }
                      onChange={(event) =>
                        setDraft(
                          event.target.checked
                            ? [...draft, file.id]
                            : draft.filter((id) => id !== file.id),
                        )
                      }
                    />
                    <FileText size={20} aria-hidden="true" />
                    <span className="lesson-material-name">
                      <b>{file.name}</b>
                      <small>
                        {file.isPublished === false
                          ? "Chờ công bố"
                          : "Tài liệu trong nhóm"}
                      </small>
                    </span>
                  </label>
                ))
              )}
              {!busy && !error && !available.length && (
                <p className="lesson-material-empty">
                  {query
                    ? "Không tìm thấy tài liệu phù hợp."
                    : "Không có tài liệu có thể chọn trong thư mục này."}
                </p>
              )}
            </div>
            {cursor && !busy && (
              <button
                type="button"
                className="button secondary compact"
                disabled={disabled || loadingMore}
                onClick={async () => {
                  const version = requestVersion.current;
                  setLoadingMore(true);
                  setError("");
                  try {
                    const data = await listFiles(groupId, {
                      folderId,
                      q: query,
                      cursor,
                      limit: 50,
                    });
                    if (version === requestVersion.current) {
                      setItems((current) => [...current, ...data.items]);
                      setCursor(data.nextCursor);
                      data.items.forEach((file) =>
                        names.current.set(file.id, file.name),
                      );
                    }
                  } catch (cause) {
                    if (version === requestVersion.current)
                      setError(asApiError(cause).message);
                  } finally {
                    if (version === requestVersion.current)
                      setLoadingMore(false);
                  }
                }}
              >
                {loadingMore ? "Đang tải…" : "Tải thêm tài liệu"}
              </button>
            )}
          </div>
        </ModalDialog>
      )}
    </div>
  );
}
