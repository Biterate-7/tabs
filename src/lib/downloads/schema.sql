-- Hubble Desktop download counts — aggregate only.
--
-- One row per (UTC day, platform, version), holding a number. That is the
-- whole of what is measured: there is no column for an IP address, a user
-- agent, a cookie, an account, a referrer or a time of day, so no row can
-- describe a person or be joined to one.
--
-- Additive and idempotent: IF NOT EXISTS throughout. Apply it with
-- `npm run migrate:downloads` (scripts/migrate-downloads.mjs). Independent of
-- every other schema; it references nothing.

CREATE TABLE IF NOT EXISTS tabdump_desktop_downloads (
  day        DATE   NOT NULL,
  platform   TEXT   NOT NULL CHECK (platform IN ('windows', 'macos', 'linux')),
  version    TEXT   NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  downloads  BIGINT NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  PRIMARY KEY (day, platform, version)
);
