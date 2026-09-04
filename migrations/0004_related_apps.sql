-- 0004_related_apps.sql
-- Normalized related-app relationships and types for Steam catalog entities
-- Distinguishes dlc, expansion, soundtrack, server, tool, demo, test, and other

CREATE TABLE IF NOT EXISTS app_relationships (
  parent_appid INTEGER NOT NULL,
  child_appid INTEGER NOT NULL,
  relationship_type TEXT NOT NULL,
  prominence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (parent_appid, child_appid)
);

CREATE INDEX IF NOT EXISTS idx_app_relationships_parent ON app_relationships(parent_appid, relationship_type);
CREATE INDEX IF NOT EXISTS idx_app_relationships_child ON app_relationships(child_appid);
CREATE INDEX IF NOT EXISTS idx_app_relationships_type ON app_relationships(relationship_type);
