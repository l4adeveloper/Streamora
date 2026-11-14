-- AlterTable
ALTER TABLE "files" ADD COLUMN "is_published" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "files" ADD COLUMN "published_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "upload_sessions" ADD COLUMN "is_published" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "files_group_id_is_published_status_created_at_id_idx" ON "files"("group_id", "is_published", "status", "created_at", "id");

