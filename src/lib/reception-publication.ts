import type { AppDatabase, AppPreparedStatement } from "./db";
import { PLAYER_SCORE_FORMULA_VERSION } from "./player-score";
import { evaluateReceptionProjectionBatch, getReceptionMonthCutoffs } from "./reception-evaluation";
import {
  RECEPTION_EVALUATION_BATCH_SIZE,
  RECEPTION_PROJECTION_VERSION,
  type ReceptionProjectionEvaluation,
} from "./reception-projection-types";

export interface ReceptionPublicationOptions {
  evaluatedAt?: Date | string;
  batchSize?: number;
}

export interface ReceptionPublicationProgress {
  status: "building" | "published" | "unchanged";
  buildId: number;
  publishedBuildId: number | null;
  evaluatedAt: string;
  cursorAppid: number;
  maxAppid: number;
  /** Work performed by this invocation; the keyset cursor is durable. */
  inspected: number;
  evaluated: number;
  reused: number;
  restarted: boolean;
}

export interface PublishedReceptionBuild {
  id: number;
  status: "building" | "published" | "superseded";
  projection_version: number;
  history_key: string;
  evaluated_at: string;
  source_revision: number;
  cursor_appid: number;
  max_appid: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

type State = { source_revision: number; published_build_id: number | null };
type Candidate = { appid: number; revision: number };
type Cached = { appid: number; input_revision: number; history_key: string; next_evaluation_at: string | null };
const locks = new WeakMap<AppDatabase, Promise<unknown>>();

// Serialize callers sharing the writer connection, including startup and ingestion.
async function exclusive<T>(db: AppDatabase, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(db) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  locks.set(db, current);
  try { return await current; }
  finally { if (locks.get(db) === current) locks.delete(db); }
}

function settings(options: ReceptionPublicationOptions): { at: string; size: number } {
  const value = options.evaluatedAt ?? new Date();
  const time = value instanceof Date ? value.getTime() : /Z$/i.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new RangeError("Invalid reception publication time");
  const size = options.batchSize ?? RECEPTION_EVALUATION_BATCH_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > RECEPTION_EVALUATION_BATCH_SIZE) {
    throw new RangeError("Reception publication batch size must be between 1 and 32");
  }
  return { at: new Date(time).toISOString(), size };
}

function identity(at: string): string {
  return JSON.stringify([RECEPTION_PROJECTION_VERSION, PLAYER_SCORE_FORMULA_VERSION, getReceptionMonthCutoffs(at)]);
}

/** Metadata only: never evaluates evidence or creates a publication. */
export async function getPublishedReceptionBuild(db: AppDatabase): Promise<PublishedReceptionBuild | null> {
  return db.prepare(`SELECT b.* FROM reception_publication_builds b
    JOIN reception_publication_state s ON s.published_build_id = b.id
    WHERE s.id = 1 AND b.status = 'published'`).first<PublishedReceptionBuild>();
}

async function state(db: AppDatabase): Promise<State> {
  return (await db.prepare("SELECT source_revision, published_build_id FROM reception_publication_state WHERE id = 1").first<State>())
    ?? { source_revision: 0, published_build_id: null };
}

function progress(build: PublishedReceptionBuild, publishedId: number | null,
  status: ReceptionPublicationProgress["status"], restarted: boolean,
  inspected = 0, evaluated = 0, reused = 0): ReceptionPublicationProgress {
  return { status, buildId: build.id, publishedBuildId: publishedId, evaluatedAt: build.evaluated_at,
    cursorAppid: build.cursor_appid, maxAppid: build.max_appid, inspected, evaluated, reused, restarted };
}

const sourceBearing = `(EXISTS (SELECT 1 FROM player_score_history h WHERE h.appid = a.appid)
  OR EXISTS (SELECT 1 FROM review_buckets h WHERE h.appid = a.appid)
  OR EXISTS (SELECT 1 FROM review_summary_snapshots h WHERE h.appid = a.appid))`;

function guard(build: PublishedReceptionBuild): string {
  return `EXISTS (SELECT 1 FROM reception_publication_state s
    JOIN reception_publication_builds b ON b.id = ${build.id}
    WHERE s.id = 1 AND s.source_revision = ${build.source_revision}
      AND b.status = 'building' AND b.cursor_appid = ${build.cursor_appid})`;
}

function evaluationWrites(db: AppDatabase, build: PublishedReceptionBuild, candidate: Candidate,
  evaluation: ReceptionProjectionEvaluation, historyKey: string, writeHistory: boolean): AppPreparedStatement[] {
  const statements: AppPreparedStatement[] = [];
  const game = evaluation.current;
  for (const [type, metric, scoreId] of [
    ["top_rated_now", game.now, game.nowScoreHistoryId],
    ["top_rated_all_time", game.allTime, null],
  ] as const) {
    statements.push(db.prepare(`INSERT INTO reception_publication_current
      (build_id, appid, type, input_revision, history_key, metric_value, qualifying_reviews,
       score_history_id, metric_json, population_json, source_timestamp, next_evaluation_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard(build)}`)
      .bind(build.id, game.appid, type, candidate.revision, historyKey, metric.metric?.value ?? null,
        metric.qualifyingReviews, scoreId, metric.metric ? JSON.stringify(metric.metric) : null,
        metric.populationRef ? JSON.stringify(metric.populationRef) : null, metric.sourceTimestamp, game.nextEvaluationAt));
  }
  if (writeHistory) for (const month of evaluation.months) {
    statements.push(db.prepare(`INSERT INTO reception_publication_months
      (history_key, appid, type, cutoff, metric_kind, value, lifetime_approval, lifetime_reviews,
       observed_at, source_observed_at, formula_version, recalculation_json, score_window_end, provenance, score_history_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard(build)}`)
      .bind(historyKey, month.appid, month.type, month.cutoff, month.metric_kind, month.value,
        month.lifetime_approval ?? null, month.lifetime_reviews ?? null, month.observed_at,
        month.source_observed_at ?? null, month.formula_version ?? null,
        month.recalculation ? JSON.stringify(month.recalculation) : null,
        month.score_window_end ?? null, month.provenance, month.score_history_id));
  }
  return statements;
}

async function batch(db: AppDatabase, options: ReceptionPublicationOptions): Promise<ReceptionPublicationProgress> {
  const { at, size } = settings(options);
  await db.prepare("INSERT OR IGNORE INTO reception_publication_state (id, source_revision) VALUES (1, 0)").run();
  const watermark = await state(db);
  const published = await getPublishedReceptionBuild(db);
  let build = await db.prepare("SELECT * FROM reception_publication_builds WHERE status = 'building' ORDER BY id DESC LIMIT 1")
    .first<PublishedReceptionBuild>();
  let restarted = false;
  // A resumed build keeps its original evidence clock, even if the caller's clock advanced.
  if (build && (build.source_revision !== watermark.source_revision || build.projection_version !== RECEPTION_PROJECTION_VERSION
    || build.history_key !== identity(build.evaluated_at))) {
    await db.prepare("UPDATE reception_publication_builds SET status = 'superseded' WHERE id = ? AND status = 'building'").bind(build.id).run();
    build = null;
    restarted = true;
  }
  if (!build) {
    const due = published ? await db.prepare(`SELECT 1 FROM reception_publication_current
      WHERE build_id = ? AND next_evaluation_at <= ? LIMIT 1`).bind(published.id, at).first() : null;
    const visibleInputsChanged = published && published.evaluated_at < at
      ? await db.prepare(`SELECT 1 WHERE
        EXISTS (SELECT 1 FROM player_score_history WHERE observed_at > ? AND observed_at <= ?)
        OR EXISTS (SELECT 1 FROM review_summary_snapshots WHERE observed_at > ? AND observed_at <= ?)
        OR EXISTS (SELECT 1 FROM review_buckets WHERE
          (observed_at > ? AND observed_at <= ?) OR (period_end > ? AND period_end <= ?))
        OR EXISTS (SELECT 1 FROM steam_events WHERE start_at IS NOT NULL AND observed_at > ? AND observed_at <= ?)`)
        .bind(published.evaluated_at, at, published.evaluated_at, at,
          published.evaluated_at, at, published.evaluated_at, at, published.evaluated_at, at).first() : null;
    if (published && published.source_revision === watermark.source_revision && published.history_key === identity(at)
      && published.projection_version === RECEPTION_PROJECTION_VERSION && published.evaluated_at <= at && !due && !visibleInputsChanged) {
      return progress(published, published.id, "unchanged", restarted);
    }
    await db.prepare(`INSERT INTO reception_publication_builds
      (projection_version, history_key, evaluated_at, source_revision, max_appid)
      SELECT ?, ?, ?, source_revision, COALESCE((SELECT MAX(a.appid) FROM apps a WHERE ${sourceBearing}), 0)
      FROM reception_publication_state WHERE id = 1`)
      .bind(RECEPTION_PROJECTION_VERSION, identity(at), at).run();
    build = (await db.prepare("SELECT * FROM reception_publication_builds WHERE status = 'building' ORDER BY id DESC LIMIT 1")
      .first<PublishedReceptionBuild>())!;
  }
  const candidates = (await db.prepare(`SELECT a.appid, COALESCE(r.revision, 0) AS revision
    FROM apps a LEFT JOIN reception_publication_revisions r ON r.appid = a.appid
    WHERE a.appid > ? AND a.appid <= ? AND ${sourceBearing} ORDER BY a.appid LIMIT ?`)
    .bind(build.cursor_appid, build.max_appid, size).all<Candidate>()).results;
  let evaluated = 0;
  let reused = 0;
  const statements: AppPreparedStatement[] = [];
  const pending: { candidate: Candidate; historyKey: string; includeHistory: boolean }[] = [];
  // Cache reads are compact and bounded to this keyset batch. Each history key is immutable.
  for (const candidate of candidates) {
    const cached = published && published.projection_version === RECEPTION_PROJECTION_VERSION
      && published.history_key === build.history_key && published.evaluated_at <= build.evaluated_at
      ? await db.prepare(`SELECT appid, input_revision, history_key, next_evaluation_at
          FROM reception_publication_current WHERE build_id = ? AND appid = ? AND type = 'top_rated_now'`)
        .bind(published.id, candidate.appid).first<Cached>() : null;
    // Future-observed evidence, including reconstruction anchors, may become visible without a revision change.
    const newlyVisible = cached ? await db.prepare(`SELECT 1 WHERE
      EXISTS (SELECT 1 FROM player_score_history WHERE appid = ? AND observed_at > ? AND observed_at <= ?)
      OR EXISTS (SELECT 1 FROM review_summary_snapshots WHERE appid = ? AND observed_at > ? AND observed_at <= ?)
      OR EXISTS (SELECT 1 FROM review_buckets WHERE appid = ? AND
        ((observed_at > ? AND observed_at <= ?) OR (period_end > ? AND period_end <= ?)))
      OR EXISTS (SELECT 1 FROM steam_events WHERE appid = ? AND start_at IS NOT NULL AND observed_at > ? AND observed_at <= ?)`)
      .bind(candidate.appid, published!.evaluated_at, build.evaluated_at,
        candidate.appid, published!.evaluated_at, build.evaluated_at,
        candidate.appid, published!.evaluated_at, build.evaluated_at, published!.evaluated_at, build.evaluated_at,
        candidate.appid, published!.evaluated_at, build.evaluated_at).first() : null;
    const reuseHistory = cached && cached.input_revision === candidate.revision && !newlyVisible;
    if (reuseHistory && (!cached.next_evaluation_at || cached.next_evaluation_at > build.evaluated_at)) {
      statements.push(db.prepare(`INSERT INTO reception_publication_current
        SELECT ?, appid, type, input_revision, history_key, metric_value, qualifying_reviews, score_history_id,
          metric_json, population_json, source_timestamp, next_evaluation_at
        FROM reception_publication_current WHERE build_id = ? AND appid = ? AND ${guard(build)}`)
        .bind(build.id, published!.id, candidate.appid));
      reused++;
    } else {
      pending.push({ candidate,
        historyKey: reuseHistory ? cached.history_key : `${build.history_key}|${candidate.appid}|${candidate.revision}|${build.id}`,
        includeHistory: !reuseHistory });
    }
  }
  for (const includeHistory of [true, false]) {
    const group = pending.filter((item) => item.includeHistory === includeHistory);
    if (group.length === 0) continue;
    const evaluations = await evaluateReceptionProjectionBatch(db, group.map((item) => item.candidate.appid),
      build.evaluated_at, { includeHistory });
    const byApp = new Map(group.map((item) => [item.candidate.appid, item]));
    for (const evaluation of evaluations) {
      const item = byApp.get(evaluation.current.appid)!;
      statements.push(...evaluationWrites(db, build, item.candidate, evaluation, item.historyKey, includeHistory));
    }
    evaluated += group.length;
  }
  const cursor = candidates.length < size ? build.max_appid : candidates[candidates.length - 1]!.appid;
  statements.push(db.prepare(`UPDATE reception_publication_builds SET cursor_appid = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND ${guard(build)}`).bind(cursor, build.id));
  // Current rows, their month values and keyset advancement commit together.
  await db.batch(statements);
  const after = await state(db);
  if (after.source_revision !== build.source_revision) {
    await db.prepare("UPDATE reception_publication_builds SET status = 'superseded' WHERE id = ? AND status = 'building'").bind(build.id).run();
    return progress(build, after.published_build_id, "building", true, candidates.length, evaluated, reused);
  }
  build.cursor_appid = cursor;
  if (cursor < build.max_appid) return progress(build, after.published_build_id, "building", restarted, candidates.length, evaluated, reused);
  // Revision check, status change and pointer swap share a single SQLite transaction.
  await db.batch([
    db.prepare(`UPDATE reception_publication_builds SET status = 'published', completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'building' AND cursor_appid = max_appid
      AND source_revision = (SELECT source_revision FROM reception_publication_state WHERE id = 1)`).bind(build.id),
    db.prepare(`UPDATE reception_publication_state SET published_build_id = ? WHERE id = 1
      AND source_revision = ? AND EXISTS (SELECT 1 FROM reception_publication_builds WHERE id = ? AND status = 'published')`)
      .bind(build.id, build.source_revision, build.id),
    db.prepare(`UPDATE reception_publication_builds SET status = 'superseded'
      WHERE status = 'published' AND id != (SELECT published_build_id FROM reception_publication_state WHERE id = 1)`),
    db.prepare("DELETE FROM reception_publication_builds WHERE status = 'superseded'"),
    db.prepare(`DELETE FROM reception_publication_months AS m WHERE NOT EXISTS
      (SELECT 1 FROM reception_publication_current c WHERE c.history_key = m.history_key AND c.appid = m.appid AND c.type = m.type)`),
  ]);
  const final = await state(db);
  return progress(build, final.published_build_id, final.published_build_id === build.id ? "published" : "building",
    restarted || final.source_revision !== build.source_revision, candidates.length, evaluated, reused);
}

/** Advances at most one bounded keyset chunk. Interrupted unchanged-input builds resume. */
export function runReceptionPublicationBatch(db: AppDatabase, options: ReceptionPublicationOptions = {}): Promise<ReceptionPublicationProgress> {
  return exclusive(db, () => batch(db, options));
}

/** Ingestion/startup driver; yields to the event loop between durable chunks. */
export async function publishReceptionProjection(db: AppDatabase, options: ReceptionPublicationOptions = {}): Promise<ReceptionPublicationProgress> {
  let inspected = 0;
  let evaluated = 0;
  let reused = 0;
  let restarted = false;
  for (;;) {
    const result = await runReceptionPublicationBatch(db, options);
    inspected += result.inspected;
    evaluated += result.evaluated;
    reused += result.reused;
    restarted ||= result.restarted;
    if (result.status !== "building") {
      // SQLite bounds this analysis and decides when statistics need refreshing.
      // Include unchanged startup: newly installed indices may have no statistics yet.
      await exclusive(db, () => db.exec("PRAGMA optimize"));
      return { ...result, inspected, evaluated, reused, restarted };
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  }
}

/** Source-only initial readiness. HTTP readers must never call this function. */
export async function ensureReceptionPublicationReady(db: AppDatabase, options: ReceptionPublicationOptions = {}): Promise<ReceptionPublicationProgress> {
  const { at } = settings(options);
  const first = await publishReceptionProjection(db, { ...options, evaluatedAt: at });
  // Resuming a long-interrupted staging generation must not activate an expired clock.
  if (first.evaluatedAt >= at) return first;
  const refreshed = await publishReceptionProjection(db, { ...options, evaluatedAt: at });
  return { ...refreshed, inspected: first.inspected + refreshed.inspected,
    evaluated: first.evaluated + refreshed.evaluated, reused: first.reused + refreshed.reused,
    restarted: first.restarted || refreshed.restarted };
}
