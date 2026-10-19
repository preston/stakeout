BEGIN;

ALTER TABLE "Dashboard"
  ADD COLUMN "monitoringEnabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN "checkIntervalSeconds" integer NOT NULL DEFAULT 60,
  ADD COLUMN "screenshotsEnabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN "screenshotIntervalSeconds" integer NOT NULL DEFAULT 60,
  ADD COLUMN "screenshotDemandUntil" timestamptz(6),
  ADD COLUMN "monitoringRevision" integer NOT NULL DEFAULT 1,
  ADD COLUMN "hourlyRetentionDays" integer DEFAULT 14,
  ADD COLUMN "dailyRetentionDays" integer,
  ADD COLUMN "availabilityRetentionDays" integer,
  ADD COLUMN "historyStartedAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "Dashboard_monitoring_check" CHECK (
    "checkIntervalSeconds" > 0 AND "screenshotIntervalSeconds" > 0 AND "monitoringRevision" > 0
    AND ("hourlyRetentionDays" IS NULL OR "hourlyRetentionDays" > 0)
    AND ("dailyRetentionDays" IS NULL OR "dailyRetentionDays" > 0)
    AND ("availabilityRetentionDays" IS NULL OR "availabilityRetentionDays" > 0));

ALTER TABLE "Service"
  ADD COLUMN "configRevision" integer NOT NULL DEFAULT 1,
  ADD COLUMN "screenshotCheckedAt" timestamptz(6),
  ADD COLUMN "historyStartedAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "availabilityPrunedBefore" timestamptz(6);

CREATE TABLE "ServiceConfiguration" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "serviceId" uuid NOT NULL REFERENCES "Service"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  revision integer NOT NULL,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  host text NOT NULL,
  port integer NOT NULL,
  http boolean NOT NULL,
  https boolean NOT NULL,
  "httpPath" text NOT NULL,
  "httpXquery" text,
  CONSTRAINT "ServiceConfiguration_serviceId_revision_key" UNIQUE ("serviceId", revision)
);

CREATE TABLE "AvailabilityInterval" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "serviceId" uuid NOT NULL REFERENCES "Service"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "configurationId" uuid NOT NULL REFERENCES "ServiceConfiguration"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "startedAt" timestamptz(6) NOT NULL,
  "endedAt" timestamptz(6),
  "lastObservedAt" timestamptz(6),
  state text NOT NULL,
  "httpState" text,
  "httpsState" text,
  reason text,
  "httpStatus" integer,
  "httpsStatus" integer,
  "httpError" text,
  "httpsError" text,
  "eventKind" text NOT NULL DEFAULT 'status',
  "checkIntervalSeconds" integer NOT NULL DEFAULT 60,
  CONSTRAINT "AvailabilityInterval_state_check" CHECK (state IN ('up','degraded','down','unknown','paused')),
  CONSTRAINT "AvailabilityInterval_protocol_check" CHECK (
    ("httpState" IS NULL OR "httpState" IN ('up','down')) AND
    ("httpsState" IS NULL OR "httpsState" IN ('up','down'))),
  CONSTRAINT "AvailabilityInterval_time_check" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"),
  CONSTRAINT "AvailabilityInterval_cadence_check" CHECK ("checkIntervalSeconds" > 0)
);
CREATE INDEX "AvailabilityInterval_serviceId_startedAt_idx" ON "AvailabilityInterval" ("serviceId", "startedAt");
CREATE INDEX "AvailabilityInterval_endedAt_idx" ON "AvailabilityInterval" ("endedAt");
CREATE UNIQUE INDEX "AvailabilityInterval_open_key" ON "AvailabilityInterval" ("serviceId") WHERE "endedAt" IS NULL;

CREATE TABLE "PerformanceAggregate" (
  "serviceId" uuid NOT NULL REFERENCES "Service"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  resolution text NOT NULL,
  "bucketStart" timestamptz(6) NOT NULL,
  "httpCount" integer NOT NULL DEFAULT 0,
  "httpFailures" integer NOT NULL DEFAULT 0,
  "httpResponseCount" integer NOT NULL DEFAULT 0,
  "httpDurationSum" double precision NOT NULL DEFAULT 0,
  "httpDurationMin" double precision,
  "httpDurationMax" double precision,
  "httpsCount" integer NOT NULL DEFAULT 0,
  "httpsFailures" integer NOT NULL DEFAULT 0,
  "httpsResponseCount" integer NOT NULL DEFAULT 0,
  "httpsDurationSum" double precision NOT NULL DEFAULT 0,
  "httpsDurationMin" double precision,
  "httpsDurationMax" double precision,
  CONSTRAINT "PerformanceAggregate_pkey" PRIMARY KEY ("serviceId", resolution, "bucketStart"),
  CONSTRAINT "PerformanceAggregate_resolution_check" CHECK (resolution IN ('hour','day'))
);
CREATE INDEX "PerformanceAggregate_resolution_bucketStart_idx" ON "PerformanceAggregate" (resolution, "bucketStart");

-- Queue rows are transient operational state. Rebuild the queue with one reusable
-- schedule per task rather than carrying completed per-check jobs into history.
DELETE FROM "ServiceCheckJob";
DROP INDEX "ServiceCheckJob_serviceId_active_key";
ALTER TABLE "ServiceCheckJob" ADD COLUMN kind text NOT NULL DEFAULT 'availability',
  ADD CONSTRAINT "ServiceCheckJob_kind_check" CHECK (kind IN ('availability','screenshot')),
  ADD CONSTRAINT "ServiceCheckJob_serviceId_kind_key" UNIQUE ("serviceId", kind);
INSERT INTO "ServiceCheckJob" ("serviceId",kind,"availableAt")
  SELECT id,'availability',now() + (abs(hashtext(id::text)::bigint) % 60) * interval '1 second'
  FROM "Service" WHERE coalesce(http,false) OR coalesce(https,false);
INSERT INTO "ServiceCheckJob" ("serviceId",kind)
  SELECT id,'screenshot' FROM "Service" WHERE "httpPreview" AND (http OR https);

COMMIT;
