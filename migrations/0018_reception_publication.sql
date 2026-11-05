CREATE TABLE `reception_publication_builds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'building' NOT NULL,
	`projection_version` integer NOT NULL,
	`history_key` text NOT NULL,
	`evaluated_at` text NOT NULL,
	`source_revision` integer NOT NULL,
	`cursor_appid` integer DEFAULT 0 NOT NULL,
	`max_appid` integer NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	CONSTRAINT "reception_publication_builds_status_check" CHECK("reception_publication_builds"."status" IN ('building', 'published', 'superseded')),
	CONSTRAINT "reception_publication_builds_revision_check" CHECK("reception_publication_builds"."source_revision" >= 0 AND "reception_publication_builds"."projection_version" > 0 AND "reception_publication_builds"."cursor_appid" >= 0 AND "reception_publication_builds"."max_appid" >= "reception_publication_builds"."cursor_appid")
);
--> statement-breakpoint
CREATE INDEX `idx_reception_publication_builds_status` ON `reception_publication_builds` (`status`,`id`);--> statement-breakpoint
CREATE TABLE `reception_publication_current` (
	`build_id` integer NOT NULL,
	`appid` integer NOT NULL,
	`type` text NOT NULL,
	`input_revision` integer NOT NULL,
	`history_key` text NOT NULL,
	`metric_value` real,
	`qualifying_reviews` integer,
	`score_history_id` integer,
	`metric_json` text,
	`population_json` text,
	`source_timestamp` text,
	`next_evaluation_at` text,
	PRIMARY KEY(`build_id`, `appid`, `type`),
	FOREIGN KEY (`build_id`) REFERENCES `reception_publication_builds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`score_history_id`) REFERENCES `player_score_history`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "reception_publication_current_type_check" CHECK("reception_publication_current"."type" IN ('top_rated_now', 'top_rated_all_time')),
	CONSTRAINT "reception_publication_current_revision_check" CHECK("reception_publication_current"."input_revision" >= 0),
	CONSTRAINT "reception_publication_current_metric_check" CHECK("reception_publication_current"."metric_value" IS NULL OR "reception_publication_current"."metric_value" BETWEEN 0 AND 100),
	CONSTRAINT "reception_publication_current_counts_check" CHECK("reception_publication_current"."qualifying_reviews" IS NULL OR "reception_publication_current"."qualifying_reviews" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_reception_publication_current_order` ON `reception_publication_current` (`build_id`,`type`,"metric_value" desc,"qualifying_reviews" desc,`appid`);--> statement-breakpoint
CREATE INDEX `idx_reception_publication_current_due` ON `reception_publication_current` (`build_id`,`next_evaluation_at`,`appid`);--> statement-breakpoint
CREATE INDEX `idx_reception_publication_current_appid` ON `reception_publication_current` (`appid`,`build_id`);--> statement-breakpoint
CREATE INDEX `idx_reception_publication_current_history` ON `reception_publication_current` (`history_key`,`appid`,`type`);--> statement-breakpoint
CREATE TABLE `reception_publication_months` (
	`history_key` text NOT NULL,
	`appid` integer NOT NULL,
	`type` text NOT NULL,
	`cutoff` text NOT NULL,
	`metric_kind` text NOT NULL,
	`value` real NOT NULL,
	`lifetime_approval` real,
	`lifetime_reviews` integer,
	`observed_at` text NOT NULL,
	`source_observed_at` text,
	`formula_version` text,
	`recalculation_json` text,
	`score_window_end` text,
	`provenance` text NOT NULL,
	`score_history_id` integer,
	PRIMARY KEY(`history_key`, `appid`, `type`, `cutoff`),
	FOREIGN KEY (`appid`) REFERENCES `apps`(`appid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`score_history_id`) REFERENCES `player_score_history`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "reception_publication_months_type_check" CHECK("reception_publication_months"."type" IN ('top_rated_now', 'top_rated_all_time')),
	CONSTRAINT "reception_publication_months_kind_check" CHECK("reception_publication_months"."metric_kind" IN ('current_player_score', 'lifetime_confidence')),
	CONSTRAINT "reception_publication_months_value_check" CHECK("reception_publication_months"."value" BETWEEN 0 AND 100 AND ("reception_publication_months"."lifetime_approval" IS NULL OR "reception_publication_months"."lifetime_approval" BETWEEN 0 AND 100)),
	CONSTRAINT "reception_publication_months_count_check" CHECK("reception_publication_months"."lifetime_reviews" IS NULL OR "reception_publication_months"."lifetime_reviews" >= 0),
	CONSTRAINT "reception_publication_months_provenance_check" CHECK("reception_publication_months"."provenance" IN ('recorded', 'reconstructed', 'lifetime_summary'))
);
--> statement-breakpoint
CREATE INDEX `idx_reception_publication_months_order` ON `reception_publication_months` (`type`,`cutoff`,"value" desc,"lifetime_reviews" desc,`appid`);--> statement-breakpoint
CREATE INDEX `idx_reception_publication_months_appid` ON `reception_publication_months` (`appid`,`history_key`);--> statement-breakpoint
CREATE TABLE `reception_publication_revisions` (
	`appid` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "reception_publication_revisions_revision_check" CHECK("reception_publication_revisions"."revision" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_reception_publication_revisions_revision` ON `reception_publication_revisions` (`revision`,`appid`);--> statement-breakpoint
CREATE TABLE `reception_publication_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`published_build_id` integer,
	`source_revision` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`published_build_id`) REFERENCES `reception_publication_builds`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reception_publication_state_singleton_check" CHECK("reception_publication_state"."id" = 1),
	CONSTRAINT "reception_publication_state_revision_check" CHECK("reception_publication_state"."source_revision" >= 0)
);

--> statement-breakpoint
CREATE TRIGGER reception_invalidate_apps_insert
AFTER INSERT ON apps
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_apps_update
AFTER UPDATE ON apps
WHEN OLD.appid IS NOT NEW.appid
  OR OLD.type IS NOT NEW.type
  OR OLD.is_eligible IS NOT NEW.is_eligible
  OR OLD.is_playable IS NOT NEW.is_playable
  OR OLD.parent_appid IS NOT NEW.parent_appid
  OR OLD.release_status IS NOT NEW.release_status
  OR OLD.is_early_access IS NOT NEW.is_early_access
  OR OLD.has_left_early_access IS NOT NEW.has_left_early_access
  OR OLD.release_date IS NOT NEW.release_date
  OR OLD.steam_release_date IS NOT NEW.steam_release_date
  OR OLD.original_release_date IS NOT NEW.original_release_date
  OR OLD.original_steam_release_date IS NOT NEW.original_steam_release_date
  OR OLD.release_from_early_access_date IS NOT NEW.release_from_early_access_date
  OR OLD.release_date_source IS NOT NEW.release_date_source
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid UNION SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_apps_delete
AFTER DELETE ON apps
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_review_buckets_insert
AFTER INSERT ON review_buckets
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_review_buckets_update
AFTER UPDATE ON review_buckets
WHEN OLD.appid IS NOT NEW.appid
  OR OLD.source_id IS NOT NEW.source_id
  OR OLD.granularity IS NOT NEW.granularity
  OR OLD.period_start IS NOT NEW.period_start
  OR OLD.period_end IS NOT NEW.period_end
  OR OLD.positive_count IS NOT NEW.positive_count
  OR OLD.negative_count IS NOT NEW.negative_count
  OR OLD.observed_at IS NOT NEW.observed_at
  OR OLD.provenance IS NOT NEW.provenance
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid UNION SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_review_buckets_delete
AFTER DELETE ON review_buckets
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_review_summary_snapshots_insert
AFTER INSERT ON review_summary_snapshots
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_review_summary_snapshots_update
AFTER UPDATE ON review_summary_snapshots
WHEN OLD.appid IS NOT NEW.appid
  OR OLD.source_id IS NOT NEW.source_id
  OR OLD.observed_at IS NOT NEW.observed_at
  OR OLD.lifetime_positive_count IS NOT NEW.lifetime_positive_count
  OR OLD.lifetime_total_count IS NOT NEW.lifetime_total_count
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid UNION SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_review_summary_snapshots_delete
AFTER DELETE ON review_summary_snapshots
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_player_score_history_insert
AFTER INSERT ON player_score_history
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_player_score_history_update
AFTER UPDATE ON player_score_history
WHEN OLD.id IS NOT NEW.id
  OR OLD.appid IS NOT NEW.appid
  OR OLD.observed_at IS NOT NEW.observed_at
  OR OLD.score IS NOT NEW.score
  OR OLD.formula_version IS NOT NEW.formula_version
  OR OLD.current_positive_count IS NOT NEW.current_positive_count
  OR OLD.current_total_count IS NOT NEW.current_total_count
  OR OLD.historical_positive_count IS NOT NEW.historical_positive_count
  OR OLD.historical_total_count IS NOT NEW.historical_total_count
  OR OLD.current_window_start IS NOT NEW.current_window_start
  OR OLD.current_window_end IS NOT NEW.current_window_end
  OR OLD.historical_window_start IS NOT NEW.historical_window_start
  OR OLD.historical_window_end IS NOT NEW.historical_window_end
  OR OLD.current_evidence_intervals IS NOT NEW.current_evidence_intervals
  OR OLD.historical_evidence_intervals IS NOT NEW.historical_evidence_intervals
  OR OLD.current_source_id IS NOT NEW.current_source_id
  OR OLD.historical_source_id IS NOT NEW.historical_source_id
  OR OLD.current_evidence_observed_at IS NOT NEW.current_evidence_observed_at
  OR OLD.historical_evidence_observed_at IS NOT NEW.historical_evidence_observed_at
  OR OLD.anchor_event_id IS NOT NEW.anchor_event_id
  OR OLD.anchor_at IS NOT NEW.anchor_at
  OR OLD.provenance IS NOT NEW.provenance
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid UNION SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_player_score_history_delete
AFTER DELETE ON player_score_history
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_player_score_state_insert
AFTER INSERT ON player_score_state
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_player_score_state_update
AFTER UPDATE ON player_score_state
WHEN OLD.appid IS NOT NEW.appid
  OR OLD.latest_score_history_id IS NOT NEW.latest_score_history_id
  OR OLD.historical_positive_count IS NOT NEW.historical_positive_count
  OR OLD.historical_total_count IS NOT NEW.historical_total_count
  OR OLD.historical_source_id IS NOT NEW.historical_source_id
  OR OLD.historical_window_start IS NOT NEW.historical_window_start
  OR OLD.historical_window_end IS NOT NEW.historical_window_end
  OR OLD.historical_evidence_intervals IS NOT NEW.historical_evidence_intervals
  OR OLD.historical_baseline_observed_at IS NOT NEW.historical_baseline_observed_at
  OR OLD.eligibility_review_count IS NOT NEW.eligibility_review_count
  OR OLD.eligibility_source_id IS NOT NEW.eligibility_source_id
  OR OLD.eligibility_window_start IS NOT NEW.eligibility_window_start
  OR OLD.eligibility_window_end IS NOT NEW.eligibility_window_end
  OR OLD.eligibility_evidence_start IS NOT NEW.eligibility_evidence_start
  OR OLD.eligibility_evidence_end IS NOT NEW.eligibility_evidence_end
  OR OLD.eligibility_evidence_intervals IS NOT NEW.eligibility_evidence_intervals
  OR OLD.eligibility_observed_at IS NOT NEW.eligibility_observed_at
  OR OLD.eligibility_provenance IS NOT NEW.eligibility_provenance
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid UNION SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_player_score_state_delete
AFTER DELETE ON player_score_state
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_steam_events_insert
AFTER INSERT ON steam_events
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_steam_events_update
AFTER UPDATE ON steam_events
WHEN OLD.event_id IS NOT NEW.event_id
  OR OLD.appid IS NOT NEW.appid
  OR OLD.category IS NOT NEW.category
  OR OLD.title IS NOT NEW.title
  OR OLD.url IS NOT NEW.url
  OR OLD.start_at IS NOT NEW.start_at
  OR OLD.publication_at IS NOT NEW.publication_at
  OR OLD.observed_at IS NOT NEW.observed_at
  OR OLD.source IS NOT NEW.source
  OR OLD.provenance IS NOT NEW.provenance
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid UNION SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_steam_events_delete
AFTER DELETE ON steam_events
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_app_release_events_insert
AFTER INSERT ON app_release_events
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_app_release_events_update
AFTER UPDATE ON app_release_events
WHEN OLD.appid IS NOT NEW.appid
  OR OLD.event_type IS NOT NEW.event_type
  OR OLD.source IS NOT NEW.source
  OR OLD.event_date IS NOT NEW.event_date
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid UNION SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_app_release_events_delete
AFTER DELETE ON app_release_events
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_app_facet_memberships_insert
AFTER INSERT ON app_facet_memberships
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_app_facet_memberships_update
AFTER UPDATE ON app_facet_memberships
WHEN OLD.appid IS NOT NEW.appid
  OR OLD.facet_group IS NOT NEW.facet_group
  OR OLD.source_id IS NOT NEW.source_id
  OR OLD.source_order IS NOT NEW.source_order
  OR OLD.weight IS NOT NEW.weight
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid UNION SELECT NEW.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_app_facet_memberships_delete
AFTER DELETE ON app_facet_memberships
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT OLD.appid AS appid
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_app_facets_insert
AFTER INSERT ON app_facets
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT appid FROM app_facet_memberships WHERE (facet_group = NEW.facet_group AND source_id = NEW.source_id)
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_app_facets_update
AFTER UPDATE ON app_facets
WHEN OLD.facet_group IS NOT NEW.facet_group
  OR OLD.source_id IS NOT NEW.source_id
  OR OLD.name IS NOT NEW.name
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT appid FROM app_facet_memberships WHERE (facet_group = OLD.facet_group AND source_id = OLD.source_id) OR (facet_group = NEW.facet_group AND source_id = NEW.source_id)
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_app_facets_delete
BEFORE DELETE ON app_facets
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT appid FROM app_facet_memberships WHERE (facet_group = OLD.facet_group AND source_id = OLD.source_id)
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_review_sources_insert
AFTER INSERT ON review_sources
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT appid FROM review_buckets WHERE source_id IN (NEW.id)
    UNION SELECT appid FROM review_summary_snapshots WHERE source_id IN (NEW.id)
    UNION SELECT appid FROM player_score_history WHERE current_source_id IN (NEW.id) OR historical_source_id IN (NEW.id)
    UNION SELECT appid FROM player_score_state WHERE historical_source_id IN (NEW.id) OR eligibility_source_id IN (NEW.id)
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_review_sources_update
AFTER UPDATE ON review_sources
WHEN OLD.id IS NOT NEW.id
  OR OLD.endpoint IS NOT NEW.endpoint
  OR OLD.request_filter IS NOT NEW.request_filter
  OR OLD.language IS NOT NEW.language
  OR OLD.purchase_type IS NOT NEW.purchase_type
  OR OLD.day_range IS NOT NEW.day_range
  OR OLD.filter_offtopic_activity IS NOT NEW.filter_offtopic_activity
  OR OLD.population IS NOT NEW.population
  OR OLD.population_flags IS NOT NEW.population_flags
  OR OLD.interpretation_version IS NOT NEW.interpretation_version
  OR OLD.identity_key IS NOT NEW.identity_key
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT appid FROM review_buckets WHERE source_id IN (OLD.id, NEW.id)
    UNION SELECT appid FROM review_summary_snapshots WHERE source_id IN (OLD.id, NEW.id)
    UNION SELECT appid FROM player_score_history WHERE current_source_id IN (OLD.id, NEW.id) OR historical_source_id IN (OLD.id, NEW.id)
    UNION SELECT appid FROM player_score_state WHERE historical_source_id IN (OLD.id, NEW.id) OR eligibility_source_id IN (OLD.id, NEW.id)
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
--> statement-breakpoint
CREATE TRIGGER reception_invalidate_review_sources_delete
BEFORE DELETE ON review_sources
BEGIN
  INSERT INTO reception_publication_state (id, source_revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET source_revision = source_revision + 1;
  INSERT INTO reception_publication_revisions (appid, revision)
  SELECT affected.appid, (SELECT source_revision FROM reception_publication_state WHERE id = 1)
  FROM (
    SELECT appid FROM review_buckets WHERE source_id IN (OLD.id)
    UNION SELECT appid FROM review_summary_snapshots WHERE source_id IN (OLD.id)
    UNION SELECT appid FROM player_score_history WHERE current_source_id IN (OLD.id) OR historical_source_id IN (OLD.id)
    UNION SELECT appid FROM player_score_state WHERE historical_source_id IN (OLD.id) OR eligibility_source_id IN (OLD.id)
  ) AS affected WHERE 1
  ON CONFLICT(appid) DO UPDATE SET revision = excluded.revision;
END;
