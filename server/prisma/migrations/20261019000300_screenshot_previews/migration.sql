BEGIN;

ALTER TABLE services
  ADD COLUMN http_screenshot_hash varchar(64),
  ADD COLUMN http_screenshot_preview bytea;

-- Existing originals remain available immediately. Previews are generated on
-- first use, then replaced atomically with subsequent worker captures.
UPDATE services
SET http_screenshot_hash = encode(sha256(http_screenshot), 'hex')
WHERE http_screenshot IS NOT NULL;

COMMIT;
