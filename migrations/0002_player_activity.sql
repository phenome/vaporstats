-- 0002_player_activity.sql
-- Player activity tracking, observations, and daily request caps

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appid INTEGER NOT NULL,
  current_players INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_observations_appid_observed_at ON observations(appid, observed_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_observations_observed_at ON observations(observed_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS tracked_games (
  appid INTEGER PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'daily',
  slot INTEGER NOT NULL DEFAULT 0,
  next_due_at TEXT NOT NULL,
  last_attempted_at TEXT,
  last_successful_at TEXT,
  latest_players INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_tracked_games_tier_due ON tracked_games(tier, next_due_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tracked_games_next_due ON tracked_games(next_due_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS player_daily_requests (
  date TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
