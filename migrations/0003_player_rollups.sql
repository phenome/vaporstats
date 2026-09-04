-- 0003_player_rollups.sql
-- Durable UTC daily rollups for player counts and service-lifetime retention

CREATE TABLE IF NOT EXISTS player_rollups (
  appid INTEGER NOT NULL,
  date TEXT NOT NULL,
  min_players INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  avg_players REAL NOT NULL,
  close_players INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (appid, date)
);

CREATE INDEX IF NOT EXISTS idx_player_rollups_date ON player_rollups(date);
CREATE INDEX IF NOT EXISTS idx_player_rollups_appid_date ON player_rollups(appid, date DESC);
