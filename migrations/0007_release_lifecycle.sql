-- 0007_release_lifecycle.sql
-- Release lifecycle metadata and dated release events

ALTER TABLE apps ADD COLUMN steam_release_date TEXT;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN original_release_date TEXT;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN original_steam_release_date TEXT;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN release_from_early_access_date TEXT;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN release_date_source TEXT
  CHECK (
    release_date_source IS NULL OR
    release_date_source IN ('original_release_date', 'steam_release_date', 'appdetails')
  );
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN is_early_access INTEGER
  CHECK (is_early_access IS NULL OR is_early_access IN (0, 1));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_release_events (
  appid INTEGER NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('early_access', 'full_release', 'patch')),
  source TEXT NOT NULL
    CHECK (source IN ('original_steam_release_date', 'release_from_early_access_date', 'original_release_date')),
  event_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (appid, event_type, event_date),
  FOREIGN KEY (appid) REFERENCES apps(appid) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_app_release_events_date
  ON app_release_events(event_date, appid);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_app_release_events_appid
  ON app_release_events(appid, event_date);
