-- Preserve the last observation while dashboard cadence edits request a fresh
-- check. The request is cleared only by an accepted, revision-fenced observation.
ALTER TABLE "Service" ADD COLUMN "availabilityCheckRequestedAt" timestamptz(6);
