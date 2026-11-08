import "client-only";

export type SavedUpload = {
  uploadId: string;
  userId: string;
  groupId: string;
  filename: string;
  size: number;
  fingerprint: string;
  expiresAt: string;
  percent?: number;
  pending?: boolean;
  queuedAt?: number;
};
export type UploadFileHandle = FileSystemFileHandle & {
  queryPermission: (options: { mode: "read" }) => Promise<PermissionState>;
  requestPermission: (options: { mode: "read" }) => Promise<PermissionState>;
};
type UploadSource = {
  uploadId: string;
  file?: File;
  handle?: UploadFileHandle;
  fingerprint?: string;
};

// Sources are separate so listing metadata does not load every saved file.
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("streamora-uploads-v1", 2);
    request.onupgradeneeded = () => {
      for (const name of ["uploads", "sources"])
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name, { keyPath: "uploadId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transact<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("uploads", mode);
      const request = work(tx.objectStore("uploads"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? request.error);
    });
  } finally {
    db.close();
  }
}
export const uploadStore = {
  // Persist the entire selection atomically before any of its files starts uploading.
  async stage(
    entries: { upload: SavedUpload; source: Omit<UploadSource, "uploadId"> }[],
  ) {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["uploads", "sources"], "readwrite");
        for (const entry of entries) {
          const existing = tx.objectStore("uploads").get(entry.upload.uploadId);
          existing.onsuccess = () => {
            if (
              existing.result &&
              Date.parse(existing.result.expiresAt) > Date.now()
            ) {
              const saved = tx
                .objectStore("sources")
                .get(entry.upload.uploadId);
              saved.onsuccess = () => {
                if (!saved.result && existing.result.pending) {
                  tx.objectStore("uploads").put(entry.upload);
                  tx.objectStore("sources").put({
                    uploadId: entry.upload.uploadId,
                    ...entry.source,
                  });
                }
              };
              return;
            }
            tx.objectStore("uploads").put(entry.upload);
            tx.objectStore("sources").put({
              uploadId: entry.upload.uploadId,
              ...entry.source,
            });
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async save(
    upload: SavedUpload,
    source?: Omit<UploadSource, "uploadId">,
    pendingId?: string,
  ) {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["uploads", "sources"], "readwrite");
        tx.objectStore("uploads").put(upload);
        if (source || pendingId) {
          const store = tx.objectStore("sources");
          const existing = store.get(pendingId ?? upload.uploadId);
          existing.onsuccess = () => {
            if (pendingId && pendingId !== upload.uploadId) {
              // Move the already durable snapshot/handle; do not create a second queue entry.
              const original = existing.result as UploadSource | undefined;
              const next = original?.file
                ? { file: original.file }
                : (source ?? original);
              if (next)
                store.put({
                  ...next,
                  uploadId: upload.uploadId,
                  fingerprint: upload.fingerprint,
                });
              store.delete(pendingId);
              tx.objectStore("uploads").delete(pendingId);
              return;
            }
            // Reuse a durable Blob on resume; handles are small and may be replaced.
            if (
              source &&
              (!existing.result || source.handle || existing.result.handle)
            )
              store.put({
                uploadId: upload.uploadId,
                ...source,
                fingerprint: upload.fingerprint,
              });
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async remove(id: string) {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["uploads", "sources"], "readwrite");
        for (const name of ["uploads", "sources"])
          tx.objectStore(name).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async source(id: string, userId: string, groupId: string) {
    const metadata = await transact<SavedUpload | undefined>(
      "readonly",
      (store) => store.get(id),
    );
    if (!metadata || metadata.userId !== userId || metadata.groupId !== groupId)
      return;
    const db = await database();
    try {
      const source = await new Promise<UploadSource | undefined>(
        (resolve, reject) => {
          const request = db
            .transaction("sources")
            .objectStore("sources")
            .get(id);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        },
      );
      // A browser-owned immutable snapshot was saved atomically with this digest.
      // Native handles can point to changed files and must still be hashed after reload.
      if (
        source?.file &&
        source.file.size === metadata.size &&
        source.file.name === metadata.filename &&
        source.fingerprint === metadata.fingerprint &&
        /^sha256-tree-v1:[a-f0-9]{64}$/.test(source.fingerprint)
      )
        fingerprints.set(source.file, source.fingerprint);
      return source;
    } finally {
      db.close();
    }
  },
  async checkpoint(id: string, percent: number) {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("uploads", "readwrite");
        const store = tx.objectStore("uploads");
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result) store.put({ ...request.result, percent });
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async list(userId: string, groupId: string) {
    const rows = await transact<SavedUpload[]>("readonly", (store) =>
      store.getAll(),
    );
    const expired = rows.filter(
      (row) => Date.parse(row.expiresAt) <= Date.now(),
    );
    if (expired.length) {
      const db = await database();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("sources", "readwrite");
          for (const row of expired)
            tx.objectStore("sources").delete(row.uploadId);
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    }
    return rows
      .filter((row) => row.userId === userId && row.groupId === groupId)
      .sort(
        (a, b) =>
          Number(!!a.pending) - Number(!!b.pending) ||
          (a.queuedAt ?? 0) - (b.queuedAt ?? 0),
      );
  },
};

// File identity, not name/size: a reselected File must be verified again.
// Weak keys do not keep large files alive after their upload is dismissed.
const fingerprints = new WeakMap<File, string>();

// Hash every byte once per File, in bounded chunks. Shared by uploads and T10.
export async function fingerprintFile(file: File, signal: AbortSignal) {
  signal.throwIfAborted();
  const cached = fingerprints.get(file);
  if (cached) return cached;
  const hashes: string[] = [];
  for (let offset = 0; offset < file.size; offset += 8 * 1024 ** 2) {
    signal.throwIfAborted();
    const bytes = await file
      .slice(offset, offset + 8 * 1024 ** 2)
      .arrayBuffer();
    hashes.push(
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join(""),
    );
  }
  signal.throwIfAborted();
  const root = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${file.size}:${hashes.join(":")}`),
  );
  signal.throwIfAborted();
  const fingerprint = `sha256-tree-v1:${Array.from(new Uint8Array(root), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  fingerprints.set(file, fingerprint);
  return fingerprint;
}
