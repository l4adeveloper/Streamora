"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, RotateCcw, Video, X } from "lucide-react";
import type { FileTrashListResponse, TrashedFile } from "@streamora/contracts";
import { asApiError } from "@/lib/api";
import { listTrash, restoreFile } from "@/lib/files/api";
import { LoadingState, RequestError } from "../common/feedback";

const statuses = {
  ARCHIVING: "Đang chuyển vào thùng rác",
  TRASHED: "Có thể khôi phục",
  RESTORING: "Đang khôi phục",
};

export function TrashPanel({
  groupId,
  onClose,
}: {
  groupId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const [page, setPage] = useState<FileTrashListResponse>();
  const [error, setError] = useState<unknown>();
  const [restoreError, setRestoreError] = useState("");
  const [busyFile, setBusyFile] = useState<string>();

  const load = useCallback(async () => {
    const version = ++request.current;
    try {
      const result = await listTrash(groupId, cursor);
      if (version !== request.current) return;
      setPage(result);
      setError(undefined);
    } catch (cause) {
      if (version === request.current) setError(cause);
    }
  }, [groupId, cursor]);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    return () => {
      request.current++;
    };
  }, []);

  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load]);

  const transferring = page?.items.some(
    (file) => file.trashStatus !== "TRASHED",
  );
  useEffect(() => {
    if (!transferring) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(async () => {
        await load();
        if (!stopped) schedule();
      }, 2000);
    };
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load, transferring]);

  async function restore(file: TrashedFile) {
    if (busyFile) return;
    setBusyFile(file.id);
    setRestoreError("");
    try {
      await restoreFile(groupId, file.id);
      setPage(
        (current) =>
          current && {
            ...current,
            items: current.items.map((item) =>
              item.id === file.id
                ? {
                    ...item,
                    trashStatus: "RESTORING",
                    progressPercent: 0,
                    retrying: false,
                  }
                : item,
            ),
          },
      );
      await load();
    } catch (cause) {
      setRestoreError(asApiError(cause).message);
    } finally {
      setBusyFile(undefined);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="library-dialog library-trash"
      aria-labelledby="library-trash-title"
      onClose={onClose}
    >
      <div className="library-dialog-heading">
        <h3 id="library-trash-title">Thùng rác</h3>
        <button
          type="button"
          aria-label="Đóng thùng rác"
          onClick={() => dialog.current?.close()}
        >
          <X size={18} />
        </button>
      </div>
      {restoreError && (
        <p className="form-error" role="alert">
          {restoreError}
        </p>
      )}
      {error ? (
        <RequestError error={error} onRetry={() => void load()} />
      ) : !page ? (
        <LoadingState message="Đang tải thùng rác…" />
      ) : (
        <>
          {!page.items.length && (
            <p>
              {cursor
                ? "Trang này không còn tài liệu."
                : "Thùng rác đang trống."}
            </p>
          )}
          <ul className="library-trash-list">
            {page.items.map((file) => {
              const Icon = file.mimeType.startsWith("video/")
                ? Video
                : FileText;
              return (
                <li key={file.id}>
                  <Icon size={19} aria-hidden="true" />
                  <div className="library-trash-file">
                    <b title={file.name}>{file.name}</b>
                    <small>
                      {file.folderName ?? "Tài liệu chung"} ·{" "}
                      {new Date(file.deletedAt).toLocaleDateString("vi-VN")}
                    </small>
                    <small aria-live="polite">
                      {statuses[file.trashStatus]}
                      {file.retrying ? " · Đang thử lại" : ""}
                    </small>
                    {file.trashStatus !== "TRASHED" && (
                      <div className="library-trash-progress">
                        <progress
                          max={100}
                          value={file.progressPercent ?? 0}
                          aria-label={`${statuses[file.trashStatus]}: ${file.name}`}
                        />
                        <span aria-hidden="true">
                          {file.progressPercent ?? 0}%
                        </span>
                      </div>
                    )}
                  </div>
                  {file.trashStatus === "TRASHED" && (
                    <button
                      type="button"
                      className="button secondary compact"
                      disabled={!!busyFile}
                      aria-label={`Khôi phục ${file.name}`}
                      onClick={() => void restore(file)}
                    >
                      <RotateCcw size={15} aria-hidden="true" /> Khôi phục
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {(cursor || page.nextCursor) && (
            <div className="library-dialog-actions">
              {cursor && (
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={!!busyFile}
                  onClick={() => {
                    setPage(undefined);
                    setCursors((current) => current.slice(0, -1));
                  }}
                >
                  Trang trước
                </button>
              )}
              {page.nextCursor && (
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={!!busyFile}
                  onClick={() => {
                    setPage(undefined);
                    setCursors((current) => [...current, page.nextCursor!]);
                  }}
                >
                  Trang sau
                </button>
              )}
            </div>
          )}
        </>
      )}
    </dialog>
  );
}
