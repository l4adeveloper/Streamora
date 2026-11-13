-- CreateTable
CREATE TABLE "folders" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "files" ADD COLUMN "folder_id" UUID;

-- AlterTable
ALTER TABLE "upload_sessions" ADD COLUMN "folder_id" UUID;

-- CreateIndex
CREATE INDEX "folders_group_id_parent_id_deleted_at_name_idx" ON "folders"("group_id", "parent_id", "deleted_at", "name");

-- CreateIndex
CREATE INDEX "files_group_id_folder_id_status_created_at_id_idx" ON "files"("group_id", "folder_id", "status", "created_at", "id");

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

