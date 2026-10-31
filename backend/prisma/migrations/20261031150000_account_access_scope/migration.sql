-- Additive-only migration: existing rows keep current behavior (app_folder / not external / not hidden).
ALTER TABLE `connected_accounts`
  ADD COLUMN `access_scope` VARCHAR(32) NOT NULL DEFAULT 'app_folder';

ALTER TABLE `files`
  ADD COLUMN `is_external` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `folders`
  ADD COLUMN `is_external` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `hidden_at` DATETIME(3) NULL;

CREATE INDEX `files_connected_account_id_is_external_idx` ON `files`(`connected_account_id`, `is_external`);

CREATE INDEX `folders_connected_account_id_is_external_idx` ON `folders`(`connected_account_id`, `is_external`);
