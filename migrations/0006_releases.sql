-- 0006_releases.sql
-- Precise release facts and ISO week indexing for playable games and consumer expansions/DLC

CREATE TABLE IF NOT EXISTS release_facts (
  appid INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  type TEXT NOT NULL,
  parent_appid INTEGER,
  release_date TEXT NOT NULL,          -- Precise ISO-8601 date YYYY-MM-DD
  release_year INTEGER NOT NULL,       -- e.g. 2026
  release_week TEXT NOT NULL,          -- e.g. '2026-W36'
  release_status TEXT NOT NULL,        -- 'released' | 'upcoming'
  is_precise INTEGER NOT NULL DEFAULT 1,
  header_image TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_release_facts_week ON release_facts(release_week, release_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_release_facts_date ON release_facts(release_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_release_facts_parent ON release_facts(parent_appid);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_release_facts_type ON release_facts(type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_apps_release_date ON apps(release_date);
