-- Generated with Prisma migrate diff; destructive domain changes replaced with renames.

BEGIN;

ALTER TABLE "dashboards" RENAME TO "Dashboard";

ALTER TABLE "Dashboard" RENAME COLUMN "created_at" TO "createdAt";

ALTER TABLE "Dashboard" RENAME COLUMN "updated_at" TO "updatedAt";

ALTER TABLE "Dashboard" RENAME CONSTRAINT "dashboards_pkey" TO "Dashboard_pkey";

ALTER TABLE "services" RENAME TO "Service";

ALTER TABLE "Service" RENAME COLUMN "created_at" TO "createdAt";

ALTER TABLE "Service" RENAME COLUMN "updated_at" TO "updatedAt";

ALTER TABLE "Service" RENAME COLUMN "dashboard_id" TO "dashboardId";

ALTER TABLE "Service" RENAME COLUMN "http_path" TO "httpPath";

ALTER TABLE "Service" RENAME COLUMN "http_path_last" TO "httpPathLast";

ALTER TABLE "Service" RENAME COLUMN "https_path_last" TO "httpsPathLast";

ALTER TABLE "Service" RENAME COLUMN "http_xquery" TO "httpXquery";

ALTER TABLE "Service" RENAME COLUMN "http_xquery_last" TO "httpXqueryLast";

ALTER TABLE "Service" RENAME COLUMN "http_preview" TO "httpPreview";

ALTER TABLE "Service" RENAME COLUMN "http_screenshot" TO "httpScreenshot";

ALTER TABLE "Service" RENAME COLUMN "http_screenshot_hash" TO "httpScreenshotHash";

ALTER TABLE "Service" RENAME COLUMN "http_screenshot_preview" TO "httpScreenshotPreview";

ALTER TABLE "Service" RENAME COLUMN "checked_at" TO "checkedAt";

ALTER TABLE "Service" RENAME CONSTRAINT "services_pkey" TO "Service_pkey";

ALTER TABLE "Service" RENAME CONSTRAINT "fk_rails_725921ac06" TO "Service_dashboardId_fkey";

ALTER TABLE "service_check_jobs" RENAME TO "ServiceCheckJob";

ALTER TABLE "ServiceCheckJob" RENAME COLUMN "created_at" TO "createdAt";

ALTER TABLE "ServiceCheckJob" RENAME COLUMN "updated_at" TO "updatedAt";

ALTER TABLE "ServiceCheckJob" RENAME COLUMN "service_id" TO "serviceId";

ALTER TABLE "ServiceCheckJob" RENAME COLUMN "available_at" TO "availableAt";

ALTER TABLE "ServiceCheckJob" RENAME COLUMN "locked_by" TO "lockedBy";

ALTER TABLE "ServiceCheckJob" RENAME COLUMN "lease_expires_at" TO "leaseExpiresAt";

ALTER TABLE "ServiceCheckJob" RENAME COLUMN "max_attempts" TO "maxAttempts";

ALTER TABLE "ServiceCheckJob" RENAME COLUMN "last_error" TO "lastError";

ALTER TABLE "ServiceCheckJob" RENAME COLUMN "completed_at" TO "completedAt";

ALTER TABLE "ServiceCheckJob" RENAME CONSTRAINT "service_check_jobs_pkey" TO "ServiceCheckJob_pkey";

ALTER TABLE "ServiceCheckJob" RENAME CONSTRAINT "service_check_jobs_service_id_fkey" TO "ServiceCheckJob_serviceId_fkey";

ALTER TABLE "ServiceCheckJob" RENAME CONSTRAINT "service_check_jobs_status_check" TO "ServiceCheckJob_status_check";

ALTER TABLE "ServiceCheckJob" RENAME CONSTRAINT "service_check_jobs_attempts_check" TO "ServiceCheckJob_attempts_check";

ALTER INDEX "index_dashboards_on_name" RENAME TO "Dashboard_name_key";

ALTER INDEX "index_services_on_dashboard_id" RENAME TO "Service_dashboardId_idx";

ALTER INDEX "index_services_on_dashboard_id_and_name" RENAME TO "Service_dashboardId_name_key";

ALTER INDEX "service_check_jobs_claim_idx" RENAME TO "ServiceCheckJob_status_availableAt_createdAt_idx";

ALTER INDEX "service_check_jobs_active_service_id" RENAME TO "ServiceCheckJob_serviceId_active_key";

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "experimental" BOOLEAN NOT NULL DEFAULT false,
    "developer" BOOLEAN NOT NULL DEFAULT false,
    "themePreferred" TEXT NOT NULL DEFAULT 'automatic',
    "screenshots" BOOLEAN NOT NULL DEFAULT true,
    "displayMode" TEXT NOT NULL DEFAULT 'overlay',
    "refreshIntervalMs" INTEGER NOT NULL DEFAULT 60000,
    "dashboardOrder" TEXT NOT NULL DEFAULT 'asc',
    "serviceSort" TEXT NOT NULL DEFAULT 'name',
    "serviceOrder" TEXT NOT NULL DEFAULT 'asc',

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "csrfToken" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "User" ADD CONSTRAINT "User_username_normalized_check" CHECK (username = lower(btrim(username)) AND length(username) > 0);

COMMIT;
