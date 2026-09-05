-- 0001_catalog.sql
-- Catalog identity, release facts, canonical slugs, and checkpoints

CREATE TABLE IF NOT EXISTS apps (
  appid INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'game',
  is_eligible INTEGER NOT NULL DEFAULT 1,
  is_playable INTEGER NOT NULL DEFAULT 1,
  parent_appid INTEGER,
  release_date TEXT,
  release_status TEXT NOT NULL DEFAULT 'released',
  description TEXT DEFAULT '',
  header_image TEXT DEFAULT '',
  developer TEXT DEFAULT '',
  publisher TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_apps_slug ON apps(slug);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_apps_type_playable ON apps(type, is_playable, is_eligible);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_apps_parent ON apps(parent_appid);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS checkpoints (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  cursor INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
