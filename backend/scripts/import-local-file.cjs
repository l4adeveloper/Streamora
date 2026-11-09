const { randomUUID } = require("node:crypto");
const { lstat, readdir, stat } = require("node:fs/promises");
const {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} = require("node:path");
const { parseArgs } = require("node:util");
const { isUUID } = require("class-validator");
const { PrismaService } = require("../dist/database/prisma.service");
const {
  GroupAccessService,
} = require("../dist/modules/memberships/group-access.service");
const {
  FileStorageService,
} = require("../dist/modules/files/file-storage.service");
const {
  StorageLocationsService,
} = require("../dist/modules/files/storage-locations.service");
const {
  loadEnvironmentFile,
  readEnvironment,
} = require("../dist/config/environment");

const MIME = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// Local developer import only. No public upload endpoint or browser-selected owner.
async function importLocalFile(config, input, shared) {
  if (config.files?.driver !== "local")
    throw new Error("Đặt FILES_STORAGE_DRIVER=local trước khi nhập file thử.");
  if (!isUUID(input.group ?? "") || !input.email || !input.path)
    throw new Error("Cần --group UUID --email EMAIL --path DUONG_DAN_FILE.");
  const source = input.source ?? "DOCUMENT";
  if (
    !["DOCUMENT", "LOCAL_RECORDING"].includes(source) ||
    (source === "LOCAL_RECORDING" && !isUUID(input.session ?? ""))
  )
    throw new Error(
      "source là DOCUMENT hoặc LOCAL_RECORDING; bản ghi cục bộ cần --session UUID.",
    );
  const path = resolve(input.path);
  const info = await stat(path);
  if (!info.isFile() || !Number.isSafeInteger(info.size))
    throw new Error("Đường dẫn phải trỏ đến file hợp lệ.");
  const name = (input.name ?? basename(path)).trim();
  if (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name))
    throw new Error("Tên file phải có 1–255 ký tự hợp lệ.");
  const prisma = shared?.prisma ?? new PrismaService(config.databaseUrl);
  const access = shared?.access ?? new GroupAccessService(prisma);
  const storage =
    shared?.storage ??
    new FileStorageService(config, new StorageLocationsService(config, prisma));
  let id,
    copied = false;
  const objectKey = `local/${randomUUID()}`;
  if (!shared) await prisma.onModuleInit();
  try {
    const storageLocationId = await storage.currentLocationId();
    const user = await prisma.user.findUnique({
      where: { email: input.email.trim().toLowerCase() },
    });
    if (!user)
      throw new Error(
        "Email chưa có tài khoản Streamora. Hãy đăng ký tài khoản trước.",
      );
    const row = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM groups WHERE id = ${input.group}::uuid FOR UPDATE`;
      await access.require(user.id, input.group, "canUpload", tx);
      if (input.session) {
        const session = await tx.classSession.findUnique({
          where: { id: input.session },
        });
        if (!session || session.groupId !== input.group)
          throw new Error("Buổi học không thuộc group này.");
      }
      return tx.libraryFile.create({
        data: {
          groupId: input.group,
          createdBy: user.id,
          name,
          size: BigInt(info.size),
          mimeType:
            MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
          source,
          status: "PENDING",
          sessionId: input.session ?? null,
          objectKey,
          storageLocationId,
        },
      });
    });
    id = row.id;
    await storage.importLocalFile(path, objectKey);
    copied = true;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM groups WHERE id = ${input.group}::uuid FOR UPDATE`;
      await access.require(user.id, input.group, "canUpload", tx);
      await tx.libraryFile.update({
        where: { id },
        data: { status: "AVAILABLE" },
      });
    });
    return { fileId: id, name, groupId: input.group };
  } catch (error) {
    if (id)
      await prisma.libraryFile.deleteMany({ where: { id, status: "PENDING" } });
    if (copied) await storage.delete(objectKey);
    throw error;
  } finally {
    if (!shared) {
      storage.onModuleDestroy();
      await prisma.onModuleDestroy();
    }
  }
}

async function* folderFiles(
  folder,
  { recursive = true, storageDirectory } = {},
) {
  const root = resolve(folder);
  if (!(await lstat(root)).isDirectory())
    throw new Error(
      "--folder phải là thư mục thật, không phải file hoặc symlink.",
    );
  const storage = storageDirectory ? resolve(storageDirectory) : undefined;
  function inStorage(path) {
    if (!storage) return false;
    const child = relative(storage, path);
    return (
      child === "" ||
      (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
    );
  }
  if (inStorage(root))
    throw new Error("Không nhập lại thư mục lưu trữ nội bộ của Streamora.");
  async function* walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || inStorage(path)) continue;
      if (entry.isFile())
        yield { path, name: relative(root, path).split(sep).join("/") };
      else if (recursive && entry.isDirectory()) yield* walk(path);
    }
  }
  yield* walk(root);
}

async function importLocalFolder(config, input, onImported = () => {}) {
  if (config.files?.driver !== "local")
    throw new Error("Đặt FILES_STORAGE_DRIVER=local trước khi nhập thư mục.");
  if (!isUUID(input.group ?? "") || !input.email || !input.folder)
    throw new Error(
      "Cần --group UUID --email EMAIL --folder DUONG_DAN_THU_MUC.",
    );
  if (input.path || input.name)
    throw new Error("--folder không dùng cùng --path hoặc --name.");
  const prisma = new PrismaService(config.databaseUrl);
  const shared = {
    prisma,
    access: new GroupAccessService(prisma),
    storage: new FileStorageService(
      config,
      new StorageLocationsService(config, prisma),
    ),
  };
  let count = 0;
  try {
    await prisma.onModuleInit();
    for await (const file of folderFiles(input.folder, {
      recursive: !input["no-recursive"],
      storageDirectory: config.files.localDirectory,
    })) {
      const result = await importLocalFile(
        config,
        { ...input, ...file },
        shared,
      );
      count++;
      onImported(result);
    }
    return { count, groupId: input.group };
  } catch (error) {
    // Earlier imports remain available if a later file fails. Never claim the whole folder succeeded.
    error.importedCount = count;
    throw error;
  } finally {
    shared.storage.onModuleDestroy();
    await prisma.onModuleDestroy();
  }
}
async function main() {
  const { values } = parseArgs({
    options: {
      group: { type: "string" },
      email: { type: "string" },
      path: { type: "string" },
      folder: { type: "string" },
      "no-recursive": { type: "boolean" },
      name: { type: "string" },
      source: { type: "string" },
      session: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      'npm run files:import -- --group UUID --email EMAIL --path "D:\\tai-lieu.pdf" [--name "Tên hiển thị.pdf"]',
    );
    console.log(
      'npm run files:import -- --group UUID --email EMAIL --folder "D:\\TaiLieu" [--no-recursive]',
    );
    return;
  }
  loadEnvironmentFile();
  if (values.folder) {
    const result = await importLocalFolder(
      readEnvironment(),
      values,
      (file) => {
        console.log(`Đã nhập ${file.name}. fileId=${file.fileId}`);
      },
    );
    console.log(
      `Hoàn tất: ${result.count} file. Mở /files?groupId=${result.groupId} và bấm Làm mới.`,
    );
    return;
  }
  if (values["no-recursive"])
    throw new Error("--no-recursive chỉ dùng với --folder.");
  const result = await importLocalFile(readEnvironment(), values);
  console.log(`Đã nhập ${result.name}. fileId=${result.fileId}`);
  console.log(`Mở /files?groupId=${result.groupId} và bấm Làm mới.`);
}
if (require.main === module)
  main().catch((error) => {
    if (error.importedCount !== undefined)
      console.error(
        `Nhập thư mục chưa hoàn tất. ${error.importedCount} file trước đó đã được thêm thành công.`,
      );
    console.error(
      error.getResponse?.().error?.message ??
        (error.name?.startsWith("Prisma")
          ? "Không thể lưu metadata. Kiểm tra database/migration."
          : error.message),
    );
    process.exitCode = 1;
  });
module.exports = { importLocalFile, importLocalFolder, folderFiles };
