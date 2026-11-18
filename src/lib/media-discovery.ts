import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { AppDatabase } from "./db";
import { writeTransaction } from "./db-transaction";
import { mainReleasedDate, type MainReleasedFields } from "./lifecycle-history";
import { finishOutletAttempt, reserveOutletAttempt } from "./media-outlet-access";
import { parsePreciseReleaseDate } from "./releases";
import { ELIGIBLE_MEDIA_ENTITY_SQL } from "./media-similarity";

const MEDIA_GAME_METADATA = [
  { choice: "cyberpunk-2077", appid: 1091500, name: "Cyberpunk 2077", aliases: ["cyberpunk 2077"] },
  { choice: "baldurs-gate-3", appid: 1086940, name: "Baldur's Gate 3", aliases: ["baldur's gate 3", "baldurs gate 3"] },
  { choice: "hades-ii", appid: 1145350, name: "Hades II", aliases: ["hades ii", "hades 2"] },
] as const;

export type MediaGameChoice = (typeof MEDIA_GAME_METADATA)[number]["choice"];

export const MEDIA_GAME_CHOICES = Object.fromEntries(
  MEDIA_GAME_METADATA.map(({ choice, appid }) => [choice, appid]),
) as Record<MediaGameChoice, number>;

export const MEDIA_OUTLETS = [
  { name: "IGN", domain: "ign.com" },
  { name: "Eurogamer", domain: "eurogamer.net" },
  { name: "GameSpot", domain: "gamespot.com" },
  { name: "PC Gamer", domain: "pcgamer.com" },
  { name: "Kotaku", domain: "kotaku.com" },
  { name: "GamesRadar+", domain: "gamesradar.com" },
] as const;

export type MediaOutlet = (typeof MEDIA_OUTLETS)[number]["name"];
export type MediaPass = "initial" | "later";
export type MediaArticleType = "review" | "preview";

export interface MediaOutletShortfall {
  required: number;
  actual: number;
  missing: MediaOutlet[];
}

export interface MediaSource {
  appid: number;
  originalUrl: string;
  discoveryUrl: string | null;
  title: string;
  outlet: MediaOutlet;
  author: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  retrievedAt: string;
  type: MediaArticleType;
  handsOn: boolean | null;
  affiliation: string | null;
  platform: string | null;
  buildContext: string | null;
}

export interface MediaRunAuthorization {
  authorized: true;
  runId: number;
  pass: MediaPass;
  games: number[];
  identity: string;
  resumed: boolean;
}

export interface MediaRunSummary {
  runId: number;
  pass: MediaPass;
  status: "completed" | "stopped" | "failed";
  games: number[];
  resumed: boolean;
  newIdentity: boolean;
  /** Queries searched so far in the pass, across every run. */
  queries: number;
  /** Outlet attempts recorded so far in the pass, across every run and stage. */
  attempts: number;
  /** Articles accepted so far in the pass, across every run. */
  articles: number;
  /** What this call itself did: searches issued, outlet attempts reserved and articles accepted. */
  issued: { searches: number; attempts: number; articles: number };
  stopReasons: string[];
  summary: {
    runId: number;
    status: "completed" | "stopped" | "failed";
    discovered: number;
    accepted: number;
    skipped: number;
    sourceFailures: number;
    outletShortfall: MediaOutletShortfall | null;
    stopReason?: string | null;
    error?: string;
    counts?: { discovered: number; accepted: number; skipped: number; sourceFailures: number; queries: number; attempts: number; articles: number };
  };
  usage: { remainingCredits: number | null; plan: "free" | "rejected" | "unknown"; planUsageAtStart: number | null; planUsage: number | null; planLimit: number | null; paygoUsage: number | null; paygoLimit: number | null; searchCreditsConsumed: number };
}

type MediaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type MediaClock = () => Date;

export interface MediaDiscoveryOptions {
  runId?: number;
  pass?: MediaPass;
  games?: readonly number[];
  tavilyApiKey?: string;
  fetch?: MediaFetch;
  now?: Date | (() => Date);
}

/** The ceiling of accepted articles per exact entity, shared by the initial and later passes. */
export const MAX_MEDIA_ARTICLES_PER_GAME = 15;
const MAX_REDIRECTS = 5;

type RunRow = {
  id: number;
  pass: MediaPass;
  identity_key: string;
  selected_games: string;
  status: string;
  resumed: number;
  query_count: number;
  article_count: number;
  attempt_count: number;
  provider_request_ids: string;
  usage: string;
  stop_reason: string | null;
  summary: string;
  origin: string;
  started_at: string | null;
};

type ProgressRow = {
  id: number;
  run_id: number;
  appid: number;
  pass: MediaPass;
  outlet: MediaOutlet;
  status: string;
  query_attempted_at: string | null;
  candidate_urls: string;
  candidate_index: number;
  stop_reason: string | null;
  stopped_at: string | null;
  completed_at: string | null;
};

const RUN_COLUMNS = "id, pass, identity_key, selected_games, status, resumed, query_count, article_count, attempt_count, provider_request_ids, usage, stop_reason, summary, origin, started_at";
const PROGRESS_COLUMNS = "id, run_id, appid, pass, outlet, status, query_attempted_at, candidate_urls, candidate_index, stop_reason, stopped_at, completed_at";

type TavilyResult = { url?: unknown; published_date?: unknown };

type Candidate = { url: string; publishedDate: string | null };
type MediaTarget = {
  appid: number;
  name: string;
  parentAppid: number | null;
  aliases: readonly string[];
};

type MediaTargetRow = {
  appid: number;
  name: string;
  parent_appid: number | null;
};

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}
function hasEntityAlias(text: string, alias: string): boolean {
  for (let offset = 0; offset <= text.length - alias.length;) {
    const index = text.indexOf(alias, offset);
    if (index < 0) return false;
    const before = text[index - 1];
    const after = text[index + alias.length];
    if ((!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z0-9]/.test(after))) return true;
    offset = index + alias.length;
  }
  return false;
}

function rootAppid(target: MediaTarget): number {
  return target.parentAppid ?? target.appid;
}



async function loadMediaTargets(db: AppDatabase, roots: readonly number[]): Promise<MediaTarget[]> {
  const rootsJson = JSON.stringify(roots);
  const targetRows = await rows<MediaTargetRow>(
    db,
    `SELECT app.appid, app.name, app.parent_appid
     FROM apps AS app
     WHERE app.appid IN (SELECT value FROM json_each(?))
       AND app.type = 'game'
       AND app.is_playable = 1
       AND app.is_eligible = 1
       AND app.parent_appid IS NULL
     UNION ALL
     SELECT child.appid, child.name, child.parent_appid
     FROM apps AS child
     JOIN apps AS parent ON parent.appid = child.parent_appid
     WHERE child.parent_appid IN (SELECT value FROM json_each(?))
       AND child.type IN ('dlc', 'expansion')
       AND child.is_eligible = 1
       AND parent.type = 'game'
       AND parent.is_playable = 1
       AND parent.is_eligible = 1
       AND parent.parent_appid IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM app_relationships AS relationship
         WHERE relationship.child_appid = child.appid
           AND relationship.relationship_type IN ('server', 'tool', 'demo', 'test', 'soundtrack')
       )
     ORDER BY appid`,
    rootsJson,
    rootsJson,
  );
  return targetRows.map((row) => {
    const metadata = row.parent_appid === null
      ? MEDIA_GAME_METADATA.find((game) => game.appid === row.appid)
      : undefined;
    const normalizedName = normalizeTitle(row.name);
    const parentName = row.parent_appid === null
      ? ""
      : normalizeTitle(targetRows.find((candidate) => candidate.appid === row.parent_appid)?.name ?? "");
    const suffix = parentName ? normalizedName.slice(parentName.length) : "";
    const childName = parentName && normalizedName.startsWith(parentName) && /^[\s:–—-]+/.test(suffix)
      ? suffix.replace(/^[\s:–—-]+/, "").trim()
      : "";
    const aliases = [...new Set([normalizedName, childName, ...(metadata?.aliases ?? []).map(normalizeTitle)].filter(Boolean))];
    return { appid: row.appid, name: row.name, parentAppid: row.parent_appid, aliases };
  });
}


function validGameIds(games: readonly number[]): number[] {
  const valid = new Set(MEDIA_GAME_METADATA.map((game) => game.appid));
  if (!Array.isArray(games) || games.length === 0) throw new Error("games must be a non-empty array");
  const result = [...new Set(games)];
  if (result.length !== games.length || result.some((id) => !Number.isInteger(id) || !valid.has(id))) {
    throw new Error("games must contain only the supported game appids");
  }
  return result.sort((a, b) => a - b);
}


function parsePass(pass: unknown): asserts pass is MediaPass {
  if (pass !== "initial" && pass !== "later") throw new Error("Unknown media discovery pass");
}

/** Only the initial pass can be authorized; the later pass is recorded but not yet triggerable. */
function parseAuthorizablePass(pass: unknown): asserts pass is "initial" {
  if (pass !== "initial") throw new Error("Only the initial media discovery pass can be authorized");
}

function identityFor(pass: MediaPass, games: readonly number[]): string {
  return `${pass}:${[...games].sort((a, b) => a - b).join(",")}`;
}

function isoNow(value: Date | (() => Date) | undefined): Date {
  const result = typeof value === "function" ? value() : value;
  const date = result ?? new Date();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Invalid media discovery clock");
  return new Date(date.getTime());
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function boundedError(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.split(secret).join("[redacted]");
  return message
    .replace(/[\r\n]+/g, " ")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, 256);
}

function json<T>(value: string | null | undefined, fallback: T): T {
  try {
    return JSON.parse(value ?? "") as T;
  } catch {
    return fallback;
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function first<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

async function rows<T>(db: AppDatabase, query: string, ...values: unknown[]): Promise<T[]> {
  const result = await db.prepare(query).bind(...values).all<T>();
  return result.results ?? [];
}

function transaction(db: AppDatabase, work: () => Promise<void>): Promise<void> {
  return writeTransaction(db, work);
}

async function prepareProgressForAuthorization(
  db: AppDatabase,
  runId: number,
  pass: MediaPass,
  games: readonly number[],
  includeCompleted: boolean,
): Promise<void> {
  const statusFilter = includeCompleted ? "" : " AND status <> 'completed'";
  const gamesJson = JSON.stringify(games);
  await db.prepare(
    `UPDATE media_discovery_progress
     SET run_id = ?,
         status = CASE
           WHEN status IN ('queued', 'searching', 'fetching')
             THEN CASE WHEN query_attempted_at IS NULL THEN 'queued' ELSE 'fetching' END
           ELSE status
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE pass = ?
       AND appid IN (SELECT value FROM json_each(?))
       ${statusFilter}`,
  ).bind(runId, pass, gamesJson).run();
}

/**
 * Stops that hold a query only for the rest of their UTC day: an Outlet day
 * stop (the daily attempt cap or an outlet rate limit) or the search
 * provider's rate limit. Any other stop, an Outlet denial, never reopens.
 */
const DAY_SCOPED_STOPS = ["daily_attempt_cap", "search_http_429", "fetch_http_429", "tavily_search_http_429"] as const;
const DAY_SCOPED_STOPS_SQL = DAY_SCOPED_STOPS.map((reason) => `'${reason}'`).join(", ");

/**
 * Reopens the queries of `passes` for `games` that a day-scoped stop held on
 * an earlier UTC day than `day`. Reopening depends only on the day of the
 * stop; whether a search or fetch is then admitted is decided by the
 * outlet's rules for `day`. An Outlet denial never reopens.
 */
async function reopenDayScopedProgress(
  db: AppDatabase,
  runId: number,
  passes: readonly MediaPass[],
  games: readonly number[],
  day: string,
): Promise<void> {
  await db.prepare(
    `UPDATE media_discovery_progress
     SET run_id = ?,
         status = CASE WHEN query_attempted_at IS NULL THEN 'queued' ELSE 'fetching' END,
         stop_reason = NULL,
         stopped_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE pass IN (SELECT value FROM json_each(?))
       AND appid IN (SELECT value FROM json_each(?))
       AND status = 'stopped'
       AND stop_reason IN (${DAY_SCOPED_STOPS_SQL})
       AND (stopped_at IS NULL OR substr(stopped_at, 1, 10) < ?)`,
  ).bind(runId, JSON.stringify(passes), JSON.stringify(games), day).run();
}

/** A pass of one entity that a discovery run serves, and since when it has been due. */
type DuePass = { target: MediaTarget; pass: MediaPass; dueAt: string };

/** A recorded time as an ISO timestamp; SQLite's `CURRENT_TIMESTAMP` form is UTC. */
function isoTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}.000Z` : new Date(Date.parse(value)).toISOString();
}

/**
 * When `outlets`' queries of one entity's pass have all finished, or null
 * while any of them has not: a query finishes when it completes or meets a
 * stop that never reopens, an Outlet denial. A query held by a day-scoped
 * stop, kept by a Provider stop, or never created is unfinished.
 */
function passFinishedAt(progress: readonly ProgressRow[], outlets: readonly MediaOutlet[]): string | null {
  let finishedAt: string | null = null;
  for (const outlet of outlets) {
    const row = progress.find((item) => item.outlet === outlet);
    if (!row) return null;
    const lastingStop = row.status === "stopped" && !(DAY_SCOPED_STOPS as readonly string[]).includes(row.stop_reason ?? "");
    if (row.status !== "completed" && !lastingStop) return null;
    const at = row.status === "completed" ? row.completed_at ?? row.query_attempted_at : row.stopped_at ?? row.query_attempted_at;
    if (at && (finishedAt === null || isoTimestamp(at) > finishedAt)) finishedAt = isoTimestamp(at);
  }
  return finishedAt;
}

const LATER_PASS_RELEASE_AGE_DAYS = 90;

/**
 * The passes of `targets` that a scheduled discovery run started at `asOf`
 * serves, oldest due time first, then by entity. An entity's initial pass is
 * due from its root's enrollment until every outlet's initial query has
 * finished. Its one later pass is then due over the outlets with an accepted
 * initial article for it: for an experiment game as soon as its initial
 * discovery finished, otherwise once its Main Released date is also at least
 * 90 days old. A pass that becomes due after `asOf` waits for the next run.
 */
async function duePasses(db: AppDatabase, targets: readonly MediaTarget[], asOf: string): Promise<DuePass[]> {
  const appids = JSON.stringify(targets.map(({ appid }) => appid));
  const roots = JSON.stringify([...new Set(targets.map(rootAppid))]);
  const enrollments = new Map((await rows<{ appid: number; reason: string; enrolled_at: string }>(
    db,
    "SELECT appid, reason, enrolled_at FROM media_enrollments WHERE appid IN (SELECT value FROM json_each(?))",
    roots,
  )).map((row) => [row.appid, row]));
  const progress = await rows<ProgressRow>(db, `SELECT ${PROGRESS_COLUMNS} FROM media_discovery_progress WHERE appid IN (SELECT value FROM json_each(?))`, appids);
  const represented = await rows<{ appid: number; outlet: MediaOutlet }>(
    db,
    "SELECT DISTINCT appid, outlet FROM media_sources WHERE pass = 'initial' AND appid IN (SELECT value FROM json_each(?))",
    appids,
  );
  const releases = new Map((await rows<MainReleasedFields & { appid: number }>(
    db,
    "SELECT appid, release_status, release_date, release_date_source, steam_release_date, original_release_date FROM apps WHERE appid IN (SELECT value FROM json_each(?))",
    appids,
  )).map((row) => [row.appid, row]));
  const due: DuePass[] = [];
  for (const target of targets) {
    const enrollment = enrollments.get(rootAppid(target));
    if (!enrollment) continue;
    const ownProgress = (pass: MediaPass) => progress.filter((row) => row.appid === target.appid && row.pass === pass);
    const initialFinishedAt = passFinishedAt(ownProgress("initial"), MEDIA_OUTLETS.map(({ name }) => name));
    if (initialFinishedAt === null) {
      due.push({ target, pass: "initial", dueAt: isoTimestamp(enrollment.enrolled_at) });
      continue;
    }
    const laterOutlets = MEDIA_OUTLETS.map(({ name }) => name).filter((outlet) => represented.some((row) => row.appid === target.appid && row.outlet === outlet));
    if (laterOutlets.length === 0 || passFinishedAt(ownProgress("later"), laterOutlets) !== null) continue;
    let dueAt = initialFinishedAt;
    if (enrollment.reason !== "experiment") {
      const released = mainReleasedDate(releases.get(target.appid) ?? { release_status: "", release_date: null, release_date_source: null, steam_release_date: null, original_release_date: null });
      const releasedOn = parsePreciseReleaseDate(released?.date);
      if (!releasedOn) continue;
      const releaseAgeDue = new Date(Date.parse(`${releasedOn}T00:00:00.000Z`) + LATER_PASS_RELEASE_AGE_DAYS * 86_400_000).toISOString();
      if (releaseAgeDue > dueAt) dueAt = releaseAgeDue;
    }
    if (dueAt > asOf) continue;
    due.push({ target, pass: "later", dueAt });
  }
  return due.sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.target.appid - right.target.appid || left.pass.localeCompare(right.pass));
}

/**
 * Whether a later-pass article qualifies for its entity: the entity has an
 * accepted initial article from the same outlet, the article's URL is not
 * already one of the entity's sources, and a dated article was published
 * after each of that outlet's initial articles for the entity. An undated
 * article qualifies otherwise and keeps its unknown date; an undated initial
 * article gives a dated one no known date to follow.
 */
async function qualifiesForLaterPass(db: AppDatabase, source: MediaSource): Promise<boolean> {
  const existing = await rows<{ pass: MediaPass; outlet: MediaOutlet; original_url: string; discovery_url: string | null; published_at: string | null }>(
    db,
    "SELECT pass, outlet, original_url, discovery_url, published_at FROM media_sources WHERE appid = ?",
    source.appid,
  );
  const urls = new Set(existing.flatMap((row) => [row.original_url, row.discovery_url ?? row.original_url]));
  if (urls.has(source.originalUrl) || (source.discoveryUrl !== null && urls.has(source.discoveryUrl))) return false;
  const initial = existing.filter((row) => row.pass === "initial" && row.outlet === source.outlet);
  if (initial.length === 0) return false;
  if (source.publishedAt === null) return true;
  const publishedAt = source.publishedAt;
  return initial.every((row) => row.published_at !== null && Date.parse(row.published_at) < Date.parse(publishedAt));
}

/** The one query an entity's pass sends to each outlet's domain. */
function passQuery(target: MediaTarget, pass: MediaPass): string {
  return pass === "initial" ? `${target.name} review preview` : `${target.name} review revisited`;
}

async function authorizeMediaRunNow(
  db: AppDatabase,
  input: { pass: MediaPass; games: readonly number[] },
): Promise<MediaRunAuthorization> {
  parseAuthorizablePass(input?.pass);
  const pass = input.pass;
  const games = validGameIds(input.games);
  const identity = identityFor(pass, games);
  let result!: MediaRunAuthorization;
  await transaction(db, async () => {
    const existing = await first<RunRow>(
      db,
      `SELECT ${RUN_COLUMNS} FROM media_discovery_runs WHERE identity_key LIKE ? ORDER BY id DESC LIMIT 1`,
      `${identity}:%`,
    );
    if (existing && (existing.status === "queued" || existing.status === "running")) {
      await db.prepare(
        "UPDATE media_discovery_runs SET status = 'running', resumed = 1, started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?",
      ).bind(existing.id).run();
      await prepareProgressForAuthorization(db, existing.id, pass, games, true);
      result = { authorized: true, runId: existing.id, pass, games, identity: existing.identity_key, resumed: true };
      return;
    }
    const reusableProgress = Number((await first<{ count: number }>(
      db,
      "SELECT COUNT(*) AS count FROM media_discovery_progress WHERE pass = ? AND appid IN (SELECT value FROM json_each(?))",
      pass,
      JSON.stringify(games),
    ))?.count ?? 0);
    const identityWithNonce = `${identity}:${crypto.randomUUID()}`;
    const inserted = await db.prepare(
      "INSERT INTO media_discovery_runs (pass, identity_key, selected_games, status, resumed, started_at) VALUES (?, ?, ?, 'running', ?, CURRENT_TIMESTAMP)",
    ).bind(pass, identityWithNonce, JSON.stringify(games), reusableProgress > 0 ? 1 : 0).run();
    if (!inserted.success) throw new Error("Unable to create media discovery run");
    const id = Number((await first<{ id: number }>(db, "SELECT id FROM media_discovery_runs WHERE identity_key = ?", identityWithNonce))?.id ?? 0);
    if (!id) throw new Error("Unable to create media discovery run");
    await prepareProgressForAuthorization(db, id, pass, games, false);
    result = { authorized: true, runId: id, pass, games, identity: identityWithNonce, resumed: reusableProgress > 0 };
  });
  return result;
}


let mediaAuthorizationQueue: Promise<unknown> = Promise.resolve();

export function authorizeMediaRun(
  db: AppDatabase,
  input: { pass: MediaPass; games: readonly number[] },
): Promise<MediaRunAuthorization> {
  const next = mediaAuthorizationQueue
    .catch(() => undefined)
    .then(() => authorizeMediaRunNow(db, input));
  mediaAuthorizationQueue = next;
  return next;
}


function hostInOutlet(url: string, outlet: (typeof MEDIA_OUTLETS)[number]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const domain = outlet.domain.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function cleanText(value: unknown): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, 500) : null;
}

function dateValue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function meta(document: Document, ...names: string[]): string | null {
  for (const name of names) {
    const selector = `meta[property="${name}"],meta[name="${name}"]`;
    const content = document.querySelector(selector)?.getAttribute("content");
    if (content?.trim()) return content.trim();
  }
  return null;
}

function parseSource(html: string, finalUrl: string, target: MediaTarget, targets: readonly MediaTarget[], outlet: MediaOutlet, retrievedAt: string): MediaSource | null {
  let document: Document;
  try {
    document = parseHTML(html).document as unknown as Document;
  } catch {
    return null;
  }
  for (const element of Array.from(document.querySelectorAll("script,style,noscript,template"))) element.remove();
  const titleMeta = meta(document, "og:title", "twitter:title");
  const authorMeta = meta(document, "author", "article:author");
  const canonicalMeta = meta(document, "og:url") ?? document.querySelector("link[rel='canonical']")?.getAttribute("href") ?? null;
  const publishedMeta = meta(document, "article:published_time", "datePublished");
  const updatedMeta = meta(document, "article:modified_time", "dateModified");
  const publishedTime = document.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
  const platformMeta = meta(document, "game:platform", "article:platform");
  const buildMeta = meta(document, "game:build", "article:build");
  const affiliationMeta = meta(document, "author_affiliation", "article:author_affiliation");
  type ReadableResult = { title?: string; byline?: string; textContent?: string };
  let readable: ReadableResult | null = null;
  try {
    readable = new Readability(document).parse() as ReadableResult | null;
  } catch {
    readable = null;
  }
  const title = cleanText(titleMeta ?? readable?.title ?? document.querySelector("h1")?.textContent ?? document.title);
  const readableArticleText = readable?.textContent ?? document.querySelector("article")?.textContent ?? document.body?.textContent;
  const fullArticleText = typeof readableArticleText === "string" ? readableArticleText.replace(/\s+/g, " ").trim() : "";
  if (!title || fullArticleText.length < 120) return null;
  const titleLower = normalizeTitle(title);
  const bodyLower = normalizeTitle(fullArticleText);
  const articleLeadLower = bodyLower.slice(0, 240);
  const titleMatches = targets.flatMap((candidate) =>
    candidate.aliases.filter((alias) => hasEntityAlias(titleLower, alias)).map((alias) => {
      const parent = candidate.parentAppid === null ? null : targets.find((item) => item.appid === candidate.parentAppid);
      const parentAlias = parent?.aliases.find((parentAlias) => hasEntityAlias(titleLower, parentAlias)) ?? null;
      return { target: candidate, alias, score: alias.length + (parentAlias?.length ?? 0) };
    }),
  ).sort((left, right) => right.score - left.score || right.alias.length - left.alias.length);
  const selected = titleMatches[0];
  if (!selected) return null;
  const titleTargets = [...new Map(titleMatches.map((match) => [match.target.appid, match.target])).values()];
  const selectedRootAppid = rootAppid(selected.target);
  if (titleTargets.some((candidate) => rootAppid(candidate) !== selectedRootAppid)) return null;
  const titleChildren = titleTargets.filter((candidate) => candidate.parentAppid !== null);
  if (titleChildren.length > 1) return null;
  const articleLeadTargets = targets.filter((candidate) => candidate.aliases.some((alias) => hasEntityAlias(articleLeadLower, alias)));
  const articleLeadFamilies = new Set(articleLeadTargets.map(rootAppid));
  if (articleLeadFamilies.size > 1 || [...articleLeadFamilies].some((appid) => appid !== selectedRootAppid)) return null;
  const childMentions = articleLeadTargets.filter((candidate) => candidate.parentAppid !== null);
  if (childMentions.length > 1) return null;
  const titleChild = titleChildren[0] ?? null;
  const leadChild = childMentions[0] ?? null;
  if (titleChild && leadChild && titleChild.appid !== leadChild.appid) return null;
  const attributedTarget = titleChild ?? leadChild ?? selected.target;
  const rootCanAttributeChild = target.parentAppid === null && attributedTarget.parentAppid === target.appid;
  if (attributedTarget.appid !== target.appid && !rootCanAttributeChild) return null;
  if (/\b(announcement|announces|revealed|reveal|trailer|launches|patch notes|update notes|roadmap)\b/.test(titleLower)) return null;
  const reviewScoreNews = /\b(?:review\s+scores?|(?:gets?|earns?|receives?|scores?|rated)\s+(?:a\s+)?\d+(?:\.\d+)?\s*(?:\/\s*\d+|out of \d+))\b/.test(titleLower);
  const coTitledReview = /\b(?:and|&)\s+.+?\s+reviews?\b/.test(titleLower);
  const reviewRelatedNews = /\breviews?\s*(?:[:\-–—]\s*|\s+)(?:embargo(?:es)?|details?|reactions?|coverage|codes?|copies|policies?|discourse)\b|\b(?:embargo(?:es)?|details?|reactions?|coverage|codes?|copies|policies?|discourse)\s*(?:[:\-–—]\s*|\s+)(?:about|around|for|on|of|to)?\s*reviews?\b/.test(titleLower);
  if (reviewScoreNews || coTitledReview || reviewRelatedNews || /\b(round[- ]?up|best games?|games like|versus|\bvs\.?\b|comparison|ranking|ranked|top\s+\d+|lists?(?:icle)?|highest|metacritic|surpasses?|outperforms?|outscores?|beats?|review\s+drama|drama)\b/.test(titleLower)) return null;
  const bodyList = /\b(round[- ]?up|games like|top\s+\d+|listicle|ranking|ranked among|(?:a|the)\s+list\s+of|multi[- ]game|multiple games?|several games?|lists?)\b/.test(bodyLower);
  const substantiveBodyComparison = /\b(side[- ]by[- ]side|head[- ]to[- ]head|direct comparison|comparison\s+(?:of|between)|versus|vs\.?)\b/.test(bodyLower);
  if (bodyList || substantiveBodyComparison) return null;
  const byline = cleanText(authorMeta ?? readable?.byline ?? document.querySelector("[rel='author'],.byline,[class*='author']")?.textContent);
  const affiliation = cleanText(affiliationMeta);
  const developerAuthorship = /developer|official|cd projekt|larian studios|supergiant|valve/i;
  if (developerAuthorship.test(byline ?? "") || developerAuthorship.test(affiliation ?? "")) return null;
  const isReview = /\breview\b/i.test(title) || /\bour review\b/i.test(fullArticleText.slice(0, 3_000));
  const explicitHandsOn = /\b(hands?[- ]on|we played|after playing|played for|impressions?)\b/i.test(`${title} ${fullArticleText.slice(0, 4_000)}`);
  const isPreview = /\b(preview|early access)\b/i.test(`${title} ${fullArticleText.slice(0, 4_000)}`);
  if (!isReview && !(isPreview && explicitHandsOn)) return null;
  const handsOn = explicitHandsOn ? true : null;
  const canonical = cleanText(canonicalMeta);
  let normalizedUrl: string;
  try {
    normalizedUrl = canonical ? new URL(canonical, finalUrl).toString() : finalUrl;
  } catch {
    return null;
  }
  const outletConfig = MEDIA_OUTLETS.find((item) => item.name === outlet);
  if (!outletConfig || !hostInOutlet(normalizedUrl, outletConfig)) return null;
  const articleType: MediaArticleType = isReview ? "review" : "preview";
  const platform = cleanText(platformMeta) ?? (/\b(pc|playstation|xbox|switch)\b/i.exec(fullArticleText.slice(0, 4_000))?.[1] ?? null);
  const buildContext = cleanText(buildMeta) ?? (/\bearly\s+access\b/i.test(`${title} ${fullArticleText}`) ? "Early Access" : null);
  return {
    appid: attributedTarget.appid,
    originalUrl: normalizedUrl,
    discoveryUrl: null,
    title,
    outlet,
    author: byline,
    publishedAt: dateValue(publishedMeta ?? publishedTime),
    updatedAt: dateValue(updatedMeta),
    retrievedAt,
    type: articleType,
    handsOn,
    affiliation,
    platform,
    buildContext,
  };
}

function candidateDate(candidate: MediaSource): number {
  return candidate.publishedAt ? Date.parse(candidate.publishedAt) : Number.MAX_SAFE_INTEGER;
}

function usageDetails(value: unknown): { plan: "free" | "rejected" | "unknown"; remainingCredits: number | null; planUsage: number | null; planLimit: number | null; paygoUsage: number | null; paygoLimit: number | null; valid: boolean } {
  const root = jsonObject(value);
  const account = jsonObject(root.account);
  const planValue = String(account.current_plan ?? root.current_plan ?? account.plan ?? root.plan ?? root.tier ?? "").toLowerCase();
  const plan: "free" | "rejected" | "unknown" = planValue === "free" || planValue === "researcher" ? "free" : planValue ? "rejected" : "unknown";
  const numberValue = (...values: unknown[]): number | null => {
    const value = values.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
    return typeof value === "number" ? value : null;
  };
  const planUsage = numberValue(account.plan_usage, root.plan_usage);
  const planLimit = numberValue(account.plan_limit, root.plan_limit);
  const paygoUsage = numberValue(account.paygo_usage, root.paygo_usage);
  const paygoLimit = numberValue(account.paygo_limit, root.paygo_limit);
  const fallbackRemaining = numberValue(root.remaining_credits, root.remainingCredits, account.remaining_credits, account.remainingCredits);
  const remaining = planLimit !== null && planUsage !== null ? planLimit - planUsage : fallbackRemaining;
  const valid = plan === "free" && remaining !== null && remaining > 0 && (paygoLimit === null || paygoLimit === 0) && paygoUsage === 0;
  return { plan, remainingCredits: remaining, planUsage, planLimit, paygoUsage, paygoLimit, valid };
}

/** Stops a query for `reason` at `at`, the run's clock, which decides when a day-scoped stop reopens. */
async function stopProgress(db: AppDatabase, progressId: number, reason: string, at: Date): Promise<void> {
  await db.prepare("UPDATE media_discovery_progress SET status = 'stopped', stop_reason = ?, stopped_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(reason.slice(0, 128), at.toISOString(), progressId).run();
}

/**
 * Returns a query the search provider refused, or could not serve, to the
 * row's unsearched state, keeping `reason` on the row until the query is
 * issued again. No search was served, so the entity, outlet and pass keep
 * their one query.
 */
async function releaseRefusedQuery(db: AppDatabase, progressId: number, status: "queued" | "stopped", reason: string, at: Date): Promise<void> {
  await db.prepare("UPDATE media_discovery_progress SET status = ?, stop_reason = ?, stopped_at = ?, query_attempted_at = NULL, candidate_urls = '[]', candidate_index = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, reason, status === "stopped" ? at.toISOString() : null, progressId).run();
}

/**
 * Fetches an outlet article without following redirects off the outlet, or
 * returns why the outlet must not be contacted again and whether this
 * candidate reached it. Every request reserves its attempt first; any other
 * failure skips only this candidate.
 */
async function fetchManual(fetchFn: MediaFetch, url: string, outlet: (typeof MEDIA_OUTLETS)[number], db: AppDatabase, runId: number, pass: MediaPass, appid: number, clock: MediaClock, issued: MediaRunSummary["issued"]): Promise<{ html: string; finalUrl: string } | { stop: string; contacted: boolean } | null> {
  let current = url;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (!hostInOutlet(current, outlet)) return null;
    const reservation = await reserveOutletAttempt(db, { runId, pass, appid, outlet: outlet.name, kind: "fetch", url: current, date: clock() });
    if ("stop" in reservation) return { stop: reservation.stop, contacted: redirect > 0 };
    issued.attempts += 1;
    let response: Response;
    try {
      response = await fetchFn(current, { redirect: "manual", headers: { Accept: "text/html,application/xhtml+xml" } });
    } catch (error) {
      await finishOutletAttempt(db, reservation.attemptId, { kind: "failure", statusCode: null, succeeded: false, error: boundedError(error) });
      return null;
    }
    const isRedirect = response.status >= 300 && response.status < 400;
    await finishOutletAttempt(db, reservation.attemptId, { kind: isRedirect ? "redirect" : "fetch", statusCode: response.status, succeeded: response.ok, error: response.ok ? null : `HTTP ${response.status}` });
    if (response.status === 401 || response.status === 403 || response.status === 429) return { stop: `fetch_http_${response.status}`, contacted: true };
    if (isRedirect) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) return null;
      const next = new URL(location, current).toString();
      if (!hostInOutlet(next, outlet)) return null;
      current = next;
      continue;
    }
    if (!response.ok) return null;
    return { html: await response.text(), finalUrl: current };
  }
  return null;
}

async function loadRun(db: AppDatabase, runId?: number): Promise<RunRow> {
  const run = runId
    ? await first<RunRow>(db, `SELECT ${RUN_COLUMNS} FROM media_discovery_runs WHERE id = ?`, runId)
    : await first<RunRow>(db, `SELECT ${RUN_COLUMNS} FROM media_discovery_runs WHERE pass = 'initial' AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`);
  if (!run) throw new Error("Media discovery run not found");
  parsePass(run.pass);
  return run;
}

/**
 * Why `appid` can admit no further article, if it cannot: it reached its own
 * 15-article ceiling, counting accepted articles from every pass. No total
 * across entities applies.
 */
async function articleCeiling(db: AppDatabase, appid: number): Promise<string | null> {
  const row = await first<{ count: number }>(db, "SELECT COUNT(*) AS count FROM media_sources WHERE appid = ?", appid);
  return Number(row?.count ?? 0) >= MAX_MEDIA_ARTICLES_PER_GAME ? `article_cap:${appid}` : null;
}

const EMPTY_USAGE_SUMMARY: MediaRunSummary["usage"] = {
  remainingCredits: null,
  plan: "unknown",
  planUsageAtStart: null,
  planUsage: null,
  planLimit: null,
  paygoUsage: null,
  paygoLimit: null,
  searchCreditsConsumed: 0,
};

type MediaRunCounts = {
  discovered: number;
  accepted: number;
  skipped: number;
  sourceFailures: number;
  queries: number;
  attempts: number;
  articles: number;
  outletShortfall: MediaOutletShortfall | null;
};

async function mediaRunCounts(db: AppDatabase, passes: readonly MediaPass[], targetAppids: readonly number[]): Promise<MediaRunCounts> {
  const targetAppidsJson = JSON.stringify(targetAppids);
  const pass = JSON.stringify(passes);
  const articleCount = Number((await first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM media_sources WHERE pass IN (SELECT value FROM json_each(?)) AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  ))?.count ?? 0);
  const queryCount = Number((await first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM media_discovery_progress WHERE query_attempted_at IS NOT NULL AND pass IN (SELECT value FROM json_each(?)) AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  ))?.count ?? 0);
  const progressCandidates = await rows<{ candidate_urls: string }>(
    db,
    "SELECT candidate_urls FROM media_discovery_progress WHERE query_attempted_at IS NOT NULL AND pass IN (SELECT value FROM json_each(?)) AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  );
  const discoveredCount = progressCandidates.reduce((total, row) => total + json<Candidate[]>(row.candidate_urls, []).length, 0);
  const attemptCount = Number((await first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE pass IN (SELECT value FROM json_each(?)) AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  ))?.count ?? 0);
  const sourceFailures = Number((await first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM media_discovery_attempts WHERE pass IN (SELECT value FROM json_each(?)) AND succeeded = 0 AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  ))?.count ?? 0);
  const acceptedOutlets = await rows<{ outlet: MediaOutlet }>(
    db,
    "SELECT DISTINCT outlet FROM media_sources WHERE pass IN (SELECT value FROM json_each(?)) AND appid IN (SELECT value FROM json_each(?))",
    pass,
    targetAppidsJson,
  );
  const acceptedOutletNames = new Set(acceptedOutlets.map((row) => row.outlet));
  const missingOutlets = MEDIA_OUTLETS.filter((item) => !acceptedOutletNames.has(item.name)).map((item) => item.name);
  const outletShortfall = acceptedOutletNames.size < 3
    ? { required: 3, actual: acceptedOutletNames.size, missing: missingOutlets }
    : null;
  return {
    discovered: discoveredCount,
    accepted: articleCount,
    skipped: Math.max(0, discoveredCount - articleCount),
    sourceFailures,
    queries: queryCount,
    attempts: attemptCount,
    articles: articleCount,
    outletShortfall,
  };
}
export async function runAuthorizedMediaDiscovery(db: AppDatabase, options: MediaDiscoveryOptions = {}): Promise<MediaRunSummary> {
  if (options.pass !== undefined) parsePass(options.pass);
  if (!options.runId && options.games) {
    const authorization = await authorizeMediaRun(db, { pass: options.pass ?? "initial", games: options.games });
    options = { ...options, runId: authorization.runId };
  }
  const run = await loadRun(db, options.runId);
  const pass = run.pass;
  // A scheduled discovery run serves every pass due when the daily media run
  // started it; an authorized run serves its own pass.
  const scheduled = run.origin === "scheduled";
  const passes: MediaPass[] = scheduled ? ["initial", "later"] : [pass];
  const selectedGames = json<number[]>(run.selected_games, []);
  const discoveryTargets = await loadMediaTargets(db, selectedGames);
  const targetAppids = discoveryTargets.map((target) => target.appid);
  const fetchFn = options.fetch ?? fetch;
  const apiKey = options.tavilyApiKey ?? process.env.TAVILY_API_KEY;
  let usageSummary: MediaRunSummary["usage"] = { ...EMPTY_USAGE_SUMMARY };
  const issued: MediaRunSummary["issued"] = { searches: 0, attempts: 0, articles: 0 };
  try {
    const clock: MediaClock = () => isoNow(options.now);
    await reopenDayScopedProgress(db, run.id, passes, targetAppids, dayKey(clock()));
    const stopReasons = new Set<string>();
    const stoppedOutlets = new Set<MediaOutlet>();
    let searchesStopped = false;
    let searchCreditBudget: number | null = null;
    let searchesIssued = 0;
    let searchCreditsConsumed = 0;
  if (!apiKey) {
    stopReasons.add("tavily_missing_key");
  } else {
    try {
      const usageResponse = await fetchFn("https://api.tavily.com/usage", { headers: { Authorization: `Bearer ${apiKey}` } });
      const usageBody = await usageResponse.json().catch(() => ({}));
      const details = usageDetails(usageBody);
      searchCreditBudget = details.remainingCredits;
      usageSummary = { remainingCredits: details.remainingCredits, plan: details.plan, planUsageAtStart: details.planUsage, planUsage: details.planUsage, planLimit: details.planLimit, paygoUsage: details.paygoUsage, paygoLimit: details.paygoLimit, searchCreditsConsumed: 0 };
      await db.prepare("UPDATE media_discovery_runs SET usage = ? WHERE id = ?").bind(JSON.stringify(usageSummary), run.id).run();
      if (!usageResponse.ok || !details.valid) stopReasons.add(details.remainingCredits === 0 ? "tavily_credits_exhausted" : details.plan === "free" ? "tavily_free_credits_unavailable" : "tavily_account_not_free");
    } catch {
      stopReasons.add("tavily_usage_error");
    }
  }
  if (stopReasons.size === 0) {
    const progressRows = await rows<ProgressRow>(db, `SELECT ${PROGRESS_COLUMNS} FROM media_discovery_progress WHERE appid IN (SELECT value FROM json_each(?)) ORDER BY appid, id`, JSON.stringify(targetAppids));
    // A scheduled run takes its due passes oldest due first, then by entity,
    // each across the outlets in roster order; an authorized run takes its
    // pass outlet by outlet.
    const queries = scheduled
      ? (await duePasses(db, discoveryTargets, isoTimestamp(run.started_at ?? clock().toISOString()))).flatMap(({ target, pass }) => MEDIA_OUTLETS.map((outlet) => ({ outlet, target, pass })))
      : MEDIA_OUTLETS.flatMap((outlet) => discoveryTargets.map((target) => ({ outlet, target, pass })));
    for (const { outlet, target, pass } of queries) {
      const appid = target.appid;
      if (await articleCeiling(db, appid)) continue;
      if (stoppedOutlets.has(outlet.name)) continue;
      // The later pass asks only the outlets with an accepted initial article for the entity.
      if (pass === "later" && !await first<{ id: number }>(db, "SELECT id FROM media_sources WHERE appid = ? AND outlet = ? AND pass = 'initial' LIMIT 1", appid, outlet.name)) continue;
        const progress = progressRows.find((row) => row.appid === appid && row.outlet === outlet.name && row.pass === pass) ?? null;
        let progressId = progress?.id;
        if (!progressId) {
          const inserted = await db.prepare("INSERT INTO media_discovery_progress (run_id, appid, pass, outlet, status) VALUES (?, ?, ?, ?, 'queued')").bind(run.id, appid, pass, outlet.name).run();
          if (!inserted.success) throw new Error("Unable to create media outlet progress");
          progressId = Number((await first<{ id: number }>(db, "SELECT id FROM media_discovery_progress WHERE appid = ? AND outlet = ? AND pass = ?", appid, outlet.name, pass))?.id ?? 0);
        } else if (progress?.run_id !== run.id) {
          await db.prepare("UPDATE media_discovery_progress SET run_id = ? WHERE id = ?").bind(run.id, progressId).run();
        }
        const current = await first<ProgressRow>(db, `SELECT ${PROGRESS_COLUMNS} FROM media_discovery_progress WHERE id = ?`, progressId);
        if (!current || current.status === "completed" || current.status === "stopped") continue;
        let candidates = json<Candidate[]>(current.candidate_urls, []).filter((candidate) => typeof candidate?.url === "string");
        let index = current.candidate_index;
        if (!current.query_attempted_at) {
          if (searchesStopped) continue;
          if (searchCreditBudget !== null && searchesIssued >= searchCreditBudget) {
            // No credit is left for this query: stop searching for the rest of
            // the run as a provider stop and keep the query for the next
            // authorized run.
            await releaseRefusedQuery(db, progressId, "queued", "tavily_credits_exhausted", clock());
            stopReasons.add("tavily_credits_exhausted");
            searchesStopped = true;
            continue;
          }
          // The query bound is one search per eligible entity, outlet and pass, so
          // eligible entities × outlets per pass: progress is unique per entity,
          // outlet and pass, and query_attempted_at is persisted before the
          // search, so reruns and restarts never search that row again.
          const query = passQuery(target, pass);
          const attemptNow = clock();
          const reservation = await reserveOutletAttempt(db, { runId: run.id, pass, appid, outlet: outlet.name, kind: "search", url: null, date: attemptNow });
          if ("stop" in reservation) {
            await stopProgress(db, progressId, reservation.stop, attemptNow);
            stoppedOutlets.add(outlet.name);
            stopReasons.add(`${outlet.name}:${reservation.stop}`);
            continue;
          }
          const attemptId = reservation.attemptId;
          searchesIssued += 1;
          issued.searches += 1;
          issued.attempts += 1;
          await db.prepare(
            "UPDATE media_discovery_progress SET query_attempted_at = ?, status = 'searching', stop_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          ).bind(attemptNow.toISOString(), progressId).run();
          let response: Response;
          try {
            response = await fetchFn("https://api.tavily.com/search", {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ query, search_depth: "basic", auto_parameters: false, include_domains: [outlet.domain], max_results: 10, include_answer: false, include_raw_content: false, include_usage: true }),
            });
          } catch (error) {
            // The search provider could not be reached, so no search was served:
            // stop searching for the rest of the run as a provider stop, leave
            // every outlet open, and keep the query for the next authorized run.
            await finishOutletAttempt(db, attemptId, { kind: "search", statusCode: null, succeeded: false, error: boundedError(error) });
            await releaseRefusedQuery(db, progressId, "queued", "tavily_search_error", attemptNow);
            stopReasons.add("tavily_search_error");
            searchesStopped = true;
            continue;
          }
          await finishOutletAttempt(db, attemptId, { kind: "search", statusCode: response.status, succeeded: response.ok, error: response.ok ? null : `HTTP ${response.status}` });
          if (response.status === 401 || response.status === 403) {
            // The search provider rejected the request, not the outlet: stop the
            // whole run as a provider stop, leave every outlet open, and keep
            // the unserved query for the next authorized run.
            const reason = `tavily_search_http_${response.status}`;
            await releaseRefusedQuery(db, progressId, "queued", reason, attemptNow);
            stopReasons.add(reason);
            break;
          }
          if (response.status === 429) {
            // The search provider's rate limit, not the outlet's: stop searching
            // for the rest of the run and retry this query on the next UTC day.
            const reason = "tavily_search_http_429";
            await releaseRefusedQuery(db, progressId, "stopped", reason, attemptNow);
            stopReasons.add(reason);
            searchesStopped = true;
            continue;
          }
          if (response.status >= 500) {
            // The search provider failed to serve the query: stop searching for
            // the rest of the run as a provider stop, leave every outlet open,
            // and keep the query for the next authorized run.
            const reason = `tavily_search_http_${response.status}`;
            await releaseRefusedQuery(db, progressId, "queued", reason, attemptNow);
            stopReasons.add(reason);
            searchesStopped = true;
            continue;
          }
          const body = await response.json().catch(() => ({}));
          const providerRequestId = cleanText(jsonObject(body).request_id ?? jsonObject(body).requestId);
          const usage = jsonObject(jsonObject(body).usage);
          const reportedCredits = usage.credits ?? usage.credits_used;
          if (typeof reportedCredits === "number" && Number.isFinite(reportedCredits) && reportedCredits >= 0) {
            searchCreditsConsumed += reportedCredits;
          }
          candidates = response.ok && Array.isArray(jsonObject(body).results)
            ? (jsonObject(body).results as TavilyResult[]).slice(0, 10).map((item) => ({ url: typeof item.url === "string" ? item.url : "", publishedDate: dateValue(item.published_date) })).filter((item) => item.url && hostInOutlet(item.url, outlet))
            : [];
          await db.prepare("UPDATE media_discovery_progress SET query_attempted_at = ?, status = 'fetching', candidate_urls = ?, candidate_index = 0, provider_request_id = ?, credits_used = ?, usage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(attemptNow.toISOString(), JSON.stringify(candidates), providerRequestId, typeof (usage.credits ?? usage.credits_used) === "number" ? (usage.credits ?? usage.credits_used) : null, JSON.stringify(usage), progressId).run();
          await db.prepare("UPDATE media_discovery_runs SET query_count = query_count + 1, provider_request_ids = json_insert(provider_request_ids, '$[#]', ?), usage = json_patch(usage, ?) WHERE id = ?").bind(providerRequestId, JSON.stringify(usage), run.id).run();
        }
        const selections = new Map<number, { review: MediaSource | null; preview: MediaSource | null }>();
        for (; index < candidates.length; index += 1) {
          // A later candidate already among the entity's sources is not fetched again.
          if (pass === "later" && await first<{ id: number }>(db, "SELECT id FROM media_sources WHERE appid = ? AND (original_url = ? OR discovery_url = ?) LIMIT 1", appid, candidates[index]!.url, candidates[index]!.url)) {
            await db.prepare("UPDATE media_discovery_progress SET candidate_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(index + 1, progressId).run();
            continue;
          }
          const fetched = await fetchManual(fetchFn, candidates[index]!.url, outlet, db, run.id, pass, appid, clock, issued);
          if (fetched && "stop" in fetched) {
            // A candidate the outlet answered is done; one refused before any
            // request is retried when the outlet reopens.
            if (fetched.contacted) await db.prepare("UPDATE media_discovery_progress SET candidate_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(index + 1, progressId).run();
            await stopProgress(db, progressId, fetched.stop, clock());
            stoppedOutlets.add(outlet.name);
            stopReasons.add(`${outlet.name}:${fetched.stop}`);
            break;
          }
          await db.prepare("UPDATE media_discovery_progress SET candidate_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(index + 1, progressId).run();
          if (!fetched) continue;
          const source = parseSource(fetched.html, fetched.finalUrl, target, discoveryTargets, outlet.name, clock().toISOString());
          if (!source) continue;
          source.discoveryUrl = candidates[index]!.url;
          if (pass === "later" && !await qualifiesForLaterPass(db, source)) continue;
          const selection = selections.get(source.appid) ?? { review: null, preview: null };
          if (source.type === "review") {
            selection.review = !selection.review || candidateDate(source) < candidateDate(selection.review) ? source : selection.review;
          } else {
            selection.preview = !selection.preview || candidateDate(source) < candidateDate(selection.preview) ? source : selection.preview;
          }
          selections.set(source.appid, selection);
        }
        for (const selection of selections.values()) {
          const selected = selection.review ?? selection.preview;
          if (!selected) continue;
          const ceiling = await articleCeiling(db, selected.appid);
          if (!ceiling) {
            const inserted = await db.prepare("INSERT OR IGNORE INTO media_sources (appid, pass, original_url, discovery_url, title, outlet, author, published_at, updated_at, retrieved_at, type, hands_on, affiliation, platform, build_context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(selected.appid, pass, selected.originalUrl, selected.discoveryUrl, selected.title, selected.outlet, selected.author, selected.publishedAt, selected.updatedAt, selected.retrievedAt, selected.type, selected.handsOn === null ? null : selected.handsOn ? 1 : 0, selected.affiliation, selected.platform, selected.buildContext).run();
            if (inserted.meta.changes === 1) issued.articles += 1;
          } else {
            stopReasons.add(ceiling);
          }
        }
        if (selections.size === 0 && current.status !== "stopped") {
          stopReasons.add(`${outlet.name}:no_qualifying_article`);
        }
        await db.prepare("UPDATE media_discovery_progress SET status = 'completed', completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'stopped'").bind(clock().toISOString(), progressId).run();
    }
  }
  const counts = await mediaRunCounts(db, passes, targetAppids);
  const providerStopped = [...stopReasons].some((reason) => reason.startsWith("tavily_"));
  const status: MediaRunSummary["status"] = providerStopped ? "stopped" : "completed";
  usageSummary = {
    ...usageSummary,
    searchCreditsConsumed,
    planUsage: usageSummary.planUsageAtStart === null ? null : usageSummary.planUsageAtStart + searchCreditsConsumed,
    remainingCredits: searchCreditBudget === null ? null : Math.max(0, searchCreditBudget - searchCreditsConsumed),
  };
  const stopReason = [...stopReasons][0] ?? null;
  const summary: MediaRunSummary["summary"] = {
    discovered: counts.discovered,
    accepted: counts.accepted,
    skipped: counts.skipped,
    sourceFailures: counts.sourceFailures,
    outletShortfall: counts.outletShortfall,
    runId: run.id,
    status,
    stopReason,
  };
  const durableSummary = {
    ...summary,
    queries: counts.queries,
    attempts: counts.attempts,
    articles: counts.articles,
    stopReasons: [...stopReasons].sort(),
    usage: usageSummary,
  };
  await db.prepare("UPDATE media_discovery_runs SET status = ?, article_count = ?, query_count = ?, attempt_count = ?, stop_reason = ?, summary = ?, usage = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, counts.articles, counts.queries, counts.attempts, stopReason, JSON.stringify(durableSummary), JSON.stringify(usageSummary), run.id).run();
  return { runId: run.id, pass, status, games: selectedGames, resumed: run.resumed === 1, newIdentity: run.resumed !== 1, queries: counts.queries, attempts: counts.attempts, articles: counts.articles, issued, stopReasons: [...stopReasons].sort(), summary, usage: usageSummary };
  } catch (error) {
    const counts = await mediaRunCounts(db, passes, targetAppids);
    const stopReason = "execution_error";
    const failureMessage = boundedError(error, apiKey);
    const summary: MediaRunSummary["summary"] = {
      discovered: counts.discovered,
      accepted: counts.accepted,
      skipped: counts.skipped,
      sourceFailures: counts.sourceFailures,
      outletShortfall: counts.outletShortfall,
      runId: run.id,
      status: "failed",
      stopReason,
      error: failureMessage,
      counts: {
        discovered: counts.discovered,
        accepted: counts.accepted,
        skipped: counts.skipped,
        sourceFailures: counts.sourceFailures,
        queries: counts.queries,
        attempts: counts.attempts,
        articles: counts.articles,
      },
    };
    const durableSummary = {
      ...summary,
      queries: counts.queries,
      attempts: counts.attempts,
      articles: counts.articles,
      stopReasons: [stopReason],
      usage: usageSummary,
    };
    await transaction(db, async () => {
      await db.prepare("UPDATE media_discovery_runs SET status = 'failed', article_count = ?, query_count = ?, attempt_count = ?, stop_reason = ?, summary = ?, usage = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").bind(counts.articles, counts.queries, counts.attempts, stopReason, JSON.stringify(durableSummary), JSON.stringify(usageSummary), run.id).run();
    });
    return { runId: run.id, pass, status: "failed", games: selectedGames, resumed: run.resumed === 1, newIdentity: run.resumed !== 1, queries: counts.queries, attempts: counts.attempts, articles: counts.articles, issued, stopReasons: [stopReason], summary, usage: usageSummary };
  }
}

export async function getMediaSources(db: AppDatabase, appid: number): Promise<MediaSource[]> {
  if (!Number.isInteger(appid) || appid <= 0) return [];
  const sourceRows = await rows<{
    appid: number; original_url: string; discovery_url: string | null; title: string; outlet: MediaOutlet;
    author: string | null; published_at: string | null; updated_at: string | null; retrieved_at: string;
    type: MediaArticleType; hands_on: number | null; affiliation: string | null; platform: string | null; build_context: string | null;
  }>(
    db,
    `SELECT source.appid, source.original_url, source.discovery_url, source.title, source.outlet,
            source.author, source.published_at, source.updated_at, source.retrieved_at,
            source.type, source.hands_on, source.affiliation, source.platform, source.build_context
     FROM media_sources AS source
     JOIN apps AS app
       ON app.appid = source.appid
      AND app.is_eligible = 1
      AND ${ELIGIBLE_MEDIA_ENTITY_SQL}
     WHERE source.appid = ?
     ORDER BY COALESCE(source.published_at, source.retrieved_at), source.id`,
    appid,
  );
  return sourceRows.map((row) => ({ appid: row.appid, originalUrl: row.original_url, discoveryUrl: row.discovery_url, title: row.title, outlet: row.outlet, author: row.author, publishedAt: row.published_at, updatedAt: row.updated_at, retrievedAt: row.retrieved_at, type: row.type, handsOn: row.hands_on === null ? null : row.hands_on === 1, affiliation: row.affiliation, platform: row.platform, buildContext: row.build_context }));
}

const activeMediaDiscovery = new Map<number, Promise<MediaRunSummary>>();
let mediaDiscoveryQueue: Promise<unknown> = Promise.resolve();

function enqueueMediaDiscovery(db: AppDatabase, runId: number, options: MediaDiscoveryOptions): Promise<MediaRunSummary> {
  const active = activeMediaDiscovery.get(runId);
  if (active) return active;

  const next = mediaDiscoveryQueue
    .catch(() => undefined)
    .then(() => runAuthorizedMediaDiscovery(db, { ...options, runId }));
  mediaDiscoveryQueue = next;
  activeMediaDiscovery.set(runId, next);
  const clear = () => {
    if (activeMediaDiscovery.get(runId) === next) activeMediaDiscovery.delete(runId);
  };
  void next.then(clear, clear);
  return next;
}

export async function runSerializedMediaDiscovery(
  db: AppDatabase,
  options: MediaDiscoveryOptions = {},
): Promise<MediaRunSummary> {
  if (options.runId !== undefined) return enqueueMediaDiscovery(db, options.runId, options);
  if (options.games) {
    const next = mediaDiscoveryQueue
      .catch(() => undefined)
      .then(async () => {
        const authorization = await authorizeMediaRun(db, { pass: "initial", games: options.games! });
        return runAuthorizedMediaDiscovery(db, { ...options, runId: authorization.runId });
      });
    mediaDiscoveryQueue = next;
    return next;
  }
  const run = await loadRun(db);
  return enqueueMediaDiscovery(db, run.id, { ...options, runId: run.id });
}
