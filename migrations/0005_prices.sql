-- 0005_prices.sql
-- Steam US/USD price state, sparse history, and deals tracking
-- Distinguishes free-to-play from unpriced/unavailable states

CREATE TABLE IF NOT EXISTS app_prices (
  appid INTEGER PRIMARY KEY,
  currency TEXT NOT NULL DEFAULT 'USD',
  initial_price INTEGER,
  final_price INTEGER,
  discount_percent INTEGER NOT NULL DEFAULT 0,
  is_free INTEGER NOT NULL DEFAULT 0,
  is_available INTEGER NOT NULL DEFAULT 1,
  formatted_initial TEXT,
  formatted_final TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_app_prices_discount ON app_prices(discount_percent, is_available);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_app_prices_observed ON app_prices(observed_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appid INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  initial_price INTEGER,
  final_price INTEGER,
  discount_percent INTEGER NOT NULL DEFAULT 0,
  is_free INTEGER NOT NULL DEFAULT 0,
  is_available INTEGER NOT NULL DEFAULT 1,
  formatted_price TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_price_history_appid_observed ON price_history(appid, observed_at ASC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_price_history_observed ON price_history(observed_at);
